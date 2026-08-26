'use strict';

/**
 * The price stack.
 *
 * Pure and I/O-free on purpose: pricing is the part of this product most
 * likely to be argued about, so it has to be reproducible from its inputs
 * alone and testable without a database.
 *
 * A quote is assembled in a fixed order, and every layer is visible to the
 * customer in the breakdown:
 *
 *   mechanic_rate          the mechanic's own hourly rate, never below the floor
 *   x demand_multiplier    metro-level scarcity, clamped and heavily bounded
 *   x job_modifiers        after-hours, vehicle class, difficulty
 *   = effective_hourly
 *
 *   effective_hourly x labor_hours   (or the minimum job charge, whichever is more)
 *   + travel fee by distance band
 *   + parts at cost, plus a handling charge
 *   = customer total
 *
 * Three rules constrain the math, and they are not negotiable in code:
 *
 *  1. The mechanic sets the rate. The platform publishes a floor and a
 *     suggestion; it never sets the number. This is the load-bearing
 *     mitigation against worker misclassification — the platform setting
 *     prices attacks prong A of the ABC test directly.
 *  2. Urgent and roadside work is exempt from demand pricing entirely. A
 *     stranded customer meets a flat, published call-out fee instead. Surging
 *     someone whose car just died is the reputational end of a trust company.
 *  3. Nothing about who the customer is reaches the price. Lane, account age,
 *     device, and history are not parameters here — see `quote()`'s signature.
 *     Personalised pricing on a broken-down car is not a business we are in.
 */

// Cents everywhere. Floating-point dollars in a money path is how you get
// totals that disagree with their own line items.
const DEFAULTS = {
  rateFloorCents: 6500,        // $65/hr. Measured mobile-mechanic average is ~$85.
  minimumJobCents: 8500,       // Showing up has a cost even if the fix is quick.
  calloutCents: 7500,          // Flat, published, and never multiplied.
  platformFeeBps: 1000,        // 10% of labour + travel. Parts are excluded.
  partsHandlingBps: 350,       // Neutralises card cost on parts pass-through.
  demandFloor: 0.90,
  demandCeiling: 1.25,
  demandStep: 0.05,            // Quantised, so quotes are stable and explainable.
  minObservationsForDemand: 20,
};

// Distance bands rather than per-mile: a mechanic quoting "$1.40/mile" invites
// an argument about the odometer. A band is a number both sides can check.
const TRAVEL_BANDS = [
  { maxMiles: 10, cents: 0 },
  { maxMiles: 20, cents: 2500 },
  { maxMiles: 35, cents: 4500 },
  { maxMiles: 50, cents: 7000 },
];

const MODIFIERS = {
  after_hours: 1.15,
  weekend: 1.10,
  european: 1.15,
  diesel: 1.20,
  ev_hv: 1.25,
};
const MODIFIER_CAP = 1.75;

function round(n) { return Math.round(n); }
function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

/**
 * Demand multiplier for a metro and service.
 *
 * Each signal is optional and a missing one is REMOVED FROM THE SUM rather
 * than defaulted to a neutral value. That distinction is what makes cold start
 * exactly 1.000 instead of drifting on made-up inputs: with no signals there
 * is no adjustment, not an average of nothing.
 *
 * @param {object} signals
 * @param {number} [signals.utilization]   0..1 share of open bays already booked
 * @param {number} [signals.demandRatio]   14d searches+leads over the 90d mean
 * @param {number} [signals.leadTimeDays]  days until the requested slot
 * @param {number} [signals.seasonal]      -1..1 seasonal pressure
 * @param {number} [signals.observations]  completed bookings in this metro x service
 * @returns {{multiplier: number, applied: boolean, reason: string}}
 */
function demandMultiplier(signals = {}, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const obs = Number(signals.observations || 0);
  if (obs < cfg.minObservationsForDemand) {
    return { multiplier: 1, applied: false, reason: 'insufficient_history' };
  }

  const terms = [];
  if (Number.isFinite(signals.utilization)) {
    terms.push(0.12 * (clamp(signals.utilization, 0, 1) - 0.5) * 2);
  }
  if (Number.isFinite(signals.demandRatio) && signals.demandRatio > 0) {
    // Log ratio: a metro at 2x its own baseline moves as far up as one at 0.5x
    // moves down. Linear ratios make a spike look like an emergency.
    terms.push(0.08 * clamp(Math.log2(signals.demandRatio), -2, 2));
  }
  if (Number.isFinite(signals.leadTimeDays)) {
    // Same-day is scarce; a week out is not.
    terms.push(0.06 * clamp((3 - signals.leadTimeDays) / 3, -1, 1));
  }
  if (Number.isFinite(signals.seasonal)) {
    terms.push(0.05 * clamp(signals.seasonal, -1, 1));
  }
  if (!terms.length) {
    return { multiplier: 1, applied: false, reason: 'no_signals' };
  }

  const raw = 1 + terms.reduce((a, b) => a + b, 0);
  const stepped = Math.round(raw / cfg.demandStep) * cfg.demandStep;
  const multiplier = clamp(Number(stepped.toFixed(2)), cfg.demandFloor, cfg.demandCeiling);
  return { multiplier, applied: multiplier !== 1, reason: 'demand' };
}

function travelFeeCents(miles) {
  if (!Number.isFinite(miles) || miles <= 0) return 0;
  for (const band of TRAVEL_BANDS) {
    if (miles <= band.maxMiles) return band.cents;
  }
  return null; // Beyond the last band: out of range, not "very expensive".
}

function modifierProduct(names = []) {
  const applied = [];
  let product = 1;
  for (const n of names) {
    const m = MODIFIERS[n];
    if (!m) continue;
    product *= m;
    applied.push({ name: n, multiplier: m });
  }
  return { product: Math.min(product, MODIFIER_CAP), applied };
}

/**
 * Build a full quote.
 *
 * Note what is NOT a parameter: the customer. No identity, lane, history, or
 * device reaches this function, so no future change can accidentally price a
 * person rather than a job.
 *
 * @param {object} input
 * @param {number} input.mechanicRateCents  the mechanic's own hourly rate
 * @param {number} input.laborHoursLow      low end of the labour estimate
 * @param {number} input.laborHoursHigh     high end
 * @param {number} [input.travelMiles]
 * @param {number} [input.partsCents]       parts at cost
 * @param {string[]} [input.modifiers]
 * @param {object} [input.demandSignals]
 * @param {boolean} [input.urgent]          roadside / same-day breakdown
 * @param {object} [opts]                   overrides for DEFAULTS
 */
function quote(input, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const {
    mechanicRateCents, laborHoursLow, laborHoursHigh,
    travelMiles = 0, partsCents = 0, modifiers = [],
    demandSignals = {}, urgent = false,
  } = input;

  if (!Number.isFinite(mechanicRateCents) || mechanicRateCents <= 0) {
    throw new Error('mechanicRateCents is required');
  }
  if (mechanicRateCents < cfg.rateFloorCents) {
    throw new Error(`rate ${mechanicRateCents} is below the platform floor ${cfg.rateFloorCents}`);
  }
  if (!Number.isFinite(laborHoursLow) || !Number.isFinite(laborHoursHigh) || laborHoursLow > laborHoursHigh) {
    throw new Error('a labour estimate needs a low and a high, low first');
  }

  // Rule 2: urgent work meets a flat call-out fee, never a multiplier.
  const demand = urgent
    ? { multiplier: 1, applied: false, reason: 'urgent_exempt' }
    : demandMultiplier(demandSignals, cfg);

  const mods = modifierProduct(modifiers);
  const effectiveHourly = round(mechanicRateCents * demand.multiplier * mods.product);

  const laborLow  = Math.max(round(effectiveHourly * laborHoursLow),  cfg.minimumJobCents);
  const laborHigh = Math.max(round(effectiveHourly * laborHoursHigh), cfg.minimumJobCents);

  const travel = travelFeeCents(travelMiles);
  if (travel === null) {
    return { outOfRange: true, reason: 'beyond_service_radius', travelMiles };
  }
  const callout = urgent ? cfg.calloutCents : 0;
  const partsHandling = round(partsCents * cfg.partsHandlingBps / 10000);

  const totalLow  = laborLow  + travel + callout + partsCents + partsHandling;
  const totalHigh = laborHigh + travel + callout + partsCents + partsHandling;

  // Rule: the fee is levied on labour and travel only. Taking a percentage of
  // parts turns a pass-through into revenue we did not earn, and taking a
  // percentage of the whole ticket while paying card fees on it too is how the
  // margin goes negative on exactly the jobs worth having.
  const feeBaseLow  = laborLow  + travel + callout;
  const feeBaseHigh = laborHigh + travel + callout;

  return {
    outOfRange: false,
    effectiveHourlyCents: effectiveHourly,
    demand,
    modifiers: mods.applied,
    lines: {
      laborLowCents: laborLow,
      laborHighCents: laborHigh,
      travelCents: travel,
      calloutCents: callout,
      partsCents,
      partsHandlingCents: partsHandling,
    },
    totalLowCents: totalLow,
    totalHighCents: totalHigh,
    platformFeeLowCents:  round(feeBaseLow  * cfg.platformFeeBps / 10000),
    platformFeeHighCents: round(feeBaseHigh * cfg.platformFeeBps / 10000),
  };
}

module.exports = {
  DEFAULTS, TRAVEL_BANDS, MODIFIERS, MODIFIER_CAP,
  demandMultiplier, travelFeeCents, modifierProduct, quote,
};

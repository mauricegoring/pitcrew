'use strict';

/**
 * Demand signal imported from PitCrew Mechanics.
 *
 * PitCrew Mechanics is the demand engine: it holds the SEO surface, the metro x
 * service pages, and years of captured searches and leads segmented by lane.
 * PitCrew is the transaction. Neither is redundant — one proves where the work
 * is, the other does the work.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE TRAP, AND WHY THIS MODULE EXISTS
 * ══════════════════════════════════════════════════════════════════════════
 *
 * It is tempting to feed imported search volume straight into the pricing
 * engine's demand signals. That would be wrong, and expensively so.
 *
 * The demand multiplier stays pinned at 1.000 until a metro has enough
 * COMPLETED BOOKINGS to trust its own numbers. That gate is not about how much
 * interest exists — it is about whether we can measure our own supply. A
 * thousand PitCrew Mechanics searches say a metro wants mechanics. They say nothing
 * about whether OUR mechanics are busy, because on day one we have none.
 *
 * Import search volume as `observations` and the engine would conclude the
 * metro is hot and surge-price the very first customer, against a supply of
 * zero, on evidence that has nothing to do with supply. So:
 *
 *   Imported demand answers: WHERE should we launch, and what should we
 *                            suggest a mechanic charge here?
 *   It never answers:        is my calendar tight right now?
 *
 * `toLaunchSignal` deliberately returns no `observations` field, so imported
 * data cannot unlock the multiplier even by accident.
 */

const LANES = ['public', 'host'];

// A metro is worth launching when there is enough demand to keep a founding
// crew busy. Thresholds are per quarter, and are launch criteria — not a
// pricing input.
const LAUNCH = {
  minSearches: 250,
  minLeads: 40,
  // Verified-host demand is weighted because a fleet operator is a repeat
  // customer with several vehicles, not a one-off. This is what makes the
  // v2 rate negotiation different from "we have traffic".
  hostLeadWeight: 4,
  minWeightedLeads: 60,
};

function emptyTally() {
  return { searches: 0, leads: 0, byLane: { public: { searches: 0, leads: 0 }, host: { searches: 0, leads: 0 } } };
}

/**
 * Fold an aggregate feed into per-metro and per-service tallies.
 *
 * The feed is AGGREGATE ONLY, by contract. Individual host identity never
 * crosses this boundary — not an email, not a name, not a vehicle. A row is a
 * count, and a count is all PitCrew is entitled to. Rows carrying anything
 * identifying are rejected rather than quietly stripped, because silently
 * accepting PII is how it ends up in a log.
 *
 * @param {Array<{metro:string, service?:string, lane:string, searches?:number, leads?:number}>} feed
 */
function ingest(feed) {
  const byMetro = new Map();
  const byMetroService = new Map();
  const rejected = [];

  for (const row of feed || []) {
    if (!row || !row.metro) { rejected.push({ row, reason: 'no_metro' }); continue; }
    if (!LANES.includes(row.lane)) { rejected.push({ row, reason: 'unknown_lane' }); continue; }

    // The aggregate-only contract, enforced rather than trusted.
    const leaked = ['email', 'name', 'phone', 'host_id', 'account_id', 'vin', 'visitor_id']
      .filter(k => k in row);
    if (leaked.length) { rejected.push({ row, reason: 'identifying_field:' + leaked.join(',') }); continue; }

    const searches = Number(row.searches || 0);
    const leads = Number(row.leads || 0);
    if (!Number.isFinite(searches) || !Number.isFinite(leads) || searches < 0 || leads < 0) {
      rejected.push({ row, reason: 'bad_counts' }); continue;
    }

    for (const [map, key] of [
      [byMetro, row.metro],
      [byMetroService, row.service ? `${row.metro}::${row.service}` : null],
    ]) {
      if (!key) continue;
      if (!map.has(key)) map.set(key, emptyTally());
      const t = map.get(key);
      t.searches += searches;
      t.leads += leads;
      t.byLane[row.lane].searches += searches;
      t.byLane[row.lane].leads += leads;
    }
  }

  return { byMetro, byMetroService, rejected };
}

/**
 * Is this metro worth launching into?
 *
 * Returns the evidence alongside the verdict, because "not yet" needs to say
 * how far off it is — that number is what decides where the next founder trip
 * goes.
 */
function launchReadiness(tally) {
  const t = tally || emptyTally();
  const weightedLeads = t.byLane.public.leads + t.byLane.host.leads * LAUNCH.hostLeadWeight;
  const checks = {
    searches: { value: t.searches, required: LAUNCH.minSearches, ok: t.searches >= LAUNCH.minSearches },
    leads: { value: t.leads, required: LAUNCH.minLeads, ok: t.leads >= LAUNCH.minLeads },
    weightedLeads: { value: weightedLeads, required: LAUNCH.minWeightedLeads, ok: weightedLeads >= LAUNCH.minWeightedLeads },
  };
  return {
    ready: Object.values(checks).every(c => c.ok),
    checks,
    hostShare: t.leads ? Number((t.byLane.host.leads / t.leads).toFixed(3)) : 0,
  };
}

/**
 * Turn imported demand into the signals it is ALLOWED to inform.
 *
 * Note what is absent: `observations`. The pricing engine gates its multiplier
 * on completed bookings, and imported search volume is not that. Omitting the
 * field means an imported metro still prices at exactly 1.000 until PitCrew has
 * done real work there — which is the correct and safe behaviour.
 *
 * `seasonal` is passed through because a seasonal pattern IS transferable: air
 * conditioning fails in July in Phoenix whoever is taking the booking.
 */
function toLaunchSignal(tally, { seasonal = null } = {}) {
  const t = tally || emptyTally();
  const signal = {};
  if (Number.isFinite(seasonal)) signal.seasonal = seasonal;
  // Deliberately no utilization, no demandRatio, no observations. Every one of
  // those describes OUR supply, and imported data knows nothing about it.
  return {
    signal,
    interest: { searches: t.searches, leads: t.leads, hostLeads: t.byLane.host.leads },
    note: 'imported demand informs launch and rate guidance only, never the live multiplier',
  };
}

/**
 * Suggested opening rate for a metro.
 *
 * A suggestion, never a setting: the mechanic types the number. Anchored on the
 * metro's measured market rate and nudged by how much verified-fleet demand
 * sits there, because a fleet operator's work is repeat work and worth
 * competing for.
 */
function suggestRate(marketRateCents, tally, { floorCents = 6500 } = {}) {
  const r = launchReadiness(tally);
  const nudge = 1 + Math.min(0.08, r.hostShare * 0.1);
  const suggested = Math.max(floorCents, Math.round(marketRateCents * nudge / 100) * 100);
  return {
    suggestedCents: suggested,
    floorCents,
    basis: 'metro market rate, adjusted for verified-fleet share',
    hostShare: r.hostShare,
    // The mechanic decides. This is the whole worker-classification posture.
    binding: false,
  };
}

module.exports = { LAUNCH, LANES, ingest, launchReadiness, toLaunchSignal, suggestRate, emptyTally };

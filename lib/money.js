'use strict';

/**
 * Money assembly: turning a quote into the exact set of amounts that get
 * charged, transferred, and recorded.
 *
 * The fee model is a business decision that is not settled, so it is a
 * parameter rather than a constant. What IS settled, and encoded here:
 *
 *  - The platform fee is levied on labour and travel, never on parts. Parts
 *    are a pass-through; taking a percentage of them books revenue we did not
 *    earn, and — worse — the card fee is charged on the full ticket including
 *    parts and tax, so a fee levied only on labour while processing is paid on
 *    everything goes negative on exactly the high-value jobs worth having.
 *  - Parts carry a handling charge sized to neutralise that processing cost
 *    honestly, rather than a hidden markup.
 *  - Every amount is in cents, and the parts add up to the total exactly.
 *    `assemble` asserts that rather than trusting it.
 *
 * Sales tax is deliberately NOT computed here. Whether labour is taxable, and
 * at what rate, genuinely varies by state, and a plausible-looking guess
 * compounds silently until an audit. The caller supplies a resolved rate or
 * none at all.
 */

const PROCESSING = { pctBps: 290, fixedCents: 30 };  // Stripe's standard US card rate.

const MODELS = {
  // 10% from the mechanic and nothing else — no customer-side line, no parts
  // handling. The simplest story and the strongest recruiting pitch, and the
  // one that does not survive contact with a parts-heavy ticket. Kept as a
  // model precisely so the arithmetic stays visible instead of being folklore.
  mechanic_only: { platformFeeBps: 1000, customerFeeBps: 0,   protectionCents: 0,    partsHandlingBps: 0 },
  // A fee on both sides. Mirrors how a rental marketplace actually monetises:
  // supply argues about the headline rate while the guest-side fee does the work.
  split:         { platformFeeBps: 1000, customerFeeBps: 800, protectionCents: 0,    partsHandlingBps: 350 },
  // 10% plus an explicit, cost-indexed protection line the customer can see,
  // plus a parts handling charge sized to neutralise the processing cost that
  // the parts pass-through otherwise imposes with no matching revenue.
  protection:    { platformFeeBps: 1000, customerFeeBps: 0,   protectionCents: 1900, partsHandlingBps: 350 },
};

// What covering a mechanic on the job actually costs, per job. A placeholder
// until a broker quotes a real program — deliberately a parameter, because the
// whole question is whether the model survives it.
const DEFAULT_INSURANCE_CENTS = 600;

function bps(amount, rate) { return Math.round(amount * rate / 10000); }

function processingFeeCents(chargeTotalCents) {
  return Math.round(chargeTotalCents * PROCESSING.pctBps / 10000) + PROCESSING.fixedCents;
}

/**
 * Assemble the money for one job.
 *
 * @param {object} input
 * @param {number} input.laborCents
 * @param {number} [input.travelCents]
 * @param {number} [input.calloutCents]
 * @param {number} [input.partsCents]        parts at cost
 * @param {number} [input.partsHandlingCents]
 * @param {number} [input.taxCents]          resolved by the caller, per state
 * @param {string} [input.model]             a key of MODELS
 * @returns {object} every amount, plus a balanced double-entry ledger
 */
function assemble(input) {
  const {
    laborCents, travelCents = 0, calloutCents = 0,
    partsCents = 0, taxCents = 0,
    insuranceCents = DEFAULT_INSURANCE_CENTS,
    model = 'protection',
  } = input;

  const m = MODELS[model];
  if (!m) throw new Error(`unknown fee model: ${model}`);
  if (!Number.isFinite(laborCents) || laborCents < 0) throw new Error('laborCents is required');
  if (partsCents < 0) throw new Error('partsCents cannot be negative');

  // What the mechanic's work is worth, before anyone's fee.
  const serviceCents = laborCents + travelCents + calloutCents;
  const feeBase = serviceCents;

  const platformFeeCents   = bps(feeBase, m.platformFeeBps);
  const customerFeeCents   = bps(feeBase, m.customerFeeBps);
  const partsHandlingCents = bps(partsCents, m.partsHandlingBps);
  const protectionCents    = m.protectionCents;

  // The customer pays for the work, the parts, and whatever is charged on top.
  const customerTotalCents =
    serviceCents + partsCents + partsHandlingCents +
    customerFeeCents + protectionCents + taxCents;

  // The mechanic keeps the work and the parts, minus the platform's cut. Parts
  // handling and tax are not theirs; neither is the customer-side fee.
  const mechanicNetCents = serviceCents + partsCents - platformFeeCents;

  const processingCents = processingFeeCents(customerTotalCents);

  // What the platform keeps once the card network and the insurer are paid.
  // This is the number that decides whether the model survives.
  const platformRevenueCents = platformFeeCents + customerFeeCents + protectionCents + partsHandlingCents;
  const contributionCents = platformRevenueCents - processingCents - insuranceCents;

  const result = {
    model,
    lines: {
      laborCents, travelCents, calloutCents,
      partsCents, partsHandlingCents,
      customerFeeCents, protectionCents, taxCents,
    },
    customerTotalCents,
    mechanicNetCents,
    platformFeeCents,
    platformRevenueCents,
    processingCents,
    insuranceCents,
    contributionCents,
  };

  // The invariant that keeps a money bug from ever being subtle: the customer's
  // total must equal the sum of what everyone receives. Processing and
  // insurance are costs against the platform's share, not extra charges, so
  // they sit outside this identity by design.
  const distributed = mechanicNetCents + platformRevenueCents + taxCents;
  if (distributed !== customerTotalCents) {
    throw new Error(
      `money does not balance: customer ${customerTotalCents} != distributed ${distributed}`
    );
  }

  result.ledger = buildLedger(result);
  return result;
}

/**
 * Double-entry ledger for one job.
 *
 * With a separate-charges-and-transfers topology the platform fee is never a
 * Stripe object — it is simply the money not transferred — so this ledger is
 * the only place platform revenue is recorded as revenue. It has to balance.
 */
function buildLedger(r) {
  const entries = [
    { account: 'cash:stripe',            debit: r.customerTotalCents, credit: 0 },
    { account: 'liability:mechanic',     debit: 0, credit: r.mechanicNetCents },
    { account: 'revenue:platform_fee',   debit: 0, credit: r.platformFeeCents },
    { account: 'revenue:customer_fee',   debit: 0, credit: r.lines.customerFeeCents },
    { account: 'revenue:protection',     debit: 0, credit: r.lines.protectionCents },
    { account: 'revenue:parts_handling', debit: 0, credit: r.lines.partsHandlingCents },
    { account: 'liability:sales_tax',    debit: 0, credit: r.lines.taxCents },
  ].filter(e => e.debit || e.credit);

  const debits  = entries.reduce((a, e) => a + e.debit, 0);
  const credits = entries.reduce((a, e) => a + e.credit, 0);
  if (debits !== credits) {
    throw new Error(`ledger does not balance: debits ${debits} != credits ${credits}`);
  }
  return entries;
}

/** Compare every model on the same job. Used by docs and by the margin test. */
function compareModels(input) {
  return Object.fromEntries(
    Object.keys(MODELS).map(k => [k, assemble({ ...input, model: k })])
  );
}

module.exports = { MODELS, PROCESSING, DEFAULT_INSURANCE_CENTS, processingFeeCents, assemble, buildLedger, compareModels };

// Run: node test/money.test.js
const M = require('../lib/money');

function assert(c, m){ if(!c) throw new Error('Assertion failed: ' + m); }
function eq(a,b,m){ assert(a===b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
const usd = c => '$' + (c/100).toFixed(2);

// Two reference jobs, both parts-heavy. The difference between them is the
// hourly rate, and that difference turns out to decide whether a bare 10%
// works at all.
//
// CHEAP is the original $50/hr proposal: 2.5h labour, $180 parts at 15%, $25
// travel, 8% tax on parts.
const CHEAP  = { laborCents: 12500, travelCents: 2500, partsCents: 20700, taxCents: 1656 };
// MARKET is the same job at $85/hr, the measured mobile-mechanic average.
const MARKET = { laborCents: 21250, travelCents: 2500, partsCents: 20700, taxCents: 1656 };
const JOB = MARKET;

let failed = false;
try {
  // ── The balance invariant, on every model. A money module that can silently
  // lose a cent is worse than one that throws.
  for (const model of Object.keys(M.MODELS)) {
    const r = M.assemble({ ...JOB, model });
    const distributed = r.mechanicNetCents + r.platformRevenueCents + r.lines.taxCents;
    eq(distributed, r.customerTotalCents, `${model}: customer total equals what is distributed`);
    const d = r.ledger.reduce((a,e)=>a+e.debit,0);
    const c = r.ledger.reduce((a,e)=>a+e.credit,0);
    eq(d, c, `${model}: the ledger balances`);
    eq(d, r.customerTotalCents, `${model}: the ledger's debit is the customer's charge`);
  }

  // ── The fee never touches parts. This is the rule that keeps a pass-through
  // from being booked as revenue.
  const withParts = M.assemble({ ...JOB, model: 'mechanic_only' });
  const noParts   = M.assemble({ ...JOB, partsCents: 0, model: 'mechanic_only' });
  eq(withParts.platformFeeCents, noParts.platformFeeCents,
     'adding $207 of parts does not change the platform fee');
  eq(withParts.platformFeeCents, Math.round((21250 + 2500) * 0.10),
     'the fee is exactly 10% of labour plus travel');

  // ── The finding that drove the whole design. At $50/hr a bare 10% is
  // negative on a parts-heavy job: the fee is levied on labour, while card
  // processing is levied on the full ticket including parts and tax, and a
  // real insurance cost lands on top.
  const cheapBare = M.assemble({ ...CHEAP, model: 'mechanic_only' });
  assert(cheapBare.contributionCents < 0,
    `a bare 10% at $50/hr loses money (got ${usd(cheapBare.contributionCents)})`);

  // Two things independently rescue it, and it is worth knowing which.
  // First: the rate. The identical model at market rate clears, because the
  // fee base grew while the parts pass-through did not.
  const marketBare = M.assemble({ ...MARKET, model: 'mechanic_only' });
  assert(marketBare.contributionCents > 0,
    `the same bare model at $85/hr clears (${usd(marketBare.contributionCents)})`);
  assert(marketBare.contributionCents > cheapBare.contributionCents,
    'raising the floor is itself a margin fix, not only a supply fix');

  // Second: charging for the parts pass-through instead of absorbing it.
  const cheapProt = M.assemble({ ...CHEAP, model: 'protection' });
  assert(cheapProt.contributionCents > 0,
    `protection clears even at $50/hr (${usd(cheapProt.contributionCents)})`);

  // And the exposure the bare model carries is exactly the parts. Same job,
  // no parts, and it is positive again.
  const cheapNoParts = M.assemble({ ...CHEAP, partsCents: 0, taxCents: 0, model: 'mechanic_only' });
  assert(cheapNoParts.contributionCents > 0,
    'the same labour with no parts is positive — parts are what invert it');

  // ── Insurance is a parameter because the real number is unknown. The model
  // must survive being told the truth later.
  const pessimistic = M.assemble({ ...MARKET, model: 'protection', insuranceCents: 2500 });
  const optimistic  = M.assemble({ ...MARKET, model: 'protection', insuranceCents: 0 });
  eq(optimistic.contributionCents - pessimistic.contributionCents, 2500,
     'contribution moves one-for-one with the insurance cost');
  assert(pessimistic.contributionCents > 0,
     'protection still clears at the top of the quoted insurance range');
  const barePessimistic = M.assemble({ ...MARKET, model: 'mechanic_only', insuranceCents: 2500 });
  assert(barePessimistic.contributionCents < 0,
     'the bare model does not survive a realistic premium even at market rate');

  // Named aliases at market rate, used by the checks below.
  const bare  = marketBare;
  const prot  = M.assemble({ ...MARKET, model: 'protection' });
  const split = M.assemble({ ...MARKET, model: 'split' });
  assert(prot.contributionCents > 0,  `protection clears (${usd(prot.contributionCents)})`);
  assert(split.contributionCents > 0, `split clears (${usd(split.contributionCents)})`);

  // The two customer-side models are not ranked — they cross over, and knowing
  // where matters more than knowing which is "better". A flat protection fee
  // is regressive: it earns most on a small ticket and is left behind on a
  // large one, where a percentage keeps scaling.
  const small = { laborCents: 8500, travelCents: 0, partsCents: 0, taxCents: 0 };
  const large = { laborCents: 51000, travelCents: 4500, partsCents: 0, taxCents: 0 };
  assert(M.assemble({ ...small, model: 'protection' }).platformRevenueCents >
         M.assemble({ ...small, model: 'split' }).platformRevenueCents,
    'on a one-hour job the flat protection fee earns more');
  assert(M.assemble({ ...large, model: 'split' }).platformRevenueCents >
         M.assemble({ ...large, model: 'protection' }).platformRevenueCents,
    'on a full-day job the percentage fee overtakes it');

  // ── The mechanic is paid the same regardless of how the platform monetises.
  // If a fee model changes what the mechanic nets, it is a pay cut wearing a
  // different name, and they will notice.
  const nets = Object.values(M.compareModels(JOB)).map(r => r.mechanicNetCents);
  eq(new Set(nets).size, 1, 'every model pays the mechanic identically');
  eq(nets[0], 21250 + 2500 + 20700 - 2375, 'mechanic keeps labour, travel and parts, less 10%');

  // ── Only the customer-side models change the customer's total.
  eq(bare.customerTotalCents, JOB.laborCents + JOB.travelCents + JOB.partsCents + JOB.taxCents,
     'mechanic-only adds nothing at all to the customer');
  assert(prot.customerTotalCents > bare.customerTotalCents, 'protection is a visible line');
  eq(prot.customerTotalCents - bare.customerTotalCents,
     M.MODELS.protection.protectionCents + prot.lines.partsHandlingCents,
     'the difference is exactly the protection and handling lines, nothing hidden');

  // ── Processing is charged on the whole ticket including tax and parts.
  eq(M.processingFeeCents(10000), 320, '2.9% + 30c');
  eq(bare.processingCents, M.processingFeeCents(bare.customerTotalCents),
     'processing follows the charged amount, not the revenue');

  // ── Tax is never revenue. It passes through to a liability.
  const taxEntry = prot.ledger.find(e => e.account === 'liability:sales_tax');
  eq(taxEntry.credit, JOB.taxCents, 'tax is a liability, not income');
  assert(!prot.ledger.some(e => e.account.startsWith('revenue') && e.credit === JOB.taxCents),
     'tax is never credited to revenue');

  // ── Bad input is loud.
  let threw = false;
  try { M.assemble({ ...JOB, model: 'free_money' }); } catch (e) { threw = /unknown fee model/.test(e.message); }
  assert(threw, 'an unknown model is rejected');
  threw = false;
  try { M.assemble({ laborCents: -1 }); } catch (e) { threw = true; }
  assert(threw, 'a negative labour amount is rejected');

  console.log('\n  model            customer   mechanic   platform   contribution');
  for (const [k, r] of Object.entries(M.compareModels(JOB))) {
    console.log('  %s %s %s %s %s',
      k.padEnd(16), usd(r.customerTotalCents).padStart(9),
      usd(r.mechanicNetCents).padStart(10), usd(r.platformRevenueCents).padStart(10),
      usd(r.contributionCents).padStart(13));
  }
  console.log('\n[test] MONEY — ALL CHECKS PASSED');
} catch (e) {
  failed = true;
  console.error('\n[test] MONEY — FAILED:', e.message);
}
process.exit(failed ? 1 : 0);

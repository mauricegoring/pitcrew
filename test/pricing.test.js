// Run: node test/pricing.test.js
const P = require('../lib/pricing');

function assert(c, m){ if(!c) throw new Error('Assertion failed: ' + m); }
function eq(a,b,m){ assert(a===b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function near(a,b,tol,m){ assert(Math.abs(a-b)<=tol, `${m} (got ${a}, want ~${b})`); }

let failed = false;
try {
  // ── Cold start. The single most important property: with no history, the
  // engine must not invent a multiplier.
  const cold = P.demandMultiplier({});
  eq(cold.multiplier, 1, 'no signals means no adjustment');
  eq(cold.applied, false, 'cold start is not "applied"');
  eq(cold.reason, 'insufficient_history', 'and it says why');

  // Signals present but too few completed bookings to trust them.
  eq(P.demandMultiplier({ utilization: 0.95, observations: 5 }).multiplier, 1,
     'a hot signal on thin history is still 1.000');

  // With history, a busy metro moves up — but only within the band.
  const busy = P.demandMultiplier({ utilization: 1, demandRatio: 4, leadTimeDays: 0, seasonal: 1, observations: 500 });
  assert(busy.multiplier > 1, 'a saturated metro prices up');
  assert(busy.multiplier <= P.DEFAULTS.demandCeiling, 'never above the ceiling');
  const dead = P.demandMultiplier({ utilization: 0, demandRatio: 0.1, leadTimeDays: 30, seasonal: -1, observations: 500 });
  assert(dead.multiplier < 1, 'a dead metro prices down');
  assert(dead.multiplier >= P.DEFAULTS.demandFloor, 'never below the floor');

  // The band is deliberately narrow. 1.6x of a $65 rate reads as gouging in
  // exactly the moment it would trigger.
  eq(P.DEFAULTS.demandCeiling, 1.25, 'ceiling stays conservative');
  eq(P.DEFAULTS.demandFloor, 0.90, 'the discount half exists too');

  // Quantised, so two customers a minute apart see the same number.
  for (const u of [0.31, 0.32, 0.33]) {
    const m = P.demandMultiplier({ utilization: u, observations: 100 }).multiplier;
    near((m * 100) % 5, 0, 0.001, 'multipliers land on a 0.05 step');
  }

  // ── Travel bands.
  eq(P.travelFeeCents(0), 0, 'no travel, no fee');
  eq(P.travelFeeCents(9), 0, 'inside the free band');
  eq(P.travelFeeCents(10), 0, 'band is inclusive at its edge');
  eq(P.travelFeeCents(10.5), 2500, 'just over rolls to the next band');
  eq(P.travelFeeCents(50), 7000, 'last band');
  eq(P.travelFeeCents(51), null, 'beyond the last band is out of range, not expensive');

  // ── Modifiers compose but cannot run away.
  eq(P.modifierProduct([]).product, 1, 'no modifiers is neutral');
  eq(P.modifierProduct(['unknown_thing']).product, 1, 'an unknown modifier is ignored, not fatal');
  near(P.modifierProduct(['after_hours']).product, 1.15, 0.001, 'a single modifier applies');
  const stacked = P.modifierProduct(['after_hours','weekend','european','diesel','ev_hv']);
  eq(stacked.product, P.MODIFIER_CAP, 'stacked modifiers are capped');

  // ── The floor is enforced, and it is the platform's only say over the rate.
  let threw = false;
  try { P.quote({ mechanicRateCents: 5000, laborHoursLow: 1, laborHoursHigh: 1 }); }
  catch (e) { threw = /floor/.test(e.message); }
  assert(threw, 'a rate below the floor is rejected');

  // A rate far ABOVE the floor is fine — the mechanic sets it, not us.
  const premium = P.quote({ mechanicRateCents: 15000, laborHoursLow: 1, laborHoursHigh: 1 });
  eq(premium.effectiveHourlyCents, 15000, 'the platform never caps a mechanic upward');

  // ── Urgent work is exempt from demand pricing. This is the rule most likely
  // to be quietly broken by a later change, so it is asserted directly.
  const hot = { utilization: 1, demandRatio: 4, leadTimeDays: 0, seasonal: 1, observations: 500 };
  const urgent = P.quote({
    mechanicRateCents: 9000, laborHoursLow: 1, laborHoursHigh: 2,
    demandSignals: hot, urgent: true,
  });
  eq(urgent.demand.multiplier, 1, 'a stranded customer is never surged');
  eq(urgent.demand.reason, 'urgent_exempt', 'and the reason is explicit');
  eq(urgent.lines.calloutCents, P.DEFAULTS.calloutCents, 'they meet a flat published call-out instead');
  const routine = P.quote({
    mechanicRateCents: 9000, laborHoursLow: 1, laborHoursHigh: 2,
    demandSignals: hot, urgent: false,
  });
  assert(routine.demand.multiplier > 1, 'the same signals do move a routine booking');
  eq(routine.lines.calloutCents, 0, 'routine work has no call-out fee');

  // ── The customer is not an input. Guard the signature itself: a future
  // change that starts pricing people has to break this test to land.
  const params = P.quote.toString().slice(0, P.quote.toString().indexOf(')'));
  for (const banned of ['customer', 'audience', 'host', 'account', 'device']) {
    assert(!params.includes(banned), `quote() takes no ${banned} parameter`);
  }

  // ── A representative job, end to end. 2.5h at $85, $180 parts, 15 miles.
  const q = P.quote({
    mechanicRateCents: 8500, laborHoursLow: 2, laborHoursHigh: 2.5,
    travelMiles: 15, partsCents: 18000,
  });
  eq(q.outOfRange, false, 'in range');
  eq(q.effectiveHourlyCents, 8500, 'no history means the rate passes through untouched');
  eq(q.lines.laborLowCents, 17000, '2h of labour');
  eq(q.lines.laborHighCents, 21250, '2.5h of labour');
  eq(q.lines.travelCents, 2500, '15 miles is the second band');
  eq(q.lines.partsHandlingCents, 630, 'parts handling is 3.5% of parts');
  eq(q.totalHighCents, 21250 + 2500 + 18000 + 630, 'the total is exactly its lines');

  // The fee is levied on labour and travel, never on the parts pass-through.
  eq(q.platformFeeHighCents, Math.round((21250 + 2500) * 0.10), 'fee excludes parts');
  assert(q.platformFeeHighCents < Math.round(q.totalHighCents * 0.10),
    'taking 10% of the whole ticket would be a different, larger number');

  // ── The minimum job charge protects a short call-out.
  const tiny = P.quote({ mechanicRateCents: 6500, laborHoursLow: 0.25, laborHoursHigh: 0.25 });
  eq(tiny.lines.laborLowCents, P.DEFAULTS.minimumJobCents, 'a 15-minute job still bills the minimum');

  // ── Out of range is reported, not priced.
  const far = P.quote({ mechanicRateCents: 8500, laborHoursLow: 1, laborHoursHigh: 1, travelMiles: 120 });
  eq(far.outOfRange, true, 'beyond the radius is out of range');
  eq(far.totalHighCents, undefined, 'and carries no price at all');

  // ── A backwards estimate is a caller bug, not a silent swap.
  threw = false;
  try { P.quote({ mechanicRateCents: 8500, laborHoursLow: 3, laborHoursHigh: 1 }); }
  catch (e) { threw = true; }
  assert(threw, 'low must not exceed high');

  console.log('\n[test] PRICING — ALL CHECKS PASSED');
} catch (e) {
  failed = true;
  console.error('\n[test] PRICING — FAILED:', e.message);
}
process.exit(failed ? 1 : 0);

// Run: node test/labor.test.js
const L = require('../lib/labor');

function assert(c, m){ if(!c) throw new Error('Assertion failed: ' + m); }
function eq(a,b,m){ assert(a===b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

let failed = false;
try {
  const seed = L.loadSeed();
  assert(seed.length >= 50, `the seed table loaded (${seed.length} services)`);

  // Every row is well formed. A malformed estimate becomes a wrong price.
  for (const r of seed) {
    assert(r.slug && r.name, `${r.slug}: has a slug and a name`);
    assert(Number.isFinite(r.hoursLow) && r.hoursLow > 0, `${r.slug}: low is a positive number`);
    assert(Number.isFinite(r.hoursHigh), `${r.slug}: high is a number`);
    assert(r.hoursLow <= r.hoursHigh, `${r.slug}: low does not exceed high`);
    assert(['yes','conditional','no'].includes(r.mobileViable), `${r.slug}: viability is a known value`);
    assert(['low','medium','high'].includes(r.confidence), `${r.slug}: confidence is a known value`);
  }

  // The table must actually contain refusals. A seed table where everything is
  // mobile-viable has not thought about the boundary.
  const refused = seed.filter(r => r.mobileViable === 'no');
  assert(refused.length > 0, `some jobs are refused outright (${refused.length})`);
  const conditional = seed.filter(r => r.mobileViable === 'conditional');
  assert(conditional.length > 0, `some jobs need review first (${conditional.length})`);

  // ── Refusal beats estimation.
  const no = L.estimate(refused[0].slug, { index: seed });
  eq(no.bookable, false, 'work that needs a lift is not bookable');
  eq(no.reason, 'not_mobile_viable', 'and it says why');
  eq(no.hoursLow, undefined, 'a refusal carries no estimate at all');

  const unknown = L.estimate('teleportation-swap', { index: seed });
  eq(unknown.bookable, false, 'an unknown service is refused, not guessed');

  // ── Conditional work is bookable but flagged for review — this is where
  // instant booking must not be offered.
  const cond = L.estimate(conditional[0].slug, { index: seed });
  eq(cond.bookable, true, 'conditional work can be booked');
  eq(cond.requiresReview, true, 'but it is flagged for review first');

  // ── With no observations the seed passes through untouched.
  const brakes = seed.find(r => r.mobileViable === 'yes');
  const cold = L.estimate(brakes.slug, { index: seed });
  eq(cold.basis, 'seed', 'no data means the seed is the estimate');
  eq(cold.hoursLow, brakes.hoursLow, 'and it is not perturbed');
  eq(cold.observations, 0, 'with zero observations');

  // ── Shrinkage. One slow job barely moves a high-confidence estimate;
  // a hundred move it most of the way.
  const high = { slug:'x', name:'X', hoursLow:1.0, hoursHigh:2.0, mobileViable:'yes', confidence:'high' };
  const one     = L.blend(high, { n: 1,   meanHours: 5 });
  const hundred = L.blend(high, { n: 100, meanHours: 5 });
  const mid = e => (e.hoursLow + e.hoursHigh) / 2;
  assert(mid(one) < 2.0, 'a single outlier does not rewrite a confident estimate');
  assert(mid(hundred) > 4.0, 'a hundred consistent jobs do');
  assert(mid(hundred) > mid(one), 'evidence accumulates monotonically');

  // Confidence is what decides how hard the seed resists.
  const low = { ...high, confidence: 'low' };
  assert(mid(L.blend(low, { n: 3, meanHours: 5 })) > mid(L.blend(high, { n: 3, meanHours: 5 })),
    'a low-confidence seed yields to evidence faster than a high-confidence one');

  // ── The band narrows with evidence but never collapses to a point.
  const tight = L.blend(high, { n: 500, meanHours: 1.5, stdevHours: 0.01 });
  assert(tight.hoursHigh > tight.hoursLow, 'an estimate is always a range, never a point');
  assert(tight.hoursLow > 0, 'and never negative');

  // ── Basis is reported honestly.
  eq(L.blend(high, {}).basis, 'seed', 'no data is seed');
  eq(L.blend(high, { n: 3, meanHours: 2 }).basis, 'blended', 'a little data is blended');
  eq(L.blend(high, { n: 40, meanHours: 2 }).basis, 'observed', 'a lot of data is observed');

  // ── CSV parsing handles the quoted commas the source notes are full of.
  const cells = L.parseCsvLine('a,"b, with comma","he said ""hi""",d');
  eq(cells.length, 4, 'quoted commas do not split a field');
  eq(cells[1], 'b, with comma', 'the comma survives');
  eq(cells[2], 'he said "hi"', 'escaped quotes unescape');

  console.log(`\n[test] LABOR — ALL CHECKS PASSED (${seed.length} services, ${refused.length} refused, ${conditional.length} conditional)`);
} catch (e) {
  failed = true;
  console.error('\n[test] LABOR — FAILED:', e.message);
}
process.exit(failed ? 1 : 0);

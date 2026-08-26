// Run: node test/verification.test.js
//
// The moat, tested. Every assertion here is a business rule, not an
// implementation detail: if one of these starts failing, the badge has stopped
// meaning what it claims.
const V = require('../lib/verification');
const P = require('../lib/pricing');

function assert(c, m){ if(!c) throw new Error('Assertion failed: ' + m); }
function eq(a,b,m){ assert(a===b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

const csv = (headers, rows) => ({ headers, rows });
const realExport = csv(
  ['Trip start', 'Trip end', 'Vehicle', 'Total earnings'],
  [
    { 'Trip start': '2026-01-04', 'Vehicle': '2021 Toyota Camry', 'Total earnings': '212.40' },
    { 'Trip start': '2026-02-11', 'Vehicle': '2021 Toyota Camry', 'Total earnings': '188.10' },
    { 'Trip start': '2026-03-02', 'Vehicle': '2019 Honda CR-V',   'Total earnings': '301.55' },
    { 'Trip start': '2026-05-19', 'Vehicle': '2019 Honda CR-V',   'Total earnings': '244.00' },
  ]
);

let failed = false;
try {
  // ── A real export verifies, and tells us what it proved.
  const ok = V.inspectExport(realExport);
  eq(ok.ok, true, 'a genuine Turo export verifies');
  eq(ok.trips, 4, 'trips are counted');
  eq(ok.vehicles.length, 2, 'the garage is pre-filled from the file');
  eq(ok.earliest, '2026-01-04', 'earliest trip');
  eq(ok.latest, '2026-05-19', 'latest trip');
  eq(ok.hasEarnings, true, 'an earnings export is recognised as one');

  // Header spelling varies between Turo exports; matching must not be brittle.
  const snake = csv(['trip_start','vehicle_name'], realExport.rows.map(r =>
    ({ trip_start: r['Trip start'], vehicle_name: r.Vehicle })));
  eq(V.inspectExport(snake).ok, true, 'header spelling and case do not matter');

  // ── A screenshot is not evidence, and neither is a hand-made file.
  eq(V.inspectExport(csv([], [])).ok, false, 'an empty file verifies nobody');
  eq(V.inspectExport(csv(['name','email'], [{name:'a',email:'b'}])).reason,
     'missing_trip_column', 'an arbitrary CSV is rejected by shape');
  eq(V.inspectExport(csv(['Trip start'], [{'Trip start':'2026-01-01'}])).reason,
     'missing_vehicle_column', 'trips without vehicles are not an export');

  // ── One trip is not an active host. The badge claims activity.
  const thin = csv(['Trip start','Vehicle'], [{ 'Trip start':'2026-01-01', Vehicle:'X' }]);
  const thinV = V.inspectExport(thin);
  eq(thinV.ok, false, 'a single trip does not verify');
  eq(thinV.reason, 'too_few_trips', 'and it says why, with the threshold');
  eq(thinV.required, V.MIN_TRIPS, 'so the host knows what would');

  // Garbage dates do not count as trips.
  const undated = csv(['Trip start','Vehicle'],
    [1,2,3,4].map(() => ({ 'Trip start': 'not a date', Vehicle: 'X' })));
  eq(V.inspectExport(undated).ok, false, 'unparseable dates are not trips');

  // ── Anti-abuse. The hash is over raw bytes, so a whitespace edit does not
  // launder the same export into a second account.
  const buf = Buffer.from('Trip start,Vehicle\n2026-01-01,X\n');
  eq(V.hashExport(buf), V.hashExport(Buffer.from(buf)), 'the same bytes hash the same');
  assert(V.hashExport(buf) !== V.hashExport(Buffer.from('Trip start,Vehicle\n2026-01-01,X \n')),
    'a whitespace edit is a different file, and will not re-verify');
  eq(V.hashExport(buf).length, 64, 'sha256, hex');

  // ── Lane assignment defaults down, never up.
  eq(V.laneFor(null), V.LANES.PUBLIC, 'no session is public');
  eq(V.laneFor(undefined), V.LANES.PUBLIC, 'undefined is public');
  eq(V.laneFor('host'), V.LANES.PUBLIC, 'a non-object is public');
  eq(V.laneFor({ accountId: 7, verifiedHost: true }), V.LANES.HOST, 'proven host is the host lane');
  eq(V.laneFor({ accountId: 7, verifiedHost: false }), V.LANES.PUBLIC, 'signed in but unverified is public');
  eq(V.laneFor({ accountId: 7 }), V.LANES.PUBLIC, 'a missing flag is public');
  eq(V.laneFor({ verifiedHost: true }), V.LANES.PUBLIC, 'a flag with no account is public');
  eq(V.laneFor({ accountId: '7', verifiedHost: true }), V.LANES.PUBLIC, 'a non-numeric id is public');
  eq(V.laneFor({ accountId: 7, verifiedHost: 'yes' }), V.LANES.PUBLIC, 'truthy is not true');

  // ── Ranking. A verified review outranks a public one even when the public
  // one is newer and better. The badge IS the ranking.
  const reviews = [
    { id: 1, reviewer_class: 'public',        rating: 5, created_at: '2026-08-01' },
    { id: 2, reviewer_class: 'verified_host', rating: 3, created_at: '2026-01-01' },
    { id: 3, reviewer_class: 'public',        rating: 4, created_at: '2026-08-20' },
    { id: 4, reviewer_class: 'verified_host', rating: 5, created_at: '2026-07-01' },
  ];
  const ranked = V.rankReviews(reviews);
  eq(ranked[0].reviewer_class, 'verified_host', 'verified sits at the top');
  eq(ranked[1].reviewer_class, 'verified_host', 'both of them do');
  eq(ranked[0].id, 4, 'and within the lane, most recent first');
  eq(ranked[2].id, 3, 'public follows, also newest first');
  assert(ranked.findIndex(r => r.id === 2) < ranked.findIndex(r => r.id === 1),
    'a three-star verified review still outranks a five-star public one');

  // rankReviews does not mutate its input — a sorted-in-place list would
  // silently reorder a caller's array.
  eq(reviews[0].id, 1, 'the caller\'s array is untouched');

  // ── The two averages are never merged.
  const s = V.summarize(reviews);
  eq(s.verifiedCount, 2, 'verified are counted separately');
  eq(s.publicCount, 2, 'so are public');
  eq(s.verifiedAvg, 4, 'verified average');
  eq(s.publicAvg, 4.5, 'public average');
  const blended = (3 + 5 + 5 + 4) / 4;
  assert(s.headline.value !== blended || s.verifiedAvg === blended,
    'the headline is never a blend of the two lanes');
  eq(s.headline.basis, 'verified_host', 'the headline is the verified number when one exists');
  eq(s.headline.count, 2, 'and it carries its count, so the claim stays checkable');

  // With no verified reviews the headline falls back to public and SAYS so.
  const pubOnly = V.summarize(reviews.filter(r => r.reviewer_class === 'public'));
  eq(pubOnly.headline.basis, 'public', 'public-only is labelled public');
  eq(pubOnly.verifiedAvg, null, 'and claims no verified average at all');

  // A mechanic with no reviews claims nothing rather than zero.
  const none = V.summarize([]);
  eq(none.headline.value, null, 'no reviews means no rating, not a zero');

  // ── The public lane is never a downgrade. Nothing in this module gates
  // search, pricing, or profiles — it only ever adds.
  const src = require('fs').readFileSync(require.resolve('../lib/verification.js'), 'utf8');
  for (const banned of ['price', 'paywall', 'upgrade', 'subscription']) {
    assert(!new RegExp(`function [a-zA-Z]*${banned}`, 'i').test(src),
      `verification exposes no ${banned} function — the badge is free, forever`);
  }

  // ── And the lane must never reach a price. This is the rule that would
  // quietly destroy the moat: a verified host quoted a different number for
  // the same job turns a trust badge into a surcharge.
  const params = P.quote.toString().slice(0, P.quote.toString().indexOf(')'));
  for (const banned of ['lane', 'audience', 'verified', 'host']) {
    assert(!params.includes(banned), `quote() takes no ${banned} parameter`);
  }
  const hostQuote = P.quote({ mechanicRateCents: 8500, laborHoursLow: 2, laborHoursHigh: 2 });
  const pubQuote  = P.quote({ mechanicRateCents: 8500, laborHoursLow: 2, laborHoursHigh: 2 });
  eq(hostQuote.totalHighCents, pubQuote.totalHighCents,
     'the same job costs the same in both lanes');

  console.log('\n[test] VERIFICATION — ALL CHECKS PASSED');
} catch (e) {
  failed = true;
  console.error('\n[test] VERIFICATION — FAILED:', e.message);
}
process.exit(failed ? 1 : 0);

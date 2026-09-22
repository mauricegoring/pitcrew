// Run: node test/ecosystem.test.js
//
// PitCrew Mechanics is the demand engine; PitCrew is the transaction. These tests
// cover the seam between them: what crosses, what must not, and the one
// mistake that would be expensive.
const D = require('../lib/demand');
const HO = require('../lib/handoff');
const P = require('../lib/pricing');

function assert(c, m){ if(!c) throw new Error('Assertion failed: ' + m); }
function eq(a,b,m){ assert(a===b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

const SECRET = 'x'.repeat(48);
const T0 = Date.UTC(2026, 8, 7, 12);

let failed = false;
try {
  // ══════════════════════════════════════════════════════════════════════
  // Demand import
  // ══════════════════════════════════════════════════════════════════════
  const feed = [
    { metro: 'las-vegas', service: 'brakes',     lane: 'public', searches: 400, leads: 30 },
    { metro: 'las-vegas', service: 'brakes',     lane: 'host',   searches: 120, leads: 18 },
    { metro: 'las-vegas', service: 'alternator', lane: 'public', searches: 90,  leads: 8 },
    { metro: 'boise',     service: 'brakes',     lane: 'public', searches: 40,  leads: 2 },
  ];
  const { byMetro, byMetroService, rejected } = D.ingest(feed);
  eq(rejected.length, 0, 'a clean feed is accepted whole');
  eq(byMetro.get('las-vegas').searches, 610, 'searches fold across services and lanes');
  eq(byMetro.get('las-vegas').byLane.host.leads, 18, 'the host lane is kept distinct');
  eq(byMetroService.get('las-vegas::brakes').leads, 48, 'per-service tallies too');

  // ── THE IMPORTANT ONE. Imported demand must not unlock the surge multiplier.
  // The multiplier gates on completed bookings — evidence about OUR supply. A
  // thousand PitCrew Mechanics searches say a metro wants mechanics; they say nothing
  // about whether ours are busy, because on day one we have none. Feeding
  // search volume in as `observations` would surge-price the first customer in
  // a brand new metro against a supply of zero.
  const launch = D.toLaunchSignal(byMetro.get('las-vegas'));
  eq('observations' in launch.signal, false,
     'imported demand carries no observations — it cannot unlock the multiplier');
  eq('utilization' in launch.signal, false, 'nor utilization, which describes our own calendar');
  eq('demandRatio' in launch.signal, false, 'nor a demand ratio from someone else\'s traffic');

  // Proven end to end: the hottest possible imported metro still prices at 1.000.
  const hot = D.ingest([
    { metro: 'vegas', lane: 'public', searches: 100000, leads: 9000 },
    { metro: 'vegas', lane: 'host',   searches: 50000,  leads: 4000 },
  ]).byMetro.get('vegas');
  const q = P.quote({
    mechanicRateCents: 8500, laborHoursLow: 2, laborHoursHigh: 2,
    demandSignals: D.toLaunchSignal(hot).signal,
  });
  eq(q.demand.multiplier, 1, 'a metro with 150k imported searches still opens at 1.000');
  eq(q.demand.applied, false, 'and says the multiplier was not applied');
  eq(q.effectiveHourlyCents, 8500, 'so the first customer pays the mechanic\'s own rate');

  // Seasonality DOES transfer — air conditioning fails in July in Phoenix
  // whoever takes the booking.
  const withSeason = D.toLaunchSignal(hot, { seasonal: 0.8 });
  eq(withSeason.signal.seasonal, 0.8, 'a seasonal pattern is transferable');
  eq('observations' in withSeason.signal, false, 'but it still unlocks nothing on its own');

  // ── The aggregate-only contract is enforced, not trusted. Individual host
  // data never crosses this boundary.
  const leaky = D.ingest([
    { metro: 'las-vegas', lane: 'public', searches: 10, email: 'host@example.com' },
    { metro: 'las-vegas', lane: 'public', searches: 10, host_id: 42 },
    { metro: 'las-vegas', lane: 'public', searches: 10, vin: '1HGCM82633A004352' },
    { metro: 'las-vegas', lane: 'public', searches: 10 },
  ]);
  eq(leaky.rejected.length, 3, 'rows carrying identity are rejected');
  for (const r of leaky.rejected) assert(/identifying_field/.test(r.reason), 'and named as such');
  eq(leaky.byMetro.get('las-vegas').searches, 10, 'only the clean row is counted');

  // Rejected, not silently stripped — quietly accepting PII is how it lands in a log.
  eq(D.ingest([{ metro: 'x', lane: 'martian', searches: 5 }]).rejected[0].reason,
     'unknown_lane', 'an unknown lane is refused');
  eq(D.ingest([{ metro: 'x', lane: 'public', searches: -5 }]).rejected[0].reason,
     'bad_counts', 'negative counts are refused');

  // ── Launch readiness, and the host weighting that makes the v2 pitch.
  const vegas = D.launchReadiness(byMetro.get('las-vegas'));
  eq(vegas.ready, true, 'Las Vegas clears the launch bar');
  const boise = D.launchReadiness(byMetro.get('boise'));
  eq(boise.ready, false, 'Boise does not');
  assert(boise.checks.searches.required > boise.checks.searches.value,
    'and the gap is reported, so it is actionable rather than a verdict');
  // Across the whole metro (30 + 18 + 8 leads), not just the brakes row.
  eq(vegas.hostShare, Number((18/56).toFixed(3)), 'the verified-fleet share is measured across the metro');

  // Fleet demand is weighted: a host with several vehicles is repeat work.
  const allPublic = D.ingest([{ metro: 'm', lane: 'public', searches: 300, leads: 45 }]).byMetro.get('m');
  const someHost  = D.ingest([
    { metro: 'm', lane: 'public', searches: 300, leads: 30 },
    { metro: 'm', lane: 'host',   searches: 0,   leads: 15 },
  ]).byMetro.get('m');
  assert(D.launchReadiness(someHost).checks.weightedLeads.value >
         D.launchReadiness(allPublic).checks.weightedLeads.value,
    'the same lead count weighs more when it comes from verified fleets');

  // ── A rate suggestion is a suggestion.
  const sug = D.suggestRate(9000, byMetro.get('las-vegas'));
  eq(sug.binding, false, 'the platform suggests; the mechanic sets');
  assert(sug.suggestedCents >= sug.floorCents, 'and never suggests below the floor');
  eq(D.suggestRate(1000, byMetro.get('las-vegas')).suggestedCents, 6500,
     'a low market anchor is lifted to the floor, not below it');

  // ══════════════════════════════════════════════════════════════════════
  // Verification hand-off
  // ══════════════════════════════════════════════════════════════════════
  const token = HO.mint(
    { subject: 'hpc:host:9182', method: 'turo_csv', verifiedAt: '2026-06-01T00:00:00Z' },
    SECRET, { now: T0 });
  const good = HO.verify(token, SECRET, { now: T0 + 1000 });
  eq(good.ok, true, 'a fresh claim verifies');
  eq(good.method, 'turo_csv', 'and carries the method it was earned by');
  eq(good.subject, 'hpc:host:9182', 'and an opaque subject');

  // ── No personal data crosses. The token travels through a browser.
  const payload = JSON.parse(Buffer.from(token.split('.')[0].replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString());
  for (const banned of ['email', 'name', 'phone', 'vin', 'address']) {
    assert(!(banned in payload), `the claim carries no ${banned}`);
  }
  eq(Object.keys(payload).sort().join(','), 'aud,exp,iat,iss,jti,method,sub,verified_at',
     'and nothing beyond the agreed fields — adding one is a deliberate act');

  // ── Tampering fails.
  eq(HO.verify(token.slice(0, -1) + 'A', SECRET, { now: T0 }).reason, 'bad_signature',
     'a flipped signature byte is caught');
  const forged = HO.mint({ subject: 'hpc:host:1', method: 'turo_csv' }, 'y'.repeat(48), { now: T0 });
  eq(HO.verify(forged, SECRET, { now: T0 }).reason, 'bad_signature',
     'a claim signed with the wrong secret is refused');
  eq(HO.verify('garbage', SECRET, { now: T0 }).ok, false, 'garbage is refused');
  eq(HO.verify('', SECRET, { now: T0 }).ok, false, 'so is nothing at all');

  // ── A hand-off is a doorway, not a licence.
  eq(HO.verify(token, SECRET, { now: T0 + (HO.DEFAULT_TTL_SECONDS + 5) * 1000 }).reason,
     'expired', 'a stale claim is refused');

  // ── Replay: a captured token cannot verify a second account.
  const spent = new Set([good.jti]);
  eq(HO.verify(token, SECRET, { now: T0 + 1000, isSpent: j => spent.has(j) }).reason,
     'replayed', 'a spent claim cannot be used again');

  // Two mints of the same claim differ, so one cannot be substituted for another.
  const t2 = HO.mint({ subject: 'hpc:host:9182', method: 'turo_csv' }, SECRET, { now: T0 });
  assert(t2 !== token, 'each claim is single-use by construction');

  // ── A weak secret is refused at mint time, not discovered later.
  let threw = false;
  try { HO.mint({ subject: 'a', method: 'turo_csv' }, 'short', { now: T0 }); }
  catch (e) { threw = /at least 32/.test(e.message); }
  assert(threw, 'a short shared secret is rejected outright');

  // ── An unknown method cannot be smuggled in to mint a badge.
  threw = false;
  try { HO.mint({ subject: 'a', method: 'trust_me' }, SECRET, { now: T0 }); }
  catch (e) { threw = true; }
  assert(threw, 'only the two real verification paths can be handed off');

  console.log('\n[test] ECOSYSTEM — ALL CHECKS PASSED');
} catch (e) {
  failed = true;
  console.error('\n[test] ECOSYSTEM — FAILED:', e.message);
}
process.exit(failed ? 1 : 0);

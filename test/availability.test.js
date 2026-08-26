// Run: node test/availability.test.js
const A = require('../lib/availability');
const MIN = A.MIN;

function assert(c, m){ if(!c) throw new Error('Assertion failed: ' + m); }
function eq(a,b,m){ assert(a===b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

// A fixed Monday 00:00 UTC so every instant below is readable arithmetic.
const DAY0 = Date.UTC(2026, 8, 7);
const at = (day, h, m = 0) => DAY0 + day*24*60*MIN + h*60*MIN + m*MIN;

// Two points ~6 miles apart in Las Vegas, and one far away.
const SHOP   = { lat: 36.1699, lng: -115.1398 };
const NEARBY = { lat: 36.1146, lng: -115.1728 };
const FAR    = { lat: 36.0395, lng: -114.9817 };

let failed = false;
try {
  // ── Interval algebra, the foundation everything else rests on.
  eq(A.mergeIntervals([{start:0,end:10},{start:5,end:20}]).length, 1, 'overlapping merge');
  eq(A.mergeIntervals([{start:0,end:10},{start:10,end:20}]).length, 1, 'touching merge');
  eq(A.mergeIntervals([{start:0,end:10},{start:11,end:20}]).length, 2, 'a real gap survives');
  eq(A.mergeIntervals([{start:5,end:5}]).length, 0, 'a zero-width interval is not an interval');

  const holed = A.subtract([{start:0,end:100}], [{start:40,end:60}]);
  eq(holed.length, 2, 'subtracting the middle leaves two pieces');
  eq(holed[0].end, 40, 'first piece ends at the cut');
  eq(holed[1].start, 60, 'second piece starts after it');
  eq(A.subtract([{start:0,end:100}], [{start:0,end:100}]).length, 0, 'a full cover leaves nothing');
  eq(A.subtract([{start:0,end:100}], [{start:200,end:300}]).length, 1, 'a disjoint cut changes nothing');

  // ── Travel estimates are conservative by construction.
  const near = A.travelMinutes(SHOP, NEARBY, { at: at(0, 13) });
  assert(near >= A.DEFAULTS.minTravelMinutes, 'never below the floor — loading up costs time');
  const far = A.travelMinutes(SHOP, FAR, { at: at(0, 13) });
  assert(far > near, 'further is longer');
  const peak = A.travelMinutes(SHOP, FAR, { at: at(0, 8) });
  const offPeak = A.travelMinutes(SHOP, FAR, { at: at(0, 13) });
  assert(peak > offPeak, 'rush hour costs more than midday');
  eq(A.travelMinutes(null, NEARBY), A.DEFAULTS.minTravelMinutes, 'unknown origin falls back to the floor');

  // ── The core case: an empty day yields slots on the grid.
  const openDay = [{ start: at(0, 8), end: at(0, 17) }];
  const slots = A.generateSlots({
    openBays: openDay, bookings: [], site: NEARBY, base: SHOP,
    durationMinutes: 120, now: at(-1, 12),
  });
  assert(slots.length > 0, 'an empty day is bookable');
  for (const s of slots) {
    eq((s.start - at(0,0)) % (30*MIN), 0, 'every slot starts on the half hour');
    eq(s.end - s.start, 120*MIN, 'every slot is the requested length');
    assert(s.end <= at(0,17), 'no slot runs past close');
  }
  assert(slots.length <= A.DEFAULTS.maxSlotsPerDay, 'the day is not flooded with options');

  // ── Advance notice. A booking two hours out is not offered.
  const rushed = A.generateSlots({
    openBays: openDay, site: NEARBY, base: SHOP,
    durationMinutes: 60, now: at(0, 8),
  });
  for (const s of rushed) {
    assert(s.start >= at(0, 8) + A.DEFAULTS.advanceNoticeMinutes*MIN,
      'nothing inside the advance-notice window');
  }

  // ── The travel shadow. This is the property that separates this from a
  // rental calendar: a committed job blocks more than its own duration.
  const booking = { start: at(0, 12), end: at(0, 13), site: FAR };
  const shadow = A.travelShadow(booking);
  assert(shadow.start < booking.start, 'the drive in is blocked too');
  assert(shadow.end > booking.end, 'so is teardown afterwards');

  const around = A.generateSlots({
    openBays: openDay, bookings: [booking], site: NEARBY, base: SHOP,
    durationMinutes: 60, now: at(-1, 12),
  });
  for (const s of around) {
    const overlapsJob = s.start < booking.end && s.end > booking.start;
    assert(!overlapsJob, 'no slot overlaps the committed job');
    const overlapsShadow = s.start < shadow.end && s.end > shadow.start;
    assert(!overlapsShadow, 'and none overlaps its travel shadow either');
  }

  // A naive implementation that subtracted only [start,end) would offer the
  // slot ending exactly at the job's start. Assert that specific slot is gone.
  const flush = around.find(s => s.end === booking.start);
  eq(flush, undefined, 'the slot flush against a job is not offered');

  // ── Per-day caps.
  const busyDay = [
    { start: at(0, 8),  end: at(0, 9),  site: NEARBY },
    { start: at(0, 10), end: at(0, 11), site: NEARBY },
    { start: at(0, 12), end: at(0, 13), site: NEARBY },
    { start: at(0, 14), end: at(0, 15), site: NEARBY },
  ];
  const capped = A.generateSlots({
    openBays: openDay, bookings: busyDay, site: NEARBY, base: SHOP,
    durationMinutes: 60, now: at(-1, 12),
  });
  eq(capped.length, 0, 'a day already at the job cap offers nothing more');

  // ── Wrench-hour cap, independent of job count.
  const longJob = [{ start: at(0, 8), end: at(0, 16), site: NEARBY }];
  const tired = A.generateSlots({
    openBays: [{ start: at(0,8), end: at(0,23) }], bookings: longJob,
    site: NEARBY, base: SHOP, durationMinutes: 120, now: at(-1, 12),
  });
  eq(tired.length, 0, 'an eight-hour job exhausts the day even at one job');

  // ── A slot must be reachable from the previous job AND leave time for the
  // next one. A far-away job right after a candidate slot rules it out.
  const sandwich = A.generateSlots({
    openBays: openDay,
    bookings: [{ start: at(0, 11), end: at(0, 12), site: FAR }],
    site: NEARBY, base: SHOP, durationMinutes: 60, now: at(-1, 12),
  });
  for (const s of sandwich) {
    const out = A.travelMinutes(NEARBY, FAR, { at: s.end });
    if (s.end <= at(0, 11)) {
      assert(s.end + out*MIN <= at(0, 11), 'a slot before a job leaves time to drive to it');
    }
  }

  // ── Blackouts remove time outright.
  const off = A.generateSlots({
    openBays: openDay, blackouts: [{ start: at(0,0), end: at(0,23) }],
    site: NEARBY, base: SHOP, durationMinutes: 60, now: at(-1, 12),
  });
  eq(off.length, 0, 'a blacked-out day offers nothing');

  // ── A job longer than the working day is simply not bookable.
  const huge = A.generateSlots({
    openBays: openDay, site: NEARBY, base: SHOP,
    durationMinutes: 10 * 60, now: at(-1, 12),
  });
  eq(huge.length, 0, 'a job that cannot fit is not offered');

  // ── Horizon.
  const far2 = A.generateSlots({
    openBays: [{ start: at(60, 8), end: at(60, 17) }],
    site: NEARBY, base: SHOP, durationMinutes: 60, now: at(0, 8),
  });
  eq(far2.length, 0, 'beyond the booking horizon nothing is offered');

  // ── Caller errors are loud.
  let threw = false;
  try { A.generateSlots({ openBays: openDay, durationMinutes: 0, now: at(0,8) }); }
  catch (e) { threw = true; }
  assert(threw, 'a zero-length job is a caller bug');

  console.log('\n[test] AVAILABILITY — ALL CHECKS PASSED');
} catch (e) {
  failed = true;
  console.error('\n[test] AVAILABILITY — FAILED:', e.message);
}
process.exit(failed ? 1 : 0);

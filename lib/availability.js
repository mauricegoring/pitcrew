'use strict';

/**
 * Slot generation.
 *
 * A bookable slot is a residue, not a lookup. It is what survives after
 * subtracting, from a mechanic's declared working hours: blackouts, the jobs
 * already committed, and — the part that makes this different from renting a
 * car — the driving between them.
 *
 * A rental asset sits still, so its calendar is one dimension. A mechanic's
 * next job is only feasible if they can get there from the last one's
 * driveway, which makes feasibility depend on the customer's address. So slots
 * are computed per request rather than precomputed per mechanic.
 *
 * Pure and I/O-free: the caller supplies the committed timeline, this module
 * does the arithmetic. That keeps the hard part testable without a database
 * and without a routing API.
 *
 * All instants are epoch milliseconds, UTC. Wall-clock working hours are the
 * caller's job to expand (see expandOpenBays) so daylight-saving transitions
 * resolve by construction rather than by arithmetic on offsets.
 */

const MIN = 60 * 1000;

const DEFAULTS = {
  gridMinutes: 30,          // Slots start on the half hour. Nobody books 10:07.
  minTravelMinutes: 20,     // Even a short hop costs loading up and parking.
  teardownMinutes: 15,      // Tools away, invoice, photos.
  advanceNoticeMinutes: 120,
  horizonDays: 21,
  maxJobsPerDay: 4,
  maxWrenchMinutesPerDay: 8 * 60,
  detourFactor: 1.35,       // Straight-line miles are not road miles.
  peakMph: 22,
  offPeakMph: 34,
  maxSlotsPerDay: 4,        // Four good options beat eighteen indistinguishable ones.
};

const EARTH_MILES = 3958.8;

function haversineMiles(a, b) {
  if (!a || !b) return null;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_MILES * Math.asin(Math.min(1, Math.sqrt(s)));
}

function isPeak(ms, tzOffsetMinutes = 0) {
  const h = new Date(ms + tzOffsetMinutes * MIN).getUTCHours();
  return (h >= 7 && h < 10) || (h >= 16 && h < 19);
}

/**
 * Estimated driving time between two points.
 *
 * v1 is deliberately a straight-line estimate inflated by a per-metro detour
 * factor. It is wrong across water, bridges and freeway-versus-surface — but
 * it is wrong CONSERVATIVELY, over-reserving rather than under-reserving, so a
 * mechanic is late less often than they are idle. Swap in a routing matrix
 * behind this signature; nothing else needs to change.
 */
function travelMinutes(from, to, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  if (!from || !to) return cfg.minTravelMinutes;
  const miles = haversineMiles(from, to);
  if (miles == null) return cfg.minTravelMinutes;
  const mph = isPeak(opts.at || 0, opts.tzOffsetMinutes || 0) ? cfg.peakMph : cfg.offPeakMph;
  const minutes = (miles * cfg.detourFactor) / mph * 60;
  return Math.max(cfg.minTravelMinutes, Math.round(minutes));
}

/** Merge overlapping or touching intervals. */
function mergeIntervals(intervals) {
  const sorted = intervals
    .filter(i => i && i.end > i.start)
    .sort((a, b) => a.start - b.start);
  const out = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ start: i.start, end: i.end });
  }
  return out;
}

/** Subtract a set of busy intervals from a set of open ones. */
function subtract(open, busy) {
  const blocks = mergeIntervals(busy);
  let result = open.map(o => ({ ...o }));
  for (const b of blocks) {
    const next = [];
    for (const o of result) {
      if (b.end <= o.start || b.start >= o.end) { next.push(o); continue; }
      if (b.start > o.start) next.push({ ...o, start: o.start, end: b.start });
      if (b.end   < o.end)   next.push({ ...o, start: b.end,   end: o.end });
    }
    result = next;
  }
  return result.filter(o => o.end > o.start);
}

/**
 * The travel shadow of a committed job.
 *
 * A booking occupies more of the day than its duration: the drive in beforehand
 * and the teardown after. Subtracting only [start, end) is the classic way to
 * produce a calendar that looks bookable and is not.
 */
function travelShadow(booking, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const driveIn = booking.driveInMinutes ?? cfg.minTravelMinutes;
  return {
    start: booking.start - driveIn * MIN,
    end: booking.end + cfg.teardownMinutes * MIN,
  };
}

/**
 * Generate bookable slots.
 *
 * @param {object} input
 * @param {Array<{start:number,end:number}>} input.openBays  working hours as UTC instants
 * @param {Array<{start:number,end:number}>} [input.blackouts]
 * @param {Array<{start:number,end:number,site?:{lat,lng},driveInMinutes?:number}>} [input.bookings]
 * @param {{lat:number,lng:number}} [input.site]   where the customer's vehicle is
 * @param {{lat:number,lng:number}} [input.base]   where the mechanic starts the day
 * @param {number} input.durationMinutes           estimated wrench time
 * @param {number} input.now
 * @param {object} [opts]
 */
function generateSlots(input, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const {
    openBays = [], blackouts = [], bookings = [],
    site = null, base = null, durationMinutes, now,
  } = input;

  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    throw new Error('durationMinutes is required');
  }
  if (!Number.isFinite(now)) throw new Error('now is required');

  const earliest = now + cfg.advanceNoticeMinutes * MIN;
  const latest   = now + cfg.horizonDays * 24 * 60 * MIN;

  // Committed work removes its travel shadow, not just its duration.
  const busy = [
    ...blackouts,
    ...bookings.map(b => travelShadow(b, cfg)),
  ];
  const free = subtract(mergeIntervals(openBays), busy);

  // Day keys let the per-day caps apply without a calendar library.
  const dayOf = ms => Math.floor(ms / (24 * 60 * MIN));
  const jobsPerDay = new Map();
  const wrenchPerDay = new Map();
  for (const b of bookings) {
    const d = dayOf(b.start);
    jobsPerDay.set(d, (jobsPerDay.get(d) || 0) + 1);
    wrenchPerDay.set(d, (wrenchPerDay.get(d) || 0) + (b.end - b.start) / MIN);
  }

  const grid = cfg.gridMinutes * MIN;
  const need = durationMinutes * MIN;
  const perDay = new Map();
  const slots = [];

  for (const window of free) {
    let t = Math.ceil(Math.max(window.start, earliest) / grid) * grid;
    for (; t + need <= window.end; t += grid) {
      if (t > latest) break;
      const day = dayOf(t);

      if ((jobsPerDay.get(day) || 0) >= cfg.maxJobsPerDay) continue;
      if ((wrenchPerDay.get(day) || 0) + durationMinutes > cfg.maxWrenchMinutesPerDay) continue;
      if ((perDay.get(day) || 0) >= cfg.maxSlotsPerDay) continue;

      // Can the mechanic actually get here from wherever they were before?
      const prior = bookings
        .filter(b => b.end <= t && dayOf(b.start) === day)
        .sort((a, b) => b.end - a.end)[0];
      const origin = prior ? (prior.site || base) : base;
      const drive = travelMinutes(origin, site, { ...cfg, at: t });
      if (t - drive * MIN < window.start) continue;

      // And get to whatever is committed after it?
      const nextUp = bookings
        .filter(b => b.start >= t + need)
        .sort((a, b) => a.start - b.start)[0];
      if (nextUp) {
        const out = travelMinutes(site, nextUp.site || base, { ...cfg, at: t + need });
        if (t + need + out * MIN > nextUp.start) continue;
      }

      slots.push({
        start: t,
        end: t + need,
        driveInMinutes: drive,
        durationMinutes,
      });
      perDay.set(day, (perDay.get(day) || 0) + 1);
    }
  }

  return slots.sort((a, b) => a.start - b.start);
}

module.exports = {
  DEFAULTS, MIN,
  haversineMiles, travelMinutes, mergeIntervals, subtract,
  travelShadow, generateSlots,
};

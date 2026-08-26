'use strict';

/**
 * Labour estimates.
 *
 * A quote is (labour hours x rate) + parts, so the hours decide the price. The
 * seed table is hand-curated with per-row confidence; the long-term source is
 * our own completed jobs, and `blend` is how one becomes the other.
 *
 * Two rules the trade forces on us:
 *
 *  1. An estimate is a RANGE. A repair quoted to the minute is a promise the
 *     work cannot keep. A customer told "2 to 3 hours" is not surprised by
 *     2h40m; one told "2 hours" is.
 *  2. Some jobs are not mobile work at all. Anything needing a lift, a press
 *     or a hoist is refused and referred, not quoted optimistically and
 *     discovered on arrival. `mobile_viable` is a hard gate.
 */

const fs = require('fs');
const path = require('path');

// How much a seed estimate is worth, expressed as the number of real
// observations it counts for. A high-confidence row takes more evidence to
// move than a guess does — which is what stops the first slow job in a metro
// from rewriting the estimate for everyone.
const PRIOR_WEIGHT = { high: 12, medium: 6, low: 2 };

function parseCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i+1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function loadSeed(file = path.join(__dirname, '..', 'data', 'labor-times.csv')) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map(l => {
    const cells = parseCsvLine(l);
    const row = Object.fromEntries(headers.map((h, i) => [h, cells[i]]));
    return {
      slug: row.service_slug,
      name: row.service_name,
      hoursLow: Number(row.hours_low),
      hoursHigh: Number(row.hours_high),
      mobileViable: row.mobile_viable,
      confidence: row.confidence,
      sourceNote: row.source_note,
    };
  });
}

/**
 * Blend a seed estimate with observed wrench time.
 *
 * Empirical-Bayes shrinkage: the observed mean pulls the estimate toward
 * itself in proportion to how much of it there is, against a prior weighted by
 * how much the seed row is worth. With no observations the seed is returned
 * unchanged; with many, the seed all but disappears.
 *
 * @param {{hoursLow:number,hoursHigh:number,confidence:string}} seed
 * @param {{n:number,meanHours:number,stdevHours?:number}} observed
 */
function blend(seed, observed = {}) {
  const n = Number(observed.n || 0);
  if (!n || !Number.isFinite(observed.meanHours)) {
    return { ...seed, basis: 'seed', observations: 0 };
  }
  const w = PRIOR_WEIGHT[seed.confidence] ?? PRIOR_WEIGHT.medium;
  const seedMid = (seed.hoursLow + seed.hoursHigh) / 2;
  const mid = (w * seedMid + n * observed.meanHours) / (w + n);

  // The band narrows as evidence accumulates, but never collapses to a point:
  // the same job on a rusted ten-year-old car is genuinely slower, and a range
  // is the honest way to say so.
  const seedSpread = (seed.hoursHigh - seed.hoursLow) / 2;
  const observedSpread = Number.isFinite(observed.stdevHours) ? observed.stdevHours : seedSpread;
  const spread = Math.max(
    0.15 * mid,
    (w * seedSpread + n * observedSpread) / (w + n)
  );

  return {
    ...seed,
    hoursLow:  Number(Math.max(0.1, mid - spread).toFixed(2)),
    hoursHigh: Number((mid + spread).toFixed(2)),
    basis: n >= 12 ? 'observed' : 'blended',
    observations: n,
  };
}

/**
 * Estimate for a service, or a refusal.
 *
 * Returns `{ bookable: false }` rather than a price when the work does not
 * belong in a driveway. Refusing a job is cheaper than sending a mechanic to
 * discover they cannot do it.
 */
function estimate(slug, { seed = null, observed = {}, index = null } = {}) {
  const table = index || loadSeed();
  const row = seed || (Array.isArray(table) ? table.find(r => r.slug === slug) : table[slug]);
  if (!row) return { bookable: false, reason: 'unknown_service', slug };
  if (row.mobileViable === 'no') {
    return { bookable: false, reason: 'not_mobile_viable', slug, name: row.name };
  }
  const est = blend(row, observed);
  return {
    bookable: true,
    slug: row.slug,
    name: row.name,
    hoursLow: est.hoursLow,
    hoursHigh: est.hoursHigh,
    basis: est.basis,
    observations: est.observations,
    confidence: row.confidence,
    // 'conditional' work is bookable but needs the vehicle confirmed first —
    // it is where instant booking must not be offered.
    requiresReview: row.mobileViable === 'conditional',
  };
}

module.exports = { PRIOR_WEIGHT, loadSeed, blend, estimate, parseCsvLine };

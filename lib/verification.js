'use strict';

/**
 * Turo host verification, and the two lanes it creates.
 *
 * Anyone can book a mechanic. Anyone who has actually paid for a job can review
 * one. But a GOLD-BADGED review comes only from an account proven to be a real,
 * active Turo host, and the proof is their own Turo data — never a checkbox, a
 * screenshot, or a support ticket.
 *
 * That is the whole moat. Any competitor can list mechanics; none can show what
 * fleet operators think, because none can prove who the fleet operators are.
 *
 * Rules that live here because they are logic, not storage:
 *
 *  - Verification is free and instant. There is no price, no tier, and no
 *    upsell in this file, and there must never be one. The reward — the badge
 *    and the pre-filled garage — IS the acquisition hook.
 *  - A screenshot is not evidence. Only a parseable export, or a live account
 *    link, verifies anyone.
 *  - One export verifies one identity, forever. The hash is the anti-abuse
 *    floor, and it is checked against every account, not just this one.
 *  - The public lane is never a downgrade. Nothing here gates search, price
 *    ranges, or profiles. The badge ADDS; it does not withhold.
 */

const crypto = require('crypto');

const LANES = { PUBLIC: 'public', HOST: 'host' };
const CLASSES = { PUBLIC: 'public', VERIFIED: 'verified_host' };

// A real Turo export names its columns. These are the ones a genuine trips or
// earnings export carries; a hand-made CSV that happens to have three columns
// should not verify anyone.
const REQUIRED_ANY = [
  ['trip start', 'start date', 'trip_start', 'start'],
  ['vehicle', 'car', 'vehicle name', 'listing'],
];
const EARNINGS_HINTS = ['earnings', 'payout', 'total earned', 'net earnings'];

// Below this, an export is not evidence of an active host — it is evidence of
// someone who tried Turo once. Active hosting is what the badge claims.
const MIN_TRIPS = 3;

/**
 * Content hash of an uploaded export.
 *
 * Over the RAW BYTES, deliberately. Normalising first — trimming, lowercasing,
 * re-serialising — would let the same export through twice under two accounts
 * after a whitespace edit, which is exactly the abuse this is here to stop.
 */
function hashExport(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

/**
 * Decide whether an upload is a real Turo export, and what it proves.
 *
 * Returns a verdict rather than throwing: a host whose file was rejected needs
 * to be told which part failed, not handed a stack trace.
 *
 * @param {{headers: string[], rows: object[]}} parsed
 * @returns {{ok: boolean, reason?: string, trips?: number, vehicles?: string[], earliest?: string, latest?: string}}
 */
function inspectExport(parsed) {
  const headers = (parsed.headers || []).map(normalizeHeader);
  if (!headers.length) return { ok: false, reason: 'no_headers' };

  const findCol = (candidates) => headers.find(h => candidates.some(c => h.includes(c)));
  const tripCol    = findCol(REQUIRED_ANY[0]);
  const vehicleCol = findCol(REQUIRED_ANY[1]);

  if (!tripCol)    return { ok: false, reason: 'missing_trip_column' };
  if (!vehicleCol) return { ok: false, reason: 'missing_vehicle_column' };

  const rows = (parsed.rows || []).map(r => {
    const out = {};
    for (const [k, v] of Object.entries(r)) out[normalizeHeader(k)] = v;
    return out;
  });

  const dated = rows
    .map(r => new Date(r[tripCol]))
    .filter(d => !Number.isNaN(d.getTime()))
    .sort((a, b) => a - b);

  if (dated.length < MIN_TRIPS) {
    return { ok: false, reason: 'too_few_trips', trips: dated.length, required: MIN_TRIPS };
  }

  const vehicles = [...new Set(
    rows.map(r => String(r[vehicleCol] || '').trim()).filter(Boolean)
  )];
  if (!vehicles.length) return { ok: false, reason: 'no_vehicles' };

  return {
    ok: true,
    trips: dated.length,
    vehicles,
    earliest: dated[0].toISOString().slice(0, 10),
    latest: dated[dated.length - 1].toISOString().slice(0, 10),
    hasEarnings: headers.some(h => EARNINGS_HINTS.some(e => h.includes(e))),
  };
}

/**
 * Which lane a request belongs to.
 *
 * Defaults down, never up. An unknown, malformed, or half-loaded session is
 * public — the badge is only ever granted by positive evidence.
 */
function laneFor(session) {
  if (!session || typeof session !== 'object') return LANES.PUBLIC;
  return session.verifiedHost === true && Number.isInteger(session.accountId)
    ? LANES.HOST : LANES.PUBLIC;
}

/**
 * Order reviews for display.
 *
 * Verified-host reviews sort above public ones, always, regardless of recency
 * or rating. A five-star public review does not outrank a three-star verified
 * one: the badge is the ranking, and burying it under a nicer review defeats
 * the point of having it.
 */
function rankReviews(reviews) {
  return [...reviews].sort((a, b) => {
    const av = a.reviewer_class === CLASSES.VERIFIED ? 0 : 1;
    const bv = b.reviewer_class === CLASSES.VERIFIED ? 0 : 1;
    if (av !== bv) return av - bv;
    return new Date(b.created_at) - new Date(a.created_at);
  });
}

/**
 * Summarise a mechanic's ratings.
 *
 * Returns TWO averages and refuses to produce a blended one. A single star
 * number would hide which lane it came from, and hiding that is the only thing
 * that could make the badge worthless. Callers wanting "the rating" get the
 * verified average when it exists, with its count, so the claim stays checkable.
 */
function summarize(reviews) {
  const pick = cls => reviews.filter(r => r.reviewer_class === cls);
  const avg = rs => rs.length
    ? Number((rs.reduce((a, r) => a + r.rating, 0) / rs.length).toFixed(2))
    : null;

  const verified = pick(CLASSES.VERIFIED);
  const pub = pick(CLASSES.PUBLIC);

  return {
    verifiedCount: verified.length,
    verifiedAvg: avg(verified),
    publicCount: pub.length,
    publicAvg: avg(pub),
    // The headline, and what it is. Never a merge of the two.
    headline: verified.length
      ? { value: avg(verified), basis: CLASSES.VERIFIED, count: verified.length }
      : { value: avg(pub),      basis: CLASSES.PUBLIC,   count: pub.length },
  };
}

module.exports = {
  LANES, CLASSES, MIN_TRIPS,
  hashExport, inspectExport, laneFor, rankReviews, summarize, normalizeHeader,
};

'use strict';

/**
 * Verification hand-off between HostPitCrew and PitCrew.
 *
 * These are two surfaces of one product, not two products. A host who proved
 * they are a real Turo host on HostPitCrew must not be asked to prove it again
 * here — asking twice is how an ecosystem becomes two apps that happen to share
 * a logo.
 *
 * A claim is a short-lived, signed statement: "the bearer verified as a Turo
 * host on HostPitCrew at this time, by this method." PitCrew trusts it because
 * it is signed with a shared secret, and only for a few minutes.
 *
 * Deliberate choices:
 *
 *  - The claim carries NO personal data. A subject reference and a method, and
 *    nothing else. The two systems share identity, not databases, and a token
 *    that travels through a browser must not carry a host's email.
 *  - It expires in minutes, not days. A hand-off is a doorway, not a licence.
 *  - Every claim has a single-use id, so a captured token cannot be replayed
 *    into a second account — the same anti-abuse rule as the export hash, at a
 *    different layer.
 *  - Signature comparison is constant-time. A byte-by-byte compare on a
 *    security token leaks its contents to anyone patient enough to measure.
 */

const crypto = require('crypto');

const DEFAULT_TTL_SECONDS = 300;
const ISSUER = 'hostpitcrew';
const AUDIENCE = 'pitcrew';

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function sign(payloadB64, secret) {
  return b64url(crypto.createHmac('sha256', secret).update(payloadB64).digest());
}

/**
 * Mint a hand-off claim. Called on the HostPitCrew side.
 *
 * @param {object} claim
 * @param {string} claim.subject   opaque reference to the verified host
 * @param {string} claim.method    'turo_csv' | 'fk_command_center'
 * @param {string} claim.verifiedAt ISO timestamp of the original verification
 * @param {string} secret          shared HMAC secret
 * @param {object} [opts]
 */
function mint(claim, secret, opts = {}) {
  if (!secret || String(secret).length < 32) {
    throw new Error('hand-off secret must be at least 32 characters');
  }
  const { subject, method, verifiedAt } = claim || {};
  if (!subject) throw new Error('claim needs a subject');
  if (!['turo_csv', 'fk_command_center'].includes(method)) {
    throw new Error(`unknown verification method: ${method}`);
  }

  // Anything not on this list does not travel. Adding a field here is a
  // decision to send it across a trust boundary.
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const payload = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: String(subject),
    method,
    verified_at: verifiedAt || null,
    jti: opts.jti || crypto.randomUUID(),
    iat: now,
    exp: now + (opts.ttlSeconds ?? DEFAULT_TTL_SECONDS),
  };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body, secret)}`;
}

/**
 * Verify a hand-off claim. Called on the PitCrew side.
 *
 * Returns a verdict rather than throwing, and never reveals WHICH check failed
 * to the bearer — the reason is for our logs, not for someone probing.
 *
 * @param {string} token
 * @param {string} secret
 * @param {object} [opts]
 * @param {(jti:string)=>boolean} [opts.isSpent]  replay check
 */
function verify(token, secret, opts = {}) {
  const fail = reason => ({ ok: false, reason });
  if (!token || typeof token !== 'string') return fail('missing_token');

  const dot = token.lastIndexOf('.');
  if (dot < 1) return fail('malformed');
  const body = token.slice(0, dot);
  const provided = token.slice(dot + 1);

  const expected = sign(body, secret);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // Length must match before timingSafeEqual, and comparing lengths first is
  // safe: the length of a signature is not a secret.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return fail('bad_signature');

  let payload;
  try { payload = JSON.parse(unb64url(body).toString('utf8')); }
  catch { return fail('malformed_payload'); }

  if (payload.iss !== ISSUER) return fail('wrong_issuer');
  // Checked explicitly: a token minted for another sibling surface must not be
  // spendable here just because the secret happens to match.
  if (payload.aud !== AUDIENCE) return fail('wrong_audience');

  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (!Number.isFinite(payload.exp) || payload.exp <= now) return fail('expired');
  if (Number.isFinite(payload.iat) && payload.iat > now + 60) return fail('issued_in_future');

  if (typeof opts.isSpent === 'function' && opts.isSpent(payload.jti)) return fail('replayed');

  return {
    ok: true,
    subject: payload.sub,
    method: payload.method,
    verifiedAt: payload.verified_at,
    jti: payload.jti,
  };
}

module.exports = { mint, verify, DEFAULT_TTL_SECONDS, ISSUER, AUDIENCE };

-- ─────────────────────────────────────────────────────────────────────────────
-- 007 — the seam with PitCrew Mechanics.
--
-- PitCrew Mechanics is the demand engine: the SEO surface, the metro x service pages,
-- and the captured searches and leads. PitCrew is the transaction. They are two
-- surfaces of one product, which has two consequences stored here.
--
-- First, a host who proved they are a real Turo host on PitCrew Mechanics is not
-- asked to prove it again. `hostpitcrew` joins the verification methods, and a
-- hand-off claim is spent exactly once.
--
-- Second, imported demand is stored SEPARATELY from anything the pricing engine
-- reads. A metro's PitCrew Mechanics search volume says where to launch; it says
-- nothing about whether our own mechanics are busy, and conflating the two
-- would surge-price the first customer in a brand-new metro against a supply of
-- zero. The separation is physical: nothing in the pricing path joins to these
-- tables.
-- ─────────────────────────────────────────────────────────────────────────────

-- Extend the verification methods rather than adding a parallel table: one
-- badge, three ways to earn it, and a single place to ask whether it is held.
ALTER TABLE host_verifications DROP CONSTRAINT IF EXISTS host_verifications_method_check;
ALTER TABLE host_verifications ADD CONSTRAINT host_verifications_method_check
-- 'hostpitcrew' is the stored method value, not a product name. PitCrew
-- Mechanics was renamed from HostPitCrew on 2026-09-21; this value stayed,
-- because it is already written into rows and already signed into claims on
-- the wire. Renaming it rejects the rows we have. See docs/ECOSYSTEM.md.
  CHECK (method IN ('turo_csv','fk_command_center','hostpitcrew'));

ALTER TABLE host_verifications ADD COLUMN IF NOT EXISTS handoff_jti UUID;
ALTER TABLE host_verifications ADD COLUMN IF NOT EXISTS handoff_subject TEXT;

-- Each path carries its own evidence and cannot borrow another's.
ALTER TABLE host_verifications DROP CONSTRAINT IF EXISTS verification_evidence;
ALTER TABLE host_verifications ADD CONSTRAINT verification_evidence CHECK (
  (method = 'turo_csv'          AND csv_sha256 IS NOT NULL AND fk_account_id IS NULL AND handoff_jti IS NULL) OR
  (method = 'fk_command_center' AND fk_account_id IS NOT NULL AND csv_sha256 IS NULL AND handoff_jti IS NULL) OR
  (method = 'hostpitcrew'       AND handoff_jti IS NOT NULL AND handoff_subject IS NOT NULL
                                AND csv_sha256 IS NULL AND fk_account_id IS NULL)
);

-- A claim is spent once. Same anti-abuse rule as the export hash, one layer up:
-- a token captured in transit cannot be replayed into a second account.
CREATE UNIQUE INDEX IF NOT EXISTS idx_handoff_jti_once
  ON host_verifications (handoff_jti) WHERE handoff_jti IS NOT NULL;
-- And one PitCrew Mechanics identity maps to one PitCrew identity.
CREATE UNIQUE INDEX IF NOT EXISTS idx_handoff_subject_once
  ON host_verifications (handoff_subject) WHERE handoff_subject IS NOT NULL;

-- ── Imported demand ──────────────────────────────────────────────────────────
-- Aggregate only, by contract. No email, no host id, no vehicle: a row is a
-- count, and a count is all PitCrew is entitled to. Individual host data never
-- leaves PitCrew Mechanics's admin surface.
CREATE TABLE IF NOT EXISTS imported_demand (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Provenance stamp, not a name — see the note on `method` above.
  source       TEXT NOT NULL DEFAULT 'hostpitcrew' CHECK (source IN ('hostpitcrew')),
  metro_slug   TEXT NOT NULL,
  service_slug TEXT,
  audience     TEXT NOT NULL CHECK (audience IN ('public','host')),
  period_start DATE NOT NULL,
  period_end   DATE NOT NULL,
  searches     INTEGER NOT NULL DEFAULT 0 CHECK (searches >= 0),
  leads        INTEGER NOT NULL DEFAULT 0 CHECK (leads >= 0),
  imported_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT imported_period CHECK (period_end >= period_start),
  CONSTRAINT imported_unique UNIQUE (source, metro_slug, service_slug, audience, period_start, period_end)
);
CREATE INDEX IF NOT EXISTS idx_imported_metro ON imported_demand (metro_slug, period_end DESC);

-- Launch readiness reads imported demand. Pricing does not. Keeping the two
-- apart in a view makes the boundary something you have to cross deliberately.
CREATE OR REPLACE VIEW metro_launch_signal AS
SELECT
  metro_slug,
  SUM(searches)                                        AS searches,
  SUM(leads)                                           AS leads,
  SUM(leads) FILTER (WHERE audience = 'host')          AS host_leads,
  SUM(leads) FILTER (WHERE audience = 'public')        AS public_leads,
  -- Fleet demand is repeat work, and weighted accordingly. This is the number
  -- the v2 rate conversation is built on.
  SUM(leads) FILTER (WHERE audience = 'public')
    + 4 * SUM(leads) FILTER (WHERE audience = 'host')  AS weighted_leads,
  MAX(period_end)                                      AS through
FROM imported_demand
GROUP BY metro_slug;

COMMENT ON TABLE imported_demand IS
  'Aggregate counts from PitCrew Mechanics. Never joined into the pricing path: search volume describes interest, not our own supply.';
COMMENT ON VIEW metro_launch_signal IS
  'Where to launch next. Not a pricing input — the demand multiplier gates on completed PitCrew bookings only.';
COMMENT ON COLUMN host_verifications.handoff_jti IS
  'Single-use claim id from PitCrew Mechanics. Unique, so a captured token cannot verify a second account.';

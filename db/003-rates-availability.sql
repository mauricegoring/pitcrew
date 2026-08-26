-- ─────────────────────────────────────────────────────────────────────────────
-- 003 — rates and availability.
--
-- The mechanic sets the rate. The platform stores a floor and a suggestion and
-- never writes the number itself: a platform that sets prices attacks prong A
-- of the ABC test directly, and `is_platform_default` exists so we can prove,
-- per mechanic, who chose it.
--
-- Working hours are stored as WALL CLOCK plus a zone, never as UTC instants.
-- A mechanic who works "8 to 5" works 8 to 5 on both sides of a daylight-saving
-- boundary; storing the instant makes them work 7 to 4 for half the year.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mechanic_rates (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mechanic_id   BIGINT NOT NULL REFERENCES mechanics(id) ON DELETE CASCADE,
  hourly_cents  INTEGER NOT NULL CHECK (hourly_cents >= 6500),
  minimum_job_cents INTEGER NOT NULL DEFAULT 8500 CHECK (minimum_job_cents >= 0),
  -- Opt-in, and bounded by the mechanic's own floor and ceiling. Demand pricing
  -- someone has not agreed to is the platform setting their price.
  dynamic_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  floor_cents   INTEGER,
  ceiling_cents INTEGER,
  is_platform_default BOOLEAN NOT NULL DEFAULT FALSE,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_to   TIMESTAMPTZ,
  CONSTRAINT rate_band CHECK (
    floor_cents IS NULL OR ceiling_cents IS NULL OR floor_cents <= ceiling_cents
  )
);
-- One live rate per mechanic. A partial unique index rather than a plain one,
-- because history rows (effective_to set) must be allowed to pile up.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_current_rate
  ON mechanic_rates (mechanic_id) WHERE effective_to IS NULL;

-- Recurring working hours: "open bays". dow 0 = Sunday.
CREATE TABLE IF NOT EXISTS open_bays (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mechanic_id BIGINT NOT NULL REFERENCES mechanics(id) ON DELETE CASCADE,
  dow         SMALLINT NOT NULL CHECK (dow BETWEEN 0 AND 6),
  opens_at    TIME NOT NULL,
  closes_at   TIME NOT NULL,
  CONSTRAINT bay_order CHECK (opens_at < closes_at),
  CONSTRAINT bay_unique UNIQUE (mechanic_id, dow, opens_at)
);

-- Date-specific closures: holidays, illness, a day already spoken for.
CREATE TABLE IF NOT EXISTS blackouts (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mechanic_id BIGINT NOT NULL REFERENCES mechanics(id) ON DELETE CASCADE,
  span        TSTZRANGE NOT NULL,
  reason      TEXT,
  EXCLUDE USING gist (mechanic_id WITH =, span WITH &&)
);

COMMENT ON COLUMN mechanic_rates.is_platform_default IS
  'TRUE only when the mechanic accepted the suggested rate unchanged. Evidence, per mechanic, of who chose the number.';
COMMENT ON TABLE open_bays IS
  'Wall-clock hours plus the metro IANA zone. Never UTC instants — DST would silently shift the working day.';

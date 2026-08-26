-- ─────────────────────────────────────────────────────────────────────────────
-- 001 — bounded taxonomies.
--
-- Metros and services are deliberately small, curated sets rather than free
-- text. Every downstream aggregate (which metro is ready, what a service costs
-- here, where supply is thin) is only as good as the vocabulary underneath it,
-- and a free-text service field turns "brakes" into forty spellings.
--
-- Labour times live here too, because an estimate is a property of a service,
-- not of a mechanic. Seeded from a hand-curated table with per-row confidence;
-- refined later from our own completed jobs.
-- ─────────────────────────────────────────────────────────────────────────────

-- Required by the exclusion constraints in 003 and 004. A GiST index cannot
-- compare a bigint for equality without it, so `mechanic_id WITH =` inside an
-- EXCLUDE clause fails outright. Supabase and RDS both ship it; a bare
-- PostgreSQL needs contrib installed.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS metros (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  state       TEXT NOT NULL,
  timezone    TEXT NOT NULL,          -- IANA. Never an offset: offsets do not survive DST.
  centroid_lat NUMERIC(9,6),
  centroid_lng NUMERIC(9,6),
  active      BOOLEAN NOT NULL DEFAULT FALSE,   -- A metro is dark until supply exists.
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS services (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,
  -- The product boundary, per service. Some work simply cannot be done in a
  -- driveway — anything needing a lift, a press, or a hoist. Storing it here
  -- means the platform can refuse a job rather than let a mechanic discover it
  -- on arrival.
  mobile_viable TEXT NOT NULL DEFAULT 'yes'
    CHECK (mobile_viable IN ('yes','conditional','no')),
  requires_diagnosis BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Labour estimates as a RANGE, never a point. A repair quoted to the minute is
-- a promise the trade cannot keep, and a customer told "2 to 3 hours" is not
-- surprised by 2h40m. `confidence` records how much the seed row is worth;
-- `observations` grows as real jobs land and is what eventually replaces it.
CREATE TABLE IF NOT EXISTS labor_times (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  service_id   BIGINT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  hours_low    NUMERIC(4,2) NOT NULL CHECK (hours_low  > 0),
  hours_high   NUMERIC(4,2) NOT NULL CHECK (hours_high > 0),
  confidence   TEXT NOT NULL DEFAULT 'medium' CHECK (confidence IN ('low','medium','high')),
  observations INTEGER NOT NULL DEFAULT 0 CHECK (observations >= 0),
  source_note  TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT labor_times_range CHECK (hours_low <= hours_high),
  CONSTRAINT labor_times_service_unique UNIQUE (service_id)
);

CREATE INDEX IF NOT EXISTS idx_services_mobile ON services (mobile_viable);
CREATE INDEX IF NOT EXISTS idx_metros_active   ON metros (active) WHERE active;

COMMENT ON COLUMN metros.timezone IS
  'IANA zone name. Working hours are stored as wall clock and converted through this, so DST resolves by construction.';
COMMENT ON COLUMN services.mobile_viable IS
  'yes = routine driveway work; conditional = depends on vehicle or site; no = refuse and refer to a shop.';
COMMENT ON TABLE labor_times IS
  'Seeded estimates, replaced over time by observed wrench time. Always a range.';

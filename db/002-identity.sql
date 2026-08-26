-- ─────────────────────────────────────────────────────────────────────────────
-- 002 — identity.
--
-- Every primary key is GENERATED ALWAYS AS IDENTITY. The database assigns ids,
-- not the application: a max(id)+1 read into process memory is a primary-key
-- race the moment more than one writer exists, and a marketplace where
-- mechanics sign themselves up always has more than one writer.
--
-- The supply side starts EMPTY. There is no seeded or imported mechanic,
-- because a listing that cannot take a booking is worse than no listing — it
-- is a dead end wearing the brand. A mechanic exists here only after they have
-- set a rate, declared hours, and connected a payout account.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS accounts (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         TEXT NOT NULL,
  email_verified_at TIMESTAMPTZ,
  password_hash TEXT,
  full_name     TEXT,
  phone         TEXT,
  role          TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','mechanic','admin')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Case-insensitive uniqueness. Storing the address as typed but matching
-- folded is the difference between one account and two.
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_email ON accounts (lower(email));

CREATE TABLE IF NOT EXISTS mechanics (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id    BIGINT NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE RESTRICT,
  business_name TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  bio           TEXT,
  home_metro_id BIGINT REFERENCES metros(id),
  base_lat      NUMERIC(9,6),
  base_lng      NUMERIC(9,6),
  service_radius_miles INTEGER NOT NULL DEFAULT 25
    CHECK (service_radius_miles BETWEEN 1 AND 100),

  -- Readiness is derived, never asserted. A mechanic is only listable when
  -- every one of these is true, and the partial index below is what search
  -- reads. Nothing here can be set by the mechanic alone.
  rate_set_at        TIMESTAMPTZ,
  availability_set_at TIMESTAMPTZ,
  payouts_enabled_at TIMESTAMPTZ,
  vetted_at          TIMESTAMPTZ,
  suspended_at       TIMESTAMPTZ,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Insurance is tracked as documents with real coverage lines and a real expiry,
-- not as a boolean. A single `insurance_verified` flag reads TRUE on a General
-- Liability certificate — which excludes damage to the customer's vehicle in
-- the mechanic's care, custody and control, i.e. the most common claim in this
-- trade. Naming the lines is the whole point.
CREATE TABLE IF NOT EXISTS mechanic_insurance (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mechanic_id   BIGINT NOT NULL REFERENCES mechanics(id) ON DELETE CASCADE,
  carrier       TEXT NOT NULL,
  policy_number TEXT NOT NULL,
  has_general_liability     BOOLEAN NOT NULL DEFAULT FALSE,
  has_garagekeepers         BOOLEAN NOT NULL DEFAULT FALSE,
  has_completed_operations  BOOLEAN NOT NULL DEFAULT FALSE,
  each_occurrence_cents BIGINT,
  effective_on  DATE NOT NULL,
  expires_on    DATE NOT NULL,
  document_url  TEXT,
  verified_at   TIMESTAMPTZ,
  verified_by   BIGINT REFERENCES accounts(id),
  CONSTRAINT insurance_dates CHECK (expires_on > effective_on)
);
CREATE INDEX IF NOT EXISTS idx_insurance_expiry ON mechanic_insurance (mechanic_id, expires_on DESC);

CREATE TABLE IF NOT EXISTS mechanic_metros (
  mechanic_id BIGINT NOT NULL REFERENCES mechanics(id) ON DELETE CASCADE,
  metro_id    BIGINT NOT NULL REFERENCES metros(id)    ON DELETE CASCADE,
  PRIMARY KEY (mechanic_id, metro_id)
);

CREATE TABLE IF NOT EXISTS mechanic_services (
  mechanic_id BIGINT NOT NULL REFERENCES mechanics(id) ON DELETE CASCADE,
  service_id  BIGINT NOT NULL REFERENCES services(id)  ON DELETE CASCADE,
  PRIMARY KEY (mechanic_id, service_id)
);

CREATE TABLE IF NOT EXISTS vehicles (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id  BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  vin         TEXT,
  year        INTEGER CHECK (year BETWEEN 1900 AND 2100),
  make        TEXT,
  model       TEXT,
  trim        TEXT,
  -- Where the decode came from. A listing-derived decoder infers drivetrain and
  -- transmission from marketplace copy and gets them wrong; only an
  -- authoritative decode may reach a price.
  decode_source TEXT CHECK (decode_source IN ('vpic','manual','enrichment')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Search only ever asks for mechanics who can actually take a job today, so
-- readiness is baked into the index rather than re-derived per query.
CREATE INDEX IF NOT EXISTS idx_mechanics_listable ON mechanics (home_metro_id)
  WHERE rate_set_at IS NOT NULL
    AND availability_set_at IS NOT NULL
    AND payouts_enabled_at IS NOT NULL
    AND vetted_at IS NOT NULL
    AND suspended_at IS NULL;

COMMENT ON TABLE mechanic_insurance IS
  'Coverage lines, not a boolean. Garagekeepers and completed-operations are the ones that pay when this trade goes wrong; General Liability excludes both.';
COMMENT ON INDEX idx_mechanics_listable IS
  'A mechanic is listable only with a rate, hours, payouts, and vetting. Search reads this index.';

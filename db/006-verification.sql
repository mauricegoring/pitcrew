-- ─────────────────────────────────────────────────────────────────────────────
-- 006 — the two lanes.
--
-- Anyone can use PitCrew. Anyone can review a mechanic they actually paid. But
-- a GOLD-BADGED review comes only from an account proven to be a real, active
-- Turo host — proven by their own Turo data, never by a checkbox.
--
-- That is the moat. Any competitor can list mechanics; none of them can show
-- you what fleet operators think, because none of them can prove who the fleet
-- operators are.
--
-- Four rules are enforced here rather than in application code, because a rule
-- that lives only in a handler is one refactor away from being a suggestion:
--
--  1. A review requires a COMPLETED booking. No paid job, no review. In a
--     directory this floor was a captured lead; in a marketplace it is money
--     that changed hands, which is strictly harder to fake.
--  2. A reviewer's class is stamped by the database from their verification
--     state at the time of writing, never supplied by the client. Gold cannot
--     be claimed.
--  3. A CSV can be used once, ever. The hash is unique across all accounts, so
--     one export cannot verify a second identity.
--  4. Verification is free and instant, and nothing here has a price. The
--     reward IS the hook.
--
-- What is deliberately absent: any path from `audience` to a price. Lane is a
-- demand-signal dimension and a ranking input. A verified host must never be
-- quoted a different number than the public for the same job.
-- ─────────────────────────────────────────────────────────────────────────────

-- How an account proved it. Two paths, one badge.
CREATE TABLE IF NOT EXISTS host_verifications (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id    BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  method        TEXT NOT NULL CHECK (method IN ('turo_csv','fk_command_center')),

  -- Anti-abuse, from day one. A Turo export verifies exactly one account: the
  -- hash is unique across the whole table, so re-uploading the same file under
  -- a second identity fails at the database rather than at a code review.
  csv_sha256    TEXT UNIQUE,
  csv_filename  TEXT,
  -- What the parse actually found. Recorded so a verification can be audited
  -- later without keeping the file itself.
  trips_found   INTEGER,
  vehicles_found INTEGER,
  earliest_trip DATE,
  latest_trip   DATE,

  fk_account_id TEXT,

  verified_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ,
  revoked_reason TEXT,

  -- Each path carries its own evidence, and cannot borrow the other's.
  CONSTRAINT verification_evidence CHECK (
    (method = 'turo_csv'          AND csv_sha256 IS NOT NULL AND fk_account_id IS NULL) OR
    (method = 'fk_command_center' AND fk_account_id IS NOT NULL AND csv_sha256 IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_verifications_account ON host_verifications (account_id)
  WHERE revoked_at IS NULL;

-- Pre-filled from the CSV or the FK link. Source-tracked, because a vehicle the
-- host typed in is not evidence of anything and must not be treated as such.
CREATE TABLE IF NOT EXISTS host_vehicles (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id    BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  vehicle_id    BIGINT REFERENCES vehicles(id) ON DELETE SET NULL,
  source        TEXT NOT NULL CHECK (source IN ('turo_csv','fk_command_center','manual')),
  verification_id BIGINT REFERENCES host_verifications(id) ON DELETE SET NULL,
  label         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Is this account a verified host right now? A function rather than a column,
-- so revocation takes effect everywhere at once and no cached boolean can
-- disagree with the evidence.
CREATE OR REPLACE FUNCTION is_verified_host(p_account_id BIGINT) RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM host_verifications
     WHERE account_id = p_account_id AND revoked_at IS NULL
  );
$$ LANGUAGE sql STABLE;

CREATE TABLE IF NOT EXISTS reviews (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mechanic_id   BIGINT NOT NULL REFERENCES mechanics(id) ON DELETE CASCADE,
  author_id     BIGINT NOT NULL REFERENCES accounts(id)  ON DELETE RESTRICT,
  -- Rule 1. One review per completed job, and no job means no review.
  booking_id    BIGINT NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE RESTRICT,

  rating        SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body          TEXT,

  -- Rule 2. Stamped by the trigger below from the author's verification state
  -- at the moment of writing. A client that sends 'verified_host' is ignored.
  reviewer_class TEXT NOT NULL DEFAULT 'public'
    CHECK (reviewer_class IN ('public','verified_host')),

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT no_self_review CHECK (author_id IS NOT NULL)
);

-- Rules 1 and 2, enforced. The class is derived, never accepted; the booking
-- must be completed and must belong to the author and the mechanic being
-- reviewed.
CREATE OR REPLACE FUNCTION stamp_review() RETURNS trigger AS $$
DECLARE b RECORD;
BEGIN
  SELECT status, customer_id, mechanic_id INTO b FROM bookings WHERE id = NEW.booking_id;
  IF b IS NULL THEN
    RAISE EXCEPTION 'review references no booking';
  END IF;
  IF b.status <> 'completed' THEN
    RAISE EXCEPTION 'a review requires a completed booking (booking % is %)', NEW.booking_id, b.status;
  END IF;
  IF b.customer_id IS DISTINCT FROM NEW.author_id THEN
    RAISE EXCEPTION 'only the customer on a booking may review it';
  END IF;
  IF b.mechanic_id IS DISTINCT FROM NEW.mechanic_id THEN
    RAISE EXCEPTION 'a review must name the mechanic who did the work';
  END IF;

  -- The badge is derived from evidence, at write time, and never trusted from
  -- the caller. This single line is the moat.
  NEW.reviewer_class := CASE WHEN is_verified_host(NEW.author_id)
                             THEN 'verified_host' ELSE 'public' END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_stamp_review ON reviews;
CREATE TRIGGER trg_stamp_review
  BEFORE INSERT OR UPDATE OF author_id, booking_id, mechanic_id, reviewer_class
  ON reviews FOR EACH ROW EXECUTE FUNCTION stamp_review();

CREATE INDEX IF NOT EXISTS idx_reviews_mechanic ON reviews (mechanic_id, reviewer_class, created_at DESC);

-- The two averages, side by side and never merged. A single blended star
-- rating hides which lane it came from, and hiding that is the one thing that
-- would make the badge worthless.
CREATE OR REPLACE VIEW mechanic_ratings AS
SELECT
  m.id AS mechanic_id,
  COUNT(*) FILTER (WHERE r.reviewer_class = 'verified_host')                AS verified_count,
  ROUND(AVG(r.rating) FILTER (WHERE r.reviewer_class = 'verified_host'), 2) AS verified_avg,
  COUNT(*) FILTER (WHERE r.reviewer_class = 'public')                       AS public_count,
  ROUND(AVG(r.rating) FILTER (WHERE r.reviewer_class = 'public'), 2)        AS public_avg
FROM mechanics m LEFT JOIN reviews r ON r.mechanic_id = m.id
GROUP BY m.id;

-- The demand signal carries its lane. Public volume proves a metro is worth a
-- mechanic's time; verified-host volume proves it is worth their best rate.
-- An unsegmented signal is a weaker negotiation.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'public';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_audience_check') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_audience_check
      CHECK (audience IN ('public','host'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS searches (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  visitor_id  TEXT NOT NULL,
  account_id  BIGINT REFERENCES accounts(id) ON DELETE SET NULL,
  metro_id    BIGINT REFERENCES metros(id),
  service_id  BIGINT REFERENCES services(id),
  result_count INTEGER NOT NULL DEFAULT 0,
  audience    TEXT NOT NULL DEFAULT 'public' CHECK (audience IN ('public','host')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_searches_lane ON searches (audience, metro_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookings_lane ON bookings (audience, metro_id, created_at DESC);

COMMENT ON FUNCTION is_verified_host IS
  'Derived from live evidence so a revocation takes effect everywhere at once. Never cache this as a column.';
COMMENT ON COLUMN reviews.reviewer_class IS
  'Stamped by trigger from the author verification state at write time. A client cannot claim the badge.';
COMMENT ON VIEW mechanic_ratings IS
  'Two averages, never one. Merging them would hide which lane a rating came from, which is the only thing that makes the badge worth anything.';
COMMENT ON COLUMN host_verifications.csv_sha256 IS
  'Unique across all accounts: one Turo export verifies exactly one identity, forever.';

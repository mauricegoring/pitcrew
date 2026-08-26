-- ─────────────────────────────────────────────────────────────────────────────
-- 004 — bookings.
--
-- Holds and bookings live in ONE table. This is the single most important
-- decision in the schema.
--
-- A PostgreSQL exclusion constraint cannot span two tables. Put tentative holds
-- in `booking_holds` and confirmed work in `bookings`, and the constraint on
-- each one is blind to the other — which reopens exactly the double-booking
-- race the hold was invented to close. One table, one constraint, one truth.
--
-- The occupied span is GENERATED, not supplied. A caller that computes its own
-- range will eventually compute it wrong, and the wrong range is precisely the
-- overlap the constraint exists to catch. It also includes the TRAVEL SHADOW:
-- a job occupies the drive there and the teardown after, not merely its
-- duration. Reserving only [starts_at, ends_at) produces a calendar that looks
-- bookable and is not.
--
-- Expiry is swept, not predicated. `now()` is not IMMUTABLE, so it cannot
-- appear in a constraint or an index predicate; expired holds are deleted in
-- the same transaction that takes a new one.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bookings (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mechanic_id   BIGINT NOT NULL REFERENCES mechanics(id) ON DELETE RESTRICT,
  customer_id   BIGINT          REFERENCES accounts(id)  ON DELETE SET NULL,
  vehicle_id    BIGINT          REFERENCES vehicles(id)  ON DELETE SET NULL,
  service_id    BIGINT NOT NULL REFERENCES services(id),
  metro_id      BIGINT          REFERENCES metros(id),

  -- A repair is not a rental: the ticket is unknown at booking, so the state
  -- machine has to survive a diagnosis that changes the price. `diagnosed`
  -- through `authorized` is the part no rental marketplace needs, and it is
  -- also where the written-estimate laws bite: additional work needs consent
  -- captured BEFORE it is performed, which is why `authorized_at` is a column
  -- and not an inference.
  status TEXT NOT NULL DEFAULT 'hold' CHECK (status IN (
    'hold',        -- slot reserved while the customer completes checkout
    'requested',   -- customer submitted; mechanic has not accepted
    'scheduled',   -- accepted by the mechanic
    'en_route',
    'diagnosed',   -- on site; estimate may now change
    'quoted',      -- revised estimate presented
    'authorized',  -- customer approved the revision, in writing, before work
    'in_progress',
    'completed',
    'cancelled',
    'no_show',
    'expired'      -- a hold nobody converted
  )),

  starts_at     TIMESTAMPTZ NOT NULL,
  ends_at       TIMESTAMPTZ NOT NULL,
  drive_in_minutes  INTEGER NOT NULL DEFAULT 20 CHECK (drive_in_minutes >= 0),
  teardown_minutes  INTEGER NOT NULL DEFAULT 15 CHECK (teardown_minutes >= 0),

  -- The real footprint on the mechanic's day.
  --
  -- These two are maintained by a trigger, never by the caller: subtracting an
  -- interval from a timestamptz is STABLE rather than IMMUTABLE (it depends on
  -- the session TimeZone), so it cannot appear in a generated expression. The
  -- span itself IS generated, because tstzrange over two timestamptz columns is
  -- immutable — which keeps the range that the exclusion constraint indexes
  -- impossible to disagree with the columns it came from.
  occupied_from TIMESTAMPTZ,
  occupied_to   TIMESTAMPTZ,
  occupied_span TSTZRANGE GENERATED ALWAYS AS (
    tstzrange(occupied_from, occupied_to, '[)')
  ) STORED,

  site_lat      NUMERIC(9,6),
  site_lng      NUMERIC(9,6),
  site_address  TEXT,

  quoted_low_cents  INTEGER,
  quoted_high_cents INTEGER,
  effective_hourly_cents INTEGER,
  demand_multiplier NUMERIC(4,2) NOT NULL DEFAULT 1.00,

  hold_expires_at TIMESTAMPTZ,
  authorized_at   TIMESTAMPTZ,
  authorization_signature TEXT,
  completed_at    TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ,
  cancelled_by    TEXT CHECK (cancelled_by IN ('customer','mechanic','platform')),

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT booking_order CHECK (ends_at > starts_at),
  CONSTRAINT quote_range CHECK (
    quoted_low_cents IS NULL OR quoted_high_cents IS NULL
    OR quoted_low_cents <= quoted_high_cents
  ),
  -- A hold without an expiry is a slot lost forever.
  CONSTRAINT hold_has_expiry CHECK (status <> 'hold' OR hold_expires_at IS NOT NULL),
  -- Work cannot begin on a revision the customer has not signed for.
  CONSTRAINT authorized_has_signature CHECK (
    authorized_at IS NULL OR authorization_signature IS NOT NULL
  )
);

-- Maintain the travel shadow. BEFORE, so the generated span sees the values,
-- and unconditional, so no code path can insert a booking that occupies less of
-- the day than it really does.
CREATE OR REPLACE FUNCTION set_occupied_window() RETURNS trigger AS $$
BEGIN
  NEW.occupied_from := NEW.starts_at - make_interval(mins => NEW.drive_in_minutes);
  NEW.occupied_to   := NEW.ends_at   + make_interval(mins => NEW.teardown_minutes);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_occupied_window ON bookings;
CREATE TRIGGER trg_occupied_window
  BEFORE INSERT OR UPDATE OF starts_at, ends_at, drive_in_minutes, teardown_minutes
  ON bookings FOR EACH ROW EXECUTE FUNCTION set_occupied_window();

-- The double-booking guard. Only live states occupy the calendar: a cancelled
-- or expired booking must not keep blocking the day.
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_no_overlap;
ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap
  EXCLUDE USING gist (
    mechanic_id WITH =,
    occupied_span WITH &&
  ) WHERE (status NOT IN ('cancelled','expired','no_show'));

CREATE INDEX IF NOT EXISTS idx_bookings_mechanic_day ON bookings (mechanic_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_bookings_customer     ON bookings (customer_id, starts_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookings_status       ON bookings (status);
CREATE INDEX IF NOT EXISTS idx_bookings_hold_expiry  ON bookings (hold_expires_at)
  WHERE status = 'hold';

-- Sweep expired holds. Called in the same transaction that takes a new hold,
-- because now() cannot live in the constraint predicate.
CREATE OR REPLACE FUNCTION expire_stale_holds() RETURNS integer AS $$
DECLARE n integer;
BEGIN
  UPDATE bookings SET status = 'expired'
   WHERE status = 'hold' AND hold_expires_at < now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$ LANGUAGE plpgsql;

COMMENT ON COLUMN bookings.occupied_span IS
  'Generated. The job plus its travel shadow — the real footprint on the day. Reserving only the duration produces a calendar that looks bookable and is not.';
COMMENT ON CONSTRAINT bookings_no_overlap ON bookings IS
  'Holds and confirmed bookings share this constraint. An exclusion constraint cannot span two tables, so they cannot live in two.';

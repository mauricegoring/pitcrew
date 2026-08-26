-- ─────────────────────────────────────────────────────────────────────────────
-- 005 — money.
--
-- Topology: separate charges and transfers, with manual capture. Destination
-- charges transfer automatically and cannot hold funds, so any dispute-window
-- hold rules them out. The consequence is that the platform fee is never a
-- Stripe object at all — it is simply the money not transferred — which makes
-- THIS LEDGER the only place platform revenue is recorded as revenue. It has
-- to balance, so a trigger enforces that rather than a convention.
--
-- Sales tax is stored, never guessed. Whether labour is taxable varies by
-- state, and a plausible default compounds silently until an audit. Rows in
-- tax_rules carry who reviewed them.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS connect_accounts (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mechanic_id   BIGINT NOT NULL UNIQUE REFERENCES mechanics(id) ON DELETE RESTRICT,
  stripe_account_id TEXT NOT NULL UNIQUE,
  -- Onboarding to RECEIVE money is a materially shorter identity check than
  -- onboarding to accept cards. For a sole proprietor working out of a van,
  -- that difference is conversion.
  payouts_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  requirements_due TEXT[],
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS booking_line_items (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id  BIGINT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN
    ('labor','travel','callout','parts','parts_handling','customer_fee','protection','tax','discount')),
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  -- Parts are a pass-through: they belong to the mechanic, and the platform fee
  -- must never be levied on them.
  billable_to_platform_fee BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_line_items_booking ON booking_line_items (booking_id);

CREATE TABLE IF NOT EXISTS payments (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id    BIGINT NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
  stripe_payment_intent_id TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL CHECK (status IN
    ('requires_capture','captured','partially_refunded','refunded','failed','canceled')),
  authorized_cents INTEGER NOT NULL,
  captured_cents   INTEGER,
  -- Read from the charge, never assumed. The window is not always seven days,
  -- and an authorization that expires unnoticed is an uncollectable job.
  capture_before TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transfers (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id    BIGINT NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
  connect_account_id BIGINT NOT NULL REFERENCES connect_accounts(id),
  stripe_transfer_id TEXT UNIQUE,
  amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
  -- Held until the dispute window closes, then released. Short enough that a
  -- mechanic is not financing us; long enough that a bad repair surfaces first.
  release_after TIMESTAMPTZ NOT NULL,
  released_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refunds (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_id    BIGINT NOT NULL REFERENCES payments(id),
  stripe_refund_id TEXT UNIQUE,
  amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
  reason        TEXT,
  -- Whether the platform gave its fee back too. On a rework we do; on a
  -- customer changing their mind we may not. Recorded either way.
  fee_refunded  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Double-entry. Every movement of money is two or more rows summing to zero.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_group UUID NOT NULL,
  booking_id  BIGINT REFERENCES bookings(id) ON DELETE RESTRICT,
  account     TEXT NOT NULL,
  debit_cents  BIGINT NOT NULL DEFAULT 0 CHECK (debit_cents  >= 0),
  credit_cents BIGINT NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  memo        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A row is a debit or a credit. Both, or neither, is a bug being written down.
  CONSTRAINT one_sided CHECK ((debit_cents = 0) <> (credit_cents = 0))
);
CREATE INDEX IF NOT EXISTS idx_ledger_group   ON ledger_entries (entry_group);
CREATE INDEX IF NOT EXISTS idx_ledger_booking ON ledger_entries (booking_id);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger_entries (account, created_at DESC);

-- Enforce the balance at commit. Deferred so a group can be inserted row by
-- row inside one transaction and still be checked as a whole.
CREATE OR REPLACE FUNCTION assert_ledger_balanced() RETURNS trigger AS $$
DECLARE d BIGINT; c BIGINT;
BEGIN
  SELECT COALESCE(SUM(debit_cents),0), COALESCE(SUM(credit_cents),0)
    INTO d, c FROM ledger_entries WHERE entry_group = NEW.entry_group;
  IF d <> c THEN
    RAISE EXCEPTION 'ledger group % does not balance: debits % != credits %', NEW.entry_group, d, c;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ledger_balanced ON ledger_entries;
CREATE CONSTRAINT TRIGGER trg_ledger_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_ledger_balanced();

CREATE TABLE IF NOT EXISTS tax_rules (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  state       TEXT NOT NULL,
  labor_taxable BOOLEAN NOT NULL,
  parts_taxable BOOLEAN NOT NULL,
  rate_bps    INTEGER NOT NULL CHECK (rate_bps >= 0),
  -- Deliberately unseeded. A guess here is wrong quietly and expensively.
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  CONSTRAINT tax_rules_state_unique UNIQUE (state)
);

COMMENT ON TABLE ledger_entries IS
  'The only record of platform revenue. With separate charges and transfers the fee is not a Stripe object — it is the money not transferred.';
COMMENT ON TABLE tax_rules IS
  'Intentionally empty until a human reviews each state. Labour taxability genuinely varies.';
COMMENT ON COLUMN payments.capture_before IS
  'Read from the Stripe charge. The authorization window is not always seven days.';

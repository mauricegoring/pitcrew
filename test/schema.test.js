// Run: DATABASE_URL=postgres://... node test/schema.test.js
//
// Applies the migrations to a real PostgreSQL and proves the constraints bite.
// A schema whose guarantees were never exercised is a set of intentions.
// Skips without DATABASE_URL so `npm test` works on a machine with no database.

const URL = process.env.DATABASE_URL;
if (!URL) {
  console.log('[test] SCHEMA — SKIPPED (no DATABASE_URL)');
  process.exit(0);
}

const { Client } = require('pg');
const { apply, migrationFiles, ORDER } = require('../scripts/db-apply');

function assert(c, m){ if(!c) throw new Error('Assertion failed: ' + m); }
function eq(a,b,m){ assert(a===b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

const H = h => `2026-09-07T${String(h).padStart(2,'0')}:00:00Z`;

let failed = false;
(async () => {
  const c = new Client({ connectionString: URL });
  try {
    eq(migrationFiles().length, ORDER.length, 'every db/*.sql is declared in ORDER');
    await apply(URL, { quiet: true });
    await apply(URL, { quiet: true });   // idempotent
    await c.connect();

    // ── The supply side starts empty, and stays empty until someone signs up.
    // A seeded mechanic is a listing that cannot take a booking.
    for (const t of ['mechanics', 'accounts', 'bookings', 'connect_accounts']) {
      const { rows } = await c.query(`SELECT count(*)::int n FROM ${t}`);
      eq(rows[0].n, 0, `${t} ships empty`);
    }
    const { rows: tax } = await c.query('SELECT count(*)::int n FROM tax_rules');
    eq(tax[0].n, 0, 'tax_rules is deliberately unseeded — a guess there is expensive');

    // ── Fixtures.
    await c.query('BEGIN');
    await c.query(`INSERT INTO metros (slug,name,state,timezone,active)
                   VALUES ('las-vegas','Las Vegas','NV','America/Los_Angeles',TRUE)`);
    await c.query(`INSERT INTO services (slug,name,category,mobile_viable)
                   VALUES ('brake-pads-front','Front brake pads','brakes','yes'),
                          ('transmission-rr','Transmission R&R','drivetrain','no')`);
    await c.query(`INSERT INTO accounts (email,role) VALUES ('mech@example.com','mechanic')`);
    const { rows: [acct] } = await c.query(`SELECT id FROM accounts LIMIT 1`);
    await c.query(`INSERT INTO mechanics (account_id,business_name,slug)
                   VALUES ($1,'Test Crew','test-crew')`, [acct.id]);
    const { rows: [mech] } = await c.query(`SELECT id FROM mechanics LIMIT 1`);
    const { rows: [svc] }  = await c.query(`SELECT id FROM services WHERE slug='brake-pads-front'`);

    // ── Identity columns. The database assigns ids, so two concurrent writers
    // cannot collide the way a max(id)+1 read into process memory does.
    const { rows: idcols } = await c.query(`
      SELECT table_name, is_identity FROM information_schema.columns
      WHERE table_schema='public' AND column_name='id' AND table_name IN
        ('accounts','mechanics','bookings','ledger_entries','payments','services','metros')`);
    for (const r of idcols) eq(r.is_identity, 'YES', `${r.table_name}.id is a generated identity`);

    // ── Email uniqueness folds case.
    let code = null;
    await c.query('SAVEPOINT p');
    try { await c.query(`INSERT INTO accounts (email) VALUES ('MECH@example.com')`); }
    catch (e) { code = e.code; }
    await c.query('ROLLBACK TO SAVEPOINT p');
    eq(code, '23505', 'the same address in different case is the same account');

    // ── The rate floor is enforced by the database, not only by the app.
    code = null;
    await c.query('SAVEPOINT p');
    try { await c.query(`INSERT INTO mechanic_rates (mechanic_id,hourly_cents) VALUES ($1, 5000)`, [mech.id]); }
    catch (e) { code = e.code; }
    await c.query('ROLLBACK TO SAVEPOINT p');
    eq(code, '23514', 'a rate below the floor is refused');
    await c.query(`INSERT INTO mechanic_rates (mechanic_id,hourly_cents) VALUES ($1, 8500)`, [mech.id]);

    // One live rate per mechanic.
    code = null;
    await c.query('SAVEPOINT p');
    try { await c.query(`INSERT INTO mechanic_rates (mechanic_id,hourly_cents) VALUES ($1, 9000)`, [mech.id]); }
    catch (e) { code = e.code; }
    await c.query('ROLLBACK TO SAVEPOINT p');
    eq(code, '23505', 'a mechanic cannot have two current rates');

    // ── The travel shadow is computed by the database.
    const mk = (h1, h2, status='scheduled') => c.query(
      `INSERT INTO bookings (mechanic_id,service_id,starts_at,ends_at,status,hold_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, occupied_from, occupied_to, starts_at, ends_at`,
      [mech.id, svc.id, H(h1), H(h2), status, status === 'hold' ? H(23) : null]);

    const { rows: [b1] } = await mk(12, 14);
    assert(new Date(b1.occupied_from) < new Date(b1.starts_at), 'the drive in is occupied too');
    assert(new Date(b1.occupied_to)   > new Date(b1.ends_at),   'so is teardown afterwards');

    // ── Double booking. The overlapping case, and — the one a naive schema
    // gets wrong — the case that is flush against it but inside the shadow.
    code = null;
    await c.query('SAVEPOINT p');
    try { await mk(13, 15); } catch (e) { code = e.code; }
    await c.query('ROLLBACK TO SAVEPOINT p');
    eq(code, '23P01', 'an overlapping booking is refused by the exclusion constraint');

    code = null;
    await c.query('SAVEPOINT p');
    try { await mk(14, 15); } catch (e) { code = e.code; }
    await c.query('ROLLBACK TO SAVEPOINT p');
    eq(code, '23P01', 'a booking flush against the last one still collides with its shadow');

    // ── A hold occupies the calendar exactly as a confirmed booking does.
    // This is why holds and bookings share one table: an exclusion constraint
    // cannot span two, so a separate holds table reopens this race.
    code = null;
    await c.query('SAVEPOINT p');
    try { await mk(13, 14, 'hold'); } catch (e) { code = e.code; }
    await c.query('ROLLBACK TO SAVEPOINT p');
    eq(code, '23P01', 'a hold blocks the slot while it is alive');

    // ── A cancelled booking releases the day.
    await c.query(`UPDATE bookings SET status='cancelled', cancelled_at=now(), cancelled_by='customer' WHERE id=$1`, [b1.id]);
    const { rows: [b2] } = await mk(12, 14);
    assert(b2.id, 'the slot is bookable again once cancelled');
    await c.query(`UPDATE bookings SET status='cancelled', cancelled_by='platform' WHERE id=$1`, [b2.id]);

    // ── A hold with no expiry is a slot lost forever.
    code = null;
    await c.query('SAVEPOINT p');
    try {
      await c.query(`INSERT INTO bookings (mechanic_id,service_id,starts_at,ends_at,status)
                     VALUES ($1,$2,$3,$4,'hold')`, [mech.id, svc.id, H(20), H(21)]);
    } catch (e) { code = e.code; }
    await c.query('ROLLBACK TO SAVEPOINT p');
    eq(code, '23514', 'a hold must carry an expiry');

    // ── Work cannot be authorized without a signature. The written-estimate
    // rules require consent captured before the extra work, not after.
    code = null;
    await c.query('SAVEPOINT p');
    try {
      await c.query(`INSERT INTO bookings (mechanic_id,service_id,starts_at,ends_at,status,authorized_at)
                     VALUES ($1,$2,$3,$4,'authorized',now())`, [mech.id, svc.id, H(20), H(21)]);
    } catch (e) { code = e.code; }
    await c.query('ROLLBACK TO SAVEPOINT p');
    eq(code, '23514', 'authorization without a signature is refused');

    // ── The ledger must balance. A deferred constraint trigger, so a group can
    // be written row by row and still be checked as a whole.
    const g = '11111111-1111-1111-1111-111111111111';
    code = null;
    await c.query('SAVEPOINT p');
    try {
      await c.query(`INSERT INTO ledger_entries (entry_group,account,debit_cents) VALUES ($1,'cash:stripe',1000)`, [g]);
      await c.query('RELEASE SAVEPOINT p');
      await c.query('SAVEPOINT q');
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    } catch (e) { code = e.code; }
    assert(code !== null, 'a one-sided ledger group is refused at check time');
    await c.query('ROLLBACK TO SAVEPOINT p').catch(()=>{});

    await c.query('ROLLBACK');

    // A balanced group commits.
    await c.query('BEGIN');
    const g2 = '22222222-2222-2222-2222-222222222222';
    await c.query(`INSERT INTO ledger_entries (entry_group,account,debit_cents) VALUES ($1,'cash:stripe',1000)`, [g2]);
    await c.query(`INSERT INTO ledger_entries (entry_group,account,credit_cents) VALUES ($1,'liability:mechanic',900)`, [g2]);
    await c.query(`INSERT INTO ledger_entries (entry_group,account,credit_cents) VALUES ($1,'revenue:platform_fee',100)`, [g2]);
    await c.query('COMMIT');
    const { rows: [bal] } = await c.query(
      `SELECT SUM(debit_cents)::int d, SUM(credit_cents)::int cr FROM ledger_entries WHERE entry_group=$1`, [g2]);
    eq(bal.d, bal.cr, 'a balanced group commits and stays balanced');
    await c.query('DELETE FROM ledger_entries WHERE entry_group=$1', [g2]);

    // ── A ledger row is a debit or a credit, never both.
    code = null;
    await c.query('BEGIN');
    try {
      await c.query(`INSERT INTO ledger_entries (entry_group,account,debit_cents,credit_cents)
                     VALUES ('33333333-3333-3333-3333-333333333333','x',5,5)`);
    } catch (e) { code = e.code; }
    await c.query('ROLLBACK');
    eq(code, '23514', 'a row cannot be both a debit and a credit');

    console.log('\n[test] SCHEMA — ALL CHECKS PASSED');
  } catch (e) {
    failed = true;
    console.error('\n[test] SCHEMA — FAILED:', e.message);
  } finally {
    try { await c.end(); } catch {}
  }
  process.exit(failed ? 1 : 0);
})();

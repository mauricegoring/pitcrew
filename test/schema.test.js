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

    // ═══════════════════════════════════════════════════════════════════════
    // The moat, at the database level. Application code can be refactored
    // around; these rules cannot.
    // ═══════════════════════════════════════════════════════════════════════
    await c.query('BEGIN');
    // The earlier fixtures were rolled back with their transaction, so this
    // block stands up its own.
    await c.query(`INSERT INTO services (slug,name,category) VALUES ('moat-svc','Moat service','brakes')`);
    await c.query(`INSERT INTO accounts (email,role) VALUES ('moat-mech@example.com','mechanic')`);
    const { rows: [ma] } = await c.query(`SELECT id FROM accounts WHERE email='moat-mech@example.com'`);
    await c.query(`INSERT INTO mechanics (account_id,business_name,slug) VALUES ($1,'Moat Crew','moat-crew')`, [ma.id]);
    const { rows: [mMech] } = await c.query(`SELECT id FROM mechanics WHERE slug='moat-crew'`);
    const { rows: [mSvc] }  = await c.query(`SELECT id FROM services WHERE slug='moat-svc'`);

    await c.query(`INSERT INTO accounts (email,role) VALUES ('cust@example.com','customer'),('hostie@example.com','customer')`);
    const { rows: [cust] } = await c.query(`SELECT id FROM accounts WHERE email='cust@example.com'`);
    const { rows: [host] } = await c.query(`SELECT id FROM accounts WHERE email='hostie@example.com'`);

    const mkDone = async (customerId, h1, h2) => {
      const { rows: [b] } = await c.query(
        `INSERT INTO bookings (mechanic_id,customer_id,service_id,starts_at,ends_at,status)
         VALUES ($1,$2,$3,$4,$5,'completed') RETURNING id`,
        [mMech.id, customerId, mSvc.id, H(h1), H(h2)]);
      return b.id;
    };

    // ── A review requires a COMPLETED booking. In a directory the floor was a
    // captured lead; here money changed hands, which is harder to fake.
    const { rows: [open] } = await c.query(
      `INSERT INTO bookings (mechanic_id,customer_id,service_id,starts_at,ends_at,status)
       VALUES ($1,$2,$3,$4,$5,'scheduled') RETURNING id`,
      [mMech.id, cust.id, mSvc.id, H(6), H(7)]);
    let msg = '';
    await c.query('SAVEPOINT p');
    try {
      await c.query(`INSERT INTO reviews (mechanic_id,author_id,booking_id,rating) VALUES ($1,$2,$3,5)`,
        [mMech.id, cust.id, open.id]);
    } catch (e) { msg = e.message; }
    await c.query('ROLLBACK TO SAVEPOINT p');
    assert(/completed booking/.test(msg), 'no completed job, no review');

    // ── Only the customer on the booking may review it.
    const jobA = await mkDone(cust.id, 8, 9);
    msg = '';
    await c.query('SAVEPOINT p');
    try {
      await c.query(`INSERT INTO reviews (mechanic_id,author_id,booking_id,rating) VALUES ($1,$2,$3,5)`,
        [mMech.id, host.id, jobA]);
    } catch (e) { msg = e.message; }
    await c.query('ROLLBACK TO SAVEPOINT p');
    assert(/only the customer/.test(msg), 'a stranger cannot review someone else\'s job');

    // ── An unverified reviewer is stamped public even when they ask for gold.
    // This is the single most important assertion in the suite: the badge
    // cannot be claimed by the client.
    const { rows: [r1] } = await c.query(
      `INSERT INTO reviews (mechanic_id,author_id,booking_id,rating,reviewer_class)
       VALUES ($1,$2,$3,5,'verified_host') RETURNING reviewer_class`,
      [mMech.id, cust.id, jobA]);
    eq(r1.reviewer_class, 'public', 'claiming the badge does not grant it');

    // ── Verify the other account, and the SAME insert now earns gold —
    // because the evidence exists, not because the request changed.
    await c.query(`INSERT INTO host_verifications (account_id,method,csv_sha256,trips_found,vehicles_found)
                   VALUES ($1,'turo_csv',$2,14,3)`, [host.id, 'a'.repeat(64)]);
    const { rows: [vh] } = await c.query(`SELECT is_verified_host($1) v`, [host.id]);
    eq(vh.v, true, 'the export verified the host');

    const jobB = await mkDone(host.id, 10, 11);
    const { rows: [r2] } = await c.query(
      `INSERT INTO reviews (mechanic_id,author_id,booking_id,rating) VALUES ($1,$2,$3,3)
       RETURNING reviewer_class`, [mMech.id, host.id, jobB]);
    eq(r2.reviewer_class, 'verified_host', 'a proven host earns the badge without asking');

    // ── One export verifies one identity, forever.
    code = null;
    await c.query('SAVEPOINT p');
    try {
      await c.query(`INSERT INTO host_verifications (account_id,method,csv_sha256) VALUES ($1,'turo_csv',$2)`,
        [cust.id, 'a'.repeat(64)]);
    } catch (e) { code = e.code; }
    await c.query('ROLLBACK TO SAVEPOINT p');
    eq(code, '23505', 'the same export cannot verify a second account');

    // ── Each verification path carries its own evidence and cannot borrow.
    code = null;
    await c.query('SAVEPOINT p');
    try {
      await c.query(`INSERT INTO host_verifications (account_id,method) VALUES ($1,'turo_csv')`, [cust.id]);
    } catch (e) { code = e.code; }
    await c.query('ROLLBACK TO SAVEPOINT p');
    eq(code, '23514', 'a CSV verification with no CSV is refused');

    // ── One review per job — no stacking praise on a single booking.
    code = null;
    await c.query('SAVEPOINT p');
    try {
      await c.query(`INSERT INTO reviews (mechanic_id,author_id,booking_id,rating) VALUES ($1,$2,$3,4)`,
        [mMech.id, cust.id, jobA]);
    } catch (e) { code = e.code; }
    await c.query('ROLLBACK TO SAVEPOINT p');
    eq(code, '23505', 'a booking can be reviewed once');

    // ── The two averages stay separate, and the blend is never computed.
    const { rows: [rate] } = await c.query(
      `SELECT * FROM mechanic_ratings WHERE mechanic_id=$1`, [mMech.id]);
    eq(Number(rate.verified_count), 1, 'one verified review');
    eq(Number(rate.public_count), 1, 'one public review');
    eq(Number(rate.verified_avg), 3, 'verified average stands alone');
    eq(Number(rate.public_avg), 5, 'public average stands alone');
    const cols = Object.keys(rate);
    assert(!cols.some(k => /^(overall|combined|blended|rating)_?avg$/.test(k)),
      'the view offers no merged rating to accidentally display');

    // ── Revocation takes effect immediately, everywhere.
    await c.query(`UPDATE host_verifications SET revoked_at=now(), revoked_reason='test' WHERE account_id=$1`, [host.id]);
    const { rows: [gone] } = await c.query(`SELECT is_verified_host($1) v`, [host.id]);
    eq(gone.v, false, 'a revoked verification stops conferring the badge at once');

    // ── The demand signal carries its lane, and admits no third value.
    code = null;
    await c.query('SAVEPOINT p');
    try { await c.query(`UPDATE bookings SET audience='admin' WHERE id=$1`, [jobA]); }
    catch (e) { code = e.code; }
    await c.query('ROLLBACK TO SAVEPOINT p');
    eq(code, '23514', 'a booking lane is public or host, nothing else');

    const { rows: [dflt] } = await c.query(`SELECT audience FROM bookings WHERE id=$1`, [jobA]);
    eq(dflt.audience, 'public', 'and it defaults down, never up');

    await c.query('ROLLBACK');

    // ═══════════════════════════════════════════════════════════════════════
    // The seam with HostPitCrew.
    // ═══════════════════════════════════════════════════════════════════════
    await c.query('BEGIN');
    await c.query(`INSERT INTO accounts (email,role) VALUES ('eco@example.com','customer')`);
    const { rows: [eco] } = await c.query(`SELECT id FROM accounts WHERE email='eco@example.com'`);

    // A host verified on HostPitCrew is verified here, without re-uploading.
    const jti = '44444444-4444-4444-4444-444444444444';
    await c.query(`INSERT INTO host_verifications (account_id,method,handoff_jti,handoff_subject)
                   VALUES ($1,'hostpitcrew',$2,'hpc:host:9182')`, [eco.id, jti]);
    const { rows: [ev] } = await c.query(`SELECT is_verified_host($1) v`, [eco.id]);
    eq(ev.v, true, 'a hand-off from HostPitCrew confers the badge — one product, two surfaces');

    // A captured claim cannot be replayed into a second account.
    await c.query(`INSERT INTO accounts (email,role) VALUES ('eco2@example.com','customer')`);
    const { rows: [eco2] } = await c.query(`SELECT id FROM accounts WHERE email='eco2@example.com'`);
    code = null;
    await c.query('SAVEPOINT p');
    try {
      await c.query(`INSERT INTO host_verifications (account_id,method,handoff_jti,handoff_subject)
                     VALUES ($1,'hostpitcrew',$2,'hpc:host:other')`, [eco2.id, jti]);
    } catch (e) { code = e.code; }
    await c.query('ROLLBACK TO SAVEPOINT p');
    eq(code, '23505', 'a hand-off claim is spent exactly once');

    // And one HostPitCrew identity maps to one PitCrew identity.
    code = null;
    await c.query('SAVEPOINT p');
    try {
      await c.query(`INSERT INTO host_verifications (account_id,method,handoff_jti,handoff_subject)
                     VALUES ($1,'hostpitcrew',gen_random_uuid(),'hpc:host:9182')`, [eco2.id]);
    } catch (e) { code = e.code; }
    await c.query('ROLLBACK TO SAVEPOINT p');
    eq(code, '23505', 'one HostPitCrew host is one PitCrew host');

    // A hand-off cannot borrow another path's evidence.
    code = null;
    await c.query('SAVEPOINT p');
    try {
      await c.query(`INSERT INTO host_verifications (account_id,method,handoff_jti,handoff_subject,csv_sha256)
                     VALUES ($1,'hostpitcrew',gen_random_uuid(),'hpc:host:x',$2)`, [eco2.id, 'b'.repeat(64)]);
    } catch (e) { code = e.code; }
    await c.query('ROLLBACK TO SAVEPOINT p');
    eq(code, '23514', 'each verification path carries only its own evidence');

    // ── Imported demand is aggregate, and stays out of the pricing path.
    await c.query(`INSERT INTO imported_demand (metro_slug,service_slug,audience,period_start,period_end,searches,leads)
                   VALUES ('las-vegas','brakes','public','2026-04-01','2026-06-30',400,30),
                          ('las-vegas','brakes','host','2026-04-01','2026-06-30',120,18)`);
    const { rows: [sig] } = await c.query(`SELECT * FROM metro_launch_signal WHERE metro_slug='las-vegas'`);
    eq(Number(sig.searches), 520, 'imported searches aggregate');
    eq(Number(sig.host_leads), 18, 'the host lane stays distinct');
    eq(Number(sig.weighted_leads), 30 + 4*18, 'fleet demand is weighted for the v2 conversation');

    // The same period cannot be imported twice and double-count.
    code = null;
    await c.query('SAVEPOINT p');
    try {
      await c.query(`INSERT INTO imported_demand (metro_slug,service_slug,audience,period_start,period_end,searches,leads)
                     VALUES ('las-vegas','brakes','public','2026-04-01','2026-06-30',400,30)`);
    } catch (e) { code = e.code; }
    await c.query('ROLLBACK TO SAVEPOINT p');
    eq(code, '23505', 're-importing a period does not double-count it');

    // The boundary, asserted structurally: nothing the pricing path reads
    // touches imported demand.
    const { rows: deps } = await c.query(`
      SELECT DISTINCT cl.relname AS referenced
      FROM pg_depend d
      JOIN pg_rewrite rw ON rw.oid = d.objid
      JOIN pg_class src ON src.oid = rw.ev_class
      JOIN pg_class cl  ON cl.oid = d.refobjid
      WHERE src.relname IN ('mechanic_ratings')`);
    assert(!deps.some(r => r.referenced === 'imported_demand'),
      'no rating or pricing view reads imported demand');

    await c.query('ROLLBACK');

    console.log('\n[test] SCHEMA — ALL CHECKS PASSED');
  } catch (e) {
    failed = true;
    console.error('\n[test] SCHEMA — FAILED:', e.message);
  } finally {
    try { await c.end(); } catch {}
  }
  process.exit(failed ? 1 : 0);
})();

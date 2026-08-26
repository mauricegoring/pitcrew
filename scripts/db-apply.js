#!/usr/bin/env node
'use strict';

/**
 * Apply the SQL migrations, in order, against DATABASE_URL.
 *
 * Order is declared rather than derived. A lexical sort puts 010 before 002,
 * and later files ALTER what earlier ones create, so ordering by accident is
 * ordering by luck. Any .sql in db/ that is not declared here is an error —
 * adding a migration should force a decision about where it runs.
 *
 * Usage: DATABASE_URL=postgres://... node scripts/db-apply.js [--quiet]
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const DB_DIR = path.join(__dirname, '..', 'db');

const ORDER = [
  '001-taxonomy.sql',
  '002-identity.sql',
  '003-rates-availability.sql',
  '004-bookings.sql',
  '005-money.sql',
  '006-verification.sql',
];

function migrationFiles() {
  const onDisk = fs.readdirSync(DB_DIR).filter(f => f.endsWith('.sql')).sort();
  const undeclared = onDisk.filter(f => !ORDER.includes(f));
  const missing = ORDER.filter(f => !onDisk.includes(f));
  if (undeclared.length) {
    throw new Error(
      `db/ has migrations not declared in scripts/db-apply.js ORDER: ${undeclared.join(', ')}. ` +
      'Add them at the position they must run in.'
    );
  }
  if (missing.length) throw new Error(`ORDER references missing files: ${missing.join(', ')}`);
  return ORDER;
}

async function apply(connectionString, { quiet = false } = {}) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    for (const file of migrationFiles()) {
      const sql = fs.readFileSync(path.join(DB_DIR, file), 'utf8');
      try {
        await client.query(sql);
        if (!quiet) console.log('  applied  %s', file);
      } catch (e) {
        throw new Error(`${file}: ${e.message}`);
      }
    }
  } finally {
    await client.end();
  }
}

module.exports = { apply, migrationFiles, ORDER };

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const quiet = process.argv.includes('--quiet');
  apply(url, { quiet })
    .then(() => { if (!quiet) console.log('migrations applied'); })
    .catch(e => { console.error('migration failed —', e.message); process.exit(1); });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.ts';

// A reviewer runs the current code against a database written by an older commit. SQLite cannot add a
// column conditionally, so every column the schema gained is added after SCHEMA runs — which means an
// index on one of those columns must not live in SCHEMA, or the upgrade throws before the ALTER does.
test('a book written before a column existed still opens and gains it', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dw-upgrade-')), 'book.sqlite');
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE evidence_files (id TEXT PRIMARY KEY, invoice_id TEXT, path TEXT, sha256 TEXT, mime TEXT, bytes INTEGER, uploaded_at TEXT);
    CREATE TABLE webhook_events (id TEXT PRIMARY KEY, type TEXT);
    INSERT INTO evidence_files (id, invoice_id, path, sha256, mime, bytes, uploaded_at)
      VALUES ('ev_1', 'inv_1', 'one.txt', '${'a'.repeat(64)}', 'text/plain', 12, '2026-10-30T00:00:00.000Z');
  `);
  legacy.close();

  const db = openDb(file);
  const columns = (db.prepare('PRAGMA table_info(evidence_files)').all() as any[]).map((c) => c.name);
  assert.ok(columns.includes('tracker'), 'the tracker column is added on open');
  assert.deepEqual(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'evidence_files' AND name NOT LIKE 'sqlite_autoindex%'").all() as any[]).map((r) => r.name),
    ['evidence_tracker'],
    'and its index is built after the column exists'
  );
  // The old row survives the upgrade, with nothing invented into its new column.
  assert.deepEqual(
    (db.prepare('SELECT id, tracker FROM evidence_files').all() as any[]).map((r) => [r.id, r.tracker]),
    [['ev_1', null]]
  );

  // Opening the upgraded book a second time must be a no-op, not a second ALTER.
  db.close();
  const again = openDb(file);
  assert.equal((again.prepare('SELECT COUNT(*) n FROM evidence_files').get() as any).n, 1);
  again.close();
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.ts';
import { appendAudit, canonical, hashEntry, verifyChain, GENESIS } from '../src/audit.ts';

test('canonical JSON sorts keys at every depth', () => {
  assert.equal(canonical({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }), '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
  assert.equal(canonical({ a: 1, b: 2 }), canonical({ b: 2, a: 1 }));
});

test('a fresh chain verifies and each row links to the one before it', () => {
  const db = openDb(':memory:');
  const first = appendAudit(db, 'gate', 'inv-1', { verdict: 'VERIFIED', score: 78 }, '2026-10-30T00:00:00Z');
  const second = appendAudit(db, 'price', 'inv-1', { advanceCents: 2_796_450 }, '2026-10-30T00:00:01Z');
  assert.equal(first.prev_hash, GENESIS);
  assert.equal(second.prev_hash, first.hash);
  const check = verifyChain(db);
  assert.equal(check.ok, true);
  assert.equal(check.length, 2);
  assert.equal(check.brokenAt, null);
});

test('editing a payload is detected at the exact entry that was changed', () => {
  const db = openDb(':memory:');
  appendAudit(db, 'gate', 'inv-1', { verdict: 'VERIFIED' }, '2026-10-30T00:00:00Z');
  appendAudit(db, 'price', 'inv-1', { advanceCents: 2_796_450 }, '2026-10-30T00:00:01Z');
  appendAudit(db, 'funding_order', 'inv-1', { orderId: 'O-1' }, '2026-10-30T00:00:02Z');

  // Someone rewrites a refusal into a pass without rehashing.
  db.prepare("UPDATE audit_log SET payload_json = ? WHERE seq = 1").run('{"verdict":"REFUSED"}');

  const check = verifyChain(db);
  assert.equal(check.ok, false);
  assert.equal(check.brokenAt, 1);
  assert.match(check.reason ?? '', /hash does not match the payload/);
});

test('rehashing a rewritten entry still breaks the chain at the next link', () => {
  const db = openDb(':memory:');
  appendAudit(db, 'gate', 'inv-1', { verdict: 'VERIFIED' }, '2026-10-30T00:00:00Z');
  appendAudit(db, 'price', 'inv-1', { advanceCents: 2_796_450 }, '2026-10-30T00:00:01Z');

  const row = db.prepare('SELECT * FROM audit_log WHERE seq = 1').get() as any;
  const forgedPayload = '{"verdict":"REFUSED"}';
  const forgedHash = hashEntry(row.prev_hash, { seq: 1, kind: row.kind, subjectId: row.subject_id, payload: JSON.parse(forgedPayload), at: row.created_at });
  db.prepare('UPDATE audit_log SET payload_json = ?, hash = ? WHERE seq = 1').run(forgedPayload, forgedHash);

  // Entry 1 now looks self-consistent; the forgery surfaces at entry 2, whose prev_hash is stale.
  const check = verifyChain(db);
  assert.equal(check.ok, false);
  assert.equal(check.brokenAt, 2);
  assert.match(check.reason ?? '', /prev_hash/);
});

test('removing an entry from the middle is detected', () => {
  const db = openDb(':memory:');
  appendAudit(db, 'gate', 'inv-1', { verdict: 'VERIFIED' }, '2026-10-30T00:00:00Z');
  appendAudit(db, 'price', 'inv-1', { advanceCents: 1 }, '2026-10-30T00:00:01Z');
  appendAudit(db, 'funding_order', 'inv-1', { orderId: 'O-1' }, '2026-10-30T00:00:02Z');
  db.prepare('DELETE FROM audit_log WHERE seq = 2').run();
  const check = verifyChain(db);
  assert.equal(check.ok, false);
  assert.equal(check.brokenAt, 3);
});

test('the same payload at the same position always produces the same hash', () => {
  const a = hashEntry(GENESIS, { seq: 1, kind: 'gate', subjectId: 'inv-1', payload: { b: 2, a: 1 }, at: '2026-10-30T00:00:00Z' });
  const b = hashEntry(GENESIS, { seq: 1, kind: 'gate', subjectId: 'inv-1', payload: { a: 1, b: 2 }, at: '2026-10-30T00:00:00Z' });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { newId, nowIso } from './db.ts';

export const GENESIS = '0'.repeat(64);

/** Deterministic JSON: sorted keys, no whitespace, so the same payload always hashes the same. */
export function canonical(value: unknown): string {
  const walk = (v: any): any => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
    return out;
  };
  return JSON.stringify(walk(value));
}

export function hashEntry(prevHash: string, payload: unknown): string {
  return crypto.createHash('sha256').update(prevHash).update(canonical(payload)).digest('hex');
}

export interface AuditRow {
  seq: number;
  kind: string;
  subject_id: string;
  payload_json: string;
  prev_hash: string;
  hash: string;
  created_at: string;
}

export function appendAudit(db: DatabaseSync, kind: string, subjectId: string, payload: unknown, when = nowIso()): AuditRow {
  const last = db.prepare('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1').get() as { seq: number; hash: string } | undefined;
  const seq = (last?.seq ?? 0) + 1;
  const prevHash = last?.hash ?? GENESIS;
  const payloadJson = canonical(payload);
  const hash = hashEntry(prevHash, { seq, kind, subjectId, payload: JSON.parse(payloadJson), at: when });
  db.prepare(
    'INSERT INTO audit_log (id, seq, kind, subject_id, payload_json, prev_hash, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(newId('audit'), seq, kind, subjectId, payloadJson, prevHash, hash, when);
  return { seq, kind, subject_id: subjectId, payload_json: payloadJson, prev_hash: prevHash, hash, created_at: when };
}

export interface ChainVerification {
  ok: boolean;
  length: number;
  brokenAt: number | null;
  reason: string | null;
}

export function verifyChain(db: DatabaseSync): ChainVerification {
  const rows = db.prepare('SELECT seq, kind, subject_id, payload_json, prev_hash, hash, created_at FROM audit_log ORDER BY seq ASC').all() as unknown as AuditRow[];
  let prev = GENESIS;
  for (const row of rows) {
    if (row.prev_hash !== prev) return { ok: false, length: rows.length, brokenAt: row.seq, reason: 'prev_hash does not match the previous row' };
    const recomputed = hashEntry(prev, { seq: row.seq, kind: row.kind, subjectId: row.subject_id, payload: JSON.parse(row.payload_json), at: row.created_at });
    if (recomputed !== row.hash) return { ok: false, length: rows.length, brokenAt: row.seq, reason: 'hash does not match the payload' };
    prev = row.hash;
  }
  return { ok: true, length: rows.length, brokenAt: null, reason: null };
}

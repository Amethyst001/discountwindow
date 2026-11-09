/**
 * The webhook intake, separated from the HTTP route so the retry rules can be tested without a
 * network. The rules are the whole point of this file:
 *
 *   - A body with no event id is not an event: 400.
 *   - If the signature cannot be *checked* (no webhook id, network down, PayPal 5xx), answer
 *     non-2xx and store nothing. PayPal resends; a stored "unverified" row would make the retry
 *     look like a duplicate and lose the event forever.
 *   - If PayPal answers that the signature is a definite failure, store the body as evidence and
 *     answer 200. It is a spoof; resending it will not make it genuine.
 *   - A verified event that has already been processed is a duplicate: 200, no second effect.
 *   - A verified event whose processing throws is left unprocessed and answered 503, so the retry
 *     runs it again.
 *   - Unverified rows are capped, oldest first, so a flood of junk cannot grow the book without
 *     limit.
 */
import type { DatabaseSync } from 'node:sqlite';
import { newId, nowIso } from './db.ts';
import { resolveWebhookInvoice, freezeForDispute, releaseFreeze, markCaptureCompleted } from './store.ts';

export type Verification =
  | { kind: 'verified' }
  | { kind: 'failed' }
  | { kind: 'error'; message: string };

export const UNVERIFIED_CAP = 200;

export interface WebhookResult {
  status: number;
  body: string;
}

function capUnverified(db: DatabaseSync): void {
  db.prepare(`
    DELETE FROM webhook_events
     WHERE verified = 0
       AND id IN (SELECT id FROM webhook_events WHERE verified = 0 ORDER BY received_at DESC, rowid DESC LIMIT -1 OFFSET ?)
  `).run(UNVERIFIED_CAP);
}

export function handleWebhook(db: DatabaseSync, opts: {
  event: any;
  raw: string;
  verification: Verification;
}): WebhookResult {
  const event = opts.event;
  const eventId = String(event?.id ?? '').trim();
  if (!eventId) return { status: 400, body: 'missing event id' };

  // Could not ask. Store nothing: the retry must not collide with a row this attempt wrote.
  if (opts.verification.kind === 'error') {
    return { status: 503, body: 'signature verification unavailable; retry' };
  }

  const verified = opts.verification.kind === 'verified';
  const type = String(event.event_type ?? 'UNKNOWN');
  const existing = db.prepare('SELECT id, verified, processed_at FROM webhook_events WHERE event_id = ?').get(eventId) as any;

  // A verified event that already ran is a duplicate. A verified row with no processed_at is a
  // previous attempt that failed mid-way: let it through and try again.
  if (existing?.verified === 1 && existing.processed_at) return { status: 200, body: 'duplicate' };

  let rowId = existing?.id as string | undefined;
  if (existing) {
    db.prepare('UPDATE webhook_events SET type = ?, payload_json = ?, verified = ?, received_at = ? WHERE id = ?')
      .run(type, opts.raw, verified ? 1 : 0, nowIso(), rowId);
  } else {
    rowId = newId('wh');
    db.prepare('INSERT INTO webhook_events (id, event_id, type, payload_json, verified, received_at) VALUES (?,?,?,?,?,?)')
      .run(rowId, eventId, type, opts.raw, verified ? 1 : 0, nowIso());
  }

  if (!verified) {
    capUnverified(db);
    return { status: 200, body: 'unverified, stored' };
  }

  try {
    const resolution = resolveWebhookInvoice(db, event);
    let outcome = 'unmatched';
    if (type === 'CUSTOMER.DISPUTE.CREATED' || type === 'PAYMENT.CAPTURE.REFUNDED' || type === 'PAYMENT.CAPTURE.REVERSED') {
      if (resolution) {
        const freeze = freezeForDispute(db, resolution.invoiceId, { eventId, via: resolution.via, kind: type, reason: event?.resource?.reason ?? null });
        outcome = freeze.frozen ? `froze ${resolution.invoiceId} (${freeze.previousStatus}) via ${resolution.via}` : `already ${freeze.previousStatus}`;
      }
    } else if (type === 'CUSTOMER.DISPUTE.RESOLVED') {
      if (resolution) {
        const release = releaseFreeze(db, resolution.invoiceId, { eventId, via: resolution.via });
        outcome = release.heldForClawback
          ? `held ${resolution.invoiceId} frozen: the capture was clawed back`
          : release.restoredTo
            ? `released ${resolution.invoiceId} to ${release.restoredTo} via ${resolution.via}`
            : `not frozen`;
      }
    } else if (type === 'PAYMENT.CAPTURE.COMPLETED') {
      const settled = markCaptureCompleted(db, String(event?.resource?.id ?? ''));
      outcome = settled > 0
        ? `capture ${event?.resource?.id} cleared on ${settled} funding commitment${settled === 1 ? '' : 's'}`
        : resolution
          ? `capture recorded against ${resolution.invoiceId} via ${resolution.via}; no funding commitment carries it`
          : 'no invoice to match';
    }
    db.prepare('UPDATE webhook_events SET invoice_id = ?, outcome = ? WHERE id = ?')
      .run(resolution?.invoiceId ?? null, outcome, rowId);
    db.prepare('UPDATE webhook_events SET processed_at = ? WHERE event_id = ?').run(nowIso(), eventId);
    return { status: 200, body: 'ok' };
  } catch (err: any) {
    // The row stays verified and unprocessed. PayPal's retry will run it again; the dedupe rule
    // above only skips a row that actually finished.
    db.prepare('UPDATE webhook_events SET outcome = ? WHERE id = ?')
      .run(`processing failed: ${String(err?.message ?? err).slice(0, 200)}`, rowId);
    return { status: 503, body: 'processing failed; retry' };
  }
}

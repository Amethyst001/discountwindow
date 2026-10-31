import test from 'node:test';
import assert from 'node:assert/strict';
import { basicAuthIdentity, roleAllows } from '../src/auth.ts';

const encoded = (s: string) => `Basic ${Buffer.from(s, 'utf8').toString('base64')}`;
const auth = (s: string, pw: string) => basicAuthIdentity(encoded(s), pw);

test('with no password configured the session is the desk', () => {
  assert.deepEqual(basicAuthIdentity(undefined, ''), { ok: true, identity: { role: 'desk', name: 'desk' } });
  assert.equal(auth('anything:whatever', '').identity.role, 'desk');
});

test('the username picks the identity and the password admits the session', () => {
  assert.equal(auth('funder:correct horse', 'correct horse').identity.role, 'funder');
  assert.equal(auth('Seller:correct horse', 'correct horse').identity.role, 'seller');
  assert.equal(auth('funder:wrong', 'correct horse').ok, false);
  // A name that is not one of the four is not a role with a hidden grant. Under a shared password this
  // mattered little; now that a side can hold its own secret, "admin" must not quietly become the desk.
  assert.equal(auth('judge:correct horse', 'correct horse').ok, false);
  assert.equal(auth('desk :correct horse', 'correct horse').identity.role, 'desk');
});

test('a side with its own secret stops accepting the shared one', () => {
  const byRole = { desk: 'desk secret', seller: '', funder: '', debtor: '' };
  assert.equal(basicAuthIdentity(encoded('desk:shared'), 'shared', byRole).ok, false, 'the desk holds its own secret');
  assert.equal(basicAuthIdentity(encoded('desk:desk secret'), 'shared', byRole).identity.role, 'desk');
  // A side left empty keeps the shared password — partial configuration is a rollout, not a lockout.
  assert.equal(basicAuthIdentity(encoded('seller:shared'), 'shared', byRole).identity.role, 'seller');
  // And a side whose own secret is set but handed the shared one is refused, not downgraded.
  assert.equal(basicAuthIdentity(encoded('seller:shared'), 'shared', { ...byRole, seller: 'seller secret' }).ok, false);
  assert.equal(basicAuthIdentity(encoded('seller:seller secret'), 'shared', { ...byRole, seller: 'seller secret' }).identity.role, 'seller');
});

test('a configured demo with no secret for a side does not open that side', () => {
  // DEMO_PASSWORD empty but per-side secrets present: an unlisted side must be refused rather than
  // falling through to the localhost "everyone is the desk" path.
  assert.equal(basicAuthIdentity(encoded('funder:'), '', { desk: 'd', seller: 's', funder: '', debtor: '' }).ok, false);
  assert.equal(basicAuthIdentity(encoded('debtor:x'), '', { desk: 'd', seller: 's', funder: '', debtor: 'x' }).identity.role, 'debtor');
});

test('a missing or malformed header never passes when a password is configured', () => {
  assert.equal(basicAuthIdentity(undefined, 'pw').ok, false);
  assert.equal(basicAuthIdentity('Bearer abc', 'pw').ok, false);
  assert.equal(basicAuthIdentity('Basic !!!not-base64!!!', 'pw').ok, false);
  assert.equal(basicAuthIdentity(encoded(':'), 'pw').ok, false);
});

test('an identity may move money only on its own side of the trade', () => {
  assert.equal(roleAllows('seller', 'submit'), true);
  assert.equal(roleAllows('seller', 'fund'), false);
  assert.equal(roleAllows('seller', 'capture'), false);
  assert.equal(roleAllows('funder', 'fund'), true);
  assert.equal(roleAllows('funder', 'capture'), true);
  assert.equal(roleAllows('funder', 'submit'), false);
  assert.equal(roleAllows('debtor', 'settle'), true);
  assert.equal(roleAllows('debtor', 'fund'), false);
  assert.equal(roleAllows('desk', 'settle'), true);
});

test('the loss side of the book is the desk alone, not either party to the loss', () => {
  // The register export is in this list for the same reason the write-off is: the file names the debtor,
  // the operator and the bytes that went out, and it is the desk's account of its own conduct.
  for (const verb of ['default', 'repurchase', 'write off', 'serve notice', 'export the register']) {
    assert.equal(roleAllows('desk', verb), true);
    assert.equal(roleAllows('seller', verb), false);
    assert.equal(roleAllows('funder', verb), false);
    assert.equal(roleAllows('debtor', verb), false);
  }
});

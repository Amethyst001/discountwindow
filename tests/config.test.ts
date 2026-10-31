import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSandbox, isSandbox, hosts, config } from '../src/config.ts';

const refuses = (base: string) => assert.throws(() => assertSandbox(base), /refusing to start/);

test('the sandbox host is accepted, with any path', () => {
  assert.equal(assertSandbox('https://api-m.sandbox.paypal.com').hostname, hosts.SANDBOX_HOST);
  assert.equal(assertSandbox('https://api-m.sandbox.paypal.com/v2/checkout/orders').hostname, hosts.SANDBOX_HOST);
});

test('production is refused by name, not by pattern', () => {
  refuses('https://api-m.paypal.com');
  refuses('https://www.paypal.com');
  refuses('https://auth.paypal.com');
});

test('a host that merely ends in the sandbox name is refused', () => {
  refuses('https://api-m.sandbox.paypal.com.evil.test');
  refuses('https://not-api-m.sandbox.paypal.com');
  refuses('https://api-m.sandbox.paypal.evil.test');
});

test('a userinfo prefix that looks like the sandbox host is refused', () => {
  refuses('https://api-m.sandbox.paypal.com@evil.test');
});

test('cleartext is refused: the basic-auth header would carry the client secret in the open', () => {
  refuses('http://api-m.sandbox.paypal.com');
});

test('an unparseable base is refused rather than trusted', () => {
  refuses('api-m.sandbox.paypal.com');
  refuses('');
});

test('the running configuration is the sandbox, and isSandbox agrees with the guard', () => {
  assert.equal(isSandbox(), true);
  assert.equal(new URL(config.paypalBase).hostname, hosts.SANDBOX_HOST);
});

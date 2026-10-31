import { timingSafeEqual } from 'node:crypto';

export const ROLES = ['desk', 'seller', 'funder', 'debtor'] as const;
export type Role = (typeof ROLES)[number];

/**
 * What each identity may make happen. The verbs are the money-moving routes; the pages are open to
 * every signed-in role because seeing the same invoice from the other side is the point of the
 * role switch. `desk` is the operator and may do anything, which is why it is never a default that
 * an unauthenticated request gets.
 *
 * The three verbs at the end of the desk list are the ones nobody else can hold. Calling a paper
 * into default, applying what the seller repurchased and writing the claim off are all decisions the
 * desk makes against its own book; a seller allowed to declare its own debt repurchased, or a funder
 * allowed to close its own loss, would be a book that reports whatever its counterparties want.
 */
const MAY: Record<Role, string[]> = {
  desk: ['submit', 'fund', 'capture', 'settle', 'default', 'repurchase', 'write off', 'serve notice', 'export the register', 'read the api'],
  seller: ['submit'],
  funder: ['fund', 'capture'],
  debtor: ['settle']
};

export function roleAllows(role: Role, verb: string): boolean {
  return MAY[role].includes(verb);
}

/**
 * Which names may press a given button, read from the same table that decides it. The pages use this
 * to name who can act when the signed-in identity is wearing a lens whose buttons are not its own —
 * a dead button that answers 403 is worse than a sentence that says where the button lives.
 */
export function holdersOf(verb: string): Role[] {
  return ROLES.filter((role) => MAY[role].includes(verb));
}

export interface Identity {
  role: Role;
  name: string;
}

/**
 * A public demo has four named identities, and the username picks what the session may make happen.
 * Two ways of guarding it are supported. With only `DEMO_PASSWORD` set, one secret admits everyone and
 * the role is self-declared — fine for a link handed to judges who are watching, and said out loud in
 * the README rather than dressed up as access control. With a per-side secret set, that side stops
 * accepting the shared password, and the role stops being something you can type your way into.
 * Comparison is constant-time either way. With no secret configured at all the app is open and the
 * session is the desk, which is the local-development default and never the public one.
 */
export function basicAuthIdentity(
  authorization: string | undefined,
  password: string,
  byRole: Record<string, string> = {}
): { ok: true; identity: Identity } | { ok: false } {
  const perSide = Object.values(byRole).filter((secret) => secret);
  if (!password && perSide.length === 0) {
    return { ok: true, identity: { role: 'desk', name: 'desk' } };
  }
  const header = String(authorization ?? '');
  if (!header.startsWith('Basic ')) return { ok: false };
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return { ok: false };
  }
  const split = decoded.indexOf(':');
  if (split < 0) return { ok: false };
  const name = decoded.slice(0, split).trim().toLowerCase();
  const supplied = decoded.slice(split + 1);
  // An unrecognised username is not a role with a hidden grant; it is somebody guessing.
  if (!(ROLES as readonly string[]).includes(name)) return { ok: false };
  const secret = byRole[name] || password;
  if (!secret) return { ok: false };
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(secret, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false };
  return { ok: true, identity: { role: name as Role, name } };
}

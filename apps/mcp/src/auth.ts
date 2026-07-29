import { timingSafeEqual } from 'node:crypto';

/**
 * Bearer token auth. Part 5: reject any request without it.
 *
 * The comparison is constant-time. A plain `===` on a secret leaks its length and
 * its matching prefix through response timing, which is a real remote oracle for
 * a token that is the only thing standing between the internet and Tal's data.
 */

export type AuthResult = { ok: true } | { ok: false; status: number; message: string };

export function checkBearer(header: string | undefined | null): AuthResult {
  const expected = process.env['TASKOS_TOKEN'];
  if (!expected || expected.length === 0) {
    // Fail closed. An unset token must never mean "allow everyone".
    return {
      ok: false,
      status: 500,
      message: 'TASKOS_TOKEN is not configured on the server; refusing every request',
    };
  }

  if (!header) {
    return { ok: false, status: 401, message: 'missing Authorization header' };
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) {
    return { ok: false, status: 401, message: 'Authorization header must be: Bearer <token>' };
  }

  const presented = Buffer.from(match[1]!.trim(), 'utf8');
  const secret = Buffer.from(expected, 'utf8');
  const same =
    presented.length === secret.length && timingSafeEqual(presented, secret);

  return same ? { ok: true } : { ok: false, status: 401, message: 'invalid token' };
}

import { timingSafeEqual } from 'node:crypto';

/**
 * Authentication. Part 5: reject any request without the token.
 *
 * The comparison is constant-time. A plain `===` on a secret leaks its length
 * and its matching prefix through response timing, which is a real remote oracle
 * for a token that is the only thing standing between the internet and Tal's
 * data.
 *
 * TWO THINGS ARE DELIBERATE HERE, and both exist because of how MCP clients
 * behave rather than because of the HTTP spec:
 *
 * 1. The token is accepted from `Authorization: Bearer` OR from a `token` query
 *    parameter. The claude.ai custom-connector form has no field for a static
 *    bearer token, so the credential has to travel in the URL for the connector
 *    to work at all. That is a real tradeoff: URLs get logged and appear in
 *    browser history in a way headers do not. Rotate it by changing
 *    TASKOS_TOKEN and re-registering.
 *
 * 2. A rejection from here carries NO `WWW-Authenticate` header AND answers 403
 *    rather than 401. Both halves exist because of the same real failure.
 *
 *    Omitting the header was not enough. Re-adding the connector without the
 *    `?token=` produced a 401, and the client treats ANY 401 as an invitation
 *    to begin OAuth discovery regardless of headers: it probes
 *    /.well-known/oauth-protected-resource, attempts dynamic client
 *    registration, and shows "Couldn't register with Task-OS's sign-in
 *    service" — an error naming a sign-in service that does not exist, about a
 *    protocol this server does not speak, when the actual problem is a missing
 *    query parameter.
 *
 *    403 is also the honest status. RFC 7235 reserves 401 for "authenticate and
 *    try again", which presumes a scheme the client can satisfy. There is none:
 *    the credential is a static pre-shared token that must be in the URL the
 *    connector was registered with. Nothing the client can negotiate will help,
 *    which is exactly what 403 means.
 */

export type AuthResult = { ok: true } | { ok: false; status: number; message: string };

function constantTimeEquals(presented: string, secret: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(secret, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The token carried by `Authorization: Bearer <token>`, if any. */
function fromHeader(header: string | undefined | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

/** The token carried by `?token=<token>`, if any. */
function fromUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  const q = url.indexOf('?');
  if (q === -1) return null;
  const value = new URLSearchParams(url.slice(q + 1)).get('token');
  return value && value.length > 0 ? value : null;
}

/**
 * Accepts the token from either the Authorization header or the query string.
 * Use this at every HTTP entrypoint.
 */
export function checkCredential(
  header: string | undefined | null,
  url?: string | undefined | null,
): AuthResult {
  const expected = process.env['TASKOS_TOKEN'];
  if (!expected || expected.length === 0) {
    // Fail closed. An unset token must never mean "allow everyone".
    return {
      ok: false,
      status: 500,
      message: 'TASKOS_TOKEN is not configured on the server; refusing every request',
    };
  }

  const headerToken = fromHeader(header);
  const urlToken = fromUrl(url);

  if (headerToken === null && urlToken === null) {
    return {
      ok: false,
      status: 403,
      message:
        'no token. This server has no sign-in flow: the credential goes in the connector URL. Register it as https://<host>/api/mcp?token=<TASKOS_TOKEN>, or send Authorization: Bearer <token>.',
    };
  }

  const presented = headerToken ?? urlToken!;
  return constantTimeEquals(presented, expected)
    ? { ok: true }
    : {
        ok: false,
        status: 403,
        message: 'invalid token: check the ?token= value on the connector URL against TASKOS_TOKEN',
      };
}

/** Header-only check. Kept for callers that never see a URL. */
export function checkBearer(header: string | undefined | null): AuthResult {
  return checkCredential(header, null);
}

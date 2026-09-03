/**
 * Supabase Storage, over its REST API.
 *
 * Not the supabase-js client: this needs four calls, all of them plain HTTP,
 * and the client would add a dependency plus an auth model that duplicates the
 * one already here. The service-role key is used deliberately — the MCP server
 * owns these tables and is the thing enforcing tenancy on this path, exactly as
 * it does for tasks. RLS remains the backstop for anything reaching Storage
 * with a user JWT, which is what the bucket policy in migration 0007 is for.
 *
 * DEGRADED, NOT BROKEN (D8). If the storage environment is not configured,
 * nothing here throws on import and no tool 500s. Metadata still reads and
 * writes; only the operations that genuinely need bytes report that they cannot
 * run, with the reason and the fix. A system that hides half its function
 * behind a stack trace is worse than one that says which half is missing.
 */

export const BUCKET = 'taskos-documents';

/** Signed URLs are short-lived on purpose: a leaked link should expire. */
export const DEFAULT_EXPIRY_SECONDS = 900;
export const MAX_EXPIRY_SECONDS = 3600;

/** Inline uploads travel as base64 inside a JSON tool call. */
export const MAX_INLINE_BYTES = 5 * 1024 * 1024;

export interface StorageConfig {
  url: string;
  serviceKey: string;
}

export type StorageStatus =
  | { configured: true; config: StorageConfig }
  | { configured: false; reason: string };

/**
 * Reduce a Supabase project URL to its ORIGIN.
 *
 * THIS IS THE FIX FOR A 404 THAT COST A DOCUMENT STORE. `attach_document`
 * returned `{"code":"PGRST125","message":"Invalid path specified in request
 * URL"}` -- and PGRST125 is PostgREST, not Storage. Storage was never reached.
 *
 * The Supabase dashboard shows several URLs, and the one labelled for the REST
 * API ends in `/rest/v1`. Paste that into SUPABASE_URL and every call here
 * becomes `https://<ref>.supabase.co/rest/v1/storage/v1/object/...`, which
 * PostgREST answers, correctly, with "invalid path". The error names a
 * component nobody was trying to use, which is why it reads as unfixable.
 *
 * A project URL never has a meaningful path, so taking the origin is safe for
 * every correct value and repairs every incorrect one. Trimming only the exact
 * suffixes we have seen would be an enumeration -- correct today, silently
 * incomplete the first time somebody pastes `/auth/v1` instead.
 *
 * The trim is REPORTED rather than silent (see `storageDiagnosis`), because a
 * setting that is wrong and works anyway is a setting that stays wrong.
 */
export function normaliseProjectUrl(raw: string): { url: string; trimmed: string | null } {
  const cleaned = raw.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    // Not a URL at all. Hand it back untouched so the caller reports the real
    // value shape rather than a parse failure from inside a helper.
    return { url: cleaned, trimmed: null };
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  return {
    url: parsed.origin,
    trimmed: path === '' || path === '/' ? null : path,
  };
}

export function storageConfig(): StorageStatus {
  const url = process.env['SUPABASE_URL'] ?? process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
  const missing: string[] = [];
  if (!url) missing.push('SUPABASE_URL');
  if (!serviceKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length > 0 || !url || !serviceKey) {
    return {
      configured: false,
      reason: `document storage is not configured: ${missing.join(' and ')} ${
        missing.length > 1 ? 'are' : 'is'
      } unset on the server. Metadata still works; bytes cannot move until this is set.`,
    };
  }
  return { configured: true, config: { url: normaliseProjectUrl(url).url, serviceKey } };
}

export interface StorageDiagnosis {
  configured: boolean;
  /** What is wrong, or null when nothing is. Never contains the URL itself. */
  problem: string | null;
  /** A path that was trimmed off SUPABASE_URL. Names the misconfiguration. */
  trimmedPath: string | null;
  /** Whether the bucket answered. null when not probed. */
  bucketReachable: boolean | null;
}

/**
 * Say whether bytes can actually move, by asking rather than by assuming.
 *
 * `/health` reported storage as configured-or-not and nothing else, so a
 * present-but-wrong SUPABASE_URL read as healthy right up until an upload
 * failed. An empty result is not a clean result: this makes one real request.
 *
 * It reports the SHAPE of the configuration and never its value -- no
 * hostnames, no keys -- for the same reason the rest of /health does not.
 */
export async function storageDiagnosis(): Promise<StorageDiagnosis> {
  const raw = process.env['SUPABASE_URL'] ?? process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const status = storageConfig();
  const trimmed = raw ? normaliseProjectUrl(raw).trimmed : null;

  if (!status.configured) {
    return { configured: false, problem: status.reason, trimmedPath: trimmed, bucketReachable: null };
  }

  let reachable = false;
  let problem: string | null = null;
  try {
    const res = await call(status.config, `/bucket/${BUCKET}`, { timeoutMs: 8_000 });
    reachable = res.ok;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      problem =
        res.status === 404 && body.includes('PGRST')
          ? `SUPABASE_URL points at PostgREST, not the project root: the request reached the database API instead of Storage. It must be the project origin (https://<ref>.supabase.co) with no path.`
          : res.status === 404
            ? `the bucket "${BUCKET}" does not exist in this project — create it, or documents have nowhere to go`
            : `Storage answered ${res.status} ${res.statusText}`;
    }
  } catch (e) {
    problem = `Storage did not answer: ${e instanceof Error ? e.message : 'unknown error'}`;
  }

  if (!problem && trimmed) {
    problem = `SUPABASE_URL has "${trimmed}" on the end and is being trimmed to the origin. Uploads work, but fix the value — the next thing to read it may not trim.`;
  }

  return { configured: true, problem, trimmedPath: trimmed, bucketReachable: reachable };
}

async function call(
  cfg: StorageConfig,
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 20_000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${cfg.url}/storage/v1${path}`, {
      ...rest,
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${cfg.serviceKey}`,
        apikey: cfg.serviceKey,
        ...(rest.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function failure(res: Response, what: string): Promise<Error> {
  const body = await res.text().catch(() => '');
  return new Error(`${what} failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`);
}

/**
 * A URL the user can PUT a file to, without ever holding a credential.
 *
 * This is the reliable ingest path. MCP tool arguments are JSON, so a large
 * binary cannot travel through a tool call at all; handing back a link the
 * person clicks moves the bytes browser-to-Supabase and keeps the service key
 * on the server.
 */
export async function createSignedUploadUrl(
  cfg: StorageConfig,
  storagePath: string,
): Promise<{ uploadUrl: string; token: string }> {
  const res = await call(cfg, `/object/upload/sign/${BUCKET}/${encodePath(storagePath)}`, {
    method: 'POST',
  });
  if (!res.ok) throw await failure(res, 'creating an upload link');
  const body = (await res.json()) as { url?: string; token?: string };
  const token = body.token ?? extractToken(body.url);
  if (!token) throw new Error('Supabase returned no upload token');
  return { uploadUrl: `${cfg.url}/storage/v1${body.url ?? ''}`, token };
}

/** A short-lived read URL. */
export async function createSignedDownloadUrl(
  cfg: StorageConfig,
  storagePath: string,
  expiresIn: number,
): Promise<string> {
  const res = await call(cfg, `/object/sign/${BUCKET}/${encodePath(storagePath)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expiresIn }),
  });
  if (!res.ok) throw await failure(res, 'signing a download link');
  const body = (await res.json()) as { signedURL?: string; signedUrl?: string };
  const signed = body.signedURL ?? body.signedUrl;
  if (!signed) throw new Error('Supabase returned no signed URL');
  return `${cfg.url}/storage/v1${signed.startsWith('/') ? '' : '/'}${signed}`;
}

/** Upload bytes we already hold, for content small enough to inline. */
export async function uploadBytes(
  cfg: StorageConfig,
  storagePath: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  const res = await call(cfg, `/object/${BUCKET}/${encodePath(storagePath)}`, {
    method: 'POST',
    headers: { 'content-type': contentType, 'x-upsert': 'false' },
    // The DOM lib is not loaded here (this is a Node target), so BodyInit is
    // not a name TypeScript knows; undici accepts a Uint8Array at runtime.
    body: bytes as unknown as RequestInit['body'],
    timeoutMs: 30_000,
  });
  if (!res.ok) throw await failure(res, 'uploading');
}

export interface StoredObject {
  path: string;
  size: number | null;
  mimeType: string | null;
}

/**
 * Every object under a workspace's prefix, in one request.
 *
 * Storage sends no webhook when an upload completes, so pending rows have to be
 * reconciled by asking. Asking once for the whole prefix rather than once per
 * document is the difference between a listing that stays fast and one that
 * degrades with every file added.
 */
export async function listObjects(
  cfg: StorageConfig,
  prefix: string,
  limit = 1000,
): Promise<StoredObject[]> {
  const res = await call(cfg, `/object/list/${BUCKET}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prefix, limit, sortBy: { column: 'name', order: 'asc' } }),
  });
  if (!res.ok) throw await failure(res, 'listing stored objects');

  // Storage lists one level at a time: a request for "<workspace>/" returns the
  // per-document folders, not the files inside them. One more pass over those
  // folders reaches the objects themselves, which is where the paths this table
  // records actually live.
  const level = (await res.json()) as Array<{
    name: string;
    id: string | null;
    metadata?: { size?: number; mimetype?: string } | null;
  }>;

  const out: StoredObject[] = [];
  const folders: string[] = [];
  for (const entry of level) {
    if (entry.id === null) folders.push(`${prefix}${entry.name}/`);
    else
      out.push({
        path: `${prefix}${entry.name}`,
        size: entry.metadata?.size ?? null,
        mimeType: entry.metadata?.mimetype ?? null,
      });
  }

  for (const folder of folders) {
    const inner = await call(cfg, `/object/list/${BUCKET}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prefix: folder, limit, sortBy: { column: 'name', order: 'asc' } }),
    });
    if (!inner.ok) continue;
    const files = (await inner.json()) as Array<{
      name: string;
      id: string | null;
      metadata?: { size?: number; mimetype?: string } | null;
    }>;
    for (const f of files) {
      if (f.id === null) continue;
      out.push({
        path: `${folder}${f.name}`,
        size: f.metadata?.size ?? null,
        mimeType: f.metadata?.mimetype ?? null,
      });
    }
  }
  return out;
}

export async function deleteObject(cfg: StorageConfig, storagePath: string): Promise<void> {
  const res = await call(cfg, `/object/${BUCKET}/${encodePath(storagePath)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw await failure(res, 'deleting');
}

/** Encode each segment, keeping the slashes that make the path a path. */
function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

function extractToken(url: string | undefined): string | null {
  if (!url) return null;
  const m = /[?&]token=([^&]+)/.exec(url);
  return m?.[1] ?? null;
}

/**
 * A filename that cannot escape its folder or confuse a path.
 *
 * Anything that is not obviously safe becomes a dash. This is deliberately
 * blunt: the real name is preserved in the document's title, so nothing is lost
 * by refusing to trust user text in a path.
 */
export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  const cleaned = base
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.\-]+/, '')
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : 'file';
}

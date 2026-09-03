import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from '../src/db.js';
import { attachDocument, createUploadLink, getDocument, listDocuments } from '../src/documents.js';
import { normaliseProjectUrl, safeFilename, storageConfig } from '../src/storage.js';
import { freshDb, type TestDb } from './harness.js';

/**
 * Documents.
 *
 * Storage itself is stubbed at the fetch boundary: what is worth testing here
 * is the behaviour around the bytes — what happens with no storage configured,
 * with a file too large to inline, with an upload that never arrives, and with
 * a row whose object has gone. Those are the states a real deployment spends
 * its time in, and none of them need a real bucket to exercise.
 *
 * The one thing NOT stubbed is the database, because the cross-tenant guard and
 * the path constraint are triggers, and a mock cannot disagree with them.
 */

let db: TestDb;
let sql: Sql;
let workspace: string;
let ventureSlug: string;

const ENV = { ...process.env };

beforeAll(async () => {
  db = await freshDb('documents');
  sql = db.sql;
  workspace = (await sql<Array<{ id: string }>>`select id from workspaces limit 1`)[0]!.id;
  ventureSlug = (
    await sql<Array<{ slug: string }>>`select slug from ventures where active order by slug limit 1`
  )[0]!.slug;
});

afterAll(async () => {
  await db.drop();
});

afterEach(() => {
  process.env = { ...ENV };
  vi.unstubAllGlobals();
});

function configureStorage() {
  process.env['SUPABASE_URL'] = 'https://example.supabase.co';
  process.env['SUPABASE_SERVICE_ROLE_KEY'] = 'service-key';
}

function unconfigureStorage() {
  delete process.env['SUPABASE_URL'];
  delete process.env['NEXT_PUBLIC_SUPABASE_URL'];
  delete process.env['SUPABASE_SERVICE_ROLE_KEY'];
}

/** Stub fetch with a router keyed on the request path. */
function stubFetch(routes: Array<[RegExp, () => Response]>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    for (const [pattern, respond] of routes) if (pattern.test(url)) return respond();
    return new Response('no stub matched', { status: 500 });
  });
  return calls;
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('degraded behaviour when storage is not configured (D8)', () => {
  it('refuses to write metadata for bytes it cannot store', async () => {
    unconfigureStorage();
    const res = await attachDocument(sql, {
      title: 'A spec',
      filename: 'spec.txt',
      content_text: 'hello',
    });
    expect(res.ok).toBe(false);
    expect(res.errors?.[0]?.code).toBe('storage_unconfigured');
    // The important half: no orphan row pointing at nothing.
    const rows = await sql`select id from documents where title = 'A spec'`;
    expect(rows).toHaveLength(0);
  });

  it('names the missing variables instead of throwing', async () => {
    unconfigureStorage();
    const res = await createUploadLink(sql, { title: 'x', filename: 'x.pdf' });
    expect(res.ok).toBe(false);
    expect(res.errors?.[0]?.message).toContain('SUPABASE_URL');
    expect(res.errors?.[0]?.message).toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('still lists what is recorded, saying the state may be stale', async () => {
    configureStorage();
    stubFetch([[/upload\/sign/, () => ok({ url: '/object/upload/sign/x?token=t', token: 't' })]]);
    await createUploadLink(sql, { title: 'Pending thing', filename: 'p.pdf' });

    unconfigureStorage();
    const res = await listDocuments(sql, { search: 'Pending thing' });
    expect(res.ok).toBe(true);
    expect((res['documents'] as unknown[]).length).toBe(1);
    expect(res.confidence.notes.join(' ')).toContain('as last recorded');
  });
});

describe('attach_document', () => {
  it('stores small inline content and records what it is attached to', async () => {
    configureStorage();
    const calls = stubFetch([[/\/object\/taskos-documents\//, () => ok({ Key: 'x' })]]);

    const res = await attachDocument(sql, {
      title: 'Charter agreement',
      filename: 'charter agreement (final).pdf',
      content_text: 'the terms',
      venture: ventureSlug,
      notes: 'signed copy',
    });

    expect(res.ok).toBe(true);
    const doc = res['document'] as { id: string; bytes: number; sha256: string };
    expect(doc.bytes).toBe('the terms'.length);
    expect(doc.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(calls.some((c) => c.startsWith('POST'))).toBe(true);

    const [row] = await sql<Array<{ storage_path: string; status: string; venture_id: string }>>`
      select storage_path, status, venture_id from documents where id = ${doc.id}`;
    expect(row!.status).toBe('stored');
    expect(row!.venture_id).not.toBeNull();
    // Path is workspace-scoped and the filename is sanitised.
    expect(row!.storage_path.startsWith(`${workspace}/`)).toBe(true);
    expect(row!.storage_path).toContain('charter-agreement-final-.pdf');
  });

  it('refuses content too large to travel in a tool call, and says what to use', async () => {
    configureStorage();
    const res = await attachDocument(sql, {
      title: 'Big deck',
      filename: 'deck.pdf',
      content_base64: Buffer.alloc(6 * 1024 * 1024).toString('base64'),
    });
    expect(res.ok).toBe(false);
    expect(res.errors?.[0]?.code).toBe('too_large');
    expect(res.errors?.[0]?.message).toContain('create_upload_link');
  });

  it('requires content', async () => {
    configureStorage();
    const res = await attachDocument(sql, { title: 'Nothing', filename: 'n.txt' });
    expect(res.errors?.[0]?.code).toBe('no_content');
  });

  it('stores the file even when the venture name does not match, and says so', async () => {
    configureStorage();
    stubFetch([[/\/object\/taskos-documents\//, () => ok({})]]);
    const res = await attachDocument(sql, {
      title: 'Orphan',
      filename: 'o.txt',
      content_text: 'x',
      venture: 'no-such-venture',
    });
    // Losing a file because its label was wrong is far worse than an unfiled file.
    expect(res.ok).toBe(true);
    expect(res.confidence.notes.join(' ')).toContain('no venture matched');
  });

  it('replays an idempotency key without storing twice', async () => {
    configureStorage();
    stubFetch([[/\/object\/taskos-documents\//, () => ok({})]]);
    const key = 'doc-idem-1';
    const first = await attachDocument(sql, {
      title: 'Once',
      filename: 'once.txt',
      content_text: 'x',
      idempotency_key: key,
    });
    const second = await attachDocument(sql, {
      title: 'Once',
      filename: 'once.txt',
      content_text: 'x',
      idempotency_key: key,
    });
    expect(first.ok).toBe(true);
    expect(second['replayed']).toBe(true);
    const rows = await sql`select id from documents where title = 'Once'`;
    expect(rows).toHaveLength(1);
  });
});

describe('create_upload_link and reconciliation', () => {
  it('records the document as pending and hands back a link', async () => {
    configureStorage();
    stubFetch([
      [/upload\/sign/, () => ok({ url: '/object/upload/sign/p?token=tok123', token: 'tok123' })],
    ]);

    const res = await createUploadLink(sql, {
      title: 'Survey report',
      filename: 'survey.pdf',
      venture: ventureSlug,
    });

    expect(res.ok).toBe(true);
    expect(res['status']).toBe('pending');
    expect(String(res['upload_url'])).toContain('/storage/v1/object/upload/sign/');
    expect(res['upload_token']).toBe('tok123');
  });

  it('will not hand out a read link for a document with no file yet', async () => {
    configureStorage();
    stubFetch([[/upload\/sign/, () => ok({ url: '/object/upload/sign/q?token=t', token: 't' })]]);
    const created = await createUploadLink(sql, { title: 'Not yet', filename: 'ny.pdf' });

    const res = await getDocument(sql, { document_id: String(created['document_id']) });
    expect(res.ok).toBe(false);
    expect(res.errors?.[0]?.code).toBe('not_uploaded');
    expect(res['url']).toBeNull();
  });

  it('flips pending to stored once the object appears in the bucket', async () => {
    configureStorage();
    stubFetch([[/upload\/sign/, () => ok({ url: '/object/upload/sign/r?token=t', token: 't' })]]);
    const created = await createUploadLink(sql, { title: 'Arrives later', filename: 'later.pdf' });
    const id = String(created['document_id']);
    const pathRows = await sql<Array<{ storage_path: string }>>`
      select storage_path from documents where id = ${id}`;
    const [, folder, file] = pathRows[0]!.storage_path.split('/');

    // Storage lists one level at a time: the workspace prefix returns folders
    // (id null), and the folder returns the object.
    stubFetch([
      [
        /object\/list/,
        () => ok([{ name: folder, id: null }]),
      ],
    ]);
    // Second call must return the file, so route on the body being the folder.
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const body = String(init?.body ?? '');
      if (body.includes(`${folder}/`))
        return ok([{ name: file, id: 'obj', metadata: { size: 42, mimetype: 'application/pdf' } }]);
      return ok([{ name: folder, id: null }]);
    });

    const res = await listDocuments(sql, { search: 'Arrives later' });
    const doc = (res['documents'] as Array<{ id: string; status: string; size_bytes: number }>)[0]!;
    expect(doc.status).toBe('stored');
    expect(doc.size_bytes).toBe(42);
    expect(res.confidence.notes.join(' ')).toContain('confirmed just now');

    // And the flip was persisted, not just reported.
    const [row] = await sql<Array<{ status: string }>>`select status from documents where id = ${id}`;
    expect(row!.status).toBe('stored');
  });

  it('reports pending documents in the notes rather than letting them look ready', async () => {
    configureStorage();
    stubFetch([[/upload\/sign/, () => ok({ url: '/object/upload/sign/s?token=t', token: 't' })]]);
    await createUploadLink(sql, { title: 'Never arrives', filename: 'never.pdf' });
    stubFetch([[/object\/list/, () => ok([])]]);

    const res = await listDocuments(sql, { search: 'Never arrives' });
    expect(res.confidence.notes.join(' ')).toContain('pending');
    expect(res.confidence.notes.join(' ')).toContain('not readable until uploaded');
  });
});

describe('get_document', () => {
  it('returns a signed url that expires, and says so', async () => {
    configureStorage();
    stubFetch([[/\/object\/taskos-documents\//, () => ok({})]]);
    const created = await attachDocument(sql, {
      title: 'Readable',
      filename: 'r.txt',
      content_text: 'hello',
    });
    const id = (created['document'] as { id: string }).id;

    stubFetch([[/\/object\/sign\//, () => ok({ signedURL: '/object/sign/x?token=abc' })]]);
    const res = await getDocument(sql, { document_id: id, expires_in_seconds: 120 });

    expect(res.ok).toBe(true);
    expect(String(res['url'])).toContain('token=abc');
    expect(res['expires_in_seconds']).toBe(120);
    expect(res.confidence.notes.join(' ')).toContain('expires in 120 seconds');
  });

  it('clamps the expiry rather than honouring a week-long link', async () => {
    configureStorage();
    stubFetch([[/\/object\/taskos-documents\//, () => ok({})]]);
    const created = await attachDocument(sql, {
      title: 'Clamped',
      filename: 'c.txt',
      content_text: 'hello',
    });
    const id = (created['document'] as { id: string }).id;

    stubFetch([[/\/object\/sign\//, () => ok({ signedURL: '/object/sign/x?token=abc' })]]);
    const res = await getDocument(sql, { document_id: id, expires_in_seconds: 604800 });
    expect(res['expires_in_seconds']).toBe(3600);
  });

  it('marks a document missing when storage no longer has the object', async () => {
    configureStorage();
    stubFetch([[/\/object\/taskos-documents\//, () => ok({})]]);
    const created = await attachDocument(sql, {
      title: 'Vanished',
      filename: 'v.txt',
      content_text: 'hello',
    });
    const id = (created['document'] as { id: string }).id;

    stubFetch([[/\/object\/sign\//, () => new Response('Object not found', { status: 404 })]]);
    const res = await getDocument(sql, { document_id: id });

    expect(res.ok).toBe(false);
    expect(res.errors?.[0]?.code).toBe('object_missing');
    expect(res['url']).toBeNull();
    const [row] = await sql<Array<{ status: string }>>`select status from documents where id = ${id}`;
    expect(row!.status).toBe('missing');
  });

  it('does not find another workspace\'s document', async () => {
    configureStorage();
    const [other] = await sql<Array<{ id: string }>>`
      insert into workspaces (name) values ('Someone Else') returning id`;
    // With two workspaces present, resolveWorkspaceId refuses to guess — which
    // is correct, and means this test has to say who is asking.
    process.env['TASKOS_WORKSPACE_ID'] = workspace;
    const [theirs] = await sql<Array<{ id: string }>>`
      insert into documents (workspace_id, title, storage_path)
      values (${other!.id}, 'Their contract', ${other!.id + '/x/theirs.pdf'})
      returning id`;

    const res = await getDocument(sql, { document_id: theirs!.id });
    expect(res.ok).toBe(false);
    expect(res.errors?.[0]?.code).toBe('not_found');

    const list = await listDocuments(sql, { search: 'Their contract' });
    expect(list['documents']).toHaveLength(0);
  });
});

describe('safeFilename', () => {
  it('strips path traversal', () => {
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename('a/b/c.pdf')).toBe('c.pdf');
    expect(safeFilename('..\\..\\win.ini')).toBe('win.ini');
  });

  it('never returns an empty name', () => {
    expect(safeFilename('...')).toBe('file');
    expect(safeFilename('/')).toBe('file');
    expect(safeFilename('')).toBe('file');
  });

  it('keeps a readable name for ordinary files', () => {
    expect(safeFilename('Q3 Report v2.pdf')).toBe('Q3-Report-v2.pdf');
  });
});

describe('SUPABASE_URL that is not the project origin', () => {
  /**
   * THE REGRESSION TEST FOR THE PGRST125 404.
   *
   * attach_document failed with `{"code":"PGRST125","message":"Invalid path
   * specified in request URL"}`. PGRST125 is PostgREST -- Storage was never
   * reached at all, which is why the error named a component nobody was using
   * and read as unfixable. The Supabase dashboard shows a URL for the REST API
   * ending in `/rest/v1`; pasted into SUPABASE_URL, every Storage call becomes
   * `https://<ref>.supabase.co/rest/v1/storage/v1/object/...`.
   */
  const CASES: Array<[string, string | null]> = [
    ['https://abc.supabase.co', null],
    ['https://abc.supabase.co/', null],
    ['https://abc.supabase.co///', null],
    // The one that actually happened.
    ['https://abc.supabase.co/rest/v1', '/rest/v1'],
    ['https://abc.supabase.co/rest/v1/', '/rest/v1'],
    // The siblings, which a trim of only the known suffix would have missed.
    ['https://abc.supabase.co/storage/v1', '/storage/v1'],
    ['https://abc.supabase.co/auth/v1', '/auth/v1'],
    ['  https://abc.supabase.co/rest/v1  ', '/rest/v1'],
  ];

  for (const [input, trimmed] of CASES) {
    it(`reduces ${JSON.stringify(input)} to the origin`, () => {
      const out = normaliseProjectUrl(input);
      expect(out.url).toBe('https://abc.supabase.co');
      expect(out.trimmed).toBe(trimmed);
    });
  }

  it('builds a Storage path, not a PostgREST one, from the broken value', () => {
    // The assertion that would have caught the outage: the request URL.
    const { url } = normaliseProjectUrl('https://abc.supabase.co/rest/v1');
    expect(`${url}/storage/v1/object/taskos-documents/x.md`).toBe(
      'https://abc.supabase.co/storage/v1/object/taskos-documents/x.md',
    );
  });

  it('takes the origin in the real config path too, not only in the helper', () => {
    const prevUrl = process.env['SUPABASE_URL'];
    const prevKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
    process.env['SUPABASE_URL'] = 'https://abc.supabase.co/rest/v1';
    process.env['SUPABASE_SERVICE_ROLE_KEY'] = 'service-key';
    try {
      const status = storageConfig();
      expect(status.configured).toBe(true);
      if (status.configured) expect(status.config.url).toBe('https://abc.supabase.co');
    } finally {
      if (prevUrl === undefined) delete process.env['SUPABASE_URL'];
      else process.env['SUPABASE_URL'] = prevUrl;
      if (prevKey === undefined) delete process.env['SUPABASE_SERVICE_ROLE_KEY'];
      else process.env['SUPABASE_SERVICE_ROLE_KEY'] = prevKey;
    }
  });

  it('leaves a value that is not a URL alone, rather than throwing', () => {
    // A helper that throws here would turn a bad setting into a 500 on a path
    // that is supposed to degrade.
    expect(normaliseProjectUrl('not a url').url).toBe('not a url');
    expect(normaliseProjectUrl('not a url').trimmed).toBeNull();
  });
});

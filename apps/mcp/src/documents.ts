import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { resolveWorkspaceId, type Sql } from './db.js';
import { findReplay, recordReceipt } from './idempotency.js';
import { envelope, narrow, plainConfidence, type ToolEnvelope } from './narrow.js';
import { ACTOR } from './tools.js';
import {
  BUCKET,
  DEFAULT_EXPIRY_SECONDS,
  MAX_EXPIRY_SECONDS,
  MAX_INLINE_BYTES,
  createSignedDownloadUrl,
  createSignedUploadUrl,
  listObjects,
  safeFilename,
  storageConfig,
  uploadBytes,
  type StorageConfig,
} from './storage.js';

/**
 * Documents: files attached to the work they belong to.
 *
 * Four tools, and the split between them exists because of one hard constraint:
 * MCP tool arguments are JSON, so bytes can only travel through a tool call as
 * base64. That is fine for a two-page contract and impossible for a deck.
 *
 *   attach_document     small content the caller already holds, inline
 *   create_upload_link  everything else — a link the person drops a file on
 *   list_documents      what is attached, and to what
 *   get_document        a short-lived signed URL to read one
 *
 * Nothing here interprets a document's contents. TaskOS has no LLM in it, and
 * "summarise this PDF" is a job for the Claude session that can already read
 * the file it just uploaded.
 */

export interface DocumentRow {
  id: string;
  title: string;
  notes: string | null;
  storage_path: string;
  mime_type: string | null;
  size_bytes: string | null;
  status: string;
  source: string;
  created_at: Date;
  venture_slug: string | null;
  project_name: string | null;
  milestone_name: string | null;
  task_title: string | null;
}

interface Attachment {
  venture?: string;
  project?: string;
  milestone?: string;
  task_id?: string;
}

interface ResolvedAttachment {
  venture_id: string | null;
  project_id: string | null;
  milestone_id: string | null;
  task_id: string | null;
  notes: string[];
}

/**
 * Turn the human-facing names in a tool call into ids.
 *
 * Unmatched names are reported, not guessed at and not fatal. A document whose
 * venture name was mistyped should still be stored — losing the file because
 * the label was wrong is a far worse outcome than an unfiled document, and the
 * note tells the caller exactly what to fix.
 */
async function resolveAttachment(
  sql: Sql,
  workspaceId: string,
  input: Attachment,
): Promise<ResolvedAttachment> {
  const notes: string[] = [];
  let ventureId: string | null = null;
  let projectId: string | null = null;
  let milestoneId: string | null = null;
  let taskId: string | null = null;

  if (input.venture) {
    const rows = await sql<Array<{ id: string }>>`
      select id from ventures
       where workspace_id = ${workspaceId}
         and (slug = ${input.venture} or name = ${input.venture}) limit 1
    `;
    ventureId = rows[0]?.id ?? null;
    if (!ventureId) notes.push(`no venture matched "${input.venture}"; stored without one`);
  }

  if (input.task_id) {
    const rows = await sql<Array<{ id: string; venture_id: string; project_id: string | null }>>`
      select id, venture_id, project_id from tasks
       where workspace_id = ${workspaceId} and id = ${input.task_id} limit 1
    `;
    const task = rows[0];
    if (!task) notes.push(`no task with id ${input.task_id} in this workspace; stored without one`);
    else {
      taskId = task.id;
      // A document attached to a task belongs to that task's venture, whatever
      // the caller said. Inheriting is right here: the task knows better.
      ventureId ??= task.venture_id;
      projectId ??= task.project_id;
    }
  }

  if (input.project) {
    const rows = await sql<Array<{ id: string; venture_id: string }>>`
      select p.id, p.venture_id from projects p
       where p.workspace_id = ${workspaceId} and p.name = ${input.project}
         ${ventureId ? sql`and p.venture_id = ${ventureId}` : sql``}
       limit 1
    `;
    projectId = rows[0]?.id ?? projectId;
    if (!rows[0]) notes.push(`no project matched "${input.project}"; stored without one`);
    else ventureId ??= rows[0].venture_id;
  }

  if (input.milestone) {
    const rows = await sql<Array<{ id: string; venture_id: string }>>`
      select m.id, m.venture_id from milestones m
       where m.workspace_id = ${workspaceId} and m.name = ${input.milestone}
         ${ventureId ? sql`and m.venture_id = ${ventureId}` : sql``}
       limit 1
    `;
    milestoneId = rows[0]?.id ?? null;
    if (!milestoneId) notes.push(`no milestone matched "${input.milestone}"; stored without one`);
    else ventureId ??= rows[0]!.venture_id;
  }

  return {
    venture_id: ventureId,
    project_id: projectId,
    milestone_id: milestoneId,
    task_id: taskId,
    notes,
  };
}

function storagePathFor(workspaceId: string, documentId: string, filename: string): string {
  return `${workspaceId}/${documentId}/${safeFilename(filename)}`;
}

// ---------------------------------------------------------------------------
// attach_document
// ---------------------------------------------------------------------------

export interface AttachDocumentInput extends Attachment {
  title: string;
  filename: string;
  content_base64?: string;
  content_text?: string;
  mime_type?: string;
  notes?: string;
  idempotency_key?: string;
}

export async function attachDocument(
  sql: Sql,
  input: AttachDocumentInput,
): Promise<ToolEnvelope> {
  const replay = await findReplay(sql, input.idempotency_key);
  if (replay) {
    return envelope(
      plainConfidence(['replayed: this idempotency_key was already used, nothing was written']),
      { ...(replay.result as Record<string, unknown>), replayed: true, originally_at: replay.at },
    );
  }

  if (!input.content_base64 && input.content_text === undefined) {
    return envelope(
      plainConfidence([]),
      { stored: false },
      [
        {
          code: 'no_content',
          message:
            'attach_document needs content_base64 or content_text. For a file you do not hold the bytes of, use create_upload_link instead.',
        },
      ],
    );
  }

  let bytes: Uint8Array;
  if (input.content_base64) {
    try {
      bytes = new Uint8Array(Buffer.from(input.content_base64, 'base64'));
    } catch {
      return envelope(plainConfidence([]), { stored: false }, [
        { code: 'bad_base64', message: 'content_base64 is not valid base64' },
      ]);
    }
  } else {
    bytes = new Uint8Array(Buffer.from(input.content_text ?? '', 'utf8'));
  }

  if (bytes.byteLength === 0) {
    return envelope(plainConfidence([]), { stored: false }, [
      { code: 'empty', message: 'the content was empty; nothing was stored' },
    ]);
  }
  if (bytes.byteLength > MAX_INLINE_BYTES) {
    return envelope(plainConfidence([]), { stored: false }, [
      {
        code: 'too_large',
        message: `${bytes.byteLength} bytes exceeds the ${MAX_INLINE_BYTES}-byte inline limit. Use create_upload_link, which moves the file directly and has no such cap.`,
      },
    ]);
  }

  const storage = storageConfig();
  const workspaceId = await resolveWorkspaceId(sql);
  const resolved = await resolveAttachment(sql, workspaceId, input);
  const documentId = randomUUID();
  const path = storagePathFor(workspaceId, documentId, input.filename);
  const mime =
    input.mime_type ?? (input.content_text !== undefined ? 'text/plain' : 'application/octet-stream');

  if (!storage.configured) {
    // D8: degraded, not broken. Nothing is written, because a metadata row
    // pointing at bytes that were never stored is worse than no row.
    return envelope(plainConfidence([storage.reason]), { stored: false }, [
      { code: 'storage_unconfigured', message: storage.reason },
    ]);
  }

  await uploadBytes(storage.config, path, bytes, mime);

  const sha = createHash('sha256').update(bytes).digest('hex');
  const inserted = await sql.begin(async (tx) => {
    const rows = await tx<Array<{ id: string; created_at: Date }>>`
      insert into documents (id, workspace_id, venture_id, project_id, milestone_id, task_id,
                             title, notes, storage_path, mime_type, size_bytes, sha256,
                             status, source, stored_at)
      values (${documentId}, ${workspaceId}, ${resolved.venture_id}, ${resolved.project_id},
              ${resolved.milestone_id}, ${resolved.task_id}, ${input.title},
              ${input.notes ?? null}, ${path}, ${mime}, ${bytes.byteLength}, ${sha},
              'stored', 'claude', now())
      returning id, created_at
    `;
    await recordReceipt(tx, {
      key: input.idempotency_key,
      actor: ACTOR,
      verb: 'attached_document',
      workspace_id: workspaceId,
      venture_id: resolved.venture_id ?? undefined,
      result: { document_id: documentId, title: input.title, bytes: bytes.byteLength },
    });
    return rows[0]!;
  });

  return envelope(
    plainConfidence([
      'stored verbatim; TaskOS does not read or interpret document contents',
      ...resolved.notes,
    ]),
    {
      stored: true,
      document: {
        id: inserted.id,
        title: input.title,
        bytes: bytes.byteLength,
        mime_type: mime,
        sha256: sha,
        attached_to: attachedTo(resolved, input),
      },
    },
  );
}

function attachedTo(resolved: ResolvedAttachment, input: Attachment) {
  return {
    venture: resolved.venture_id ? (input.venture ?? 'inherited from the task') : null,
    project: resolved.project_id ? (input.project ?? 'inherited from the task') : null,
    milestone: resolved.milestone_id ? input.milestone : null,
    task_id: resolved.task_id,
  };
}

// ---------------------------------------------------------------------------
// create_upload_link
// ---------------------------------------------------------------------------

export interface CreateUploadLinkInput extends Attachment {
  title: string;
  filename: string;
  mime_type?: string;
  notes?: string;
}

/**
 * The main ingest path. Returns a URL the person uploads to directly.
 *
 * The row is written first, as 'pending'. That ordering is deliberate: a link
 * with no row behind it produces an orphan object nothing can find, whereas a
 * row with no object is visible, labelled pending, and self-corrects the next
 * time list_documents reconciles against the bucket.
 */
export async function createUploadLink(
  sql: Sql,
  input: CreateUploadLinkInput,
): Promise<ToolEnvelope> {
  const storage = storageConfig();
  if (!storage.configured) {
    return envelope(plainConfidence([storage.reason]), { link: null }, [
      { code: 'storage_unconfigured', message: storage.reason },
    ]);
  }

  const workspaceId = await resolveWorkspaceId(sql);
  const resolved = await resolveAttachment(sql, workspaceId, input);
  const documentId = randomUUID();
  const path = storagePathFor(workspaceId, documentId, input.filename);

  const { uploadUrl, token } = await createSignedUploadUrl(storage.config, path);

  await sql`
    insert into documents (id, workspace_id, venture_id, project_id, milestone_id, task_id,
                           title, notes, storage_path, mime_type, status, source)
    values (${documentId}, ${workspaceId}, ${resolved.venture_id}, ${resolved.project_id},
            ${resolved.milestone_id}, ${resolved.task_id}, ${input.title},
            ${input.notes ?? null}, ${path}, ${input.mime_type ?? null}, 'pending', 'upload_link')
  `;

  return envelope(
    plainConfidence([
      'the link is single-use and expires; the document stays "pending" until the upload is seen',
      ...resolved.notes,
    ]),
    {
      document_id: documentId,
      title: input.title,
      upload_url: uploadUrl,
      upload_token: token,
      how: [
        'Open the upload_url in a browser and select the file, or:',
        `curl -X PUT "${uploadUrl}" -H "authorization: Bearer ${token}" --data-binary @${safeFilename(input.filename)}`,
      ],
      bucket: BUCKET,
      status: 'pending',
    },
  );
}

// ---------------------------------------------------------------------------
// list_documents
// ---------------------------------------------------------------------------

export interface ListDocumentsInput {
  venture?: string;
  task_id?: string;
  milestone?: string;
  search?: string;
}

/**
 * What is attached, and to what.
 *
 * Reconciles pending rows against the bucket in one listing, because Storage
 * sends no completion callback. If storage cannot be reached the rows are still
 * returned — with a note saying the upload state is as last known rather than
 * as it is now. Partial results beat an exception (D8).
 */
export async function listDocuments(sql: Sql, input: ListDocumentsInput): Promise<ToolEnvelope> {
  const workspaceId = await resolveWorkspaceId(sql);
  const notes: string[] = [];

  const rows = await sql<DocumentRow[]>`
    select d.id, d.title, d.notes, d.storage_path, d.mime_type, d.size_bytes,
           d.status, d.source, d.created_at,
           v.slug as venture_slug, p.name as project_name,
           m.name as milestone_name, t.title as task_title
      from documents d
      left join ventures v on v.id = d.venture_id
      left join projects p on p.id = d.project_id
      left join milestones m on m.id = d.milestone_id
      left join tasks t on t.id = d.task_id
     where d.workspace_id = ${workspaceId}
       ${input.venture ? sql`and (v.slug = ${input.venture} or v.name = ${input.venture})` : sql``}
       ${input.task_id ? sql`and d.task_id = ${input.task_id}` : sql``}
       ${input.milestone ? sql`and m.name = ${input.milestone}` : sql``}
       ${
         input.search
           ? sql`and (d.title ilike ${'%' + input.search + '%'} or d.notes ilike ${'%' + input.search + '%'})`
           : sql``
       }
     order by d.created_at desc
  `;

  const reconciled = await reconcilePending(sql, workspaceId, rows, notes);

  const list = narrow(
    reconciled.map((d) => ({
      id: d.id,
      title: d.title,
      status: d.status,
      size_bytes: d.size_bytes === null ? null : Number(d.size_bytes),
      mime_type: d.mime_type,
      source: d.source,
      created_at: d.created_at.toISOString().slice(0, 10),
      notes: d.notes,
      attached_to: {
        venture: d.venture_slug,
        project: d.project_name,
        milestone: d.milestone_name,
        task: d.task_title,
      },
    })),
  );

  const pending = reconciled.filter((d) => d.status === 'pending').length;
  if (pending > 0) {
    notes.push(
      `${pending} document(s) are pending: a link was issued and no file has arrived yet. They are not readable until uploaded.`,
    );
  }
  const missing = reconciled.filter((d) => d.status === 'missing').length;
  if (missing > 0) {
    notes.push(
      `${missing} document(s) are recorded but absent from storage. Something deleted the object; the metadata is all that remains.`,
    );
  }

  return envelope(plainConfidence(notes), { documents: list.items, total: list.total, ...(list.truncated ? { truncated: list.truncated } : {}) });
}

/**
 * Bring pending rows up to date against what is actually in the bucket.
 *
 * Mutates the rows it is given and writes the changes back, so a single listing
 * both reports and repairs. Only pending rows are examined: a document already
 * marked stored is not re-checked on every list, because that would turn a
 * cheap read into a slow one for no new information.
 */
async function reconcilePending(
  sql: Sql,
  workspaceId: string,
  rows: DocumentRow[],
  notes: string[],
): Promise<DocumentRow[]> {
  const pending = rows.filter((r) => r.status === 'pending');
  if (pending.length === 0) return rows;

  const storage = storageConfig();
  if (!storage.configured) {
    notes.push(`${storage.reason} Upload state below is as last recorded, not as it is now.`);
    return rows;
  }

  let objects;
  try {
    objects = await listObjects(storage.config, `${workspaceId}/`);
  } catch (e) {
    notes.push(
      `could not reach storage to confirm pending uploads (${
        e instanceof Error ? e.message : String(e)
      }); upload state below is as last recorded`,
    );
    return rows;
  }

  const byPath = new Map(objects.map((o) => [o.path, o]));
  const arrived: Array<{ id: string; size: number | null; mime: string | null }> = [];
  for (const row of pending) {
    const found = byPath.get(row.storage_path);
    if (!found) continue;
    row.status = 'stored';
    row.size_bytes = found.size === null ? null : String(found.size);
    row.mime_type = row.mime_type ?? found.mimeType;
    arrived.push({ id: row.id, size: found.size, mime: found.mimeType });
  }

  for (const a of arrived) {
    await sql`
      update documents
         set status = 'stored', stored_at = now(), checked_at = now(),
             size_bytes = coalesce(${a.size}, size_bytes),
             mime_type = coalesce(mime_type, ${a.mime})
       where id = ${a.id} and workspace_id = ${workspaceId}
    `;
  }
  if (arrived.length > 0) notes.push(`${arrived.length} upload(s) confirmed just now`);
  return rows;
}

// ---------------------------------------------------------------------------
// get_document
// ---------------------------------------------------------------------------

export interface GetDocumentInput {
  document_id: string;
  expires_in_seconds?: number;
}

export async function getDocument(sql: Sql, input: GetDocumentInput): Promise<ToolEnvelope> {
  const workspaceId = await resolveWorkspaceId(sql);
  const rows = await sql<DocumentRow[]>`
    select d.id, d.title, d.notes, d.storage_path, d.mime_type, d.size_bytes,
           d.status, d.source, d.created_at,
           v.slug as venture_slug, p.name as project_name,
           m.name as milestone_name, t.title as task_title
      from documents d
      left join ventures v on v.id = d.venture_id
      left join projects p on p.id = d.project_id
      left join milestones m on m.id = d.milestone_id
      left join tasks t on t.id = d.task_id
     where d.workspace_id = ${workspaceId} and d.id = ${input.document_id}
     limit 1
  `;
  const doc = rows[0];
  if (!doc) {
    return envelope(plainConfidence([]), { document: null }, [
      {
        code: 'not_found',
        message: `no document ${input.document_id} in this workspace`,
      },
    ]);
  }

  const storage = storageConfig();
  const body = {
    document: {
      id: doc.id,
      title: doc.title,
      notes: doc.notes,
      status: doc.status,
      mime_type: doc.mime_type,
      size_bytes: doc.size_bytes === null ? null : Number(doc.size_bytes),
      created_at: doc.created_at.toISOString().slice(0, 10),
      attached_to: {
        venture: doc.venture_slug,
        project: doc.project_name,
        milestone: doc.milestone_name,
        task: doc.task_title,
      },
    },
  };

  if (!storage.configured) {
    return envelope(plainConfidence([storage.reason]), { ...body, url: null }, [
      { code: 'storage_unconfigured', message: storage.reason },
    ]);
  }
  if (doc.status === 'pending') {
    return envelope(
      plainConfidence(['this document has no file yet: the upload link was issued but nothing arrived']),
      { ...body, url: null },
      [{ code: 'not_uploaded', message: 'nothing has been uploaded against this document yet' }],
    );
  }

  const expires = Math.min(
    Math.max(input.expires_in_seconds ?? DEFAULT_EXPIRY_SECONDS, 60),
    MAX_EXPIRY_SECONDS,
  );

  try {
    const url = await createSignedDownloadUrl(storage.config, doc.storage_path, expires);
    return envelope(
      plainConfidence([
        `this link expires in ${expires} seconds; anyone holding it can read the file until then`,
      ]),
      { ...body, url, expires_in_seconds: expires },
    );
  } catch (e) {
    // The row says stored and storage disagrees. Say exactly that rather than
    // returning a broken link.
    await sql`update documents set status = 'missing', checked_at = now()
               where id = ${doc.id} and workspace_id = ${workspaceId}`;
    return envelope(
      plainConfidence(['the metadata row survives, but the file behind it does not']),
      { ...body, url: null },
      [
        {
          code: 'object_missing',
          message: `storage has no object at ${doc.storage_path}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        },
      ],
    );
  }
}

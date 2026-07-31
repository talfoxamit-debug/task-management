import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { INSTRUCTIONS } from './instructions.js';
import { listSuggestions, resolveSuggestion, suggestImprovement } from './feedback.js';
import { closeMany, killTask, reopenTask, snoozeTask, updateTask } from './edit.js';
import {
  createPerson,
  deleteMilestone,
  deleteOutcomeTarget,
  listMilestones,
  listPeople,
  listVentures,
  setVenture,
} from './registry.js';
import type { Sql } from './db.js';
import { errorResult, jsonResult } from './narrow.js';
import {
  attachDocument,
  createUploadLink,
  getDocument,
  listDocuments,
} from './documents.js';
import {
  capacity,
  capture,
  close,
  commitTasks,
  listTasks,
  processInbox,
  setMilestone,
  setOutcomeTarget,
  ventureStatus,
} from './tools.js';

/**
 * Tool registration, in the order Part 5 lists them.
 *
 * Descriptions matter more here than usual: they are the entire interface Claude
 * sees, and a tool whose purpose is ambiguous gets called for the wrong thing.
 * In particular set_milestone and set_outcome_target must never be confused —
 * that distinction (D1) is the most important one in the system.
 */

const criticality = z.enum(['blocking', 'enabling', 'supporting', 'optional']);
const context = z.enum([
  'deep_work',
  'calls',
  'admin',
  'errands',
  'creative',
  'review',
  'physical',
]);
const energy = z.enum(['high', 'medium', 'low']);
const taskStatus = z.enum(['inbox', 'active', 'blocked', 'waiting', 'parked', 'done', 'killed']);
const civilDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a calendar date, YYYY-MM-DD, never a timestamp');

/** Any thrown error becomes a readable tool error rather than a 500. */
async function guard(fn: () => Promise<unknown>) {
  try {
    return jsonResult(await fn());
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return errorResult(message, {
      hint: 'nothing was written unless the message says otherwise; transactions roll back as a whole',
    });
  }
}

export function buildServer(sql: Sql): McpServer {
  const server = new McpServer(
    { name: 'taskos', version: '1.0.0' },
    {
      instructions: INSTRUCTIONS,
    },
  );

  server.registerTool(
    'capture',
    {
      title: 'Capture to inbox',
      description:
        'Put raw text into the inbox with NO parsing and no interpretation. One inbox item per line. Use this the moment something is mentioned; sorting happens later via process_inbox. Returns the created ids.',
      inputSchema: {
        text: z.string().min(1).describe('Raw text. Newlines and bullets become separate items.'),
        idempotency_key: z
          .string()
          .optional()
          .describe('Repeat calls with the same key return the original result and write nothing.'),
      },
    },
    async (args) => guard(() => capture(sql, args)),
  );

  server.registerTool(
    'process_inbox',
    {
      title: 'Propose fields for inbox items',
      description:
        'Return unprocessed inbox items with PROPOSED venture, project, criticality, context, estimate and value. These are keyword-rule proposals, not a parse — present them to Tal for confirmation and pass the confirmed versions to commit_tasks. Writes nothing.',
      inputSchema: {},
    },
    async () => guard(() => processInbox(sql)),
  );

  server.registerTool(
    'commit_tasks',
    {
      title: 'Write confirmed tasks',
      description:
        'Write confirmed tasks in one transaction, with dependency edges given by task title. Use `depends_on` for what must finish first and `blocks` for what waits on this. Set from_inbox_task_id to convert an existing inbox item rather than creating a duplicate. Dependency edges are what give a milestone trustworthy slack, so add them whenever the order actually matters.',
      inputSchema: {
        tasks: z
          .array(
            z.object({
              title: z.string().min(1),
              venture: z.string().describe('Venture slug or name.'),
              from_inbox_task_id: z.string().optional(),
              project: z.string().optional(),
              milestone: z.string().optional().describe('Milestone name within that venture.'),
              notes: z.string().optional(),
              criticality: criticality.optional(),
              context: context.optional(),
              energy: energy.optional(),
              estimate_minutes: z.number().int().positive().optional(),
              value: z.number().int().min(1).max(10).optional(),
              deadline_date: civilDate.optional(),
              deadline_time: z.string().optional().describe('HH:MM:SS, optional.'),
              target_date: civilDate.optional(),
              lead_time_days: z.number().int().positive().optional(),
              status: taskStatus.optional(),
              assignee: z.string().optional().describe('Person name.'),
              is_recurring: z.boolean().optional(),
              recurrence_rule: z
                .string()
                .optional()
                .describe('Required when is_recurring. e.g. FREQ=DAILY or FREQ=WEEKLY;BYDAY=MO.'),
              blocks: z.array(z.string()).optional().describe('Titles this task must precede.'),
              depends_on: z.array(z.string()).optional().describe('Titles that must finish first.'),
            }),
          )
          .min(1),
        idempotency_key: z.string().optional(),
      },
    },
    async (args) => guard(() => commitTasks(sql, args)),
  );

  server.registerTool(
    'set_milestone',
    {
      title: 'Set a milestone (an event Tal controls)',
      description:
        'Create or update a MILESTONE: an event Tal controls and can put on a critical path, such as "YachtyHub live" or "pricing page shipped". Milestones drive demand. Do NOT use this for a result someone else decides — a first sale, a reply, an approval — that is set_outcome_target.',
      inputSchema: {
        venture: z.string(),
        name: z.string(),
        due_date: civilDate,
        hardness: z
          .enum(['hard', 'soft'])
          .describe('hard means the date itself cannot move; it multiplies demand by 1.5.'),
        cost_of_slip: z
          .string()
          .describe(
            'What actually happens if this slips. Lead with a severity word (critical/high/medium/low) — the slip ranking orders by it.',
          ),
        idempotency_key: z.string().optional(),
      },
    },
    async (args) => guard(() => setMilestone(sql, args)),
  );

  server.registerTool(
    'set_outcome_target',
    {
      title: 'Set an outcome target (a result someone else decides)',
      description:
        'Create or update an OUTCOME TARGET: a result someone else decides, such as "first sale" or "lead signs". It has no critical path, drives no demand and never gets slack computed — it is tracked only by leading indicators. Link the milestones believed to cause it. Use set_milestone for anything Tal controls directly.',
      inputSchema: {
        venture: z.string(),
        name: z.string(),
        target_date: civilDate.nullable().optional(),
        milestone_ids: z
          .array(z.string())
          .optional()
          .describe('Ids of the milestones believed to cause this outcome.'),
        indicators: z
          .array(z.string())
          .optional()
          .describe('Leading indicators to track. Defaults to proposals_sent, demos_booked, follow_ups_open, pipeline_count.'),
        idempotency_key: z.string().optional(),
      },
    },
    async (args) => guard(() => setOutcomeTarget(sql, args)),
  );

  server.registerTool(
    'capacity',
    {
      title: 'What is going to slip',
      description:
        'THE MAIN TOOL. Runs slack, then coverage, then demand, then the capacity check against the hours given. Returns each venture\'s share of the week, the hours deficit, and the ranked list of what slips first, cheapest to give up first. Available hours are reduced by recurring overhead and then by a 20% buffer before anything is allocated. Read confidence.notes before presenting the numbers.',
      inputSchema: {
        available_hours: z
          .number()
          .min(0)
          .describe('Real hours available for work this week, before overhead and buffer.'),
      },
    },
    async (args) => guard(() => capacity(sql, args)),
  );

  server.registerTool(
    'venture_status',
    {
      title: 'One venture in detail',
      description:
        'Milestones with slack and dependency coverage, open blocking tasks ordered by slack, outcome-target indicators, and the top 5 tasks by score for one venture.',
      inputSchema: { slug: z.string().describe('Venture slug, e.g. yachtyhub.') },
    },
    async (args) => guard(() => ventureStatus(sql, args)),
  );

  server.registerTool(
    'list_tasks',
    {
      title: 'List tasks',
      description:
        'Filtered task list, highest score first, capped at 15 with a total. Filter by venture, status, criticality, milestone, or needs_triage for work snoozed three times or more.',
      inputSchema: {
        venture: z.string().optional(),
        status: taskStatus.optional(),
        criticality: criticality.optional(),
        milestone: z.string().optional(),
        needs_triage: z.boolean().optional(),
      },
    },
    async (args) => guard(() => listTasks(sql, args)),
  );

  server.registerTool(
    'close',
    {
      title: 'Close a task',
      description:
        'Mark a task done. Pass actual_minutes ONLY if Tal volunteered how long it took — a volunteered duration is a measurement and feeds calibration, while an unstated one records the estimate as provisional. Closing an already-closed task succeeds and changes nothing.',
      inputSchema: {
        task_id: z.string(),
        actual_minutes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Only when Tal actually said how long it took. Never guess this.'),
        evidence: z.string().optional().describe('What shows it is done.'),
        idempotency_key: z.string().optional(),
      },
    },
    async (args) => guard(() => close(sql, args)),
  );

  // -------------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------------
  // The descriptions carry one distinction that Claude will otherwise get
  // wrong every time: attach_document needs the bytes in the tool call, which
  // only works for small text-ish files, and create_upload_link is for
  // everything else. Getting this backwards means either a failed call on a
  // large file or a pointless round trip on a small one.

  const attachment = {
    venture: z.string().optional().describe('Venture slug or name.'),
    project: z.string().optional(),
    milestone: z.string().optional().describe('Milestone name within that venture.'),
    task_id: z.string().optional().describe('Attaching to a task also files it under that task\'s venture and project.'),
  };

  server.registerTool(
    'attach_document',
    {
      title: 'Attach a small document inline',
      description:
        'Store a document whose CONTENT YOU ALREADY HAVE, passed inline as content_text or content_base64. Suitable for notes, specs, CSVs and small PDFs up to 5MB. For anything larger, or any file you cannot read the bytes of, use create_upload_link instead — inline content travels inside the tool call and a big file will simply not fit. TaskOS stores the file verbatim and never reads or interprets it.',
      inputSchema: {
        title: z.string().min(1).describe('What this document is, in words. Not the filename.'),
        filename: z.string().min(1).describe('e.g. contract.pdf — used for the stored path and the extension.'),
        content_text: z.string().optional().describe('For text documents. Use this or content_base64, not both.'),
        content_base64: z.string().optional().describe('Base64 for binary. Max 5MB decoded.'),
        mime_type: z.string().optional(),
        notes: z.string().optional().describe('Why this matters and what it is for. This is what makes it useful as context later.'),
        ...attachment,
        idempotency_key: z.string().optional(),
      },
    },
    async (args) => guard(() => attachDocument(sql, args)),
  );

  server.registerTool(
    'create_upload_link',
    {
      title: 'Get a link to upload a file to',
      description:
        'Create a document record and return a short-lived URL Tal can upload the file to directly. Use this for anything you do not hold the bytes of, and for anything over 5MB — decks, scans, photos, large PDFs. The document is recorded immediately as "pending" and becomes readable once the upload arrives; list_documents confirms it. Give Tal the upload_url.',
      inputSchema: {
        title: z.string().min(1),
        filename: z.string().min(1),
        mime_type: z.string().optional(),
        notes: z.string().optional(),
        ...attachment,
      },
    },
    async (args) => guard(() => createUploadLink(sql, args)),
  );

  server.registerTool(
    'list_documents',
    {
      title: 'List attached documents',
      description:
        'What documents exist and what they are attached to. Filter by venture, task, milestone, or a text search over titles and notes. Also confirms any pending uploads that have since arrived. Capped at 15 with a true total.',
      inputSchema: {
        venture: z.string().optional(),
        task_id: z.string().optional(),
        milestone: z.string().optional(),
        search: z.string().optional().describe('Matches title and notes.'),
      },
    },
    async (args) => guard(() => listDocuments(sql, args)),
  );

  server.registerTool(
    'get_document',
    {
      title: 'Get a link to read a document',
      description:
        'Return a short-lived signed URL for one document, plus what it is attached to. The URL expires — treat it as single-use and do not store it. Use this when you need to actually read a file Tal referred to.',
      inputSchema: {
        document_id: z.string(),
        expires_in_seconds: z
          .number()
          .int()
          .optional()
          .describe('Default 900, maximum 3600. Shorter is safer.'),
      },
    },
    async (args) => guard(() => getDocument(sql, args)),
  );

  // -------------------------------------------------------------------------
  // Feedback to the person who builds this
  // -------------------------------------------------------------------------
  // Tal writes TaskOS. Agents using it are the ones who meet its edges, and
  // until now every one of those observations died with the conversation. The
  // description below has to do two jobs at once: invite the report, and stop
  // it becoming a suggestion box that nobody reads.

  server.registerTool(
    'suggest_improvement',
    {
      title: 'Tell Tal what this system is missing',
      description:
        'Tal BUILDS this system and can change it. File a bug, a missing capability, or friction you actually hit — a tool that could not express what was needed, an answer that did not answer the question, a limit you had to work around. File it WHEN IT HAPPENS, from the real occasion, and include what you were trying to do. Do not file speculative wishlists, and do not derail what Tal asked for to discuss it — file it and mention it in a sentence. Re-reporting the same title increments a counter rather than duplicating, so say so again if you hit it again. This is NOT a task: it takes no share of the week and drives no demand.',
      inputSchema: {
        kind: z
          .enum(['bug', 'feature', 'improvement', 'friction', 'question'])
          .describe(
            'bug: it does the wrong thing. feature: it cannot do this at all. improvement: it works but badly. friction: it works but cost you a workaround. question: the design is unclear.',
          ),
        title: z
          .string()
          .min(4)
          .describe('Short and specific — this is the dedupe key, so phrase it as the problem.'),
        detail: z.string().min(10).describe('What is wrong or missing, and what good would look like.'),
        trigger_context: z
          .string()
          .optional()
          .describe(
            'The concrete moment: the call that failed, the question you could not answer, the workaround you used. A request without its occasion is a wish.',
          ),
        severity: z
          .enum(['blocking', 'high', 'medium', 'low'])
          .optional()
          .describe('blocking means you could not complete what Tal asked. Reserve it for that.'),
        reported_from: z.string().optional().describe('Which surface, e.g. "claude session".'),
      },
    },
    async (args) => guard(() => suggestImprovement(sql, args)),
  );

  server.registerTool(
    'list_suggestions',
    {
      title: 'What has been reported about this system',
      description:
        'Everything filed via suggest_improvement, worst and most-repeated first. Check here before filing something that sounds familiar, and use it when Tal asks what needs building.',
      inputSchema: {
        status: z.enum(['open', 'planned', 'done', 'declined']).optional().describe('Default open.'),
        kind: z.enum(['bug', 'feature', 'improvement', 'friction', 'question']).optional(),
      },
    },
    async (args) => guard(() => listSuggestions(sql, args)),
  );

  server.registerTool(
    'resolve_suggestion',
    {
      title: 'Mark a suggestion planned, built or declined',
      description:
        "Tal's side of the loop. Use only when Tal says what he has decided about a suggestion — never to tidy the list on your own judgement. A declined item that gets reported again reopens itself, because being hit twice is new evidence.",
      inputSchema: {
        id: z.string(),
        status: z.enum(['open', 'planned', 'done', 'declined']),
        note: z.string().optional().describe("Tal's reasoning, in his words where possible."),
      },
    },
    async (args) => guard(() => resolveSuggestion(sql, args)),
  );

  // -------------------------------------------------------------------------
  // Correction
  // -------------------------------------------------------------------------
  // The system could create work and complete it and nothing in between, so
  // every mistake was permanent. These are what make it repairable.

  server.registerTool(
    'update_task',
    {
      title: 'Change fields on an existing task',
      description:
        'Partial update: ONLY the fields you supply change, everything else is untouched. Pass an explicit null to CLEAR a nullable field (deadline_date, target_date, assignee, milestone, project) — omitting it leaves it alone, which is a different thing. Returns the whole task afterwards so you do not need a second read. Use this rather than creating a corrected duplicate.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        task_id: z.string(),
        title: z.string().optional(),
        venture: z.string().optional().describe('Slug or name.'),
        project: z.string().nullable().optional(),
        milestone: z.string().nullable().optional().describe('null detaches it from its milestone.'),
        status: taskStatus.optional(),
        criticality: criticality.optional(),
        context: context.optional(),
        energy: energy.optional(),
        estimate_minutes: z.number().int().positive().optional(),
        value: z.number().int().min(1).max(10).optional(),
        deadline_date: civilDate.nullable().optional(),
        deadline_time: z.string().nullable().optional(),
        target_date: civilDate.nullable().optional(),
        lead_time_days: z.number().int().positive().nullable().optional(),
        assignee: z.string().nullable().optional().describe('Person name; null unassigns.'),
        is_recurring: z
          .boolean()
          .optional()
          .describe('Setting false also clears the rule. Setting true without a rule is an error.'),
        recurrence_rule: z.string().nullable().optional(),
        notes: z.string().optional(),
        kill_reason: z
          .string()
          .nullable()
          .optional()
          .describe(
            'Required when setting status to killed. Prefer kill_task, which records it for you.',
          ),
        idempotency_key: z.string().optional(),
      },
    },
    async (args) => guard(() => updateTask(sql, args)),
  );

  server.registerTool(
    'kill_task',
    {
      title: 'Kill a task that should never have been on the list',
      description:
        'Mark a task killed. NOT the same as close: close means it happened, kill means it should not have been here or the world changed. The difference is not cosmetic — close feeds calibration, so closing a mistaken task teaches the estimator from a fiction. A killed task contributes no demand and drops out of capacity.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      inputSchema: {
        task_id: z.string(),
        reason: z.string().optional().describe('Why it is not real work. Recorded permanently.'),
        idempotency_key: z.string().optional(),
      },
    },
    async (args) => guard(() => killTask(sql, args)),
  );

  server.registerTool(
    'reopen_task',
    {
      title: 'Undo a close',
      description:
        'Return a done or killed task to active. By default it clears the recorded actual_minutes, because a mistaken close otherwise keeps teaching calibration a duration that never happened. Pass clear_actual:false only if the time really was spent.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        task_id: z.string(),
        clear_actual: z.boolean().optional().describe('Default true.'),
        idempotency_key: z.string().optional(),
      },
    },
    async (args) => guard(() => reopenTask(sql, args)),
  );

  server.registerTool(
    'snooze_task',
    {
      title: 'Defer a task, and count it',
      description:
        'Push a task out and increment its snooze counter. At three snoozes it leaves the ranking entirely and shows up as needing triage — the repeatedly-deferred task is the highest-signal object in the system, and that is what this counter is for. Give until (a date) or days.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: {
        task_id: z.string(),
        until: civilDate.optional(),
        days: z.number().int().positive().optional(),
        reason: z.string().optional().describe('Why it is being pushed. This is the useful part.'),
      },
    },
    async (args) => guard(() => snoozeTask(sql, args)),
  );

  server.registerTool(
    'close_many',
    {
      title: 'Close several tasks at once',
      description:
        'An evening wrap-up in one call. Same rule as close: pass actual_minutes ONLY where Tal volunteered a duration, never inferred. Partial success is reported per task — some closing while others fail is normal and is not an error.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        closures: z
          .array(
            z.object({
              task_id: z.string(),
              actual_minutes: z.number().int().positive().optional(),
              evidence: z.string().optional(),
            }),
          )
          .min(1),
        idempotency_key: z.string().optional(),
      },
    },
    async (args) => guard(() => closeMany(sql, args)),
  );

  // -------------------------------------------------------------------------
  // Enumeration — you cannot audit what you cannot list
  // -------------------------------------------------------------------------

  server.registerTool(
    'list_ventures',
    {
      title: 'Every venture, with its slug',
      description:
        'The ventures, their slugs, weights, floors, ceilings and whether they are active — plus open task and milestone counts. Call this when you need a slug, rather than guessing one and reading it out of an error message.',
      annotations: { readOnlyHint: true },
      inputSchema: { active: z.boolean().optional() },
    },
    async (args) => guard(() => listVentures(sql, args)),
  );

  server.registerTool(
    'set_venture',
    {
      title: 'Create, rename or retune a venture',
      description:
        'Change a venture\'s name, slug, strategic weight, floor, ceiling or active flag; pass create:true to make a new one. A slug rename carries every task, milestone and outcome target with it, because they reference it by id. Weights and floors change what the whole portfolio recommends — only set them when Tal says so.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        slug: z.string().describe('The venture to change, by current slug or name.'),
        create: z.boolean().optional().describe('Make it if it does not exist.'),
        name: z.string().optional(),
        new_slug: z.string().optional(),
        weight: z.number().min(0.3).max(2).optional(),
        floor: z.number().min(0).max(0.5).optional(),
        ceiling: z.number().min(0.1).max(1).optional(),
        active: z.boolean().optional(),
        idempotency_key: z.string().optional(),
      },
    },
    async (args) => guard(() => setVenture(sql, args)),
  );

  server.registerTool(
    'list_milestones',
    {
      title: 'Every milestone, including the stale ones',
      description:
        'All milestones with venture, due date, hardness, cost of slip, status and how many tasks are attached. Flags the two conditions that make a slip ranking read as nonsense: an active milestone with NO attached tasks (it frees nothing when slipped) and one whose venture is inactive (its demand is silently not counted).',
      annotations: { readOnlyHint: true },
      inputSchema: {
        venture: z.string().optional(),
        status: z.enum(['active', 'hit', 'missed', 'dropped']).optional(),
        include_outcome_targets: z.boolean().optional(),
      },
    },
    async (args) => guard(() => listMilestones(sql, args)),
  );

  server.registerTool(
    'delete_milestone',
    {
      title: 'Delete a milestone',
      description:
        'Remove a milestone. REFUSES by default if tasks are attached, and tells you how many and which — detaching work silently is how a critical path disappears without anyone noticing. Pass force:true to detach and delete anyway; the tasks survive, unattached.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      inputSchema: {
        milestone_id: z.string(),
        force: z.boolean().optional(),
        idempotency_key: z.string().optional(),
      },
    },
    async (args) => guard(() => deleteMilestone(sql, args)),
  );

  server.registerTool(
    'delete_outcome_target',
    {
      title: 'Delete an outcome target',
      description:
        'Remove an outcome target and its milestone links. Nothing is orphaned: outcome targets own no tasks and drive no demand.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      inputSchema: { outcome_id: z.string(), idempotency_key: z.string().optional() },
    },
    async (args) => guard(() => deleteOutcomeTarget(sql, args)),
  );

  server.registerTool(
    'create_person',
    {
      title: 'Record someone work can be delegated to',
      description:
        'Create a person so commit_tasks and update_task can assign to them. Give hours_per_week when Tal states it — delegated capacity is the real limit on what can come off his own week, and it cannot be reported without knowing how much of theirs exists. Calling again with the same name updates rather than duplicating.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        name: z.string().min(1),
        role: z.string().optional(),
        hours_per_week: z.number().min(0).max(168).optional().describe('Only if Tal stated it.'),
        active: z.boolean().optional(),
        idempotency_key: z.string().optional(),
      },
    },
    async (args) => guard(() => createPerson(sql, args)),
  );

  server.registerTool(
    'list_people',
    {
      title: 'Who work can go to, and how loaded they are',
      description:
        'Everyone recorded, with their stated week and how many open hours are already assigned to them. Use it before delegating, and to answer what is actually on someone.',
      annotations: { readOnlyHint: true },
      inputSchema: { active: z.boolean().optional() },
    },
    async (args) => guard(() => listPeople(sql, args)),
  );

  return server;
}

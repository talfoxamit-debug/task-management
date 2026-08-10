import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { INSTRUCTIONS } from './instructions.js';
import { listSuggestions, resolveSuggestion, suggestImprovement } from './feedback.js';
import {
  awaitingReview,
  closeMany,
  killTask,
  linkTasks,
  markPrepared,
  reopenTask,
  snoozeTask,
  updateTask,
} from './edit.js';
import { getContext } from './context.js';
import { dayPlan, setWorkHours } from './day-plan.js';
import { commentOnTask, delegationInbox } from './delegate-inbox.js';
import { pairPersonChat, sendWorkToPerson } from './worker-chat.js';
import { delegateLink, listDelegationLinks, ownerLink, revokeDelegation } from './delegation.js';
import { getDayAllocation, nextActions, setDayAllocation } from './next-actions.js';
import {
  createPerson,
  deleteMilestone,
  deleteOutcomeTarget,
  listMilestones,
  listPeople,
  listProjects,
  listVentures,
  moveMilestone,
  setProject,
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
              ai_preparable: z
                .boolean()
                .optional()
                .describe(
                  'You can produce a usable first draft of this before Tal reaches it. Set it only after reading the task — day_plan books the REVIEW rather than the build for anything flagged, so a wrong flag books 15 minutes where 2 hours were needed.',
                ),
              review_minutes: z
                .number()
                .int()
                .positive()
                .optional()
                .describe('How long reviewing your draft takes. Meaningful with ai_preparable.'),
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
    'get_context',
    {
      title: 'The whole situation, in one call',
      description:
        'CALL THIS FIRST, at the start of every session. Ventures with weights and shares, people with their working weeks and current load, active milestones with slack and coverage, the week and its deficit, inbox and triage counts, and an `unknown` list of what the system has NOT been told. It exists so a session starts already knowing the situation instead of rebuilding it by asking. Everything here was reachable before; it just took six calls.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        available_hours: z
          .number()
          .min(0)
          .optional()
          .describe(
            'This week specifically. Omitted, it uses the normal week on record; with neither, the week is reported as unknown rather than assumed.',
          ),
      },
    },
    async (args) => guard(() => getContext(sql, args)),
  );

  server.registerTool(
    'mark_prepared',
    {
      title: 'You drafted it; Tal reviews and sends',
      description:
        "Record that you have done the preparable part of a task -- read, gathered, drafted -- and Tal's judgement is all that remains. THIS DOES NOT CLOSE THE TASK and does not change its status: a drafted email is not a sent email, and recording it as done would put a fiction into the system. Attach what you produced with attach_document and pass its document_id. State review_minutes if you can estimate the review honestly; leave it out otherwise. Prepared work sorts FIRST in next_actions, because minutes of judgement on something nearly finished is the cheapest valuable time in the week.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        task_id: z.string(),
        summary: z
          .string()
          .min(3)
          .describe('What you produced, in a sentence, so the review can start without re-reading everything.'),
        review_minutes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Minutes of Tal's judgement still needed. Omit rather than guess."),
        document_id: z.string().optional().describe('The draft, from attach_document.'),
        prepared_by: z.enum(['ai', 'tal', 'delegate']).optional().describe('Default ai.'),
        idempotency_key: z.string().optional(),
      },
    },
    async (args) => guard(() => markPrepared(sql, args)),
  );

  server.registerTool(
    'awaiting_review',
    {
      title: 'Everything drafted and waiting on Tal',
      description:
        'The queue of work Claude has prepared and Tal has not yet reviewed and sent, with what was produced and how long each review should take. None of it is done. This is usually the cheapest hour in the week.',
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    async (args) => guard(() => awaitingReview(sql, args)),
  );

  server.registerTool(
    'next_actions',
    {
      title: 'What to pick up in the slot you actually have',
      description:
        'THE tool for "what should I do now". Takes the minutes available and optionally your energy and context. NEVER returns a task whose blockers are still open. Energy is a HARD filter (mismatched energy produces work that has to be redone); context is a soft preference (mismatched context only costs time). A task bigger than the slot is still returned, marked partial with a suggested chunk, because a size filter makes the biggest and most important work permanently invisible. Every action carries a one-line `why`.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        available_minutes: z.number().int().positive().describe('The real slot, right now.'),
        context: context.optional().describe('Preferred, not required.'),
        energy: energy.optional().describe('A hard ceiling: low excludes high-energy work.'),
        date: civilDate.optional(),
        limit: z.number().int().min(1).max(15).optional(),
        ignore_day_allocation: z
          .boolean()
          .optional()
          .describe('Ignore whose day it is. Use when Tal says today is different.'),
      },
    },
    async (args) => guard(() => nextActions(sql, args)),
  );

  server.registerTool(
    'set_day_allocation',
    {
      title: 'Which venture owns which day',
      description:
        'Record the weekly shape: which venture each day belongs to, how many minutes of flex it can give other ventures, and which days are not worked. 0 = Sunday. Flex is spent by CLOSING off-plan work, never by asking what to do, and does not roll over.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        days: z
          .array(
            z.object({
              day_of_week: z.number().int().min(0).max(6).describe('0 = Sunday.'),
              venture: z.string().nullable().optional().describe('Slug or name; null for none.'),
              flex_minutes: z.number().int().min(0).optional().describe('Default 90.'),
              is_working_day: z.boolean().optional(),
              note: z.string().optional(),
            }),
          )
          .min(1),
      },
    },
    async (args) => guard(() => setDayAllocation(sql, args)),
  );

  server.registerTool(
    'get_day_allocation',
    {
      title: 'The weekly shape',
      description: 'Which venture owns each day, its flex budget, and which days are not worked.',
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    async (args) => guard(() => getDayAllocation(sql, args)),
  );

  server.registerTool(
    'link_tasks',
    {
      title: 'Wire dependency edges between existing tasks',
      description:
        'Add (or with remove:true, delete) dependency edges between tasks that ALREADY EXIST. commit_tasks can only resolve depends_on/blocks among tasks in the same call, so work added later could never join a chain created earlier — which leaves the milestone below the 60% coverage threshold and its slack suppressed. Accepts ids or exact titles; an ambiguous title is refused rather than guessed, because wiring the wrong critical path is invisible afterwards. Reports what it did to each affected milestone\'s coverage.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        links: z
          .array(
            z.object({
              task: z.string().describe('Task id, or its exact title.'),
              blocks: z.array(z.string()).optional().describe('Tasks this one must precede.'),
              depends_on: z.array(z.string()).optional().describe('Tasks that must finish first.'),
            }),
          )
          .min(1),
        remove: z.boolean().optional().describe('Delete these edges instead of adding them.'),
        idempotency_key: z.string().optional(),
      },
    },
    async (args) => guard(() => linkTasks(sql, args)),
  );

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
        ai_preparable: z
          .boolean()
          .optional()
          .describe('You can draft this before Tal reaches it; day_plan then books the review.'),
        review_minutes: z.number().int().positive().nullable().optional(),
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
  // The day, in hours
  // -------------------------------------------------------------------------

  server.registerTool(
    'day_plan',
    {
      title: 'Today laid into hours, in execution order',
      description:
        'The ranking laid against the hours actually on record, as timed slots. Unlike next_actions it CHAINS dependent work inside the day: a task whose blocker is scheduled earlier today is placed after it, so "do A at 09:00 then B at 10:30 because A unblocks it" appears as two slots. Slots flagged ai_can_prepare are booked at REVIEW length because Claude is expected to draft them first — `to_prepare` lists what has to be written and by when for the plan to be honest. Returns what did not fit and why, never silently.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        date: civilDate.optional().describe('Defaults to today in the workspace timezone.'),
        start_hour: z.number().int().min(0).max(23).optional().describe('Override for this call only.'),
        end_hour: z.number().int().min(1).max(24).optional(),
      },
    },
    async (args) => guard(() => dayPlan(sql, args)),
  );

  server.registerTool(
    'set_work_hours',
    {
      title: 'When the day starts and ends',
      description:
        'The window day_plan lays work into. Without it there is no plan at all — assuming nine-to-five for someone with 28 usable hours across six days would put work in hours that are not worked and make every start time wrong. Pass day_of_week (0=Sunday) to override one weekday; omit it to set the default for every day.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        start_hour: z.number().int().min(0).max(23),
        end_hour: z.number().int().min(1).max(24),
        day_of_week: z.number().int().min(0).max(6).optional(),
      },
    },
    async (args) => guard(() => setWorkHours(sql, args)),
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
    'list_projects',
    {
      title: 'The projects, and what is actually moving in them',
      description:
        'Every project with its venture, its stated outcome, open task count and hours, and when it last moved. Flags active projects with no open tasks (nothing is going to happen in them) and ones that have not moved in a fortnight. Answers "what are my projects and what is in each one".',
      annotations: { readOnlyHint: true },
      inputSchema: {
        venture: z.string().optional(),
        status: z.enum(['active', 'paused', 'done', 'killed']).optional(),
      },
    },
    async (args) => guard(() => listProjects(sql, args)),
  );

  server.registerTool(
    'set_project',
    {
      title: 'Create or change a project',
      description:
        'A body of work inside a venture, with an OUTCOME — what is true when it is finished. commit_tasks and update_task accept a project by name and refuse an unknown one, so this is what makes that field usable. State the outcome: a project without one is a folder, and a folder cannot be finished.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        name: z.string().min(1),
        venture: z.string().describe('Slug or name.'),
        outcome: z.string().optional().describe('What is true when this is done.'),
        milestone: z.string().nullable().optional().describe('The milestone it serves, if any.'),
        status: z.enum(['active', 'paused', 'done', 'killed']).optional(),
        new_name: z.string().optional().describe('Rename it.'),
        idempotency_key: z.string().optional(),
      },
    },
    async (args) => guard(() => setProject(sql, args)),
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
    'move_milestone',
    {
      title: 'Put a milestone under the right venture',
      description:
        'Move a milestone to a different venture, taking its tasks with it. set_milestone CANNOT do this — it keys on (venture, name), so naming a different venture there creates a second milestone and leaves the tasks on the first. Use this when a milestone is filed under the wrong venture, and especially when list_milestones flags one on an INACTIVE venture: its demand is silently not counted, so real work exists and capacity() says the week is fine.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        milestone_id: z.string().describe('From list_milestones.'),
        venture: z.string().describe('Slug or name of the venture it belongs to.'),
        move_tasks: z
          .boolean()
          .optional()
          .describe(
            'Default true. A task carries its own venture and that is what allocates its hours, so leaving them behind reports demand against a venture that is not doing the work.',
          ),
        idempotency_key: z.string().optional(),
      },
    },
    async (args) => guard(() => moveMilestone(sql, args)),
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

  // -------------------------------------------------------------------------
  // Delegation — the links, and what comes back through them
  // -------------------------------------------------------------------------

  server.registerTool(
    'delegate_link',
    {
      title: 'Mint a link that lets someone do the work',
      description:
        'Create a secret link giving one person a page with their assigned work, where they can mark it done, say what they are stuck on and add it to their calendar. No account, no app, no invite. THE LINK IS THE CREDENTIAL and its plaintext is returned exactly once — only a hash is stored, so it can never be shown again. Default scope is one task, which stops working 90 minutes after that task is marked done; pass scope:"person" for a durable link to their whole queue, or scope:"calendar" for a read-only feed that can close nothing. Give the link to Tal to send — do not describe it as sent.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: {
        person: z.string().describe('Exact name, as recorded by create_person.'),
        scope: z
          .enum(['task', 'person', 'calendar'])
          .optional()
          .describe('Defaults to "task" when task_id is given, otherwise "person".'),
        task_id: z.string().optional().describe('Required for a task link, forbidden otherwise.'),
        label: z.string().optional().describe('What this link was for, so it can be recognised later.'),
        rotate: z
          .boolean()
          .optional()
          .describe(
            'Replace an existing live link. The old one keeps working for grace_hours so nobody is locked out.',
          ),
        grace_hours: z.number().min(0).max(720).optional(),
        expires_in_days: z.number().min(1).max(3650).optional(),
      },
    },
    async (args) => guard(() => delegateLink(sql, args)),
  );

  server.registerTool(
    'owner_link',
    {
      title: "Tal's own page",
      description:
        "Mint the link to Tal's OWN page — his day in hours, what is overdue, what is drafted and waiting, who is blocked. He has no other interface: the dashboard needs a login that has never worked, so without this the only way he can see his own portfolio is by asking you. THE WIDEST CREDENTIAL IN THE SYSTEM: anyone holding it reads everything. It can mark work done and undo that within 15 minutes, and nothing else. Shown exactly once. Give it to Tal and tell him to bookmark it.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: {
        rotate: z.boolean().optional().describe('Replace the existing link; the old one works for grace_hours.'),
        grace_hours: z.number().min(0).max(720).optional(),
        label: z.string().optional(),
      },
    },
    async (args) => guard(() => ownerLink(sql, args)),
  );

  server.registerTool(
    'pair_person_chat',
    {
      title: 'Connect a person to the Telegram chat you share',
      description:
        'Return a one-time code that binds a Telegram chat to a person, so work can be SENT to them instead of Tal copy-pasting a link. Tal adds the bot to the chat he already has with them and sends "/taskos <code>" there. The code is single-use and expires in 30 minutes. A paired chat can RECEIVE only — it never gains the ability to run commands or see anything but that person\'s own page.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: { person: z.string().describe('Exact name, as recorded by create_person.') },
    },
    async (args) => guard(() => pairPersonChat(sql, args)),
  );

  server.registerTool(
    'send_work_to_person',
    {
      title: 'Send approved work to their chat',
      description:
        'Deliver a message and their link to a paired person\'s Telegram chat. SENT VERBATIM — draft it, show it to Tal, and call this only once he says send. Never call it on your own initiative after assigning something: assignments get made provisionally during planning, and work that reaches somebody before Tal has decided is exactly the failure he built the review step to avoid. Requires pair_person_chat first.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: {
        person: z.string(),
        message: z.string().optional().describe('What Tal approved. Sent unchanged.'),
        include_link: z
          .boolean()
          .optional()
          .describe('Default true. Mints a fresh link to their page and appends it.'),
        scope: z.enum(['person', 'task']).optional(),
        task_id: z.string().optional(),
        idempotency_key: z.string().optional(),
      },
    },
    async (args) => guard(() => sendWorkToPerson(sql, args)),
  );

  server.registerTool(
    'list_delegation_links',
    {
      title: 'Which links are out there',
      description:
        'Every delegation link with its person, scope, prefix, issue date and expiry. A fetch count is NOT a read — WhatsApp, Telegram and Slack all fetch a URL to build a preview; last_action is the only signal that is definitely a person. Use the prefix to name a link for revoke_delegation.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        person: z.string().optional(),
        include_revoked: z.boolean().optional(),
      },
    },
    async (args) => guard(() => listDelegationLinks(sql, args)),
  );

  server.registerTool(
    'revoke_delegation',
    {
      title: 'Kill a link now',
      description:
        'Revoke by token_id, by prefix, or every link belonging to a person. Immediate: the next request on those links is refused. Use it the moment a link is somewhere it should not be, and when somebody stops working with Tal.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      inputSchema: {
        token_id: z.string().optional(),
        token_prefix: z.string().optional(),
        person: z.string().optional(),
        reason: z.string().optional(),
      },
    },
    async (args) => guard(() => revokeDelegation(sql, args)),
  );

  server.registerTool(
    'delegation_inbox',
    {
      title: 'What the people doing the work have said back',
      description:
        'Unread comments from delegates, the tasks they have flagged as blocked and how long they have been blocked, and what they closed this week. Check this at the start of a session: a blocked delegate does NOT reduce demand — the hours are still counted and simply are not moving, which is the most expensive silence in the system. Reading does not mark anything read; call again with mark_read:true only AFTER you have shown the comments to Tal.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        person: z.string().optional(),
        include_read: z.boolean().optional(),
        mark_read: z
          .boolean()
          .optional()
          .describe('Only after Tal has actually seen them. Default false.'),
      },
    },
    async (args) => guard(() => delegationInbox(sql, args)),
  );

  server.registerTool(
    'comment_on_task',
    {
      title: 'Answer a delegate, in their thread',
      description:
        'Write a comment the current assignee sees on their delegation page. This is how a blocked person gets unblocked. It does NOT notify them — they see it next time they open their link, so tell Tal if it is urgent enough to message. Pass clear_flag:true once the blocker is genuinely gone, which takes the task off the blocked list.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        task_id: z.string(),
        body: z.string().min(1).max(4000),
        clear_flag: z
          .boolean()
          .optional()
          .describe('Clear "needs attention" — only when the blocker is actually resolved.'),
        idempotency_key: z.string().optional(),
      },
    },
    async (args) => guard(() => commentOnTask(sql, args)),
  );

  return server;
}

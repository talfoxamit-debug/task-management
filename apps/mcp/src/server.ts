import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Sql } from './db.js';
import { errorResult, jsonResult } from './narrow.js';
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
      instructions: [
        'TaskOS answers one question: given real milestones and real hours, what is going to slip?',
        '',
        'Start with capacity(available_hours) — it is the main tool and the primary output.',
        '',
        'Two object types must never be confused. A MILESTONE is an event Tal controls',
        '("YachtyHub live"); it has a critical path and it drives demand. An OUTCOME TARGET',
        'is a result someone else decides ("first sale"); it drives no demand, gets no slack,',
        'and is tracked only by leading indicators. Never file a hoped-for result as a milestone.',
        '',
        'Every response carries a `confidence` object. Read its `notes` before presenting any',
        'number as settled: below 8 samples per context nothing is calibrated, below 14 days',
        'of events the balance corrector is off, and a milestone whose dependency coverage is',
        'under 60% has slack that must not be trusted. Say so rather than rounding it away.',
        '',
        'Lists are capped at 15 with a `total`; ask for a narrower filter rather than assuming',
        'you were shown everything.',
      ].join('\n'),
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

  return server;
}

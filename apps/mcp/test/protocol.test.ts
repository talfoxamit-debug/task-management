import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/mcp-server.js';
import { freshDb, type TestDb } from './harness.js';

/**
 * End-to-end over the real MCP protocol. The tools are only usable if they work
 * through registerTool's schema validation and JSON-RPC, not just as functions:
 * a zod schema that rejects a legitimate argument, or a tool that returns
 * something the protocol cannot carry, is invisible to a direct unit test.
 */

let db: TestDb;
let client: Client;

beforeAll(async () => {
  db = await freshDb('protocol');
  const server = buildServer(db.sql);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
}, 60_000);

afterAll(async () => {
  await client?.close();
  await db?.drop();
});

function parse(result: unknown): Record<string, any> {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  expect(content[0]!.type).toBe('text');
  return JSON.parse(content[0]!.text);
}

describe('tool registration', () => {
  it('exposes exactly the nine tools of Part 5', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'capacity',
      'capture',
      'close',
      'commit_tasks',
      'list_tasks',
      'process_inbox',
      'set_milestone',
      'set_outcome_target',
      'venture_status',
    ]);
  });

  it('describes the milestone / outcome-target distinction in both directions (D1)', async () => {
    const { tools } = await client.listTools();
    const milestone = tools.find((t) => t.name === 'set_milestone')!;
    const outcome = tools.find((t) => t.name === 'set_outcome_target')!;
    // Each tool must warn against the other, or they will be used interchangeably.
    expect(milestone.description).toContain('set_outcome_target');
    expect(milestone.description).toContain('drive demand');
    expect(outcome.description).toContain('set_milestone');
    expect(outcome.description).toContain('drives no demand');
  });

  it('tells the caller not to guess actual_minutes (D6)', async () => {
    const { tools } = await client.listTools();
    const close = tools.find((t) => t.name === 'close')!;
    const prop = (close.inputSchema as { properties: Record<string, { description?: string }> })
      .properties['actual_minutes'];
    expect(prop?.description).toContain('Never guess');
  });

  it('publishes instructions that name the main tool and the confidence object', async () => {
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('capacity(available_hours)');
    expect(instructions).toContain('confidence');
    expect(instructions).toContain('what is going to slip');
  });
});

describe('a full conversation over the protocol', () => {
  it('captures, proposes, commits, then answers capacity', async () => {
    const captured = parse(
      await client.callTool({
        name: 'capture',
        arguments: { text: 'Wire Stripe live keys for the yacht booking flow' },
      }),
    );
    expect(captured['total']).toBe(1);
    const inboxId = (captured['created'] as Array<{ id: string }>)[0]!.id;

    const proposed = parse(await client.callTool({ name: 'process_inbox', arguments: {} }));
    const proposal = (proposed['proposals'] as Array<Record<string, any>>)[0]!;
    expect(proposal['venture'].value.slug).toBe('yachtyhub');
    expect(proposal['context'].value).toBe('deep_work');

    const committed = parse(
      await client.callTool({
        name: 'commit_tasks',
        arguments: {
          tasks: [
            {
              title: 'Wire Stripe live keys',
              venture: 'yachtyhub',
              milestone: 'YachtyHub live',
              from_inbox_task_id: inboxId,
              criticality: 'blocking',
              context: 'deep_work',
              estimate_minutes: 1080,
              value: 9,
            },
            {
              title: 'Cut over DNS',
              venture: 'yachtyhub',
              milestone: 'YachtyHub live',
              criticality: 'blocking',
              context: 'admin',
              estimate_minutes: 360,
              status: 'blocked',
              depends_on: ['Wire Stripe live keys'],
            },
          ],
          idempotency_key: 'proto-commit-1',
        },
      }),
    );
    expect(committed['ok']).toBe(true);
    expect((committed['edges'] as unknown[]).length).toBe(1);

    const cap = parse(await client.callTool({ name: 'capacity', arguments: { available_hours: 20 } }));
    expect(cap['question']).toContain('what is going to slip');
    expect(['ok', 'deficit']).toContain(cap['verdict']);
    expect(cap['confidence']).toBeTruthy();
    expect(cap['confidence'].notes.length).toBeGreaterThan(0);
    expect(cap['shares']).toBeTruthy();

    const status = parse(
      await client.callTool({ name: 'venture_status', arguments: { slug: 'yachtyhub' } }),
    );
    const live = (status['milestones'] as Array<Record<string, unknown>>).find(
      (m) => m['milestone'] === 'YachtyHub live',
    )!;
    // Two blockers, one edge between them: both are wired, so coverage is 1.0.
    expect(live['coverage']).toBe(1);
    expect(live['min_slack_days']).not.toBeNull();
  });

  it('replays an idempotent call through the protocol without writing again', async () => {
    const again = parse(
      await client.callTool({
        name: 'commit_tasks',
        arguments: {
          tasks: [{ title: 'Wire Stripe live keys', venture: 'yachtyhub' }],
          idempotency_key: 'proto-commit-1',
        },
      }),
    );
    expect(again['replayed']).toBe(true);
    const rows = await db.sql<Array<{ n: string }>>`
      select count(*)::text as n from tasks where title = 'Wire Stripe live keys'`;
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('rejects an argument the schema forbids, before any query runs', async () => {
    // The SDK reports a schema violation as an isError result carrying the
    // validation message, not as a rejected promise.
    const rejected = async (call: { name: string; arguments: Record<string, unknown> }) => {
      const result = (await client.callTool(call)) as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      expect(result.isError, `${call.name} accepted an illegal argument`).toBe(true);
      return result.content[0]!.text;
    };

    // value must be 1..10
    expect(
      await rejected({
        name: 'commit_tasks',
        arguments: { tasks: [{ title: 'bad', venture: 'octo', value: 99 }] },
      }),
    ).toContain('validation');

    // A midnight timestamp is not a calendar date: D2 forbids deadlines as
    // timestamps, and the schema refuses one at the boundary.
    expect(
      await rejected({
        name: 'set_milestone',
        arguments: {
          venture: 'octo',
          name: 'x',
          due_date: '2026-08-10T00:00:00Z',
          hardness: 'soft',
          cost_of_slip: 'low',
        },
      }),
    ).toContain('calendar date');

    expect(
      await rejected({ name: 'capacity', arguments: { available_hours: -5 } }),
    ).toContain('validation');

    // Nothing was written by any of them.
    const rows = await db.sql<Array<{ n: string }>>`
      select count(*)::text as n from tasks where title = 'bad'`;
    expect(Number(rows[0]!.n)).toBe(0);
    const ms = await db.sql<Array<{ n: string }>>`
      select count(*)::text as n from milestones where name = 'x'`;
    expect(Number(ms[0]!.n)).toBe(0);
  });

  it('returns a readable tool error rather than a crash when a tool fails', async () => {
    const result = await client.callTool({
      name: 'venture_status',
      arguments: { slug: 'does-not-exist' },
    });
    const body = parse(result);
    expect(body['ok']).toBe(false);
    expect(body['errors'][0].code).toBe('missing_venture');
  });

  it('caps every list at 15 with a total, over the wire', async () => {
    const many = Array.from({ length: 25 }, (_, i) => `Protocol filler ${i}`).join('\n');
    parse(await client.callTool({ name: 'capture', arguments: { text: many } }));
    const listed = parse(await client.callTool({ name: 'list_tasks', arguments: {} }));
    expect((listed['tasks'] as unknown[]).length).toBe(15);
    expect(listed['total']).toBeGreaterThan(15);
    expect(listed['truncated'].omitted).toBeGreaterThan(0);
  });

  it('carries the confidence object on every single tool response', async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [
      { name: 'capture', arguments: { text: 'confidence check' } },
      { name: 'process_inbox', arguments: {} },
      { name: 'commit_tasks', arguments: { tasks: [{ title: 'conf', venture: 'octo' }] } },
      {
        name: 'set_milestone',
        arguments: {
          venture: 'octo',
          name: 'Conf milestone',
          due_date: '2026-09-09',
          hardness: 'soft',
          cost_of_slip: 'low - internal',
        },
      },
      { name: 'set_outcome_target', arguments: { venture: 'octo', name: 'Conf outcome' } },
      { name: 'capacity', arguments: { available_hours: 10 } },
      { name: 'venture_status', arguments: { slug: 'octo' } },
      { name: 'list_tasks', arguments: { venture: 'octo' } },
    ];
    for (const call of calls) {
      const body = parse(await client.callTool(call));
      expect(body['confidence'], `${call.name} lost its confidence object`).toBeTruthy();
      expect(Array.isArray(body['confidence'].notes)).toBe(true);
      expect(typeof body['confidence'].calibrated).toBe('boolean');
      expect(typeof body['confidence'].balancingActive).toBe('boolean');
    }

    const conf = await db.sql<Array<{ id: string }>>`
      select id from tasks where title = 'conf' limit 1`;
    const closed = parse(
      await client.callTool({ name: 'close', arguments: { task_id: conf[0]!.id } }),
    );
    expect(closed['confidence']).toBeTruthy();
  });
});

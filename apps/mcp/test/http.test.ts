import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkBearer } from '../src/auth.js';
import { buildServer } from '../src/server.js';
import { freshDb, type TestDb } from './harness.js';

/**
 * The endpoint over real HTTP, with real bearer auth — the same handler shape
 * api/mcp.ts serves on Vercel. This is the step 9 verification, run locally
 * first: if capacity() cannot be reached over HTTP with a token here, it will
 * not work from a connector either.
 */

const TOKEN = 'test-token-do-not-use-in-production';

let db: TestDb;
let httpServer: Server;
let url: string;

beforeAll(async () => {
  db = await freshDb('http');
  process.env['TASKOS_TOKEN'] = TOKEN;

  httpServer = createServer(async (req, res) => {
    if (req.url !== '/api/mcp') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    const auth = checkBearer(req.headers['authorization']);
    if (!auth.ok) {
      res.statusCode = auth.status;
      res.setHeader('content-type', 'application/json');
      if (auth.status === 401) res.setHeader('www-authenticate', 'Bearer');
      res.end(
        JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: auth.message }, id: null }),
      );
      return;
    }
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('allow', 'POST');
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'use POST' }, id: null }));
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildServer(db.sql);
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  url = `http://127.0.0.1:${port}/api/mcp`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
  await db?.drop();
});

async function connected(token: string | null): Promise<Client> {
  const client = new Client({ name: 'http-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : {},
  });
  await client.connect(transport);
  return client;
}

describe('the endpoint refuses unauthenticated callers', () => {
  it('rejects a request with no Authorization header', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    const body = await res.json();
    expect(body.error.message).toContain('missing Authorization');
  });

  it('rejects a wrong token', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer not-the-token',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects GET, since there is no session to resume', async () => {
    const res = await fetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('never reaches the database on an unauthenticated request', async () => {
    const before = await db.sql<Array<{ n: string }>>`select count(*)::text as n from events`;
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'capture', arguments: { text: 'should never be written' } },
      }),
    });
    const after = await db.sql<Array<{ n: string }>>`select count(*)::text as n from events`;
    expect(after[0]!.n).toBe(before[0]!.n);
    const task = await db.sql<Array<{ n: string }>>`
      select count(*)::text as n from tasks where title = 'should never be written'`;
    expect(Number(task[0]!.n)).toBe(0);
  });
});

describe('capacity() end to end over HTTP — the step 9 verification', () => {
  it('completes a handshake and lists the nine tools', async () => {
    const client = await connected(TOKEN);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(9);
    await client.close();
  });

  it('answers what is going to slip, with real milestones and real hours', async () => {
    const client = await connected(TOKEN);

    // A real critical path: three blockers in a chain against the hard milestone.
    await client.callTool({
      name: 'commit_tasks',
      arguments: {
        tasks: [
          {
            title: 'Rebuild the booking flow',
            venture: 'yachtyhub',
            milestone: 'YachtyHub live',
            criticality: 'blocking',
            context: 'deep_work',
            estimate_minutes: 1440,
            value: 9,
            blocks: ['Wire Stripe live keys'],
          },
          {
            title: 'Wire Stripe live keys',
            venture: 'yachtyhub',
            milestone: 'YachtyHub live',
            criticality: 'blocking',
            context: 'deep_work',
            estimate_minutes: 1080,
            value: 9,
            status: 'blocked',
            blocks: ['Cut over DNS and announce'],
          },
          {
            title: 'Cut over DNS and announce',
            venture: 'yachtyhub',
            milestone: 'YachtyHub live',
            criticality: 'blocking',
            context: 'admin',
            estimate_minutes: 1080,
            value: 9,
            status: 'blocked',
          },
          {
            title: 'Pricing page with three tiers',
            venture: 'stackwrk',
            milestone: 'Site sale-ready: contract, pricing, pages',
            criticality: 'blocking',
            context: 'creative',
            estimate_minutes: 720,
            value: 8,
          },
          {
            title: 'Daily launch check on staging',
            venture: 'yachtyhub',
            criticality: 'supporting',
            context: 'review',
            estimate_minutes: 60,
            value: 6,
            is_recurring: true,
            recurrence_rule: 'FREQ=DAILY',
          },
        ],
        idempotency_key: 'http-e2e-1',
      },
    });

    const raw = await client.callTool({ name: 'capacity', arguments: { available_hours: 40 } });
    const body = JSON.parse(
      (raw as { content: Array<{ text: string }> }).content[0]!.text,
    ) as Record<string, any>;

    // The question it exists to answer.
    expect(body['question']).toBe(
      'given these hours and these milestones, what is going to slip?',
    );
    expect(body['verdict']).toBe('deficit');

    // The hours arithmetic: 7 h/wk of recurring overhead, then the 20% buffer.
    expect(body['hours'].available).toBe(40);
    expect(body['hours'].recurring_overhead).toBe(7);
    expect(body['hours'].usable).toBeCloseTo((40 - 7) * 0.8, 1);
    expect(body['hours'].deficit).toBeGreaterThan(0);

    // Shares over the five real ventures, summing to 1.
    const shares = body['shares'] as Array<{ venture: string; share: number }>;
    expect(shares).toHaveLength(5);
    expect(shares.some((s) => s.venture === 'unsorted')).toBe(false);
    expect(shares.reduce((a, s) => a + s.share, 0)).toBeCloseTo(1, 2);

    // A ranked slip list, cheapest first, with a running total.
    const slip = body['slip_order'] as Array<{ milestone: string; cumulative_hours_freed: number }>;
    expect(slip.length).toBeGreaterThan(1);
    // The hard milestone is protected: it is last to be given up.
    expect(slip[slip.length - 1]!.milestone).toBe('YachtyHub live');
    expect(body['protect_first'][0].milestone).toBe('YachtyHub live');
    expect(body['protect_first'][0].hardness).toBe('hard');

    // And it states its own uncertainty rather than presenting guesses as facts.
    expect(body['confidence'].calibrated).toBe(false);
    expect(body['confidence'].balancingActive).toBe(false);
    expect(body['confidence'].notes.join(' ')).toContain('calibration not applied');

    await client.close();
  });

  it('computes the chain slack against the real due date', async () => {
    const client = await connected(TOKEN);
    const raw = await client.callTool({ name: 'venture_status', arguments: { slug: 'yachtyhub' } });
    const body = JSON.parse((raw as { content: Array<{ text: string }> }).content[0]!.text);

    const live = (body['milestones'] as Array<Record<string, any>>).find(
      (m) => m['milestone'] === 'YachtyHub live',
    )!;
    // 1440 + 1080 + 1080 minutes at 6 work hours a day is 4 + 3 + 3 = a 10-day
    // chain. Against 2026-08-10 that puts the latest start at 07-31, so with 12
    // days to go the chain still fits, with 2 days of slack and no pressure.
    const daysUntil = live['days_until_due'] as number;
    expect(live['min_slack_days']).toBe(daysUntil - 10);
    expect(live['coverage']).toBe(1);
    expect(live['pressure']).toBe(1);
    await client.close();
  });

  it('goes negative and applies pressure once the chain outgrows the date', async () => {
    const client = await connected(TOKEN);

    // Four more days of blocking work at the head of the same chain: 14 days of
    // work against 12 days of calendar.
    await client.callTool({
      name: 'commit_tasks',
      arguments: {
        tasks: [
          {
            title: 'Rewrite the availability engine',
            venture: 'yachtyhub',
            milestone: 'YachtyHub live',
            criticality: 'blocking',
            context: 'deep_work',
            estimate_minutes: 1440,
            value: 9,
            blocks: ['Rebuild the booking flow'],
          },
        ],
      },
    });

    const raw = await client.callTool({ name: 'venture_status', arguments: { slug: 'yachtyhub' } });
    const body = JSON.parse((raw as { content: Array<{ text: string }> }).content[0]!.text);
    const live = (body['milestones'] as Array<Record<string, any>>).find(
      (m) => m['milestone'] === 'YachtyHub live',
    )!;

    const daysUntil = live['days_until_due'] as number;
    expect(live['min_slack_days']).toBe(daysUntil - 14);
    expect(live['min_slack_days']).toBeLessThan(0);
    // pressure = 1 + 2 * (-minSlack / 7), and it appears here and nowhere else.
    const minSlack = live['min_slack_days'] as number;
    expect(live['pressure']).toBeCloseTo(1 + 2 * (-minSlack / 7), 3);
    expect(body['confidence'].notes.join(' ')).toContain('negative slack');
    await client.close();
  });

  it('stays idempotent across separate HTTP connections', async () => {
    const client = await connected(TOKEN);
    const raw = await client.callTool({
      name: 'commit_tasks',
      arguments: {
        tasks: [{ title: 'Rebuild the booking flow', venture: 'yachtyhub' }],
        idempotency_key: 'http-e2e-1',
      },
    });
    const body = JSON.parse((raw as { content: Array<{ text: string }> }).content[0]!.text);
    expect(body['replayed']).toBe(true);
    const rows = await db.sql<Array<{ n: string }>>`
      select count(*)::text as n from tasks where title = 'Rebuild the booking flow'`;
    expect(Number(rows[0]!.n)).toBe(1);
    await client.close();
  });
});

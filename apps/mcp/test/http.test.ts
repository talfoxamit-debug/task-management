import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import entrypoint from '../src/server.js';
import { freshDb, type TestDb } from './harness.js';

/**
 * The endpoint over real HTTP, driving THE SAME default export Vercel invokes
 * (src/server.ts). This is the step 9 verification, run locally
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
  // Point the server's own connection at this test database, so /health's
  // database status is exercised for real rather than depending on whoever ran
  // the suite having exported DATABASE_URL.
  process.env['DATABASE_URL'] = db.url;

  httpServer = createServer((req, res) => {
    void entrypoint(req, res);
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
    // 403, NOT 401. Omitting www-authenticate was not enough: the client treats
    // any 401 as an invitation to begin OAuth discovery, and showed Tal
    // "Couldn't register with Task-OS's sign-in service" — an error about a
    // protocol this server does not speak, when the real problem was a missing
    // ?token= on the connector URL.
    expect(res.status).toBe(403);
    expect(res.headers.get('www-authenticate')).toBeNull();
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('no token');
    // The message has to name the actual fix, because it is the only place the
    // fix is written down at the moment somebody needs it.
    expect(body.error.message).toContain('?token=');
    expect(body.error.message).toContain('no sign-in flow');
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
    expect(res.status).toBe(403);
    expect(res.headers.get('www-authenticate')).toBeNull();
  });

  it('accepts the token from the query string, for connectors with no header field', async () => {
    // The claude.ai custom-connector form has no static-bearer field, so the
    // credential has to be able to travel in the URL.
    const res = await fetch(`${url}?token=${encodeURIComponent(TOKEN)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(200);
  });

  it('rejects a wrong token in the query string', async () => {
    const res = await fetch(`${url}?token=nope`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(403);
  });

  it('never offers an OAuth flow it does not have', async () => {
    // A client that finds any of these starts a registration it cannot finish.
    const base = url.replace('/api/mcp', '');
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-authorization-server',
      '/.well-known/openid-configuration',
      '/register',
    ]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(404);
    }
  });

  it('routes only /api/mcp, and answers /health without a credential', async () => {
    const base = url.replace('/api/mcp', '');
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as Record<string, unknown>;
    expect(body['ok']).toBe(true);
    expect(body['service']).toBe('taskos-mcp');
    expect(body['tokenConfigured']).toBe(true);
    expect(body['database']).toBe('connected');
    // It must never leak the connection string, the host or the token.
    const text = JSON.stringify(body);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('postgres');
    expect(text).not.toContain('5433');

    const missing = await fetch(`${base}/`);
    expect(missing.status).toBe(404);
    expect((await missing.json() as { hint: string }).hint).toContain('/api/mcp');
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
  it('completes a handshake and lists the tools', async () => {
    const client = await connected(TOKEN);
    const { tools } = await client.listTools();
    // capacity is the one that matters here: this test exists to prove the
    // whole transport works end to end, not to count registrations.
    expect(tools.map((t) => t.name)).toContain('capacity');
    expect(tools.length).toBeGreaterThanOrEqual(9);
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
    // chain, so the slack is however long there is minus that chain.
    //
    // The RELATIONSHIP is asserted rather than the numbers. This test used to
    // pin pressure at exactly 1 against a hardcoded 2026-08-10, which held only
    // while that date was far enough away — it began failing on its own as the
    // calendar moved. A fixture with a fixed date and a real `today` has to be
    // read as a difference or it is a time bomb.
    const daysUntil = live['days_until_due'] as number;
    expect(live['min_slack_days']).toBe(daysUntil - 10);
    expect(live['coverage']).toBe(1);
    // Pressure rises as slack shrinks and is never below 1.
    expect(live['pressure']).toBeGreaterThanOrEqual(1);
    if ((live['min_slack_days'] as number) > 7) expect(live['pressure']).toBe(1);
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

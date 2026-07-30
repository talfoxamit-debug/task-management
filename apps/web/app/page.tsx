import { redirect } from 'next/navigation';
import { getSql, loadPortfolio, runCapacity, runEngine } from '@taskos/mcp';
import { currentViewer } from '../lib/session';

/**
 * The dashboard. Read-only, and deliberately so: entry stays conversational
 * through Claude, and a page that cannot write cannot corrupt anything.
 *
 * It calls loadPortfolio and the engine pipeline — the same functions the MCP
 * server calls, in the same order — rather than querying for itself. If this
 * page computed its own numbers, the UI and Claude would eventually disagree
 * about what is going to slip, and there would be no way to tell which was
 * right.
 */

export const dynamic = 'force-dynamic';

const HOURS = 25;

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}
function h(n: number): string {
  return `${Math.round(n * 10) / 10}h`;
}

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ hours?: string }>;
}) {
  const viewer = await currentViewer();
  if (!viewer) redirect('/login');

  const params = await searchParams;
  const parsed = Number(params.hours);
  const availableHours = Number.isFinite(parsed) && parsed >= 0 ? parsed : HOURS;

  const sql = getSql();
  const portfolio = await loadPortfolio(sql, viewer.workspaceId);
  const pipeline = runEngine(portfolio);
  const capacity = runCapacity(portfolio, pipeline, availableHours);

  const ventureBySlug = new Map(portfolio.ventures.map((v) => [v.id, v]));
  const shares = portfolio.ventures
    .filter((v) => v.active)
    .map((v) => ({
      slug: v.slug,
      name: v.name,
      share: capacity.shareByVenture[v.id] ?? 0,
      hours: capacity.allocatedHoursByVenture[v.id] ?? 0,
      required: pipeline.demand.requiredByVenture[v.id] ?? 0,
      belowFloor: pipeline.demand.venturesBelowFloor.includes(v.id),
    }))
    .sort((a, b) => b.share - a.share);

  const milestones = portfolio.milestones
    .filter((m) => m.status === 'active')
    .map((m) => {
      const detail = pipeline.demand.milestoneDetail.find((d) => d.milestone_id === m.id);
      return {
        id: m.id,
        name: m.name,
        venture: ventureBySlug.get(m.venture_id)?.slug ?? '—',
        due: m.due_date,
        hardness: m.hardness,
        slack: pipeline.slack.minSlackByMilestone[m.id] ?? null,
        coverage: pipeline.coverage.byMilestone[m.id] ?? null,
        trusted: !pipeline.coverage.lowConfidence.includes(m.id),
        required: detail?.requiredHours ?? 0,
      };
    })
    .sort((a, b) => (a.slack ?? 1e9) - (b.slack ?? 1e9));

  const top = pipeline.scores.scores.filter((s) => s.score > 0).slice(0, 8);
  const deficit = capacity.verdict === 'deficit';

  return (
    <main>
      <h1>What is going to slip?</h1>
      <p className="sub">
        {viewer.workspaceName} · {portfolio.today} · {portfolio.settings.active_tz}
      </p>

      <div className="grid cols">
        <div className="panel">
          <div className="dim">Verdict at {h(availableHours)}/week</div>
          <div className={`big ${deficit ? 'bad' : 'ok'}`}>
            {deficit ? `Short ${h(capacity.deficitHours)}` : `Clear by ${h(capacity.surplusHours)}`}
          </div>
        </div>
        <div className="panel">
          <div className="dim">Usable after overhead and buffer</div>
          <div className="big">{h(capacity.usableHours)}</div>
          <div className="dim" style={{ fontSize: 13 }}>
            {h(capacity.recurringHours)} recurring · {pct(capacity.bufferRatio)} buffer
          </div>
        </div>
        <div className="panel">
          <div className="dim">Required by milestones</div>
          <div className="big">{h(capacity.requiredHours)}</div>
        </div>
      </div>

      <h2>Where the week goes</h2>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Venture</th>
              <th className="num">Share</th>
              <th className="num">Hours</th>
              <th className="num">Required</th>
            </tr>
          </thead>
          <tbody>
            {shares.map((s) => (
              <tr key={s.slug}>
                <td>
                  {s.name}{' '}
                  {s.belowFloor && <span className="tag warn">under floor</span>}
                  <div className="bar dim">
                    <span style={{ width: pct(s.share) }} />
                  </div>
                </td>
                <td className="num">{pct(s.share)}</td>
                <td className="num">{h(s.hours)}</td>
                <td className="num">{h(s.required)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Milestones, tightest first</h2>
      <div className="panel">
        {milestones.length === 0 ? (
          <p className="dim">No active milestones. Nothing is driving demand yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Milestone</th>
                <th>Venture</th>
                <th>Due</th>
                <th className="num">Slack</th>
                <th className="num">Coverage</th>
                <th className="num">h/wk</th>
              </tr>
            </thead>
            <tbody>
              {milestones.map((m) => (
                <tr key={m.id}>
                  <td>
                    {m.name}{' '}
                    {m.hardness === 'hard' && <span className="tag">hard</span>}
                  </td>
                  <td className="dim">{m.venture}</td>
                  <td className="dim">{m.due}</td>
                  <td className={`num ${m.slack === null ? 'dim' : m.slack < 0 ? 'bad' : m.slack < 3 ? 'warn' : ''}`}>
                    {m.slack === null ? '—' : `${m.slack}d`}
                  </td>
                  <td className={`num ${m.trusted ? '' : 'warn'}`}>
                    {m.coverage === null ? '—' : pct(m.coverage)}
                    {!m.trusted && ' ⚠'}
                  </td>
                  <td className="num">{h(m.required)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2>What slips first</h2>
      <div className="panel">
        {capacity.verdict === 'ok' ? (
          <p className="dim">
            Nothing has to slip at {h(availableHours)} a week. {h(capacity.surplusHours)} to spare.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Milestone</th>
                <th>Cost of slipping it</th>
                <th className="num">Frees</th>
                <th className="num">Running</th>
              </tr>
            </thead>
            <tbody>
              {capacity.slipCandidates.map((c, i) => (
                <tr key={c.milestone_id}>
                  <td className="dim">{i + 1}</td>
                  <td>
                    {c.name} {c.hardness === 'hard' && <span className="tag bad">hard</span>}
                  </td>
                  <td className="dim">{c.cost_of_slip}</td>
                  <td className="num">{h(c.hoursFreed)}</td>
                  <td className={`num ${c.clearsDeficit ? 'ok' : ''}`}>
                    {h(c.cumulativeHoursFreed)}
                    {c.clearsDeficit ? ' ✓' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2>Next by score</h2>
      <div className="panel">
        {top.length === 0 ? (
          <p className="dim">Nothing startable. Every task is blocked, waiting, or closed.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Task</th>
                <th>Why</th>
                <th className="num">Score</th>
              </tr>
            </thead>
            <tbody>
              {top.map((s) => (
                <tr key={s.task_id}>
                  <td>{s.title}</td>
                  <td className="dim">
                    value {s.components.value}
                    {s.components.urgencyReason !== 'none' &&
                      ` · ${s.components.urgencyReason.replace(/_/g, ' ')}`}
                    {s.components.directlyBlockedCount > 0 &&
                      ` · unblocks ${s.components.directlyBlockedCount}`}
                  </td>
                  <td className="num">{s.score.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/*
        The confidence notes are the whole reason this page can be trusted. They
        are rendered in full, not truncated and not summarised: D4 says the
        system states its own uncertainty rather than presenting guesses as
        facts, and a dashboard that hides them would be doing the opposite of
        what the engine goes to such lengths to say.
      */}
      <h2>What this does not know</h2>
      <div className="panel">
        <div style={{ marginBottom: 10 }}>
          <span className={`tag ${capacity.confidence.calibrated ? 'ok' : ''}`}>
            {capacity.confidence.calibrated ? 'calibrated' : 'not calibrated'}
          </span>{' '}
          <span className={`tag ${capacity.confidence.balancingActive ? 'ok' : ''}`}>
            {capacity.confidence.balancingActive ? 'balancing on' : 'balancing off'}
          </span>
        </div>
        <ul className="notes">
          {capacity.confidence.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      </div>

      <p className="sub" style={{ marginTop: 28, fontSize: 13 }}>
        Read-only. Add and close work by talking to Claude. Change the week with{' '}
        <code>?hours=40</code>.
      </p>
    </main>
  );
}

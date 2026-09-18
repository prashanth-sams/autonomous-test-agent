import type { RunSummary } from '@qa-agent/shared-contracts';

const SEVERITY_COLOR: Record<string, string> = {
  critical: '#b3261e',
  high: '#c9541c',
  medium: '#8a6b0a',
  low: '#3a6ea5',
  info: '#5b6470',
};

/** Self-contained run report; opens straight from the run directory. */
export function toHtml(summary: RunSummary): string {
  const defects = summary.defects
    .map(
      (defect) => `
      <article class="defect">
        <header>
          <span class="sev" style="background:${SEVERITY_COLOR[defect.severity] ?? '#5b6470'}">${defect.severity}</span>
          <h3>${escapeHtml(defect.id)} — ${escapeHtml(defect.title)}</h3>
        </header>
        <p>${escapeHtml(defect.summary)}</p>
        <dl>
          <div><dt>Status</dt><dd>${defect.status} (${defect.reproductions.successes}/${defect.reproductions.attempts} replays)</dd></div>
          <div><dt>Confidence</dt><dd>${Math.round(defect.confidence * 100)}%</dd></div>
          <div><dt>Route</dt><dd><code>${escapeHtml(defect.route)}</code></dd></div>
          <div><dt>Occurrences</dt><dd>${defect.occurrences}</dd></div>
        </dl>
        ${
          defect.steps.length
            ? `<h4>Reproduction</h4><ol>${defect.steps
                .map((step) => `<li>${escapeHtml(step.action.description)}</li>`)
                .join('')}</ol>`
            : ''
        }
        ${
          defect.evidence.length
            ? `<h4>Evidence</h4><ul>${defect.evidence
                .map((item) => `<li><a href="${escapeHtml(item.path)}">${escapeHtml(item.label ?? item.path)}</a></li>`)
                .join('')}</ul>`
            : ''
        }
      </article>`,
    )
    .join('');

  const missions = summary.missions
    .map(
      (mission) => `
      <tr>
        <td>${escapeHtml(mission.name)}</td>
        <td>${mission.source}</td>
        <td>${mission.status}</td>
        <td>${escapeHtml(mission.rationale)}</td>
      </tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QA Agent run ${escapeHtml(summary.runId)}</title>
<style>
  :root { color-scheme: light dark; --fg:#12151a; --bg:#fbfbfd; --muted:#5b6470; --line:#dfe3ea; --card:#fff; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e9edf3; --bg:#14171c; --muted:#9aa4b2; --line:#2a2f38; --card:#1b1f26; }
  }
  body { margin:0; padding:32px 16px; background:var(--bg); color:var(--fg);
         font:16px/1.55 ui-sans-serif,-apple-system,Segoe UI,Roboto,sans-serif; }
  main { max-width: 900px; margin: 0 auto; }
  h1 { font-size: 1.6rem; margin:0 0 4px; }
  .verdict { display:inline-block; padding:4px 12px; border-radius:999px; font-weight:600; color:#fff;
             background:${summary.recommendation === 'pass' ? '#1f7a4d' : summary.recommendation === 'review' ? '#8a6b0a' : summary.recommendation === 'error' ? '#5b6470' : '#b3261e'}; }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin:24px 0; }
  .stat { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
  .stat b { display:block; font-size:1.4rem; }
  .stat span { color:var(--muted); font-size:.8rem; text-transform:uppercase; letter-spacing:.04em; }
  table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  th,td { text-align:left; padding:8px 12px; border-bottom:1px solid var(--line); font-size:.92rem; vertical-align:top; }
  .defect { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; margin:16px 0; }
  .defect header { display:flex; align-items:center; gap:10px; }
  .defect h3 { font-size:1.05rem; margin:0; }
  .sev { color:#fff; border-radius:6px; padding:2px 8px; font-size:.72rem; text-transform:uppercase; letter-spacing:.05em; }
  dl { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:8px; margin:12px 0; }
  dt { color:var(--muted); font-size:.75rem; text-transform:uppercase; letter-spacing:.04em; }
  dd { margin:0; }
  code { background:rgba(127,127,127,.15); padding:1px 5px; border-radius:4px; }
</style>
</head>
<body>
<main>
  <h1>Autonomous exploratory run</h1>
  <p><span class="verdict">${summary.recommendation.toUpperCase()}</span>
     &nbsp;<code>${escapeHtml(summary.runId)}</code> · ${escapeHtml(summary.target)}</p>

  <div class="stats">
    <div class="stat"><b>${summary.defects.length}</b><span>Defects</span></div>
    <div class="stat"><b>${summary.stepsExecuted}</b><span>Actions</span></div>
    <div class="stat"><b>${summary.coverage.routes.length}</b><span>Routes</span></div>
    <div class="stat"><b>${summary.coverage.statesVisited}</b><span>States</span></div>
    <div class="stat"><b>${(summary.durationMs / 1000).toFixed(1)}s</b><span>Duration</span></div>
  </div>

  <h2>Missions</h2>
  <table><thead><tr><th>Mission</th><th>Source</th><th>Status</th><th>Why it ran</th></tr></thead>
  <tbody>${missions}</tbody></table>

  <h2>Defects</h2>
  ${defects || '<p>No defects found.</p>'}

  <h2>Routes covered</h2>
  <p>${summary.coverage.routes.map((route) => `<code>${escapeHtml(route)}</code>`).join(' ') || '—'}</p>
</main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

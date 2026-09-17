import type { Defect, RunSummary } from '@qa-agent/shared-contracts';

const STATUS_LABEL: Record<Defect['status'], string> = {
  reproduced: 'reproduced',
  'not-reproduced': 'not reproduced on replay',
  unverified: 'unverified',
  'false-positive': 'marked false positive',
};

/** The PR comment / check-run summary: verdict first, evidence attached. */
export function toMarkdown(summary: RunSummary): string {
  const verdict =
    summary.recommendation === 'pass'
      ? 'Passed'
      : summary.recommendation === 'review'
        ? 'Needs review'
        : summary.recommendation === 'error'
          ? 'Could not test'
          : 'Failed';
  const lines: string[] = [];

  lines.push(`## QA Agent Result: ${verdict}`);
  lines.push('');
  lines.push(`**Target:** ${summary.target}${summary.build ? ` (build ${summary.build})` : ''}`);
  lines.push(
    `**Missions:** ${summary.missions.length} selected · ` +
      `${summary.missions.filter((mission) => mission.status === 'completed').length} completed · ` +
      `${summary.missions.filter((mission) => mission.status === 'failed').length} failed · ` +
      `${summary.missions.filter((mission) => mission.status === 'skipped').length} skipped`,
  );
  lines.push(
    `**Coverage:** ${summary.coverage.routes.length} route(s), ` +
      `${summary.coverage.statesVisited} state(s), ` +
      `${summary.coverage.actionsExecuted} action(s) in ${(summary.durationMs / 1000).toFixed(1)}s`,
  );
  if (summary.impact) {
    lines.push(
      `**Impact confidence:** ${Math.round(summary.impact.confidence * 100)}%` +
        (summary.impact.broadened ? ' (scope broadened — low confidence)' : ''),
    );
  }
  lines.push(`**Stopped because:** ${summary.stoppedBecause}`);
  lines.push('');

  if (summary.impact && summary.impact.areas.length > 0) {
    lines.push('### Why these journeys were selected');
    lines.push('');
    lines.push('| Area | Confidence | Journeys | Changed files |');
    lines.push('| --- | --- | --- | --- |');
    for (const area of summary.impact.areas) {
      lines.push(
        `| ${area.area} | ${Math.round(area.confidence * 100)}% | ${area.journeys.join(', ')} | ` +
          `${area.changedPaths.slice(0, 3).join('<br>')}${area.changedPaths.length > 3 ? '<br>…' : ''} |`,
      );
    }
    lines.push('');
    for (const note of summary.impact.notes) lines.push(`> ${note}`);
    lines.push('');
  }

  if (summary.defects.length === 0) {
    lines.push('No defects found.');
  } else {
    lines.push(`### Defects (${summary.defects.length})`);
    lines.push('');
    for (const [index, defect] of summary.defects.entries()) {
      // A rule between defects, never a trailing one before the next section.
      if (index > 0) {
        lines.push('---');
        lines.push('');
      }
      lines.push(
        `#### ${defect.id} · ${defect.severity.toUpperCase()} · ${defect.title}`,
      );
      lines.push('');
      lines.push(defect.summary);
      lines.push('');
      lines.push(
        `- **Status:** ${STATUS_LABEL[defect.status]} ` +
          `(${defect.reproductions.successes}/${defect.reproductions.attempts} replays)`,
      );
      lines.push(`- **Confidence:** ${Math.round(defect.confidence * 100)}%`);
      lines.push(`- **Where:** \`${defect.route}\` — ${defect.url}`);
      lines.push(`- **Seen:** ${defect.occurrences}x`);
      if (defect.steps.length > 0) {
        lines.push('- **Reproduction:**');
        for (const step of defect.steps) {
          lines.push(`  ${step.index + 1}. ${step.action.description}`);
        }
      }
      if (defect.evidence.length > 0) {
        lines.push(
          `- **Evidence:** ${defect.evidence.map((item) => `\`${item.path}\``).join(', ')}`,
        );
      }
      lines.push('');
    }
  }

  const skipped = summary.missions.filter((mission) => mission.status === 'skipped');
  if (skipped.length > 0) {
    lines.push('### Not tested');
    lines.push('');
    for (const mission of skipped) {
      lines.push(`- ${mission.name} — skipped (${summary.stoppedBecause})`);
    }
    lines.push('');
  }

  lines.push('### Recommendation');
  lines.push('');
  lines.push(recommendationText(summary));
  if (summary.falsePositivesSuppressed > 0) {
    lines.push('');
    lines.push(
      `_${summary.falsePositivesSuppressed} finding(s) suppressed as known false positives._`,
    );
  }
  return lines.join('\n');
}

function recommendationText(summary: RunSummary): string {
  switch (summary.recommendation) {
    case 'error':
      return (
        'No verdict — every mission failed to execute, so this run says nothing about the ' +
        'application. Treat it as a broken agent or environment, not as a pass.'
      );
    case 'block':
      return 'Block merge — a high-severity defect was reproduced from a clean state.';
    case 'review':
      return 'Review before merge — findings need a human decision (advisory mode, or unverified findings).';
    default:
      return 'Safe to merge from this agent’s perspective.';
  }
}

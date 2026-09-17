import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ExplorationAgent,
  analyzeImpact,
  missionsFromImpact,
  writeReports,
} from '@qa-agent/agent-core';
import type { AgentConfig, ImpactAnalysis, Mission, RunSummary } from '@qa-agent/shared-contracts';
import { WebExecutor } from '@qa-agent/web-playwright';

export interface RunOptions {
  config: AgentConfig;
  /** Supplied for PR runs; omitted for a plain exploratory session. */
  diff?: { base: string; head: string; changedFiles: string[] };
  quiet?: boolean;
}

export interface RunOutput {
  summary: RunSummary;
  runDir: string;
  reports: { json: string; markdown: string; html: string };
  impact?: ImpactAnalysis;
}

/** Wires the web executor into the shared core and produces the reports. */
export async function runWebAgent(options: RunOptions): Promise<RunOutput> {
  const { config } = options;
  const log = (message: string) => {
    if (!options.quiet) process.stderr.write(`${message}\n`);
  };

  let impact: ImpactAnalysis | undefined;
  let missions: Mission[] = [];
  if (options.diff) {
    impact = analyzeImpact(options.diff, config);
    missions = missionsFromImpact(impact, config);
    log(
      `impact: ${impact.areas.length} area(s), confidence ${Math.round(impact.confidence * 100)}%` +
        `${impact.broadened ? ' (broadened)' : ''}`,
    );
  }

  const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const runDir = join(config.reporting.outputDir, runId);
  const executor = new WebExecutor({ config, runDir, onLog: log });

  const agent = new ExplorationAgent({
    config,
    executor,
    missions,
    impact,
    runId,
    events: {
      onLog: log,
      onMission: (mission) => log(`\n▸ ${mission.name} (${mission.source})`),
      onStep: (info) =>
        log(`  ${String(info.step).padStart(3)} ${info.action.description}  — ${info.rationale}`),
      onFinding: (finding) => log(`  ! ${finding.severity.toUpperCase()}: ${finding.title}`),
    },
  });

  const summary = await agent.run();

  // Attach an executable reproduction to every defect that has steps.
  for (const defect of summary.defects) {
    if (defect.steps.length === 0) continue;
    const scriptPath = join(agent.runDirectory, 'artifacts', `${defect.id}.spec.ts`);
    writeFileSync(
      scriptPath,
      executor.reproductionScript(defect.steps, config.target.baseUrl),
      'utf8',
    );
    defect.evidence.push({
      kind: 'repro-script',
      path: join('artifacts', `${defect.id}.spec.ts`),
      label: `${defect.id} Playwright reproduction`,
    });
  }

  const reports = writeReports(summary, agent.runDirectory);
  return { summary, runDir: agent.runDirectory, reports, impact };
}

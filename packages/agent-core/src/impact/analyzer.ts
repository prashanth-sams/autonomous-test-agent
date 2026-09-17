import type { AgentConfig, ImpactAnalysis, ImpactedArea, Mission } from '@qa-agent/shared-contracts';
import { missionFromImpact } from '../missions';

export interface ImpactInput {
  base: string;
  head: string;
  changedFiles: string[];
}

/**
 * Turns a diff into testing missions, in the three layers the design calls for:
 *
 *  1. deterministic rules  — critical journeys always run (handled by the agent)
 *  2. impact mapping       — configured path -> area -> journeys
 *  3. broadening           — low confidence widens scope instead of guessing
 *
 * No AI is required for this step, which is what keeps scope selection auditable.
 */
export function analyzeImpact(input: ImpactInput, config: AgentConfig): ImpactAnalysis {
  const notes: string[] = [];
  const areas = new Map<string, ImpactedArea>();
  const unmapped: string[] = [];

  for (const file of input.changedFiles) {
    const entries = config.impactMap.filter((entry) =>
      entry.paths.some((pattern) => pathMatches(file, pattern)),
    );
    if (entries.length === 0) {
      unmapped.push(file);
      continue;
    }
    for (const entry of entries) {
      const existing = areas.get(entry.area);
      if (existing) {
        existing.changedPaths.push(file);
        existing.journeys = [...new Set([...existing.journeys, ...entry.journeys])];
        existing.confidence = Math.max(existing.confidence, entry.confidence);
      } else {
        areas.set(entry.area, {
          area: entry.area,
          confidence: entry.confidence,
          changedPaths: [file],
          journeys: [...entry.journeys],
          reason: `${file} maps to ${entry.area} via the configured impact map`,
        });
      }
    }
  }

  const mappedCount = input.changedFiles.length - unmapped.length;
  const coverageRatio = input.changedFiles.length === 0 ? 0 : mappedCount / input.changedFiles.length;
  const mappedConfidence = [...areas.values()].reduce((best, area) => Math.max(best, area.confidence), 0);
  let confidence = round(coverageRatio * 0.5 + mappedConfidence * 0.5);

  if (unmapped.length > 0) {
    notes.push(
      `${unmapped.length} changed file(s) are not in the impact map: ${unmapped.slice(0, 8).join(', ')}` +
        (unmapped.length > 8 ? ', …' : ''),
    );
  }
  if (input.changedFiles.length === 0) {
    notes.push('No changed files were supplied; falling back to broad exploration.');
    confidence = 0;
  }

  // Low or unknown confidence must widen the scope, never narrow it.
  const broadened = confidence < 0.6;
  if (broadened) {
    notes.push(
      `Impact confidence ${Math.round(confidence * 100)}% is below the 60% threshold, ` +
        'so exploration is broadened beyond the mapped areas.',
    );
  }

  return {
    base: input.base,
    head: input.head,
    changedFiles: input.changedFiles,
    areas: [...areas.values()].sort((a, b) => b.confidence - a.confidence),
    confidence,
    broadened,
    notes,
  };
}

/** Missions implied by the analysis, budgeted against the run's step limit. */
export function missionsFromImpact(analysis: ImpactAnalysis, config: AgentConfig): Mission[] {
  const journeyCount = analysis.areas.reduce((total, area) => total + area.journeys.length, 0);
  if (journeyCount === 0) return [];
  const perMission = Math.max(
    6,
    Math.floor((config.limits.maxSteps * (analysis.broadened ? 0.4 : 0.7)) / journeyCount),
  );

  return analysis.areas.flatMap((area) =>
    area.journeys.map((journey) =>
      missionFromImpact({
        area: area.area,
        journey,
        reason: `${area.changedPaths.length} changed file(s) in ${area.area}: ${area.changedPaths
          .slice(0, 3)
          .join(', ')}`,
        confidence: area.confidence,
        maxSteps: perMission,
      }),
    ),
  );
}

const GLOBSTAR = '__GLOBSTAR__';

function pathMatches(file: string, pattern: string): boolean {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, GLOBSTAR)
    .replace(/\*/g, '[^/]*')
    .replace(new RegExp(GLOBSTAR, 'g'), '.*');
  return new RegExp(`^${source}$`).test(file);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

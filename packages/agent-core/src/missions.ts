import type { AgentConfig, Mission } from '@qa-agent/shared-contracts';
import { shortHash } from './util/hash';

/**
 * Layer 1 of the scope decision: deterministic critical journeys that run on
 * every execution regardless of what impact analysis or AI suggest.
 */
export function criticalJourneyMissions(config: AgentConfig): Mission[] {
  return config.criticalJourneys.map((journey, index) => ({
    id: journey.id,
    name: journey.name,
    goal: journey.goal ?? `Exercise the ${journey.name} journey end to end`,
    rationale: 'configured as a critical journey; always runs',
    source: 'critical-journey',
    priority: 100 - index,
    startUrl: journey.startUrl,
    hints: journey.hints ?? deriveHints(journey.name),
    script: journey.script,
    maxSteps: Math.max(8, Math.floor(config.limits.maxSteps / 4)),
    status: 'pending',
  }));
}

/** The fallback mission: explore whatever budget is left, unguided. */
export function explorationMission(maxSteps: number): Mission {
  return {
    id: 'free-exploration',
    name: 'Free exploration',
    goal: 'Explore reachable application states and look for anomalies',
    rationale: 'remaining budget after targeted missions',
    source: 'exploration',
    priority: 1,
    hints: [],
    maxSteps,
    status: 'pending',
  };
}

export function missionFromImpact(params: {
  area: string;
  journey: string;
  reason: string;
  confidence: number;
  maxSteps: number;
}): Mission {
  return {
    id: `impact-${shortHash(`${params.area}:${params.journey}`, 6)}`,
    name: `${params.area}: ${params.journey}`,
    goal: `Verify the ${params.journey} journey still works after changes to ${params.area}`,
    rationale: params.reason,
    source: 'impact-analysis',
    priority: Math.round(50 + params.confidence * 40),
    hints: deriveHints(params.journey),
    maxSteps: params.maxSteps,
    status: 'pending',
  };
}

const STOP_WORDS = new Set(['the', 'a', 'an', 'and', 'to', 'of', 'journey', 'flow', 'page']);

function deriveHints(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

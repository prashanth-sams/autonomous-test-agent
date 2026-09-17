import type { Action, ApplicationState, Mission } from '@qa-agent/shared-contracts';
import type { ScoredAction } from './risk';

export interface PlanningContext {
  state: ApplicationState;
  candidates: Action[];
  mission?: Mission;
  stepsTaken: number;
  stepsRemaining: number;
  /** Rank produced by the deterministic risk engine. */
  ranked: ScoredAction[];
  recentActions: Action[];
}

export interface PlanDecision {
  action: Action | null;
  rationale: string;
  source: 'heuristic' | 'ai';
}

export interface Planner {
  readonly kind: 'heuristic' | 'ai';
  decide(context: PlanningContext): Promise<PlanDecision>;
  /** Tokens/calls spent, surfaced in the run's cost report. */
  usage(): { aiCalls: number; aiInputTokens: number; aiOutputTokens: number };
}

/**
 * Deterministic planner: takes the risk engine's top-ranked action, with a
 * little anti-loop jitter so the agent does not oscillate between two states.
 */
export class HeuristicPlanner implements Planner {
  readonly kind = 'heuristic' as const;

  async decide(context: PlanningContext): Promise<PlanDecision> {
    const recentIds = new Set(context.recentActions.slice(-4).map((action) => action.id));
    const viable = context.ranked.filter((scored) => scored.score > -2);
    const fresh = viable.filter((scored) => !recentIds.has(scored.action.id));
    const pick = (fresh[0] ?? viable[0]) ?? null;
    if (!pick) {
      return { action: null, rationale: 'no viable action left in this state', source: 'heuristic' };
    }
    return {
      action: pick.action,
      rationale: `${pick.reasons.join('; ')} (score ${pick.score.toFixed(1)})`,
      source: 'heuristic',
    };
  }

  usage() {
    return { aiCalls: 0, aiInputTokens: 0, aiOutputTokens: 0 };
  }
}

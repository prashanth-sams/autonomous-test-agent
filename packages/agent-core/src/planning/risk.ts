import type { Action, ApplicationState, Mission } from '@qa-agent/shared-contracts';
import type { StateMemory } from '../memory/stateMemory';

export interface ScoredAction {
  action: Action;
  score: number;
  reasons: string[];
}

/** Controls that historically hide the most defects. */
const HIGH_VALUE_NAME = /(submit|save|pay|checkout|confirm|place order|apply|continue|next|login|sign in|refund|cancel|retry|upload|search)/i;
// Boilerplate and off-site chrome only. Support and help pages belong to the
// application and are worth exploring.
const LOW_VALUE_NAME = /(privacy|terms|cookie policy|language|theme|twitter|facebook|linkedin|instagram)/i;

/**
 * Turns "what could I do here" into "what is worth doing here", using mission
 * relevance, novelty and element risk. Deterministic and explainable: every
 * score carries the reasons that produced it, which is what lets the report
 * answer "why did the agent test this?".
 */
export class RiskEngine {
  constructor(private readonly memory: StateMemory) {}

  score(state: ApplicationState, action: Action, mission?: Mission): ScoredAction {
    const reasons: string[] = [];
    let score = 1;

    const attempts = this.memory.attemptsFor(state.id, action);
    if (attempts === 0) {
      score += 3;
      reasons.push('not tried in this state');
    } else {
      score -= attempts * 2.5;
      reasons.push(`tried ${attempts}x already`);
    }

    if (this.memory.isKnownDeadEnd(state.id, action)) {
      score -= 3;
      reasons.push('previously led nowhere');
    }

    if (mission) {
      const haystack = `${action.description} ${action.value ?? ''}`.toLowerCase();
      const hits = mission.hints.filter((hint) => haystack.includes(hint.toLowerCase()));
      if (hits.length > 0) {
        score += 4 + hits.length;
        reasons.push(`matches mission hints: ${hits.join(', ')}`);
      }
    }

    if (HIGH_VALUE_NAME.test(action.description)) {
      score += 2.5;
      reasons.push('high-value control (state-changing)');
    }
    if (LOW_VALUE_NAME.test(action.description)) {
      score -= 2;
      reasons.push('low-value / boilerplate control');
    }

    switch (action.kind) {
      case 'fill':
        // Filling before submitting is what makes a form defect reachable.
        score += 2;
        reasons.push('form input feeds validation paths');
        break;
      case 'select':
      case 'check':
        score += 1.5;
        break;
      case 'back':
        score -= 1.5;
        reasons.push('navigating back rarely reveals new state');
        break;
      case 'scroll':
      case 'hover':
      case 'wait':
        score -= 1;
        break;
      default:
        break;
    }

    if (action.destructive) {
      score -= 4;
      reasons.push('destructive: deprioritised');
    }

    if (action.tags?.includes('modal')) {
      // Modals trap the agent; resolving them first keeps exploration moving.
      score += 2;
      reasons.push('resolves an open modal');
    }

    return { action, score, reasons };
  }

  rank(state: ApplicationState, actions: Action[], mission?: Mission): ScoredAction[] {
    return actions
      .map((action) => this.score(state, action, mission))
      .sort((a, b) => b.score - a.score);
  }
}

import type { Action, ActionResult, ApplicationState } from '@qa-agent/shared-contracts';
import type { JourneyStep } from '@qa-agent/shared-contracts';
import { shortHash } from '../util/hash';

interface StateRecord {
  state: ApplicationState;
  visits: number;
  firstSeenAt: string;
  lastSeenAt: string;
  /** actionKey -> times attempted from this state. */
  attempts: Map<string, number>;
  /** actionKey -> state ids reached. */
  transitions: Map<string, Set<string>>;
}

export function actionKey(action: Action): string {
  return shortHash(
    [action.kind, action.targetId ?? '', action.selector ?? '', action.value ?? ''].join('|'),
  );
}

/**
 * The agent's model of the application: which screens exist, how they connect,
 * what has already been tried, and the exact path walked to get here.
 *
 * This is platform-neutral on purpose — mobile and desktop executors reuse it
 * unchanged.
 */
export class StateMemory {
  private readonly states = new Map<string, StateRecord>();
  private readonly journey: JourneyStep[] = [];
  private currentStateId: string | null = null;

  observe(state: ApplicationState): StateRecord {
    const existing = this.states.get(state.id);
    if (existing) {
      existing.visits += 1;
      existing.lastSeenAt = state.capturedAt;
      // Keep the newest snapshot: element selectors can drift between visits.
      existing.state = state;
      this.currentStateId = state.id;
      return existing;
    }
    const record: StateRecord = {
      state,
      visits: 1,
      firstSeenAt: state.capturedAt,
      lastSeenAt: state.capturedAt,
      attempts: new Map(),
      transitions: new Map(),
    };
    this.states.set(state.id, record);
    this.currentStateId = state.id;
    return record;
  }

  record(result: ActionResult): void {
    const record = this.states.get(result.stateBefore);
    const key = actionKey(result.action);
    if (record) {
      record.attempts.set(key, (record.attempts.get(key) ?? 0) + 1);
      const reached = record.transitions.get(key) ?? new Set<string>();
      reached.add(result.stateAfter);
      record.transitions.set(key, reached);
    }
    this.journey.push({
      index: this.journey.length,
      action: result.action,
      stateBefore: result.stateBefore,
      stateAfter: result.stateAfter,
      locationBefore: this.states.get(result.stateBefore)?.state.location,
      ok: result.ok,
      at: new Date().toISOString(),
    });
    this.currentStateId = result.stateAfter;
  }

  attemptsFor(stateId: string, action: Action): number {
    return this.states.get(stateId)?.attempts.get(actionKey(action)) ?? 0;
  }

  /** True when this action has only ever led back to where it started. */
  isKnownDeadEnd(stateId: string, action: Action): boolean {
    const record = this.states.get(stateId);
    if (!record) return false;
    const reached = record.transitions.get(actionKey(action));
    if (!reached || reached.size === 0) return false;
    return reached.size === 1 && reached.has(stateId);
  }

  visits(stateId: string): number {
    return this.states.get(stateId)?.visits ?? 0;
  }

  isNewState(stateId: string): boolean {
    return !this.states.has(stateId);
  }

  get size(): number {
    return this.states.size;
  }

  get current(): string | null {
    return this.currentStateId;
  }

  getState(stateId: string): ApplicationState | undefined {
    return this.states.get(stateId)?.state;
  }

  knownStates(): ApplicationState[] {
    return [...this.states.values()].map((record) => record.state);
  }

  /** Full path walked so far; the raw material for reproduction steps. */
  fullJourney(): JourneyStep[] {
    return [...this.journey];
  }

  /**
   * The steps that lead to the current position, trimmed to the last visit of
   * the earliest state still on the path. Short repros beat exhaustive ones.
   */
  reproductionPath(maxSteps = 25): JourneyStep[] {
    return this.journey.slice(-maxSteps).map((step, index) => ({ ...step, index }));
  }

  markJourneyBoundary(): void {
    // A mission boundary: later repro paths should not reach across it.
    this.journey.length = 0;
  }
}

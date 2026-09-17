import type { Action, ApplicationState, CoverageReport, Mission } from '@qa-agent/shared-contracts';

/** Tracks what the run actually touched, so the report can state it plainly. */
export class CoverageTracker {
  private readonly routes = new Set<string>();
  private readonly states = new Set<string>();
  private readonly elements = new Set<string>();
  private readonly byKind = new Map<string, number>();
  private readonly missionSteps = new Map<string, number>();
  private actions = 0;

  visitState(state: ApplicationState): void {
    this.routes.add(state.route);
    this.states.add(state.id);
  }

  recordAction(state: ApplicationState, action: Action, missionId?: string): void {
    this.actions += 1;
    this.byKind.set(action.kind, (this.byKind.get(action.kind) ?? 0) + 1);
    if (action.targetId) this.elements.add(`${state.route}#${action.targetId}`);
    if (missionId) this.missionSteps.set(missionId, (this.missionSteps.get(missionId) ?? 0) + 1);
  }

  report(missions: Mission[], statesKnown: number): CoverageReport {
    return {
      routes: [...this.routes].sort(),
      statesVisited: this.states.size,
      statesKnown,
      actionsExecuted: this.actions,
      actionsByKind: Object.fromEntries([...this.byKind.entries()].sort()),
      elementsInteracted: this.elements.size,
      missions: missions.map((mission) => ({
        id: mission.id,
        name: mission.name,
        status: mission.status,
        steps: this.missionSteps.get(mission.id) ?? 0,
      })),
    };
  }

  get routeCount(): number {
    return this.routes.size;
  }
}

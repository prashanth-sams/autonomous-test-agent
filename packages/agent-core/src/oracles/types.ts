import type {
  Action,
  ActionResult,
  AgentConfig,
  ApplicationState,
  Finding,
  Mission,
  Observation,
  Severity,
} from '@qa-agent/shared-contracts';
import { shortHash, stripVolatile } from '../util/hash';

export interface RequestLogEntry {
  method: string;
  url: string;
  status: number;
  ok: boolean;
  at: string;
}

export interface OracleContext {
  /** State observed after the action ran (or the initial state). */
  state: ApplicationState;
  previousState?: ApplicationState;
  action?: Action;
  result?: ActionResult;
  /** Observations produced while this step ran. */
  observations: Observation[];
  /** Every request seen so far in the run. */
  requestLog: RequestLogEntry[];
  mission?: Mission;
  config: AgentConfig;
}

export interface Oracle {
  readonly name: string;
  /** Oracles must be pure: they judge, they never drive the browser. */
  evaluate(context: OracleContext): Finding[];
}

export function makeFinding(
  context: OracleContext,
  oracle: string,
  params: {
    title: string;
    detail: string;
    severity: Severity;
    /** Stable part of the problem, volatile bits stripped by the caller. */
    fingerprintKey: string;
    observations?: Observation[];
    /**
     * 'state' problems belong to one screen; 'run' problems (a cumulative rule
     * like "never create two orders") belong to the whole session and must not
     * split into one defect per route they happened to be noticed on.
     */
    scope?: 'state' | 'run';
  },
): Finding {
  const fingerprint = shortHash(
    [oracle, params.scope === 'run' ? 'run' : context.state.route, stripVolatile(params.fingerprintKey)].join('::'),
    12,
  );
  return {
    id: shortHash(`${fingerprint}:${Date.now()}:${Math.random()}`, 8),
    oracle,
    title: params.title,
    detail: params.detail,
    severity: params.severity,
    fingerprint,
    stateId: context.state.id,
    route: context.state.route,
    url: context.state.location,
    action: context.action,
    observations: params.observations ?? context.observations,
    missionId: context.mission?.id,
    at: new Date().toISOString(),
  };
}

export function matchesAny(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern, 'i').test(value);
    } catch {
      return value.toLowerCase().includes(pattern.toLowerCase());
    }
  });
}

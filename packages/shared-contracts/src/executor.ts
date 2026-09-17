import type {
  Action,
  ActionResult,
  ApplicationState,
  Observation,
  Platform,
} from './state';
import type { EvidenceRef, ScriptedStep } from './findings';

/**
 * The single seam between the shared testing core and a platform.
 * The core must never import platform code; it only ever sees this interface.
 */
export interface PlatformExecutor {
  readonly platform: Platform;
  readonly name: string;

  /** Bring the application up and ready for observation. */
  start(): Promise<void>;

  /** Snapshot the application as the core understands it. */
  observe(): Promise<ApplicationState>;

  /** Everything the agent could legally do from the current state. */
  availableActions(state: ApplicationState): Promise<Action[]>;

  execute(action: Action): Promise<ActionResult>;

  /** Run a deterministic scripted step (critical journeys, auth, replays). */
  runScriptedStep(step: ScriptedStep): Promise<ActionResult>;

  /** Screenshots, traces, DOM dumps, logs for the given label. */
  captureEvidence(label: string): Promise<EvidenceRef[]>;

  /** Observations collected since the last call (console, network, crashes). */
  drainObservations(): Observation[];

  /** Return to a clean starting point, e.g. for defect verification. */
  reset(): Promise<void>;

  stop(): Promise<void>;
}

/** Executors that can emit a runnable reproduction implement this. */
export interface ReproducibleExecutor {
  /** Source code of a standalone test that replays the given steps. */
  reproductionScript(steps: import('./findings').JourneyStep[], baseUrl: string): string;
}

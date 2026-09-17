import type { Action, ApplicationState, Observation, Severity } from './state';

export interface EvidenceRef {
  kind: 'screenshot' | 'video' | 'trace' | 'har' | 'dom' | 'console' | 'network' | 'repro-script';
  /** Path relative to the run directory. */
  path: string;
  label?: string;
}

/** One step of a reproduction, replayable by an executor. */
export interface JourneyStep {
  index: number;
  action: Action;
  stateBefore: string;
  stateAfter: string;
  /** Where the application was before this step; a replay starts here. */
  locationBefore?: string;
  ok: boolean;
  at: string;
}

/** A suspicion raised by an oracle. Not yet a defect. */
export interface Finding {
  id: string;
  oracle: string;
  title: string;
  detail: string;
  severity: Severity;
  /** Groups findings that are the same underlying problem. */
  fingerprint: string;
  stateId: string;
  route: string;
  url: string;
  action?: Action;
  observations: Observation[];
  missionId?: string;
  at: string;
}

export type DefectStatus =
  | 'reproduced'
  | 'not-reproduced'
  | 'unverified'
  | 'false-positive';

export interface Defect {
  id: string;
  title: string;
  summary: string;
  severity: Severity;
  fingerprint: string;
  status: DefectStatus;
  /** How many times this fingerprint was seen in the run. */
  occurrences: number;
  /** Verification attempts that reproduced it / were attempted. */
  reproductions: { attempts: number; successes: number };
  confidence: number;
  route: string;
  url: string;
  missionId?: string;
  steps: JourneyStep[];
  evidence: EvidenceRef[];
  findings: Finding[];
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface CoverageReport {
  routes: string[];
  statesVisited: number;
  statesKnown: number;
  actionsExecuted: number;
  actionsByKind: Record<string, number>;
  elementsInteracted: number;
  missions: { id: string; name: string; status: MissionStatus; steps: number }[];
}

export type MissionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'blocked';

export interface Mission {
  id: string;
  name: string;
  /** What the agent is trying to accomplish, in plain language. */
  goal: string;
  /** Why this mission was selected (impact analysis, config, AI suggestion). */
  rationale: string;
  source: 'critical-journey' | 'impact-analysis' | 'ai-suggestion' | 'exploration';
  priority: number;
  startUrl?: string;
  /** Keywords that make an action look relevant to this mission. */
  hints: string[];
  /** Optional deterministic script; when present the agent runs it verbatim. */
  script?: ScriptedStep[];
  /** Budget in agent steps. */
  maxSteps: number;
  status: MissionStatus;
}

export interface ScriptedStep {
  kind: 'goto' | 'click' | 'fill' | 'expectText' | 'expectNoText' | 'press' | 'wait';
  selector?: string;
  value?: string;
  description?: string;
}

export interface RunSummary {
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  target: string;
  platform: string;
  build?: string;
  missions: Mission[];
  coverage: CoverageReport;
  defects: Defect[];
  falsePositivesSuppressed: number;
  stepsExecuted: number;
  stoppedBecause: string;
  impact?: ImpactAnalysis;
  /** 'error' means the agent could not test the application, not that it found nothing. */
  recommendation: 'pass' | 'review' | 'block' | 'error';
  costs: { aiCalls: number; aiInputTokens: number; aiOutputTokens: number };
}

export interface ImpactedArea {
  area: string;
  confidence: number;
  changedPaths: string[];
  journeys: string[];
  reason: string;
}

export interface ImpactAnalysis {
  base: string;
  head: string;
  changedFiles: string[];
  areas: ImpactedArea[];
  confidence: number;
  /** Deterministic fallback triggered because confidence was low. */
  broadened: boolean;
  notes: string[];
}

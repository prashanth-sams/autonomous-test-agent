import type {
  Action,
  ActionResult,
  AgentConfig,
  ApplicationState,
  Defect,
  EvidenceRef,
  Finding,
  ImpactAnalysis,
  JourneyStep,
  Mission,
  Observation,
  PlatformExecutor,
  RunSummary,
  ScriptedStep,
} from '@qa-agent/shared-contracts';
import { DefectRepository, severityRank } from './defects/repository';
import { DefectVerifier, type ReplayOutcome } from './defects/verifier';
import { EvidenceCollector } from './evidence/collector';
import { CoverageTracker } from './memory/coverage';
import { StateMemory } from './memory/stateMemory';
import { criticalJourneyMissions, explorationMission } from './missions';
import { defaultOracles, type Oracle, type OracleContext, type RequestLogEntry } from './oracles';
import { HeuristicPlanner, type Planner } from './planning/planner';
import { RiskEngine } from './planning/risk';
import { SafetyPolicy } from './safety/policy';
import { shortHash } from './util/hash';

export interface AgentEvents {
  onStep?: (info: {
    step: number;
    mission: string;
    action: Action;
    rationale: string;
    state: ApplicationState;
  }) => void;
  onFinding?: (finding: Finding) => void;
  onMission?: (mission: Mission) => void;
  onLog?: (message: string) => void;
}

export interface AgentOptions {
  config: AgentConfig;
  executor: PlatformExecutor;
  missions?: Mission[];
  impact?: ImpactAnalysis;
  planner?: Planner;
  events?: AgentEvents;
  runId?: string;
}

/**
 * The shared exploratory-testing core. It knows nothing about browsers: it
 * observes, plans, acts and judges through the PlatformExecutor contract, which
 * is what lets the same loop drive mobile and desktop later.
 */
export class ExplorationAgent {
  private readonly config: AgentConfig;
  private readonly executor: PlatformExecutor;
  private readonly planner: Planner;
  private readonly memory = new StateMemory();
  private readonly coverage = new CoverageTracker();
  private readonly policy: SafetyPolicy;
  private readonly risk: RiskEngine;
  private readonly oracles: Oracle[];
  private readonly defects: DefectRepository;
  private readonly evidence: EvidenceCollector;
  private readonly events: AgentEvents;
  private readonly requestLog: RequestLogEntry[] = [];
  private readonly missions: Mission[];
  private readonly impact?: ImpactAnalysis;
  private readonly runId: string;
  private readonly startedAt = Date.now();
  private steps = 0;
  private stoppedBecause = 'completed all missions';

  constructor(options: AgentOptions) {
    this.config = options.config;
    this.executor = options.executor;
    this.planner = options.planner ?? new HeuristicPlanner();
    this.events = options.events ?? {};
    this.impact = options.impact;
    this.runId = options.runId ?? `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    this.policy = new SafetyPolicy(this.config);
    this.risk = new RiskEngine(this.memory);
    this.oracles = defaultOracles(this.config);
    this.defects = new DefectRepository(this.config.knownFalsePositives);
    this.evidence = new EvidenceCollector(this.config.reporting.outputDir, this.runId, this.policy);

    const targeted = options.missions ?? [];
    const critical = criticalJourneyMissions(this.config);
    const planned = [...critical, ...targeted].sort((a, b) => b.priority - a.priority);
    const usedBudget = planned.reduce((total, mission) => total + mission.maxSteps, 0);
    const leftover = this.config.limits.maxSteps - usedBudget;
    this.missions = leftover > 3 ? [...planned, explorationMission(leftover)] : planned;
  }

  get runDirectory(): string {
    return this.evidence.runDir;
  }

  async run(): Promise<RunSummary> {
    await this.executor.start();
    try {
      await this.authenticate();
      for (const mission of this.missions) {
        if (this.outOfBudget()) {
          // Say plainly why an area went untested; silence here is what makes
          // teams distrust the agent.
          this.stoppedBecause = this.stopReason();
          mission.status = 'skipped';
          continue;
        }
        await this.runMission(mission);
      }
      await this.verifyDefects();
    } finally {
      await this.executor.stop();
    }
    return this.summarize();
  }

  // --- mission execution -------------------------------------------------

  private async authenticate(): Promise<void> {
    const auth = this.config.auth;
    if (!auth?.steps?.length) return;
    this.log('authenticating');
    for (const step of auth.steps) {
      const result = await this.executor.runScriptedStep(step);
      if (!result.ok) {
        throw new Error(`Authentication step failed: ${step.kind} ${step.selector ?? ''} — ${result.error}`);
      }
    }
    this.executor.drainObservations();
    if (auth.verifyText) {
      const state = await this.executor.observe();
      if (!state.text.toLowerCase().includes(auth.verifyText.toLowerCase())) {
        throw new Error(`Authentication could not be confirmed: "${auth.verifyText}" not visible`);
      }
    }
  }

  private async runMission(mission: Mission): Promise<void> {
    mission.status = 'running';
    this.events.onMission?.(mission);
    this.log(`mission: ${mission.name} — ${mission.rationale}`);
    this.memory.markJourneyBoundary();

    try {
      await this.executor.reset();
      if (mission.startUrl) {
        await this.executor.runScriptedStep({ kind: 'goto', value: mission.startUrl });
      }

      if (mission.script?.length) {
        const ok = await this.runScript(mission, mission.script);
        mission.status = ok ? 'completed' : 'failed';
        if (!ok) return;
      }

      const budget = Math.min(mission.maxSteps, this.config.limits.maxSteps - this.steps);
      await this.explore(mission, budget);
      if (mission.status === 'running') mission.status = 'completed';
    } catch (error) {
      mission.status = 'failed';
      this.log(`mission ${mission.name} failed: ${(error as Error).message}`);
    }
  }

  /** Deterministic part of a critical journey: exact steps, exact expectations. */
  private async runScript(mission: Mission, script: ScriptedStep[]): Promise<boolean> {
    for (const step of script) {
      const result = await this.executor.runScriptedStep(step);
      this.steps += 1;
      const state = await this.executor.observe();
      this.memory.observe(state);
      this.coverage.visitState(state);
      this.coverage.recordAction(state, result.action, mission.id);
      this.memory.record(result);
      await this.judge(state, result, mission);

      if (!result.ok) {
        // A failing expectation in a critical journey is itself a defect.
        await this.raise(
          {
            oracle: 'critical-journey',
            title: `Critical journey "${mission.name}" broke at: ${describeStep(step)}`,
            detail: result.error ?? 'step failed',
            severity: 'critical',
            fingerprintKey: `journey ${mission.id} ${describeStep(step)}`,
          },
          state,
          result.action,
          mission,
        );
        return false;
      }
    }
    return true;
  }

  /** Autonomous part: observe, choose, act, judge — until the budget runs out. */
  private async explore(mission: Mission, budget: number): Promise<void> {
    const recent: Action[] = [];
    for (let taken = 0; taken < budget; taken += 1) {
      if (this.outOfBudget()) {
        this.stoppedBecause = this.stopReason();
        return;
      }

      const state = await this.executor.observe();
      this.memory.observe(state);
      this.coverage.visitState(state);
      await this.judge(state, undefined, mission);

      const candidates = (await this.executor.availableActions(state)).filter((action) => {
        const verdict = this.policy.check(action);
        if (!verdict.allowed) this.log(`blocked: ${action.description} (${verdict.reason})`);
        return verdict.allowed;
      });

      if (candidates.length === 0) {
        this.log(`no permitted actions in ${state.route}; returning to start`);
        await this.executor.reset();
        continue;
      }

      const ranked = this.risk.rank(state, candidates, mission);
      const decision = await this.planner.decide({
        state,
        candidates,
        mission,
        stepsTaken: this.steps,
        stepsRemaining: this.config.limits.maxSteps - this.steps,
        ranked,
        recentActions: recent,
      });
      if (!decision.action) {
        await this.executor.reset();
        continue;
      }

      this.steps += 1;
      recent.push(decision.action);
      this.events.onStep?.({
        step: this.steps,
        mission: mission.name,
        action: decision.action,
        rationale: decision.rationale,
        state,
      });

      const result = await this.executor.execute(decision.action);
      this.coverage.recordAction(state, decision.action, mission.id);
      this.memory.record(result);

      const nextState = await this.executor.observe();
      this.memory.observe(nextState);
      this.coverage.visitState(nextState);
      await this.judge(nextState, result, mission, state);
    }
  }

  // --- judging -----------------------------------------------------------

  private async judge(
    state: ApplicationState,
    result?: ActionResult,
    mission?: Mission,
    previousState?: ApplicationState,
  ): Promise<void> {
    const observations = [...(result?.observations ?? []), ...this.executor.drainObservations()];
    this.ingestRequests(observations);

    const context: OracleContext = {
      state,
      previousState,
      action: result?.action,
      result,
      observations,
      requestLog: this.requestLog,
      mission,
      config: this.config,
    };

    for (const oracle of this.oracles) {
      for (const finding of oracle.evaluate(context)) {
        await this.report(finding, mission);
      }
    }
  }

  private ingestRequests(observations: Observation[]): void {
    for (const observation of observations) {
      if (observation.type !== 'network') continue;
      this.requestLog.push({
        method: String(observation.detail?.method ?? 'GET'),
        url: String(observation.detail?.url ?? ''),
        status: Number(observation.detail?.status ?? 0),
        ok: Boolean(observation.detail?.ok),
        at: observation.at,
      });
    }
  }

  /** Raise a finding the agent produced itself (outside the oracle suite). */
  private async raise(
    params: { oracle: string; title: string; detail: string; severity: Finding['severity']; fingerprintKey: string },
    state: ApplicationState,
    action: Action | undefined,
    mission: Mission,
  ): Promise<void> {
    const finding: Finding = {
      id: shortHash(`${params.fingerprintKey}:${Date.now()}`, 8),
      oracle: params.oracle,
      title: params.title,
      detail: params.detail,
      severity: params.severity,
      fingerprint: shortHash(`${params.oracle}::${state.route}::${params.fingerprintKey}`, 12),
      stateId: state.id,
      route: state.route,
      url: state.location,
      action,
      observations: [],
      missionId: mission.id,
      at: new Date().toISOString(),
    };
    await this.report(finding, mission);
  }

  private async report(finding: Finding, mission?: Mission): Promise<void> {
    const known = this.defects.get(finding.fingerprint);
    this.events.onFinding?.(finding);

    let evidence: EvidenceRef[] = [];
    if (!known && this.defects.count < this.config.limits.maxDefects) {
      // Capture evidence once per distinct problem, not once per occurrence.
      evidence = await this.executor.captureEvidence(`finding-${finding.fingerprint}`);
      evidence.push(
        this.evidence.writeJson(`finding-${finding.fingerprint}.json`, finding, 'console', finding.title),
      );
    }
    const steps = mission ? this.memory.reproductionPath() : [];
    this.defects.add(finding, steps, evidence);
  }

  // --- verification ------------------------------------------------------

  private async verifyDefects(): Promise<void> {
    const candidates = this.defects
      .list()
      .filter((defect) => defect.status === 'unverified' && defect.steps.length > 0);
    if (candidates.length === 0) return;

    this.log(`verifying ${candidates.length} candidate defect(s)`);
    const verifier = new DefectVerifier(
      this.defects,
      (steps, label) => this.replay(steps, label),
      this.config.limits.verificationAttempts,
    );
    await verifier.verify(candidates);
  }

  /** Replay a reproduction path from a clean state and re-run the oracles. */
  private async replay(steps: JourneyStep[], label: string): Promise<ReplayOutcome> {
    const fingerprints: string[] = [];
    const findings: Finding[] = [];
    // Cumulative rules ("never create two orders") would fire trivially if the
    // replay inherited the run's request log, so verification starts clean.
    const replayRequestLog: RequestLogEntry[] = [];
    await this.executor.reset();
    // A mission may have started deep in the app; replaying from the home page
    // would fail on the first step and report the defect as not reproducible.
    const entryPoint = steps[0]?.locationBefore;
    if (entryPoint) {
      await this.executor.runScriptedStep({ kind: 'goto', value: entryPoint });
    }
    this.executor.drainObservations();

    let previousState = await this.executor.observe();
    for (const step of steps) {
      const result = await this.executor.execute(step.action);
      const state = await this.executor.observe();
      const observations = [...result.observations, ...this.executor.drainObservations()];
      for (const observation of observations) {
        if (observation.type !== 'network') continue;
        replayRequestLog.push({
          method: String(observation.detail?.method ?? 'GET'),
          url: String(observation.detail?.url ?? ''),
          status: Number(observation.detail?.status ?? 0),
          ok: Boolean(observation.detail?.ok),
          at: observation.at,
        });
      }
      const context: OracleContext = {
        state,
        previousState,
        action: step.action,
        result,
        observations,
        requestLog: replayRequestLog,
        config: this.config,
      };
      for (const oracle of this.oracles) {
        for (const finding of oracle.evaluate(context)) {
          findings.push(finding);
          fingerprints.push(finding.fingerprint);
        }
      }
      previousState = state;
      if (!result.ok) break;
    }

    const evidence = await this.executor.captureEvidence(label);
    return { fingerprints, findings, evidence };
  }

  // --- reporting ---------------------------------------------------------

  private outOfBudget(): boolean {
    return (
      this.steps >= this.config.limits.maxSteps ||
      Date.now() - this.startedAt >= this.config.limits.maxDurationMs ||
      this.defects.count >= this.config.limits.maxDefects
    );
  }

  private stopReason(): string {
    if (this.defects.count >= this.config.limits.maxDefects) return 'defect limit reached';
    if (this.steps >= this.config.limits.maxSteps) return 'step budget exhausted';
    return 'time budget exhausted';
  }

  private summarize(): RunSummary {
    const finishedAt = Date.now();
    const defects = this.defects.list();
    return {
      runId: this.runId,
      startedAt: new Date(this.startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs: finishedAt - this.startedAt,
      target: this.config.target.baseUrl,
      platform: this.executor.platform,
      build: this.config.target.build,
      missions: this.missions,
      coverage: this.coverage.report(this.missions, this.memory.size),
      defects,
      falsePositivesSuppressed: this.defects.suppressedCount,
      stepsExecuted: this.steps,
      stoppedBecause: this.stoppedBecause,
      impact: this.impact,
      recommendation: recommend(defects, this.config),
      costs: this.planner.usage(),
    };
  }

  private log(message: string): void {
    this.events.onLog?.(message);
  }
}

/**
 * Merge advice. Only defects that were actually reproduced can block, so a
 * one-off flake never stops a team from shipping.
 */
export function recommend(defects: Defect[], config: AgentConfig): RunSummary['recommendation'] {
  const actionable = defects.filter(
    (defect) => defect.status === 'reproduced' || defect.status === 'unverified',
  );
  const blocking = actionable.filter(
    (defect) =>
      defect.status === 'reproduced' &&
      severityRank(defect.severity) >= severityRank('high') &&
      defect.confidence >= 0.7,
  );
  if (blocking.length > 0) return config.mode === 'blocking' ? 'block' : 'review';
  if (actionable.length > 0) return 'review';
  return 'pass';
}

function describeStep(step: ScriptedStep): string {
  return [step.description, step.kind, step.selector, step.value].filter(Boolean).join(' ').trim();
}

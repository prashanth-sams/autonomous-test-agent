import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type {
  Action,
  AgentConfig,
  ApplicationState,
  Finding,
  JourneyStep,
  Mission,
  PlatformExecutor,
} from '@qa-agent/shared-contracts';
import { ExplorationAgent, recommend } from './agent';
import { DefectRepository } from './defects/repository';
import { analyzeImpact, missionsFromImpact } from './impact/analyzer';
import { StateMemory } from './memory/stateMemory';
import { InvariantOracle } from './oracles/invariants';
import { ConsoleErrorOracle } from './oracles/runtime';
import type { OracleContext } from './oracles/types';
import { RiskEngine } from './planning/risk';
import { SafetyPolicy } from './safety/policy';
import { maskRoute } from './util/route';

function config(patch: Partial<AgentConfig> = {}): AgentConfig {
  return {
    target: { baseUrl: 'https://shop.example.com' },
    criticalJourneys: [],
    rules: [],
    limits: {
      maxSteps: 40,
      maxDurationMs: 60_000,
      maxDefects: 20,
      verificationAttempts: 1,
      actionTimeoutMs: 5000,
    },
    safety: {
      allowedHosts: ['shop.example.com'],
      prohibitedActions: ['complete real payment'],
      destructiveKeywords: ['delete'],
      allowDestructive: false,
      redactKeys: ['password'],
    },
    impactMap: [],
    oracles: {
      consoleErrors: true,
      networkFailures: true,
      pageCrash: true,
      unresponsiveElements: true,
      brokenLinks: true,
      missingContent: true,
      accessibility: false,
      invariants: true,
      ignorePatterns: [],
      ignoreStatusFor: [],
    },
    planner: { kind: 'heuristic' },
    browser: { name: 'chromium', headless: true },
    knownFalsePositives: [],
    reporting: { outputDir: 'runs', video: false, trace: false, har: false },
    mode: 'advisory',
    ...patch,
  };
}

function state(patch: Partial<ApplicationState> = {}): ApplicationState {
  return {
    id: 'state-1',
    platform: 'web',
    signature: 'sig',
    location: 'https://shop.example.com/checkout',
    route: '/checkout',
    title: 'Checkout',
    elements: [],
    text: 'Checkout page',
    modalOpen: false,
    capturedAt: new Date().toISOString(),
    meta: {},
    ...patch,
  };
}

function context(patch: Partial<OracleContext> = {}): OracleContext {
  return {
    state: state(),
    observations: [],
    requestLog: [],
    config: config(),
    ...patch,
  };
}

function finding(patch: Partial<Finding> = {}): Finding {
  return {
    id: 'f1',
    oracle: 'network-failures',
    title: 'HTTP 500 on POST /api/orders',
    detail: 'boom',
    severity: 'high',
    fingerprint: 'fp-1',
    stateId: 'state-1',
    route: '/checkout',
    url: 'https://shop.example.com/checkout',
    observations: [],
    at: new Date().toISOString(),
    ...patch,
  };
}

const steps: JourneyStep[] = [
  {
    index: 0,
    action: { id: 'a1', kind: 'click', description: 'Click button "Place order"' },
    stateBefore: 'state-0',
    stateAfter: 'state-1',
    ok: true,
    at: new Date().toISOString(),
  },
];

test('impact analysis maps changed files to areas and journeys', () => {
  const analysis = analyzeImpact(
    { base: 'main', head: 'pr', changedFiles: ['web/components/PaymentForm.tsx'] },
    config({
      impactMap: [
        {
          paths: ['web/components/Payment*'],
          area: 'Payments',
          journeys: ['checkout', 'refund'],
          confidence: 0.9,
        },
      ],
    }),
  );

  assert.equal(analysis.areas.length, 1);
  assert.equal(analysis.areas[0]?.area, 'Payments');
  assert.equal(analysis.broadened, false);
  assert.equal(missionsFromImpact(analysis, config()).length, 2);
});

test('unmapped changes lower confidence and broaden the scope', () => {
  const analysis = analyzeImpact(
    { base: 'main', head: 'pr', changedFiles: ['services/unknown/thing.ts'] },
    config(),
  );

  assert.equal(analysis.areas.length, 0);
  assert.equal(analysis.broadened, true);
  assert.ok(analysis.notes.some((note) => note.includes('not in the impact map')));
});

test('an empty diff never narrows testing to nothing', () => {
  const analysis = analyzeImpact({ base: 'main', head: 'pr', changedFiles: [] }, config());
  assert.equal(analysis.confidence, 0);
  assert.equal(analysis.broadened, true);
});

test('identical findings merge into one defect instead of spamming the PR', () => {
  const repository = new DefectRepository();
  repository.add(finding(), steps, []);
  repository.add(finding({ id: 'f2' }), steps, []);

  assert.equal(repository.count, 1);
  assert.equal(repository.list()[0]?.occurrences, 2);
});

test('known false positives are suppressed', () => {
  const repository = new DefectRepository(['fp-1']);
  assert.equal(repository.add(finding(), steps, []), null);
  assert.equal(repository.count, 0);
  assert.equal(repository.suppressedCount, 1);
});

test('confidence rises when a defect reproduces and collapses when it does not', () => {
  const reproduced = new DefectRepository();
  reproduced.add(finding(), steps, []);
  reproduced.recordVerification('fp-1', true);

  const flaky = new DefectRepository();
  flaky.add(finding(), steps, []);
  flaky.recordVerification('fp-1', false);

  assert.equal(reproduced.list()[0]?.status, 'reproduced');
  assert.equal(flaky.list()[0]?.status, 'not-reproduced');
  assert.ok((reproduced.list()[0]?.confidence ?? 0) > (flaky.list()[0]?.confidence ?? 1));
});

test('only reproduced high-severity defects can block a merge', () => {
  const repository = new DefectRepository();
  repository.add(finding({ severity: 'critical' }), steps, []);
  const unverified = repository.list();
  assert.equal(recommend(unverified, config({ mode: 'blocking' })), 'review');

  repository.recordVerification('fp-1', true);
  assert.equal(recommend(repository.list(), config({ mode: 'blocking' })), 'block');
  // Advisory mode never blocks, whatever the agent found.
  assert.equal(recommend(repository.list(), config({ mode: 'advisory' })), 'review');
});

test('a clean run passes', () => {
  assert.equal(recommend([], config({ mode: 'blocking' })), 'pass');
});

test('a run whose every mission failed reports an error, not a pass', () => {
  const mission = (status: Mission['status']): Mission => ({
    id: `m-${status}`,
    name: `mission ${status}`,
    goal: 'exercise the fixture',
    rationale: 'test fixture',
    source: 'critical-journey',
    priority: 1,
    hints: [],
    maxSteps: 5,
    status,
  });

  // Nothing was tested, so an empty defect list proves nothing.
  assert.equal(
    recommend([], config({ mode: 'advisory' }), [mission('failed'), mission('failed')]),
    'error',
  );
  // One mission that got through is enough for the defects to mean something.
  assert.equal(
    recommend([], config({ mode: 'advisory' }), [mission('failed'), mission('completed')]),
    'pass',
  );
  // A run stopped by its budget has not errored.
  assert.equal(recommend([], config({ mode: 'advisory' }), [mission('skipped')]), 'pass');
});

test('a failed login still produces an error summary instead of throwing', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'qa-agent-'));
  const calls: string[] = [];
  const executor: PlatformExecutor = {
    platform: 'web',
    name: 'stub',
    start: async () => void calls.push('start'),
    observe: async () => state(),
    availableActions: async () => [],
    execute: async () => {
      throw new Error('no mission should run');
    },
    runScriptedStep: async () => ({
      action: { id: 'login', kind: 'click', description: 'Log in' },
      ok: false,
      error: 'selector not found',
      durationMs: 0,
      stateBefore: 'state-0',
      stateAfter: 'state-0',
      noOp: true,
      observations: [],
    }),
    captureEvidence: async (label) => {
      calls.push(`evidence:${label}`);
      return [];
    },
    drainObservations: () => [],
    reset: async () => undefined,
    stop: async () => void calls.push('stop'),
  };

  try {
    const agent = new ExplorationAgent({
      executor,
      config: config({
        auth: { steps: [{ kind: 'click', selector: '#login' }] },
        reporting: { outputDir, video: false, trace: false, har: false },
      }),
    });
    const summary = await agent.run();

    assert.equal(summary.recommendation, 'error');
    assert.match(summary.stoppedBecause, /^authentication failed: .*selector not found/);
    assert.ok(summary.missions.every((mission) => mission.status === 'skipped'));
    assert.deepEqual(calls, ['start', 'evidence:setup-failure', 'stop']);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('safety policy blocks destructive and prohibited actions', () => {
  const policy = new SafetyPolicy(config());
  const click = (description: string): Action => ({ id: 'a', kind: 'click', description });

  assert.equal(policy.check(click('Click button "Delete account"')).allowed, false);
  assert.equal(policy.check(click('Click button "complete real payment"')).allowed, false);
  assert.equal(policy.check(click('Click button "Add to cart"')).allowed, true);
  assert.equal(policy.blockedActions().length, 2);
});

test('navigation outside the allowed hosts is blocked', () => {
  const policy = new SafetyPolicy(config());
  const navigate: Action = {
    id: 'a',
    kind: 'navigate',
    value: 'https://evil.example.net/',
    description: 'Open https://evil.example.net/',
  };
  assert.equal(policy.check(navigate).allowed, false);
  assert.equal(policy.hostAllowed('shop.example.com'), true);
});

test('secrets are redacted from evidence', () => {
  const policy = new SafetyPolicy(config());
  assert.equal(policy.redact('{"password": "hunter2"}'), '{"password": "***"}');
});

test('risk engine prefers mission-relevant, untried actions', () => {
  const memory = new StateMemory();
  const current = state();
  memory.observe(current);
  const risk = new RiskEngine(memory);

  const ranked = risk.rank(
    current,
    [
      { id: 'a1', kind: 'click', description: 'Click link "Privacy policy"' },
      { id: 'a2', kind: 'click', description: 'Click button "Place order"' },
    ],
    {
      id: 'checkout',
      name: 'Checkout',
      goal: '',
      rationale: '',
      source: 'critical-journey',
      priority: 1,
      hints: ['order'],
      maxSteps: 10,
      status: 'pending',
    },
  );

  assert.equal(ranked[0]?.action.id, 'a2');
  assert.ok(ranked[0]?.reasons.some((reason) => reason.includes('mission hints')));
});

test('repeating an action is penalised so the agent does not loop', () => {
  const memory = new StateMemory();
  const current = state();
  memory.observe(current);
  const action: Action = { id: 'a1', kind: 'click', description: 'Click button "Next"' };
  const risk = new RiskEngine(memory);
  const before = risk.score(current, action).score;

  memory.record({
    action,
    ok: true,
    durationMs: 10,
    stateBefore: current.id,
    stateAfter: current.id,
    noOp: false,
    observations: [],
  });

  assert.ok(risk.score(current, action).score < before);
  assert.equal(memory.isKnownDeadEnd(current.id, action), true);
});

test('cumulative business rules fire on repeated successful requests', () => {
  const oracle = new InvariantOracle();
  const findings = oracle.evaluate(
    context({
      config: config({
        rules: [
          {
            id: 'single-order',
            description: 'An order must never be created twice',
            maxRequests: { method: 'POST', urlPattern: '/api/orders$', max: 1 },
            severity: 'critical',
          },
        ],
      }),
      requestLog: [
        { method: 'POST', url: 'https://shop.example.com/api/orders', status: 200, ok: true, at: 'now' },
        { method: 'POST', url: 'https://shop.example.com/api/orders', status: 200, ok: true, at: 'now' },
      ],
    }),
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, 'critical');
});

test('forbidden text rules only apply on their configured route', () => {
  const oracle = new InvariantOracle();
  const rules = [
    {
      id: 'no-declined-order',
      description: 'A declined payment must not create an order',
      route: '/checkout',
      forbidText: 'Payment declined for order',
      severity: 'critical' as const,
    },
  ];
  const text = 'Payment declined for order 1001';

  assert.equal(
    oracle.evaluate(context({ config: config({ rules }), state: state({ text }) })).length,
    1,
  );
  assert.equal(
    oracle.evaluate(
      context({ config: config({ rules }), state: state({ route: '/cart', text }) }),
    ).length,
    0,
  );
});

test('console noise that only echoes a failed request is not a separate defect', () => {
  const oracle = new ConsoleErrorOracle();
  const observations = [
    {
      type: 'console' as const,
      severity: 'high' as const,
      message: 'Failed to load resource: the server responded with a status of 500',
      at: 'now',
    },
    {
      type: 'network' as const,
      severity: 'high' as const,
      message: 'GET /api/inventory -> 500',
      detail: { status: 500, url: '/api/inventory', method: 'GET' },
      at: 'now',
    },
  ];

  assert.equal(oracle.evaluate(context({ observations })).length, 0);
});

test('routes are masked so per-record pages collapse into one route', () => {
  assert.equal(maskRoute('https://shop.example.com/orders/1042'), '/orders/:id');
  assert.equal(maskRoute('https://shop.example.com/'), '/');
});

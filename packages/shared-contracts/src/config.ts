import type { ScriptedStep } from './findings';

/** Business invariant supplied by the customer: the part AI cannot infer. */
export interface InvariantRule {
  id: string;
  description: string;
  /** Where the rule applies; matched against the masked route. */
  route?: string;
  /** Rule fails if this text is visible. */
  forbidText?: string;
  /** Rule fails if this text is missing. */
  requireText?: string;
  /** Rule fails if a matching element is present and enabled. */
  forbidElement?: { role?: string; name?: string };
  /** Rule fails if more than `max` requests match method+urlPattern. */
  maxRequests?: { method?: string; urlPattern: string; max: number };
  severity?: 'low' | 'medium' | 'high' | 'critical';
}

export interface AuthConfig {
  /** Deterministic login steps, run before exploration. */
  steps?: ScriptedStep[];
  /** Reuse a Playwright storageState file instead of logging in. */
  storageStatePath?: string;
  /** Text that proves login succeeded. */
  verifyText?: string;
}

export interface LimitsConfig {
  maxSteps: number;
  maxDurationMs: number;
  maxDefects: number;
  /** Verification replays per candidate defect. */
  verificationAttempts: number;
  actionTimeoutMs: number;
}

export interface SafetyConfig {
  /** Navigation outside these hosts is blocked and reported. */
  allowedHosts: string[];
  /** Action descriptions/names matching these are never executed. */
  prohibitedActions: string[];
  /** Treated as destructive; executed only when allowDestructive is true. */
  destructiveKeywords: string[];
  allowDestructive: boolean;
  /** Values matching these keys are redacted from evidence and reports. */
  redactKeys: string[];
}

export interface ImpactMapEntry {
  /** Glob-ish path prefixes/patterns from the diff. */
  paths: string[];
  area: string;
  journeys: string[];
  confidence: number;
}

export interface AgentConfig {
  target: { baseUrl: string; build?: string };
  auth?: AuthConfig;
  criticalJourneys: Array<{
    id: string;
    name: string;
    goal?: string;
    startUrl?: string;
    hints?: string[];
    script?: ScriptedStep[];
  }>;
  rules: InvariantRule[];
  limits: LimitsConfig;
  safety: SafetyConfig;
  impactMap: ImpactMapEntry[];
  oracles: {
    consoleErrors: boolean;
    networkFailures: boolean;
    pageCrash: boolean;
    unresponsiveElements: boolean;
    brokenLinks: boolean;
    missingContent: boolean;
    accessibility: boolean;
    invariants: boolean;
    /** Console/network noise the customer accepts. */
    ignorePatterns: string[];
    /** Status codes that are expected (e.g. 401 on a probe endpoint). */
    ignoreStatusFor: string[];
  };
  planner: { kind: 'heuristic' | 'ai'; model?: string; maxAiCalls?: number };
  browser: { name: 'chromium' | 'firefox' | 'webkit'; headless: boolean; viewport?: { width: number; height: number } };
  /** Fingerprints marked as false positives by humans in earlier runs. */
  knownFalsePositives: string[];
  reporting: { outputDir: string; video: boolean; trace: boolean; har: boolean };
  mode: 'advisory' | 'blocking';
}

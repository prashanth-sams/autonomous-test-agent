import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import type { AgentConfig } from '@qa-agent/shared-contracts';

/** Conservative defaults: bounded, non-destructive, advisory. */
export function defaultConfig(baseUrl: string): AgentConfig {
  const host = safeHost(baseUrl);
  return {
    target: { baseUrl },
    criticalJourneys: [],
    rules: [],
    limits: {
      maxSteps: 60,
      maxDurationMs: 10 * 60 * 1000,
      maxDefects: 25,
      verificationAttempts: 2,
      actionTimeoutMs: 10_000,
    },
    safety: {
      allowedHosts: host ? [host] : [],
      prohibitedActions: [],
      destructiveKeywords: [
        'delete',
        'remove account',
        'deactivate',
        'wipe',
        'purge',
        'pay now',
        'confirm payment',
        'send email',
      ],
      allowDestructive: false,
      redactKeys: ['password', 'token', 'secret', 'authorization', 'apiKey', 'api_key'],
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
      ignorePatterns: ['favicon.ico', 'analytics', 'google-analytics', 'hotjar', 'sentry'],
      ignoreStatusFor: [],
    },
    planner: { kind: 'heuristic' },
    browser: { name: 'chromium', headless: true },
    knownFalsePositives: [],
    reporting: { outputDir: 'runs', video: false, trace: true, har: false },
    mode: 'advisory',
  };
}

/** Load agent.yaml (or .json) and merge it over the defaults. */
export function loadConfig(configPath: string | undefined, overrides: Partial<AgentConfig> = {}): AgentConfig {
  let fileConfig: Partial<AgentConfig> = {};
  if (configPath) {
    const absolute = resolve(configPath);
    if (!existsSync(absolute)) throw new Error(`Config file not found: ${absolute}`);
    fileConfig = parse(readFileSync(absolute, 'utf8')) as Partial<AgentConfig>;
  }

  const baseUrl =
    overrides.target?.baseUrl ?? fileConfig.target?.baseUrl ?? 'http://localhost:3000';
  const base = defaultConfig(baseUrl);
  const merged = deepMerge(deepMerge(base, fileConfig), overrides) as AgentConfig;

  // A config that names a target but no allowed hosts would let the agent wander.
  if (merged.safety.allowedHosts.length === 0) {
    const host = safeHost(merged.target.baseUrl);
    if (host) merged.safety.allowedHosts = [host];
  }
  return merged;
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined || patch === null) return base;
  if (Array.isArray(patch) || typeof patch !== 'object') return patch as T;
  const output: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    const current = output[key];
    output[key] =
      current && typeof current === 'object' && !Array.isArray(current)
        ? deepMerge(current, value)
        : value;
  }
  return output as T;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

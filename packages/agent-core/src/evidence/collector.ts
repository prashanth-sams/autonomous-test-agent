import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvidenceRef } from '@qa-agent/shared-contracts';
import type { SafetyPolicy } from '../safety/policy';

/**
 * Owns the run directory. Executors write their artefacts inside it and return
 * run-relative paths, so a report stays portable when the directory is zipped
 * and attached to a PR.
 */
export class EvidenceCollector {
  readonly runDir: string;

  constructor(
    baseDir: string,
    readonly runId: string,
    private readonly policy: SafetyPolicy,
  ) {
    this.runDir = join(baseDir, runId);
    mkdirSync(join(this.runDir, 'artifacts'), { recursive: true });
  }

  /** Persist arbitrary structured evidence (logs, DOM dumps, repro scripts). */
  write(name: string, contents: string, kind: EvidenceRef['kind'], label?: string): EvidenceRef {
    const relative = join('artifacts', name);
    writeFileSync(join(this.runDir, relative), this.policy.redact(contents), 'utf8');
    return { kind, path: relative, label: label ?? name };
  }

  writeJson(name: string, value: unknown, kind: EvidenceRef['kind'], label?: string): EvidenceRef {
    return this.write(name, JSON.stringify(value, null, 2), kind, label);
  }

  path(...segments: string[]): string {
    return join(this.runDir, ...segments);
  }
}

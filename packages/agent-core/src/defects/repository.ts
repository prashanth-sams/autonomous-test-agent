import type { Defect, EvidenceRef, Finding, JourneyStep, Severity } from '@qa-agent/shared-contracts';
import { shortHash } from '../util/hash';

const SEVERITY_ORDER: Severity[] = ['info', 'low', 'medium', 'high', 'critical'];

/** How much each oracle is trusted before verification. */
const ORACLE_BASE_CONFIDENCE: Record<string, number> = {
  'page-crash': 0.95,
  'business-invariant': 0.9,
  'network-failures': 0.8,
  'console-errors': 0.7,
  'broken-links': 0.8,
  'missing-content': 0.7,
  'unexpected-navigation': 0.55,
  'unresponsive-element': 0.5,
  accessibility: 0.85,
};

/**
 * Collects findings into defects: identical fingerprints merge instead of
 * spamming the PR, known false positives are dropped, and confidence reflects
 * both the oracle's reliability and whether the defect was reproduced.
 */
export class DefectRepository {
  private readonly defects = new Map<string, Defect>();
  private suppressed = 0;

  constructor(private readonly knownFalsePositives: string[] = []) {}

  add(finding: Finding, steps: JourneyStep[], evidence: EvidenceRef[]): Defect | null {
    if (this.knownFalsePositives.includes(finding.fingerprint)) {
      this.suppressed += 1;
      return null;
    }

    const existing = this.defects.get(finding.fingerprint);
    if (existing) {
      existing.occurrences += 1;
      existing.lastSeenAt = finding.at;
      existing.findings.push(finding);
      if (severityRank(finding.severity) > severityRank(existing.severity)) {
        existing.severity = finding.severity;
      }
      // Keep the first path that produced the problem. A later, shorter path is
      // usually just a re-observation of the same cumulative state (a rule that
      // stays violated), and replaying it would not reproduce anything.
      if (existing.steps.length === 0 && steps.length > 0) {
        existing.steps = steps;
        existing.evidence = [...existing.evidence, ...evidence];
      }
      existing.confidence = this.confidenceFor(existing);
      return existing;
    }

    const defect: Defect = {
      id: `DEF-${shortHash(finding.fingerprint, 6).toUpperCase()}`,
      title: finding.title,
      summary: finding.detail,
      severity: finding.severity,
      fingerprint: finding.fingerprint,
      status: 'unverified',
      occurrences: 1,
      reproductions: { attempts: 0, successes: 0 },
      confidence: ORACLE_BASE_CONFIDENCE[finding.oracle] ?? 0.5,
      route: finding.route,
      url: finding.url,
      missionId: finding.missionId,
      steps,
      evidence,
      findings: [finding],
      firstSeenAt: finding.at,
      lastSeenAt: finding.at,
    };
    this.defects.set(finding.fingerprint, defect);
    return defect;
  }

  recordVerification(fingerprint: string, reproduced: boolean, evidence: EvidenceRef[] = []): void {
    const defect = this.defects.get(fingerprint);
    if (!defect) return;
    defect.reproductions.attempts += 1;
    if (reproduced) {
      defect.reproductions.successes += 1;
      defect.status = 'reproduced';
      defect.evidence = [...defect.evidence, ...evidence];
    } else if (defect.reproductions.successes === 0) {
      defect.status = 'not-reproduced';
    }
    defect.confidence = this.confidenceFor(defect);
  }

  markFalsePositive(fingerprint: string): void {
    const defect = this.defects.get(fingerprint);
    if (!defect) return;
    defect.status = 'false-positive';
    defect.confidence = 0;
  }

  private confidenceFor(defect: Defect): number {
    const base = ORACLE_BASE_CONFIDENCE[defect.findings[0]?.oracle ?? ''] ?? 0.5;
    const repeatBoost = Math.min(0.1, (defect.occurrences - 1) * 0.02);
    const { attempts, successes } = defect.reproductions;
    if (attempts === 0) return round(Math.min(0.9, base + repeatBoost));
    const rate = successes / attempts;
    if (successes === 0) return round(Math.max(0.05, base * 0.25));
    // Fully reproducible findings are what we are willing to block a merge on.
    return round(Math.min(0.99, base * 0.6 + rate * 0.4 + repeatBoost));
  }

  list(): Defect[] {
    return [...this.defects.values()].sort(
      (a, b) =>
        severityRank(b.severity) - severityRank(a.severity) || b.confidence - a.confidence,
    );
  }

  get(fingerprint: string): Defect | undefined {
    return this.defects.get(fingerprint);
  }

  get count(): number {
    return this.defects.size;
  }

  get suppressedCount(): number {
    return this.suppressed;
  }
}

export function severityRank(severity: Severity): number {
  return SEVERITY_ORDER.indexOf(severity);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

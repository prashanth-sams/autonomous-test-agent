import type { Defect, EvidenceRef, Finding, JourneyStep } from '@qa-agent/shared-contracts';
import type { DefectRepository } from './repository';

export interface ReplayOutcome {
  /** Fingerprints observed during the replay. */
  fingerprints: string[];
  findings: Finding[];
  evidence: EvidenceRef[];
}

export type ReplayFn = (steps: JourneyStep[], label: string) => Promise<ReplayOutcome>;

/**
 * "Repeat a suspicious failure before reporting it." Every candidate defect is
 * replayed from a clean state; only ones that come back are reported as
 * reproduced, and flaky ones are labelled instead of silently dropped.
 */
export class DefectVerifier {
  constructor(
    private readonly repository: DefectRepository,
    private readonly replay: ReplayFn,
    private readonly attempts: number,
  ) {}

  async verify(defects: Defect[]): Promise<void> {
    if (this.attempts <= 0) return;
    for (const defect of defects) {
      if (defect.steps.length === 0) {
        // Nothing to replay (e.g. found on the landing page); leave unverified.
        continue;
      }
      for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
        const outcome = await this.replay(defect.steps, `verify-${defect.id}-${attempt}`);
        const reproduced = outcome.fingerprints.includes(defect.fingerprint);
        this.repository.recordVerification(defect.fingerprint, reproduced, outcome.evidence);
        if (reproduced) break;
      }
    }
  }
}

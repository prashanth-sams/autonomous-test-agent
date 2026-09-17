import type { Action, AgentConfig } from '@qa-agent/shared-contracts';
import { hostOf } from '../util/route';

export interface PolicyVerdict {
  allowed: boolean;
  reason?: string;
}

/**
 * Bounds the agent. Destructive and prohibited actions are blocked before they
 * reach the executor, navigation is confined to the application under test, and
 * anything that looks like a secret is redacted out of evidence and reports.
 */
export class SafetyPolicy {
  private readonly prohibited: RegExp[];
  private readonly destructive: RegExp[];
  private readonly blocked: Array<{ action: string; reason: string }> = [];

  constructor(private readonly config: AgentConfig) {
    this.prohibited = compile(config.safety.prohibitedActions);
    this.destructive = compile(config.safety.destructiveKeywords);
  }

  check(action: Action): PolicyVerdict {
    const text = `${action.description} ${action.value ?? ''} ${action.selector ?? ''}`;

    const prohibitedHit = this.prohibited.find((pattern) => pattern.test(text));
    if (prohibitedHit) {
      return this.block(action, `matches prohibited action policy ${prohibitedHit}`);
    }

    if (!this.config.safety.allowDestructive) {
      const destructiveHit = this.destructive.find((pattern) => pattern.test(text));
      if (destructiveHit || action.destructive) {
        return this.block(
          action,
          destructiveHit
            ? `looks destructive (${destructiveHit}); allowDestructive is false`
            : 'executor flagged the action as destructive; allowDestructive is false',
        );
      }
    }

    if (action.kind === 'navigate' && action.value) {
      const host = hostOf(action.value);
      if (host && !this.hostAllowed(host)) {
        return this.block(action, `navigation to ${host} is outside allowedHosts`);
      }
    }

    return { allowed: true };
  }

  hostAllowed(host: string): boolean {
    const allowed = this.config.safety.allowedHosts;
    if (allowed.length === 0) return true;
    return allowed.some((entry) => host === entry || host.endsWith(`.${entry}`));
  }

  /** Mask configured secret-ish keys before anything is written to disk. */
  redact(value: string): string {
    let output = value;
    for (const key of this.config.safety.redactKeys) {
      const pattern = new RegExp(`("?${escape(key)}"?\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^,\\s}]+)`, 'gi');
      output = output.replace(pattern, '$1"***"');
    }
    return output;
  }

  blockedActions(): Array<{ action: string; reason: string }> {
    return [...this.blocked];
  }

  private block(action: Action, reason: string): PolicyVerdict {
    this.blocked.push({ action: action.description, reason });
    return { allowed: false, reason };
  }
}

function compile(patterns: string[]): RegExp[] {
  return patterns.map((pattern) => {
    try {
      return new RegExp(pattern, 'i');
    } catch {
      return new RegExp(escape(pattern), 'i');
    }
  });
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

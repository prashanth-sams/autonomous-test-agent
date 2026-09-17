import type { Finding, InvariantRule } from '@qa-agent/shared-contracts';
import { makeFinding, type Oracle, type OracleContext } from './types';

/**
 * Business rules the agent cannot infer: "a declined payment must not create an
 * order", "a viewer must not see delete". Customers configure these in YAML;
 * this oracle is what turns them into failures.
 */
export class InvariantOracle implements Oracle {
  readonly name = 'business-invariant';

  evaluate(context: OracleContext): Finding[] {
    if (!context.config.oracles.invariants) return [];
    const findings: Finding[] = [];
    for (const rule of context.config.rules) {
      if (rule.route && !routeMatches(context.state.route, rule.route)) continue;
      const violation = this.check(rule, context);
      if (!violation) continue;
      findings.push(
        makeFinding(context, this.name, {
          title: `Business rule violated: ${rule.description}`,
          detail: violation,
          severity: rule.severity ?? 'high',
          fingerprintKey: `rule ${rule.id}`,
          scope: rule.maxRequests ? 'run' : 'state',
        }),
      );
    }
    return findings;
  }

  private check(rule: InvariantRule, context: OracleContext): string | null {
    const { state, requestLog } = context;

    if (rule.forbidText && state.text.toLowerCase().includes(rule.forbidText.toLowerCase())) {
      return `Forbidden text "${rule.forbidText}" is visible on ${state.route}.`;
    }

    if (rule.requireText && !state.text.toLowerCase().includes(rule.requireText.toLowerCase())) {
      return `Required text "${rule.requireText}" is missing from ${state.route}.`;
    }

    if (rule.forbidElement) {
      const { role, name } = rule.forbidElement;
      const match = state.elements.find(
        (element) =>
          element.enabled &&
          element.visible &&
          (!role || element.role === role) &&
          (!name || element.name.toLowerCase().includes(name.toLowerCase())),
      );
      if (match) {
        return `Forbidden control "${match.name || match.role}" is present and enabled on ${state.route}.`;
      }
    }

    if (rule.maxRequests) {
      const { method, urlPattern, max } = rule.maxRequests;
      const pattern = new RegExp(urlPattern, 'i');
      const matching = requestLog.filter(
        (entry) =>
          (!method || entry.method.toUpperCase() === method.toUpperCase()) &&
          pattern.test(entry.url) &&
          entry.ok,
      );
      if (matching.length > max) {
        return (
          `${matching.length} successful ${method ?? 'ANY'} requests matched ${urlPattern}, ` +
          `limit is ${max}. Observed: ${matching.map((entry) => `${entry.status} ${entry.url}`).slice(0, 5).join(', ')}`
        );
      }
    }

    return null;
  }
}

function routeMatches(route: string, pattern: string): boolean {
  if (pattern === route) return true;
  try {
    return new RegExp(`^${pattern.replace(/\*/g, '.*')}$`).test(route);
  } catch {
    return false;
  }
}

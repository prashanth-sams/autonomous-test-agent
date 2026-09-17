import type { Finding } from '@qa-agent/shared-contracts';
import { hostOf } from '../util/route';
import { makeFinding, type Oracle, type OracleContext } from './types';

/**
 * A control that accepts a click and then does nothing: no navigation, no DOM
 * change, no request. Classic sign of a broken handler.
 */
export class UnresponsiveElementOracle implements Oracle {
  readonly name = 'unresponsive-element';

  evaluate(context: OracleContext): Finding[] {
    const { result, action } = context;
    if (!context.config.oracles.unresponsiveElements) return [];
    if (!result || !action) return [];
    if (action.kind !== 'click') return [];
    if (!result.ok) return [];
    if (!result.noOp) return [];

    const sawTraffic = result.observations.some((observation) => observation.type === 'network');
    if (sawTraffic) return [];

    return [
      makeFinding(context, this.name, {
        title: `Control does nothing: ${action.description}`,
        detail:
          `Clicking "${action.description}" produced no navigation, no DOM change and no network ` +
          'request. The control is either dead or its handler failed silently.',
        severity: 'medium',
        fingerprintKey: `noop ${action.description}`,
      }),
    ];
  }
}

/** The action took the agent somewhere it should not be able to go. */
export class UnexpectedNavigationOracle implements Oracle {
  readonly name = 'unexpected-navigation';

  evaluate(context: OracleContext): Finding[] {
    const { previousState, state, action } = context;
    if (!previousState || !action) return [];
    const host = hostOf(state.location);
    const allowed = context.config.safety.allowedHosts;
    if (host && allowed.length > 0 && !allowed.includes(host)) {
      return [
        makeFinding(context, this.name, {
          title: `Navigated outside the application to ${host}`,
          detail:
            `"${action.description}" left the application under test ` +
            `(${previousState.location} -> ${state.location}).`,
          severity: 'low',
          fingerprintKey: `offsite ${host}`,
        }),
      ];
    }

    // A form submit that silently lands back on the same screen with no
    // message is a broken journey, not a successful save.
    if (action.kind === 'click' && /submit|save|continue|next|place order|pay/i.test(action.description)) {
      // A control that did nothing at all is the unresponsive-element oracle's
      // finding, not this one: reporting both would double-count one bug.
      if (context.result?.noOp) return [];
      const sameScreen = previousState.id === state.id;
      const hasFeedback = /error|invalid|required|success|thank|confirm/i.test(state.text);
      if (sameScreen && !hasFeedback) {
        return [
          makeFinding(context, this.name, {
            title: `Submit produced no visible outcome: ${action.description}`,
            detail:
              `"${action.description}" left the user on the same screen with no success or ` +
              'validation message. The journey cannot continue from here.',
            severity: 'medium',
            fingerprintKey: `silent-submit ${action.description}`,
          }),
        ];
      }
    }
    return [];
  }
}

/** Blank screens, permanent spinners and error placeholders. */
export class MissingContentOracle implements Oracle {
  readonly name = 'missing-content';

  evaluate(context: OracleContext): Finding[] {
    if (!context.config.oracles.missingContent) return [];
    const { state } = context;
    const findings: Finding[] = [];

    if (state.text.trim().length < 20 && state.elements.length <= 1) {
      findings.push(
        makeFinding(context, this.name, {
          title: 'Page rendered empty',
          detail: `${state.location} rendered with no meaningful content or controls.`,
          severity: 'high',
          fingerprintKey: `empty ${state.route}`,
        }),
      );
    }

    if (/^(loading|please wait)\b/i.test(state.text.trim()) || Boolean(state.meta.stuckSpinner)) {
      findings.push(
        makeFinding(context, this.name, {
          title: 'Screen stuck in loading state',
          detail: `${state.location} still showed a loading indicator after the settle timeout.`,
          severity: 'high',
          fingerprintKey: `stuck-loading ${state.route}`,
        }),
      );
    }

    if (/(something went wrong|unexpected error|internal server error|application error)/i.test(state.text)) {
      findings.push(
        makeFinding(context, this.name, {
          title: 'Error screen displayed',
          detail: `${state.location} displayed an application error message to the user.`,
          severity: 'high',
          fingerprintKey: `error-screen ${state.route}`,
        }),
      );
    }

    return findings;
  }
}

/** Accessibility violations reported by the executor (axe-core on web). */
export class AccessibilityOracle implements Oracle {
  readonly name = 'accessibility';

  evaluate(context: OracleContext): Finding[] {
    if (!context.config.oracles.accessibility) return [];
    const violations = context.state.meta.a11yViolations as
      | Array<{ id: string; impact?: string; help: string; nodes: number }>
      | undefined;
    if (!violations?.length) return [];

    return violations
      .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
      .map((violation) =>
        makeFinding(context, this.name, {
          title: `Accessibility: ${violation.help}`,
          detail: `${violation.id} (${violation.impact}) affects ${violation.nodes} element(s) on ${context.state.route}.`,
          severity: violation.impact === 'critical' ? 'medium' : 'low',
          fingerprintKey: `a11y ${violation.id}`,
        }),
      );
  }
}

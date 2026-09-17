import type { Finding } from '@qa-agent/shared-contracts';
import { makeFinding, matchesAny, type Oracle, type OracleContext } from './types';

/** Uncaught JS exceptions and console errors emitted by the application. */
export class ConsoleErrorOracle implements Oracle {
  readonly name = 'console-errors';

  evaluate(context: OracleContext): Finding[] {
    if (!context.config.oracles.consoleErrors) return [];
    const ignore = context.config.oracles.ignorePatterns;
    return context.observations
      .filter((observation) => observation.type === 'console' || observation.type === 'pageerror')
      .filter((observation) => observation.severity === 'high' || observation.severity === 'critical')
      .filter((observation) => !matchesAny(observation.message, ignore))
      // The browser logs "Failed to load resource" for every failed request;
      // the network oracle already reports those with far more detail.
      .filter(
        (observation) =>
          !(
            /failed to load resource|net::ERR_/i.test(observation.message) &&
            context.observations.some((other) => other.type === 'network')
          ),
      )
      .map((observation) =>
        makeFinding(context, this.name, {
          title:
            observation.type === 'pageerror'
              ? 'Unhandled JavaScript exception'
              : 'Console error on page',
          detail: observation.message,
          severity: observation.type === 'pageerror' ? 'high' : 'medium',
          // First line only: stack tails differ per load.
          fingerprintKey: observation.message.split('\n')[0] ?? observation.message,
          observations: [observation],
        }),
      );
  }
}

/** The page itself died: renderer crash, navigation to an error page. */
export class PageCrashOracle implements Oracle {
  readonly name = 'page-crash';

  evaluate(context: OracleContext): Finding[] {
    if (!context.config.oracles.pageCrash) return [];
    return context.observations
      .filter((observation) => observation.type === 'crash')
      .map((observation) =>
        makeFinding(context, this.name, {
          title: 'Application crashed',
          detail: observation.message,
          severity: 'critical',
          fingerprintKey: observation.message,
          observations: [observation],
        }),
      );
  }
}

/** Failed HTTP traffic: 5xx always, 4xx unless the customer allows it. */
export class NetworkFailureOracle implements Oracle {
  readonly name = 'network-failures';

  evaluate(context: OracleContext): Finding[] {
    if (!context.config.oracles.networkFailures) return [];
    const { ignorePatterns, ignoreStatusFor } = context.config.oracles;
    const findings: Finding[] = [];

    for (const observation of context.observations) {
      if (observation.type !== 'network') continue;
      const status = Number(observation.detail?.status ?? 0);
      const url = String(observation.detail?.url ?? '');
      const method = String(observation.detail?.method ?? 'GET');
      const failed = Boolean(observation.detail?.failed);
      if (!failed && status < 400) continue;
      if (matchesAny(url, ignorePatterns)) continue;
      if (matchesAny(`${status} ${url}`, ignoreStatusFor)) continue;
      // Failed page navigations belong to the broken-link oracle, which names
      // the link that led there. Reporting both would double-count one defect.
      if (context.config.oracles.brokenLinks && Boolean(observation.detail?.isDocument)) {
        continue;
      }

      const severity = failed || status >= 500 ? 'high' : 'medium';
      findings.push(
        makeFinding(context, this.name, {
          title: failed
            ? `Request failed: ${method} ${stripQuery(url)}`
            : `HTTP ${status} on ${method} ${stripQuery(url)}`,
          detail: observation.message,
          severity,
          fingerprintKey: `${method} ${stripQuery(url)} ${failed ? 'failed' : status}`,
          observations: [observation],
        }),
      );
    }
    return findings;
  }
}

/**
 * A page navigation that resolves to 404/410 or fails outright. Owns every
 * document-level failure so a broken link is one defect, not two: the network
 * oracle steps aside for these.
 */
export class BrokenLinkOracle implements Oracle {
  readonly name = 'broken-links';

  evaluate(context: OracleContext): Finding[] {
    if (!context.config.oracles.brokenLinks) return [];
    const navigation = context.observations.find(
      (observation) =>
        observation.type === 'network' &&
        Boolean(observation.detail?.isDocument) &&
        (Number(observation.detail?.status) >= 400 || Boolean(observation.detail?.failed)),
    );
    if (!navigation) return [];
    if (matchesAny(String(navigation.detail?.url ?? ''), context.config.oracles.ignorePatterns)) {
      return [];
    }

    const status = String(navigation.detail?.status ?? 0);
    const url = stripQuery(String(navigation.detail?.url ?? ''));
    // The link that led here, when the same step observed the click.
    const via = context.action?.kind === 'click' ? context.action.description : undefined;

    return [
      makeFinding(context, this.name, {
        title: via ? `Broken link: ${via}` : `Navigation returned HTTP ${status}: ${url}`,
        detail: via
          ? `Following "${via}" returned HTTP ${status} for ${url}`
          : `Loading ${url} returned HTTP ${status}.`,
        severity: 'medium',
        // Keyed on the destination so the same dead page found by different
        // routes into it stays one defect.
        fingerprintKey: `document ${url} ${status}`,
        observations: [navigation],
      }),
    ];
  }
}

function stripQuery(url: string): string {
  const index = url.indexOf('?');
  return index === -1 ? url : url.slice(0, index);
}

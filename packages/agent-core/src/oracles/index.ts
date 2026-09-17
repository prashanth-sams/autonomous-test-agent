import type { AgentConfig } from '@qa-agent/shared-contracts';
import {
  BrokenLinkOracle,
  ConsoleErrorOracle,
  NetworkFailureOracle,
  PageCrashOracle,
} from './runtime';
import {
  AccessibilityOracle,
  MissingContentOracle,
  UnexpectedNavigationOracle,
  UnresponsiveElementOracle,
} from './interaction';
import { InvariantOracle } from './invariants';
import type { Oracle } from './types';

export * from './types';
export * from './runtime';
export * from './interaction';
export * from './invariants';

/** The V1 oracle suite. Each one is individually switchable from config. */
export function defaultOracles(_config: AgentConfig): Oracle[] {
  return [
    new PageCrashOracle(),
    new ConsoleErrorOracle(),
    new NetworkFailureOracle(),
    new BrokenLinkOracle(),
    new UnresponsiveElementOracle(),
    new UnexpectedNavigationOracle(),
    new MissingContentOracle(),
    new AccessibilityOracle(),
    new InvariantOracle(),
  ];
}

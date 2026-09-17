import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserContext,
  type Page,
  type Response,
} from 'playwright';
import type {
  Action,
  ActionResult,
  AgentConfig,
  ApplicationState,
  ElementDescriptor,
  EvidenceRef,
  JourneyStep,
  Observation,
  PlatformExecutor,
  ReproducibleExecutor,
  ScriptedStep,
  Severity,
} from '@qa-agent/shared-contracts';
import { enumerateActions } from './actions';
import { snapshot } from './observe';

export interface WebExecutorOptions {
  config: AgentConfig;
  /** Directory the agent owns; artefacts are written under <runDir>/artifacts. */
  runDir: string;
  onLog?: (message: string) => void;
}

const LAUNCHERS = { chromium, firefox, webkit };

/**
 * The web implementation of PlatformExecutor: DOM and accessibility inspection,
 * network interception, console capture, traces and video — everything the
 * shared core needs, expressed in the platform-neutral contract.
 */
export class WebExecutor implements PlatformExecutor, ReproducibleExecutor {
  readonly platform = 'web' as const;
  readonly name = 'playwright-web';

  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private observations: Observation[] = [];
  private readonly consoleLog: string[] = [];
  private readonly scannedRoutes = new Set<string>();
  private readonly artifactsDir: string;
  /** Requests still in flight, used to decide when the page has settled. */
  private inFlight = 0;
  private lastNetworkActivityAt = 0;

  constructor(private readonly options: WebExecutorOptions) {
    this.artifactsDir = join(options.runDir, 'artifacts');
    mkdirSync(this.artifactsDir, { recursive: true });
  }

  // --- lifecycle ---------------------------------------------------------

  async start(): Promise<void> {
    const { config } = this.options;
    const launcher = LAUNCHERS[config.browser.name] ?? chromium;
    this.browser = await launcher.launch({ headless: config.browser.headless });

    this.context = await this.browser.newContext({
      viewport: config.browser.viewport ?? { width: 1280, height: 800 },
      ...(config.auth?.storageStatePath ? { storageState: config.auth.storageStatePath } : {}),
      ...(config.reporting.video ? { recordVideo: { dir: join(this.artifactsDir, 'video') } } : {}),
      ...(config.reporting.har ? { recordHar: { path: join(this.artifactsDir, 'network.har') } } : {}),
    });

    if (config.reporting.trace) {
      await this.context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    }

    this.page = await this.context.newPage();
    this.attachListeners(this.page);
    await this.page.goto(config.target.baseUrl, { waitUntil: 'domcontentloaded' });
    await this.settle();
  }

  async stop(): Promise<void> {
    const { config } = this.options;
    try {
      if (config.reporting.trace && this.context) {
        await this.context.tracing.stop({ path: join(this.artifactsDir, 'trace.zip') });
      }
      writeFileSync(join(this.artifactsDir, 'console.log'), this.consoleLog.join('\n'), 'utf8');
      await this.context?.close();
    } finally {
      await this.browser?.close();
    }
  }

  async reset(): Promise<void> {
    const page = this.requirePage();
    await page.goto(this.options.config.target.baseUrl, { waitUntil: 'domcontentloaded' });
    await this.settle();
  }

  // --- observation -------------------------------------------------------

  async observe(): Promise<ApplicationState> {
    const page = this.requirePage();
    await this.settle();
    const raw = await snapshot(page);

    const elements: ElementDescriptor[] = raw.elements.map((element, index) => ({
      ...element,
      id: `e${index}`,
    }));

    const route = maskRoute(raw.url);
    const signature = [
      route,
      raw.modalOpen ? 'modal' : 'page',
      // Text matters too: a status message is a state change even when the
      // controls are unchanged. Ids and numbers are masked so one order
      // confirmation is not a different state from the next.
      `text:${digest(stripVolatile(raw.text.slice(0, 600)))}`,
      // Roles and names, not positions: cosmetic reflow must not look like a
      // new screen, but a new control must.
      ...elements.map((element) => `${element.role}:${element.name.slice(0, 40)}`).sort(),
    ].join('|');

    const meta: Record<string, unknown> = { stuckSpinner: raw.spinnerVisible };
    if (this.options.config.oracles.accessibility && !this.scannedRoutes.has(route)) {
      this.scannedRoutes.add(route);
      meta.a11yViolations = await this.scanAccessibility(page);
    }

    return {
      id: createHash('sha1').update(signature).digest('hex').slice(0, 12),
      platform: 'web',
      signature,
      location: raw.url,
      route,
      title: raw.title,
      elements,
      text: raw.text,
      modalOpen: raw.modalOpen,
      capturedAt: new Date().toISOString(),
      meta,
    };
  }

  async availableActions(state: ApplicationState): Promise<Action[]> {
    return enumerateActions(state);
  }

  drainObservations(): Observation[] {
    const drained = this.observations;
    this.observations = [];
    return drained;
  }

  // --- acting ------------------------------------------------------------

  async execute(action: Action): Promise<ActionResult> {
    const page = this.requirePage();
    const startedAt = Date.now();
    const before = await this.observe();
    this.drainObservations();

    let ok = true;
    let error: string | undefined;
    const timeout = this.options.config.limits.actionTimeoutMs;

    try {
      const locator = action.selector ? page.locator(action.selector).first() : null;
      switch (action.kind) {
        case 'click':
          await locator!.click({ timeout });
          break;
        case 'fill':
          await locator!.fill(action.value ?? '', { timeout });
          break;
        case 'select':
          await locator!.selectOption(action.value ?? '', { timeout });
          break;
        case 'check':
          await locator!.click({ timeout });
          break;
        case 'press':
          await page.keyboard.press(action.value ?? 'Enter');
          break;
        case 'hover':
          await locator!.hover({ timeout });
          break;
        case 'navigate':
          // Scripted steps use app-relative paths; replays go through here too.
          await page.goto(
            resolveUrl(action.value ?? '', this.options.config.target.baseUrl),
            { waitUntil: 'domcontentloaded', timeout },
          );
          break;
        case 'back':
          await page.goBack({ timeout }).catch(() => null);
          break;
        case 'scroll':
          await page.mouse.wheel(0, 600);
          break;
        case 'wait':
          await page.waitForTimeout(clampDelay(action.value));
          break;
        default:
          ok = false;
          error = `unsupported action kind: ${action.kind}`;
      }
    } catch (caught) {
      ok = false;
      error = (caught as Error).message.split('\n')[0];
    }

    await this.settle();
    const after = await this.observe();
    const observations = this.drainObservations();

    return {
      action,
      ok,
      error,
      durationMs: Date.now() - startedAt,
      stateBefore: before.id,
      stateAfter: after.id,
      // "Nothing happened": same screen, same URL, no traffic, no console output.
      noOp:
        ok &&
        before.id === after.id &&
        before.location === after.location &&
        observations.length === 0,
      observations,
    };
  }

  /** Deterministic steps: authentication, critical journeys and replays. */
  async runScriptedStep(step: ScriptedStep): Promise<ActionResult> {
    const page = this.requirePage();
    const startedAt = Date.now();
    const before = await this.observe();
    this.drainObservations();
    const timeout = this.options.config.limits.actionTimeoutMs;

    const action: Action = {
      id: createHash('sha1').update(JSON.stringify(step)).digest('hex').slice(0, 10),
      kind: scriptKindToActionKind(step.kind),
      selector: step.selector,
      value: step.value,
      description: step.description ?? describeScriptedStep(step),
      tags: ['scripted'],
    };

    let ok = true;
    let error: string | undefined;
    try {
      switch (step.kind) {
        case 'goto':
          await page.goto(resolveUrl(step.value ?? '', this.options.config.target.baseUrl), {
            waitUntil: 'domcontentloaded',
            timeout,
          });
          break;
        case 'click':
          await page.locator(step.selector!).first().click({ timeout });
          break;
        case 'fill':
          await page.locator(step.selector!).first().fill(step.value ?? '', { timeout });
          break;
        case 'press':
          await page.keyboard.press(step.value ?? 'Enter');
          break;
        case 'wait':
          await page.waitForTimeout(clampDelay(step.value));
          break;
        case 'expectText': {
          await this.settle();
          const text = await page.innerText('body').catch(() => '');
          if (!text.toLowerCase().includes((step.value ?? '').toLowerCase())) {
            ok = false;
            error = `expected to see "${step.value}" but it was not on the page`;
          }
          break;
        }
        case 'expectNoText': {
          await this.settle();
          const text = await page.innerText('body').catch(() => '');
          if (text.toLowerCase().includes((step.value ?? '').toLowerCase())) {
            ok = false;
            error = `did not expect to see "${step.value}" but it was on the page`;
          }
          break;
        }
        default:
          ok = false;
          error = `unsupported scripted step: ${String(step.kind)}`;
      }
    } catch (caught) {
      ok = false;
      error = (caught as Error).message.split('\n')[0];
    }

    await this.settle();
    const after = await this.observe();
    const observations = this.drainObservations();
    return {
      action,
      ok,
      error,
      durationMs: Date.now() - startedAt,
      stateBefore: before.id,
      stateAfter: after.id,
      noOp: false,
      observations,
    };
  }

  // --- evidence ----------------------------------------------------------

  async captureEvidence(label: string): Promise<EvidenceRef[]> {
    const page = this.page;
    if (!page || page.isClosed()) return [];
    const safe = label.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 60);
    const refs: EvidenceRef[] = [];

    try {
      const screenshotPath = join(this.artifactsDir, `${safe}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false });
      refs.push({ kind: 'screenshot', path: this.relative(screenshotPath), label: `${safe} screenshot` });
    } catch {
      /* the page may have navigated away mid-capture */
    }

    try {
      const domPath = join(this.artifactsDir, `${safe}.html`);
      writeFileSync(domPath, await page.content(), 'utf8');
      refs.push({ kind: 'dom', path: this.relative(domPath), label: `${safe} DOM` });
    } catch {
      /* ignore */
    }

    return refs;
  }

  /** An executable Playwright spec a developer can run to see the defect. */
  reproductionScript(steps: JourneyStep[], baseUrl: string): string {
    const body = steps
      .map((step) => {
        const action = step.action;
        const selector = action.selector ? JSON.stringify(action.selector) : null;
        switch (action.kind) {
          case 'click':
          case 'check':
            return `  await page.locator(${selector}).first().click();`;
          case 'fill':
            return `  await page.locator(${selector}).first().fill(${JSON.stringify(action.value ?? '')});`;
          case 'select':
            return `  await page.locator(${selector}).first().selectOption(${JSON.stringify(action.value ?? '')});`;
          case 'press':
            return `  await page.keyboard.press(${JSON.stringify(action.value ?? 'Enter')});`;
          case 'navigate':
            // App-relative paths would not resolve in a standalone spec.
            return `  await page.goto(${JSON.stringify(resolveUrl(action.value ?? '', baseUrl))});`;
          case 'back':
            return '  await page.goBack();';
          default:
            return `  // ${action.description}`;
        }
      })
      .join('\n');

    return `import { test, expect } from '@playwright/test';

// Generated by the autonomous web testing agent.
test('reproduction', async ({ page }) => {
  await page.goto(${JSON.stringify(baseUrl)});
${body}
  // The agent flagged the state reached here; assert the expected behaviour.
});
`;
  }

  // --- internals ---------------------------------------------------------

  private attachListeners(page: Page): void {
    page.on('console', (message) => {
      const text = `${message.type()}: ${message.text()}`;
      this.consoleLog.push(`[${new Date().toISOString()}] ${text}`);
      if (message.type() !== 'error' && message.type() !== 'warning') return;
      this.record({
        type: 'console',
        severity: message.type() === 'error' ? 'high' : 'low',
        message: message.text(),
        at: new Date().toISOString(),
      });
    });

    page.on('pageerror', (error) => {
      this.consoleLog.push(`[${new Date().toISOString()}] pageerror: ${error.message}`);
      this.record({
        type: 'pageerror',
        severity: 'high',
        message: `${error.name}: ${error.message}`,
        detail: { stack: error.stack?.split('\n').slice(0, 4).join('\n') },
        at: new Date().toISOString(),
      });
    });

    page.on('crash', () => {
      this.record({
        type: 'crash',
        severity: 'critical',
        message: 'The page crashed (renderer terminated)',
        at: new Date().toISOString(),
      });
    });

    page.on('dialog', (dialog) => {
      this.record({
        type: 'dialog',
        severity: dialog.type() === 'alert' ? 'low' : 'info',
        message: `${dialog.type()} dialog: ${dialog.message()}`,
        at: new Date().toISOString(),
      });
      // Dismiss rather than accept: accepting may confirm a destructive action.
      void dialog.dismiss().catch(() => null);
    });

    page.on('request', () => {
      this.inFlight += 1;
      this.lastNetworkActivityAt = Date.now();
    });

    page.on('requestfinished', () => {
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.lastNetworkActivityAt = Date.now();
    });

    page.on('response', (response: Response) => {
      const request = response.request();
      this.record({
        type: 'network',
        severity: statusSeverity(response.status()),
        message: `${request.method()} ${response.url()} -> ${response.status()}`,
        detail: {
          method: request.method(),
          url: response.url(),
          status: response.status(),
          ok: response.status() < 400,
          failed: false,
          isDocument: request.resourceType() === 'document',
        },
        at: new Date().toISOString(),
      });
    });

    page.on('requestfailed', (request) => {
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.lastNetworkActivityAt = Date.now();
      const failure = request.failure()?.errorText ?? 'unknown error';
      // Aborted requests are normal when the agent navigates mid-flight.
      if (/ERR_ABORTED|NS_BINDING_ABORTED/i.test(failure)) return;
      this.record({
        type: 'network',
        severity: 'high',
        message: `${request.method()} ${request.url()} failed: ${failure}`,
        detail: {
          method: request.method(),
          url: request.url(),
          status: 0,
          ok: false,
          failed: true,
          isDocument: request.resourceType() === 'document',
        },
        at: new Date().toISOString(),
      });
    });
  }

  private record(observation: Observation): void {
    // Cap the buffer so a chatty page cannot exhaust memory in a long run.
    if (this.observations.length > 2000) this.observations.shift();
    this.observations.push(observation);
  }

  /**
   * Wait for the application to go quiet.
   *
   * Playwright's 'networkidle' only tracks the navigation lifecycle, so a fetch
   * fired by a click is not awaited at all — the agent would snapshot before the
   * response arrived and report working controls as dead. This tracks in-flight
   * requests directly and gives the DOM a moment to react to the last one.
   */
  private async settle(quietMs = 350, timeoutMs = 4000): Promise<void> {
    const page = this.requirePage();
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 });
    } catch {
      /* a page that never loads is itself reported by the oracles */
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const quietFor = Date.now() - this.lastNetworkActivityAt;
      if (this.inFlight === 0 && quietFor >= quietMs) return;
      await page.waitForTimeout(50).catch(() => null);
    }
  }

  private async scanAccessibility(
    page: Page,
  ): Promise<Array<{ id: string; impact?: string; help: string; nodes: number }>> {
    try {
      await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
      return await page.evaluate(async () => {
        const axe = (window as unknown as { axe: { run: (options: unknown) => Promise<unknown> } }).axe;
        const results = (await axe.run({
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
        })) as { violations: Array<{ id: string; impact?: string; help: string; nodes: unknown[] }> };
        return results.violations.map((violation) => ({
          id: violation.id,
          impact: violation.impact,
          help: violation.help,
          nodes: violation.nodes.length,
        }));
      });
    } catch {
      this.options.onLog?.('accessibility scan skipped (axe could not run on this page)');
      return [];
    }
  }

  private relative(absolutePath: string): string {
    return relative(this.options.runDir, absolutePath);
  }

  private requirePage(): Page {
    if (!this.page) throw new Error('WebExecutor.start() must be called before use');
    return this.page;
  }
}

/** A wait value may be absent or carry unrelated text after a replay mapping. */
function clampDelay(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 500;
  return Math.min(parsed, 5000);
}

function statusSeverity(status: number): Severity {
  if (status >= 500) return 'high';
  if (status >= 400) return 'medium';
  return 'info';
}

function scriptKindToActionKind(kind: ScriptedStep['kind']): Action['kind'] {
  switch (kind) {
    case 'goto':
      return 'navigate';
    case 'click':
      return 'click';
    case 'fill':
      return 'fill';
    case 'press':
      return 'press';
    default:
      return 'wait';
  }
}

function describeScriptedStep(step: ScriptedStep): string {
  switch (step.kind) {
    case 'goto':
      return `Open ${step.value}`;
    case 'click':
      return `Click ${step.selector}`;
    case 'fill':
      return `Fill ${step.selector} with "${step.value}"`;
    case 'press':
      return `Press ${step.value}`;
    case 'expectText':
      return `Expect to see "${step.value}"`;
    case 'expectNoText':
      return `Expect not to see "${step.value}"`;
    default:
      return `Wait ${step.value ?? 500}ms`;
  }
}

function resolveUrl(value: string, baseUrl: string): string {
  if (/^https?:\/\//i.test(value)) return value;
  return new URL(value, baseUrl).toString();
}

function stripVolatile(value: string): string {
  return value
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{uuid}')
    .replace(/\b\d+\b/g, '{n}');
}

function digest(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 8);
}

/** Kept local to the executor: the core has its own copy for reporting. */
function maskRoute(rawUrl: string): string {
  try {
    const { pathname } = new URL(rawUrl);
    const masked = pathname
      .split('/')
      .map((segment) => {
        if (!segment) return segment;
        if (/^\d+$/.test(segment)) return ':id';
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(segment)) return ':uuid';
        if (/^[0-9a-f]{16,}$/i.test(segment)) return ':hash';
        return segment;
      })
      .join('/');
    return masked === '' ? '/' : masked;
  } catch {
    return rawUrl;
  }
}

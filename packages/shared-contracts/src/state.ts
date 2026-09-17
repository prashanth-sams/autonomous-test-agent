/** Platform-neutral description of what the application looks like right now. */

export type Platform = 'web' | 'mobile' | 'desktop' | 'api';

/**
 * One interactable thing in the application under test. Deliberately free of
 * platform vocabulary: `selector` is opaque to the core and only ever handed
 * back to the executor that produced it.
 */
export interface ElementDescriptor {
  /** Stable within a state snapshot; used by actions to refer to an element. */
  id: string;
  /** Accessibility role (button, link, textbox, checkbox, combobox, ...). */
  role: string;
  /** Accessible name, trimmed and collapsed. */
  name: string;
  /** Executor-specific handle (a Playwright selector for the web executor). */
  selector: string;
  tag?: string;
  inputType?: string;
  value?: string;
  placeholder?: string;
  href?: string;
  enabled: boolean;
  visible: boolean;
  required?: boolean;
  /** Set by the executor when it can tell the control is inside a modal/dialog. */
  inModal?: boolean;
  attributes?: Record<string, string>;
}

export interface ApplicationState {
  /** Fingerprint of `signature`; equal ids mean "the same screen" to the core. */
  id: string;
  platform: Platform;
  /** Structural signature the fingerprint is derived from. */
  signature: string;
  /** Web: full URL. Mobile/desktop: activity or window identifier. */
  location: string;
  /** Web: pathname with numeric/uuid segments masked. Used for coverage. */
  route: string;
  title: string;
  elements: ElementDescriptor[];
  /** Visible text digest, used by content oracles and invariants. */
  text: string;
  modalOpen: boolean;
  capturedAt: string;
  meta: Record<string, unknown>;
}

export type ActionKind =
  | 'click'
  | 'fill'
  | 'select'
  | 'check'
  | 'press'
  | 'navigate'
  | 'back'
  | 'hover'
  | 'scroll'
  | 'wait';

export interface Action {
  id: string;
  kind: ActionKind;
  /** ElementDescriptor.id this action targets, when it targets an element. */
  targetId?: string;
  selector?: string;
  value?: string;
  /** Human sentence used in reproduction steps and PR output. */
  description: string;
  /** Executor's opinion that this action may mutate or destroy data. */
  destructive?: boolean;
  tags?: string[];
}

export type ObservationType =
  | 'console'
  | 'pageerror'
  | 'network'
  | 'crash'
  | 'dialog'
  | 'download'
  | 'navigation'
  | 'timing';

export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';

/** A raw signal collected by an executor while an action ran. */
export interface Observation {
  type: ObservationType;
  severity: Severity;
  message: string;
  detail?: Record<string, unknown>;
  at: string;
}

export interface ActionResult {
  action: Action;
  ok: boolean;
  error?: string;
  durationMs: number;
  stateBefore: string;
  stateAfter: string;
  /** True when the action provably changed nothing observable. */
  noOp: boolean;
  observations: Observation[];
}

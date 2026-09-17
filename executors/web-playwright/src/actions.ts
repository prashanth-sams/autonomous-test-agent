import type { Action, ApplicationState, ElementDescriptor } from '@qa-agent/shared-contracts';
import { createHash } from 'node:crypto';

/** Words that mean "this click may delete or spend something". */
const DESTRUCTIVE = /(delete|remove|destroy|drop|deactivate|close account|wipe|purge|revoke|unsubscribe|pay now|charge)/i;

/**
 * Input data with intent: a realistic value first, then the edge cases that
 * actually break forms. Boundary data is where exploratory testing earns its
 * keep, so it is generated deterministically rather than randomly — the same
 * defect reproduces with the same value.
 */
function valuesFor(element: ElementDescriptor): string[] {
  const type = element.inputType ?? 'text';
  const name = `${element.name} ${element.placeholder ?? ''}`.toLowerCase();

  if (type === 'email' || /e-?mail/.test(name)) {
    return ['qa.agent@example.com', 'not-an-email'];
  }
  if (type === 'password' || /password/.test(name)) {
    return ['Str0ng-Passw0rd!', 'a'];
  }
  if (type === 'number' || /(amount|qty|quantity|price|count)/.test(name)) {
    return ['1', '0', '-1', '999999999'];
  }
  if (type === 'tel' || /phone/.test(name)) {
    return ['+15551234567', 'abc'];
  }
  if (type === 'date') {
    return ['2026-01-15', '1900-01-01'];
  }
  if (/(card|credit)/.test(name)) {
    // Declined-card path is a journey the customer usually cares about.
    return ['4111111111111111', '4000000000000002'];
  }
  if (/(coupon|promo|discount)/.test(name)) {
    return ['SAVE10', 'INVALID-CODE'];
  }
  if (/search|query/.test(name)) {
    return ['test', "' OR 1=1 --"];
  }
  return ['QA Agent', '', 'x'.repeat(256)];
}

function actionId(parts: string[]): string {
  return createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 10);
}

function label(element: ElementDescriptor): string {
  const name = element.name.trim() || element.placeholder || element.selector;
  return `${element.role} "${truncate(name, 60)}"`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Everything the agent could legally do here. Ordering does not matter — the
 * core's risk engine decides what is worth doing.
 */
export function enumerateActions(state: ApplicationState): Action[] {
  const actions: Action[] = [];
  // While a modal is open, only the modal's controls are actually reachable.
  const scope = state.modalOpen ? state.elements.filter((element) => element.inModal) : state.elements;
  const elements = scope.length > 0 ? scope : state.elements;

  for (const element of elements) {
    if (!element.enabled || !element.visible) continue;
    const tags = element.inModal ? ['modal'] : [];

    switch (element.role) {
      case 'textbox': {
        for (const value of valuesFor(element)) {
          if (value === element.value) continue;
          actions.push({
            id: actionId(['fill', element.selector, value]),
            kind: 'fill',
            targetId: element.id,
            selector: element.selector,
            value,
            description: `Fill ${label(element)} with ${value === '' ? '(empty)' : `"${truncate(value, 30)}"`}`,
            tags: [...tags, 'form'],
          });
        }
        break;
      }
      case 'checkbox':
      case 'switch':
      case 'radio': {
        actions.push({
          id: actionId(['check', element.selector]),
          kind: 'check',
          targetId: element.id,
          selector: element.selector,
          description: `Toggle ${label(element)}`,
          tags: [...tags, 'form'],
        });
        break;
      }
      case 'combobox': {
        const options = (element.attributes?.options ?? '').split('|').filter(Boolean);
        for (const option of options.slice(0, 3)) {
          if (option === element.value) continue;
          actions.push({
            id: actionId(['select', element.selector, option]),
            kind: 'select',
            targetId: element.id,
            selector: element.selector,
            value: option,
            description: `Select "${truncate(option, 30)}" in ${label(element)}`,
            tags: [...tags, 'form'],
          });
        }
        break;
      }
      default: {
        const external = element.href?.startsWith('http') === true;
        actions.push({
          id: actionId(['click', element.selector, element.name]),
          kind: 'click',
          targetId: element.id,
          selector: element.selector,
          description: `Click ${label(element)}`,
          destructive: DESTRUCTIVE.test(element.name),
          tags: [...tags, external ? 'external' : 'nav'],
        });
      }
    }
  }

  if (state.modalOpen) {
    actions.push({
      id: actionId(['press', 'Escape', state.id]),
      kind: 'press',
      value: 'Escape',
      description: 'Press Escape to dismiss the dialog',
      tags: ['modal'],
    });
  }

  actions.push({
    id: actionId(['back', state.id]),
    kind: 'back',
    description: 'Go back to the previous screen',
    tags: ['nav'],
  });

  return actions;
}

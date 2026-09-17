import type { Page } from 'playwright';
import type { ElementDescriptor } from '@qa-agent/shared-contracts';

export interface RawSnapshot {
  title: string;
  url: string;
  text: string;
  modalOpen: boolean;
  spinnerVisible: boolean;
  elements: ElementDescriptor[];
}

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type=hidden])',
  'select',
  'textarea',
  '[role=button]',
  '[role=link]',
  '[role=tab]',
  '[role=menuitem]',
  '[role=checkbox]',
  '[role=switch]',
  '[onclick]',
].join(',');

/**
 * Reads the page the way a person would: visible, operable controls with their
 * accessible names, plus the visible text the content oracles judge.
 *
 * Runs entirely inside the page so one round trip produces the whole state.
 */
export async function snapshot(page: Page, maxElements = 120): Promise<RawSnapshot> {
  return page.evaluate(
    ({ interactiveSelector, limit }) => {
      const isVisible = (element: Element): boolean => {
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
        const style = window.getComputedStyle(element);
        return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
      };

      const accessibleName = (element: Element): string => {
        const labelled = element.getAttribute('aria-label');
        if (labelled) return labelled.trim();
        const labelledBy = element.getAttribute('aria-labelledby');
        if (labelledBy) {
          const target = document.getElementById(labelledBy);
          if (target?.textContent) return target.textContent.trim();
        }
        const input = element as HTMLInputElement;
        if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
          if (input.labels?.length && input.labels[0]?.textContent) {
            return input.labels[0].textContent.trim();
          }
          return (input.placeholder || input.name || input.type || '').trim();
        }
        const text = (element as HTMLElement).innerText ?? element.textContent ?? '';
        if (text.trim()) return text.trim().slice(0, 80);
        return (
          element.getAttribute('title') ||
          element.getAttribute('alt') ||
          element.getAttribute('name') ||
          ''
        ).trim();
      };

      const roleOf = (element: Element): string => {
        const explicit = element.getAttribute('role');
        if (explicit) return explicit;
        switch (element.tagName) {
          case 'A':
            return 'link';
          case 'BUTTON':
            return 'button';
          case 'SELECT':
            return 'combobox';
          case 'TEXTAREA':
            return 'textbox';
          case 'INPUT': {
            const type = (element as HTMLInputElement).type;
            if (type === 'checkbox') return 'checkbox';
            if (type === 'radio') return 'radio';
            if (type === 'submit' || type === 'button') return 'button';
            return 'textbox';
          }
          default:
            return 'generic';
        }
      };

      // Selectors must survive a reload so defect replays work: prefer test ids
      // and stable attributes, fall back to a structural path.
      const selectorFor = (element: Element): string => {
        const testId = element.getAttribute('data-testid') ?? element.getAttribute('data-test-id');
        if (testId) return `[data-testid="${cssEscape(testId)}"]`;
        if (element.id && !/^[0-9]/.test(element.id)) return `#${cssEscape(element.id)}`;
        const name = element.getAttribute('name');
        if (name) return `${element.tagName.toLowerCase()}[name="${cssEscape(name)}"]`;

        const parts: string[] = [];
        let node: Element | null = element;
        while (node && node.nodeType === 1 && parts.length < 5) {
          const parent: Element | null = node.parentElement;
          if (!parent) break;
          const siblings = [...parent.children].filter((child) => child.tagName === node!.tagName);
          const index = siblings.indexOf(node) + 1;
          parts.unshift(
            siblings.length > 1
              ? `${node.tagName.toLowerCase()}:nth-of-type(${index})`
              : node.tagName.toLowerCase(),
          );
          if (parent.id && !/^[0-9]/.test(parent.id)) {
            parts.unshift(`#${cssEscape(parent.id)}`);
            break;
          }
          node = parent;
        }
        return parts.join(' > ');
      };

      function cssEscape(value: string): string {
        return value.replace(/["\\]/g, '\\$&');
      }

      const modalOpen = [...document.querySelectorAll('[role=dialog], dialog[open], .modal')].some(
        (element) => isVisible(element),
      );
      const spinnerVisible = [
        ...document.querySelectorAll('[role=progressbar], .spinner, .loading, [data-loading=true]'),
      ].some((element) => isVisible(element));

      const elements: ElementDescriptorLike[] = [];
      const nodes = [...document.querySelectorAll(interactiveSelector)].slice(0, limit * 3);
      for (const node of nodes) {
        if (!isVisible(node)) continue;
        const asInput = node as HTMLInputElement;
        const disabled =
          asInput.disabled === true || node.getAttribute('aria-disabled') === 'true';
        const descriptor: ElementDescriptorLike = {
          id: '',
          role: roleOf(node),
          name: accessibleName(node),
          selector: selectorFor(node),
          tag: node.tagName.toLowerCase(),
          inputType: node.tagName === 'INPUT' ? asInput.type : undefined,
          value: 'value' in node ? String(asInput.value ?? '').slice(0, 60) : undefined,
          placeholder: asInput.placeholder || undefined,
          href: node.getAttribute('href') ?? undefined,
          enabled: !disabled,
          visible: true,
          required: asInput.required === true,
          inModal: Boolean(node.closest('[role=dialog], dialog[open], .modal')),
          attributes:
            node.tagName === 'SELECT'
              ? {
                  options: [...(node as HTMLSelectElement).options]
                    .map((option) => option.value)
                    .slice(0, 20)
                    .join('|'),
                }
              : undefined,
        };
        elements.push(descriptor);
        if (elements.length >= limit) break;
      }

      const bodyText = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 4000);

      return {
        title: document.title,
        url: location.href,
        text: bodyText,
        modalOpen,
        spinnerVisible,
        elements: elements as unknown as ElementDescriptor[],
      };

      // Local structural type: ElementDescriptor is not available inside the page.
      type ElementDescriptorLike = {
        id: string;
        role: string;
        name: string;
        selector: string;
        tag: string;
        inputType?: string;
        value?: string;
        placeholder?: string;
        href?: string;
        enabled: boolean;
        visible: boolean;
        required: boolean;
        inModal: boolean;
        attributes?: Record<string, string>;
      };
    },
    { interactiveSelector: INTERACTIVE_SELECTOR, limit: maxElements },
  );
}

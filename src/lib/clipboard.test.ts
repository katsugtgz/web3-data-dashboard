import { afterEach, describe, expect, test } from 'bun:test';
import { copyText } from './clipboard';

interface FakeNode {
  tagName: string;
  value?: string;
  style: Record<string, string>;
  children: FakeNode[];
  parent: FakeNode | null;
  attributes: Record<string, string>;
  focused?: boolean;
  focusCount?: number;
  selected?: boolean;
  closestDialog?: FakeNode | null;
  setAttribute: (k: string, v: string) => void;
  appendChild: (child: FakeNode) => FakeNode;
  remove: () => void;
  focus: () => void;
  select: () => void;
  closest: (selector: string) => FakeNode | null;
}

function makeFakeElement(
  tagName: string,
  doc: { activeElement: FakeNode | null },
  opts: { acceptFocus?: boolean; closestDialog?: FakeNode | null } = {},
): FakeNode {
  const node: FakeNode = {
    tagName,
    style: {},
    children: [],
    parent: null,
    attributes: {},
    focusCount: 0,
    closestDialog: opts.closestDialog ?? null,
    setAttribute(k, v) {
      node.attributes[k] = v;
    },
    appendChild(child) {
      child.parent = node;
      node.children.push(child);
      return child;
    },
    remove() {
      if (!node.parent) return;
      node.parent.children = node.parent.children.filter(c => c !== node);
      node.parent = null;
    },
    focus() {
      node.focusCount = (node.focusCount ?? 0) + 1;
      if (opts.acceptFocus !== false) {
        doc.activeElement = node;
        node.focused = true;
      }
    },
    select() {
      node.selected = true;
    },
    closest(selector) {
      if (selector === 'dialog[open]') return node.closestDialog ?? null;
      return null;
    },
  };
  return node;
}

const origNavigator = globalThis.navigator;
const origDocument = globalThis.document;

afterEach(() => {
  Object.defineProperty(globalThis, 'navigator', { value: origNavigator, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: origDocument, configurable: true });
});

describe('copyText fallback inside modals', () => {
  test('mounts fallback textarea inside open dialog, verifies focus before execCommand, and restores prior focus', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText: async () => { throw new Error('denied'); } } },
      configurable: true,
    });

    const docState: { activeElement: FakeNode | null } = { activeElement: null };
    const body = makeFakeElement('BODY', docState);
    const openDialog = makeFakeElement('DIALOG', docState);
    const triggerBtn = makeFakeElement('BUTTON', docState, { closestDialog: openDialog });
    docState.activeElement = triggerBtn;

    let createdTa: FakeNode | null = null;
    const copyState: { mountedParent: FakeNode | null } = { mountedParent: null };
    let execCalled = 0;

    Object.defineProperty(globalThis, 'document', {
      value: {
        body,
        get activeElement() {
          return docState.activeElement;
        },
        querySelector(sel: string) {
          return sel === 'dialog[open]' ? openDialog : null;
        },
        createElement(tag: string) {
          createdTa = makeFakeElement(tag.toUpperCase(), docState, { acceptFocus: true });
          return createdTa;
        },
        execCommand(cmd: string) {
          execCalled += 1;
          copyState.mountedParent = createdTa?.parent ?? null;
          return cmd === 'copy';
        },
      },
      configurable: true,
    });

    const ok = await copyText('hello brief');
    expect(ok).toBe(true);
    expect(execCalled).toBe(1);
    expect(copyState.mountedParent).toBe(openDialog);
    expect(body.children).toHaveLength(0);
    expect(openDialog.children).toHaveLength(0);
    expect(docState.activeElement).toBe(triggerBtn);
    expect(triggerBtn.focusCount).toBe(1);
  });

  test('returns false without calling execCommand when fallback textarea cannot take focus (inert modal)', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText: async () => { throw new Error('denied'); } } },
      configurable: true,
    });

    const docState: { activeElement: FakeNode | null } = { activeElement: null };
    const body = makeFakeElement('BODY', docState);
    const triggerBtn = makeFakeElement('BUTTON', docState);
    docState.activeElement = triggerBtn;
    let execCalled = 0;

    Object.defineProperty(globalThis, 'document', {
      value: {
        body,
        get activeElement() {
          return docState.activeElement;
        },
        querySelector() {
          return null;
        },
        createElement(tag: string) {
          return makeFakeElement(tag.toUpperCase(), docState, { acceptFocus: false });
        },
        execCommand() {
          execCalled += 1;
          return true;
        },
      },
      configurable: true,
    });

    const ok = await copyText('hello brief');
    expect(ok).toBe(false);
    expect(execCalled).toBe(0);
    expect(body.children).toHaveLength(0);
    expect(triggerBtn.focusCount).toBe(1);
  });
});

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Menu } from '../../src/game/menu';

/**
 * 轻量级 DOM 模拟,补足 `Menu` 需要的那部分(创建节点、事件监听、
 * 属性/文本读写)。和 `hud.test.ts` 的 `MockNode` 同一类思路,但 `Hud`
 * 不挂事件监听,`Menu` 挂了(按钮点击、表单提交),所以这里多补了
 * `addEventListener` / `dispatch`。
 */
class MockNode {
  id = '';
  className = '';
  textContent = '';
  hidden = false;
  value = '';
  type = '';
  min = '';
  step = '';
  htmlFor = '';
  attributes = new Map<string, string>();
  children: MockNode[] = [];
  parent: MockNode | null = null;
  tagName: string;
  private readonly listeners = new Map<string, ((event: { preventDefault(): void }) => void)[]>();

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  append(...nodes: (MockNode | string)[]): void {
    for (const node of nodes) {
      if (typeof node === 'string') {
        continue;
      }
      node.parent = this;
      this.children.push(node);
    }
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === 'id') this.id = value;
    if (name === 'class') this.className = value;
  }

  addEventListener(type: string, handler: (event: { preventDefault(): void }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  /** 测试用:模拟一次事件触发。 */
  dispatch(type: string): void {
    let prevented = false;
    const event = { preventDefault: () => { prevented = true; } };
    for (const handler of this.listeners.get(type) ?? []) {
      handler(event);
    }
    void prevented;
  }

  remove(): void {
    if (this.parent !== null) {
      const idx = this.parent.children.indexOf(this);
      if (idx !== -1) {
        this.parent.children.splice(idx, 1);
      }
      this.parent = null;
    }
  }

  querySelector(selector: string): MockNode | null {
    return querySelectorImpl(this, selector);
  }
}

function querySelectorImpl(root: MockNode, selector: string): MockNode | null {
  for (const child of root.children) {
    if (matchesSelector(child, selector)) {
      return child;
    }
    const found = querySelectorImpl(child, selector);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

function matchesSelector(node: MockNode, selector: string): boolean {
  if (selector.startsWith('#')) {
    return node.id === selector.slice(1);
  }
  if (selector.startsWith('.')) {
    const cls = selector.slice(1);
    return node.className.split(/\s+/).includes(cls);
  }
  return node.tagName.toLowerCase() === selector.toLowerCase();
}

beforeAll(() => {
  const mockDoc = {
    createElement: (tag: string) => new MockNode(tag) as unknown as HTMLElement,
  };
  Object.defineProperty(globalThis, 'document', {
    value: mockDoc,
    writable: true,
    configurable: true,
  });
});

describe('Menu 暂停/换 seed 菜单', () => {
  let container: MockNode;

  beforeEach(() => {
    container = new MockNode('div');
  });

  it('初始隐藏,show/hide/toggle 正确切换', () => {
    const menu = new Menu(container as unknown as HTMLElement, 42, {
      onResume: () => {},
      onRestart: () => {},
      onChangeSeed: () => {},
    });

    const overlay = container.querySelector('#menu-overlay');
    expect(overlay?.hidden).toBe(true);
    expect(menu.isOpen).toBe(false);

    menu.show();
    expect(overlay?.hidden).toBe(false);
    expect(menu.isOpen).toBe(true);

    menu.toggle();
    expect(overlay?.hidden).toBe(true);
    expect(menu.isOpen).toBe(false);

    menu.hide();
    expect(overlay?.hidden).toBe(true);
  });

  it('继续按钮触发 onResume', () => {
    let resumed = false;
    const menu = new Menu(container as unknown as HTMLElement, 1, {
      onResume: () => { resumed = true; },
      onRestart: () => {},
      onChangeSeed: () => {},
    });
    menu.show();

    const button = container.querySelector('.menu-button-primary');
    expect(button?.textContent).toContain('继续');
    button?.dispatch('click');

    expect(resumed).toBe(true);
  });

  it('重开按钮触发 onRestart', () => {
    let restarted = false;
    const menu = new Menu(container as unknown as HTMLElement, 1, {
      onResume: () => {},
      onRestart: () => { restarted = true; },
      onChangeSeed: () => {},
    });
    void menu;

    // 第二个 .menu-button(第一个是 primary 的继续按钮)。
    const restartButton = container.querySelector('#menu-overlay')?.children
      .flatMap((card) => card.children)
      .find((node) => node.className === 'menu-button');
    restartButton?.dispatch('click');

    expect(restarted).toBe(true);
  });

  it('提交 seed 表单触发 onChangeSeed,携带解析出的整数', () => {
    let receivedSeed: number | null = null;
    const menu = new Menu(container as unknown as HTMLElement, 7, {
      onResume: () => {},
      onRestart: () => {},
      onChangeSeed: (seed) => { receivedSeed = seed; },
    });
    void menu;

    const input = container.querySelector('.menu-seed-input');
    expect(input?.value).toBe('7');
    if (input !== null) {
      input.value = '99';
    }

    const form = container.querySelector('.menu-seed-row');
    form?.dispatch('submit');

    expect(receivedSeed).toBe(99);
  });

  it('非法 seed 输入不触发 onChangeSeed', () => {
    let called = false;
    const menu = new Menu(container as unknown as HTMLElement, 7, {
      onResume: () => {},
      onRestart: () => {},
      onChangeSeed: () => { called = true; },
    });
    void menu;

    const input = container.querySelector('.menu-seed-input');
    if (input !== null) {
      input.value = 'not-a-number';
    }
    container.querySelector('.menu-seed-row')?.dispatch('submit');

    expect(called).toBe(false);
  });

  it('dispose 移除挂载的节点', () => {
    const menu = new Menu(container as unknown as HTMLElement, 1, {
      onResume: () => {},
      onRestart: () => {},
      onChangeSeed: () => {},
    });
    expect(container.querySelector('#menu-overlay')).not.toBeNull();
    menu.dispose();
    expect(container.querySelector('#menu-overlay')).toBeNull();
  });
});

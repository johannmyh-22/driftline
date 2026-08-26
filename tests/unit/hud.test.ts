import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { Hud, formatDelta, formatTime } from '../../src/game/hud';
import { Race } from '../../src/game/race';
import { generateTrack } from '../../src/game/trackLayout';

// 确保在 Node.js 环境下拥有完备的轻量级 DOM 模拟
class MockNode {
  id = '';
  className = '';
  textContent = '';
  style: Record<string, string> = {};
  attributes = new Map<string, string>();
  children: MockNode[] = [];
  parent: MockNode | null = null;
  tagName: string;

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  append(...nodes: (MockNode | string)[]): void {
    for (const node of nodes) {
      if (typeof node === 'string') {
        const textNode = new MockNode('#text');
        textNode.textContent = node;
        textNode.parent = this;
        this.children.push(textNode);
      } else {
        node.parent = this;
        this.children.push(node);
      }
    }
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === 'id') this.id = value;
    if (name === 'class') this.className = value;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
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
    return node.id === selector.slice(1) || node.attributes.get('id') === selector.slice(1);
  }
  if (selector.startsWith('.')) {
    const cls = selector.slice(1);
    const classes = (node.className || node.attributes.get('class') || '').split(/\s+/);
    return classes.includes(cls);
  }
  return node.tagName.toLowerCase() === selector.toLowerCase();
}

beforeAll(() => {
  // 注入 __BUILD_ID__ 全局定义
  (globalThis as unknown as { __BUILD_ID__: string }).__BUILD_ID__ = '#test-build 123456';

  const mockDoc = {
    createElement: (tag: string) => new MockNode(tag) as unknown as HTMLElement,
    createElementNS: (_ns: string, tag: string) => new MockNode(tag) as unknown as SVGElement,
    createTextNode: (text: string) => {
      const n = new MockNode('#text');
      n.textContent = text;
      return n as unknown as Text;
    },
  };

  Object.defineProperty(globalThis, 'document', {
    value: mockDoc,
    writable: true,
    configurable: true,
  });
});

describe('HUD 与小地图 UI 逻辑', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = (globalThis.document as unknown as { createElement: (t: string) => MockNode }).createElement('div') as unknown as HTMLDivElement;
  });

  it('时间格式化 formatTime 正确输出 MM:SS.hh', () => {
    expect(formatTime(0)).toBe('--:--.--');
    expect(formatTime(-1)).toBe('--:--.--');
    expect(formatTime(5.32)).toBe('00:05.32');
    expect(formatTime(65.04)).toBe('01:05.04');
    expect(formatTime(125.89)).toBe('02:05.89');
  });

  it('Delta 格式化 formatDelta 正确输出带符号秒数', () => {
    expect(formatDelta(-0.35)).toBe('-0.35s');
    expect(formatDelta(0.42)).toBe('+0.42s');
    expect(formatDelta(-1.05)).toBe('-1.05s');
    expect(formatDelta(0)).toBe('±0.00s');
  });

  it('Hud 初始化创建所有必要节点且包含构建号', () => {
    const rng = new Rng(42);
    const layout = generateTrack(rng.fork());
    const race = new Race(layout);

    const hud = new Hud(container, 42, layout, race);

    const root = container.querySelector('#readout');
    expect(root).not.toBeNull();

    // 速度显示节点
    const speed = container.querySelector('.readout-speed');
    expect(speed).not.toBeNull();

    // 计时卡片节点
    const timingCard = container.querySelector('.hud-timing-card');
    expect(timingCard).not.toBeNull();
    expect(timingCard?.querySelector('.hud-lap-badge')?.textContent).toBe('LAP 1');
    expect(timingCard?.querySelector('.hud-current-time')?.textContent).toBe('00:00.00');
    expect(timingCard?.querySelector('.hud-delta-badge')?.textContent).toBe('—');

    // 小地图 SVG
    const minimapCard = container.querySelector('.hud-minimap-card');
    expect(minimapCard).not.toBeNull();
    const svg = minimapCard?.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.querySelector('.hud-map-path-line')).not.toBeNull();
    expect(svg?.querySelector('.hud-map-player')).not.toBeNull();

    // 构建号与操作说明 (必须保留在左下角)
    const build = container.querySelector('.readout-build');
    expect(build).not.toBeNull();
    expect(build?.textContent).toBe('#test-build 123456');

    const help = container.querySelector('.readout-help');
    expect(help).not.toBeNull();
    expect(help?.textContent).toContain('W/S');

    hud.dispose();
    expect(container.querySelector('#readout')).toBeNull();
  });

  it('Hud.update 能够无报错地更新速度、圈时、Delta 与玩家光标', () => {
    const rng = new Rng(42);
    const layout = generateTrack(rng.fork());
    const race = new Race(layout);

    const hud = new Hud(container, 42, layout, race);

    // 模拟推进状态
    race.lapTime = 14.28;
    race.delta = -0.45;
    race.deltaTimer = 2.0;

    hud.update(25.0, race, { x: 10, y: 0, z: 20 }, 0.5);

    const speedNum = container.querySelector('.hud-speed-num');
    expect(speedNum?.textContent).toBe('90'); // 25 m/s * 3.6 = 90 km/h

    const currentTime = container.querySelector('.hud-current-time');
    expect(currentTime?.textContent).toBe('00:14.28');

    const deltaBadge = container.querySelector('.hud-delta-badge');
    expect(deltaBadge?.textContent).toContain('-0.45s');
    expect(deltaBadge?.className).toContain('hud-delta-ahead');

    hud.dispose();
  });

  it('平地场景(track 为 null)下小地图安全隐藏且不报错', () => {
    const hud = new Hud(container, 1, null, null);
    const minimapCard = container.querySelector<HTMLDivElement>('.hud-minimap-card');
    expect(minimapCard?.style.display).toBe('none');

    // update 正常执行不崩溃
    expect(() => {
      hud.update(10, null, { x: 0, y: 0, z: 0 }, 0);
    }).not.toThrow();

    hud.dispose();
  });
});

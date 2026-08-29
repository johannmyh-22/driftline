import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { Hud, formatDelta, formatGap, formatTime } from '../../src/game/hud';
import type { StandingRow } from '../../src/game/standings';
import { RaceSession } from '../../src/game/raceSession';
import { Standings } from '../../src/game/standings';
import { Race } from '../../src/game/race';
import { generateTrack } from '../../src/game/trackLayout';

// 确保在 Node.js 环境下拥有完备的轻量级 DOM 模拟
class MockNode {
  id = '';
  className = '';
  textContent = '';
  hidden = false;
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

  it('传入精选赛道数据时渲染 TARGET 行,没传时不渲染', () => {
    const rng = new Rng(42);
    const layout = generateTrack(rng.fork());
    const race = new Race(layout);

    const hudWithout = new Hud(container, 42, layout, race);
    expect(container.querySelector('.hud-target-val')).toBeNull();
    hudWithout.dispose();

    const hudWith = new Hud(container, 135, layout, race, {
      seed: 135,
      name: '荒漠 #135',
      theme: '荒漠',
      targetLapTime: 67.06,
    });
    const targetVal = container.querySelector('.hud-target-val');
    expect(targetVal?.textContent).toBe(formatTime(67.06));
    hudWith.dispose();
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

describe('名次显示(M7)', () => {
  function makeRow(over: Partial<StandingRow> = {}): StandingRow {
    return {
      id: 'player',
      distance: 0,
      laps: 0,
      position: 1,
      gapToLeader: 0,
      gapToAhead: 0,
      gapToBehind: 0,
      ...over,
    };
  }

  it('formatGap 用符号区分领先/落后,和分段 delta 的约定一致', () => {
    expect(formatGap(0)).toBe('±0m');
    expect(formatGap(0.4)).toBe('±0m');
    expect(formatGap(42.4)).toBe('+42m');
    expect(formatGap(-42.4)).toBe('−42m');
    expect(formatGap(Number.NaN)).toBe('—');
  });

  it('formatGap 超过一公里改用 km,免得 HUD 上出现读不快的四位数', () => {
    expect(formatGap(1834)).toBe('+1.83km');
    expect(formatGap(-2500)).toBe('−2.50km');
  });

  it('有对手时显示 P几/几,领跑时挂上高亮类', () => {
    const container = document.createElement('div');
    const hud = new Hud(container, 1, null, null, null);
    hud.update(10, null, undefined, undefined, makeRow({ position: 1 }), 2);

    const badge = container.querySelector('.hud-pos-badge') as HTMLElement | null;
    expect(badge).not.toBeNull();
    expect(badge?.hidden).toBe(false);
    expect(badge?.textContent).toBe('P1/2');
    expect(badge?.className).toContain('hud-pos-lead');

    hud.update(10, null, undefined, undefined, makeRow({ position: 2, gapToAhead: 30 }), 2);
    expect(badge?.textContent).toBe('P2/2');
    expect(badge?.className).not.toContain('hud-pos-lead');
    hud.dispose();
  });

  it('领跑时 GAP 显示的是甩开后车的距离(负号),不是恒为 0', () => {
    const container = document.createElement('div');
    const hud = new Hud(container, 1, null, null, null);
    hud.update(10, null, undefined, undefined, makeRow({ position: 1, gapToBehind: 88 }), 2);

    const gapRow = container.querySelector('.hud-gap-row') as HTMLElement | null;
    expect(gapRow).not.toBeNull();
    expect(gapRow?.hidden).toBe(false);
    expect(gapRow?.querySelector('.hud-record-val')?.textContent).toBe('−88m');
    hud.dispose();
  });

  it('没有对手(flat 场地)时名次与 GAP 整个隐藏,不占位', () => {
    const container = document.createElement('div');
    const hud = new Hud(container, 1, null, null, null);
    hud.update(10, null, undefined, undefined, null, 0);

    const badge = container.querySelector('.hud-pos-badge') as HTMLElement | null;
    expect(badge?.hidden).toBe(true);
    hud.dispose();
  });
});

describe('赛制显示(M7)', () => {
  function makeRow(over: Partial<StandingRow> = {}): StandingRow {
    return {
      id: 'player', distance: 0, laps: 0, position: 1,
      gapToLeader: 0, gapToAhead: 0, gapToBehind: 0, ...over,
    };
  }

  it('倒计时期间在画面中央显示剩余秒数', () => {
    const container = document.createElement('div');
    const hud = new Hud(container, 1, null, null, null);
    const session = new RaceSession();
    session.begin();

    hud.update(0, null, undefined, undefined, makeRow(), 2, session);
    const el = container.querySelector('.hud-countdown') as HTMLElement | null;
    expect(el).not.toBeNull();
    expect(el?.hidden).toBe(false);
    expect(el?.textContent).toBe('3');
    hud.dispose();
  });

  it('圈数徽章显示 LAP n/N,冲线后不会变成 LAP 4/3', () => {
    const container = document.createElement('div');
    const race = new Race(generateTrack(new Rng(1)));
    const hud = new Hud(container, 1, null, race, null);
    const session = new RaceSession(3);
    session.begin({ skipCountdown: true });

    hud.update(0, race, undefined, undefined, makeRow(), 2, session);
    const badge = container.querySelector('.hud-lap-badge') as HTMLElement | null;
    expect(badge?.textContent).toBe('LAP 1/3');

    // 跑完 3 圈之后 race.laps 会到 3,显示要停在 3/3。
    (race as unknown as { laps: number }).laps = 3;
    hud.update(0, race, undefined, undefined, makeRow(), 2, session);
    expect(badge?.textContent).toBe('LAP 3/3');
    hud.dispose();
  });

  it('比赛结束后弹出结算面板,冠军在最上面,没冲线的显示 DNF', () => {
    const container = document.createElement('div');
    const hud = new Hud(container, 1, null, null, null);
    const session = new RaceSession(1);
    session.begin({ skipCountdown: true });

    // 让玩家冲线,对手原地不动,然后等过宽限期强制结算。
    const standings = new Standings(['player', 'rival'], 1000);
    standings.reset([0, 0]);
    for (const arc of [250, 500, 750, 990, 20]) {
      standings.setArc(0, arc);
      standings.setArc(1, 10);
      standings.update();
      session.update(1 / 60, standings);
    }
    for (let t = 0; t < 25; t += 1 / 60) {
      session.update(1 / 60, standings);
    }
    expect(session.phase).toBe('finished');

    hud.update(0, null, undefined, undefined, makeRow(), 2, session);
    const panel = container.querySelector('.hud-results') as HTMLElement | null;
    expect(panel?.hidden).toBe(false);
    const rows = container.querySelector('.hud-results-body');
    expect(rows?.children.length).toBe(2);
    // 假 DOM 的 textContent 不聚合子节点,直接看子 span。
    const cells = (row: unknown): string[] =>
      ((row as { children?: { textContent?: string }[] }).children ?? []).map(
        (c) => c.textContent ?? '',
      );
    const first = cells(rows?.children[0]);
    expect(first[0]).toBe('P1');
    expect(first[1]).toBe('你');
    // 没冲线的那辆记 DNF。
    expect(cells(rows?.children[1])[2]).toBe('DNF');
    hud.dispose();
  });

  it('没有赛制(flat 场地)时倒计时与结算都不出现', () => {
    const container = document.createElement('div');
    const hud = new Hud(container, 1, null, null, null);
    hud.update(0, null, undefined, undefined, null, 0, null);
    expect((container.querySelector('.hud-countdown') as HTMLElement | null)?.hidden).toBe(true);
    expect((container.querySelector('.hud-results') as HTMLElement | null)?.hidden).toBe(true);
    hud.dispose();
  });
});

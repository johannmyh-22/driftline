import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllRecords,
  clearRecord,
  decodeGhostInput,
  encodeGhostInput,
  getStorageEnabled,
  isStorageAvailable,
  loadRecord,
  saveRecord,
  setStorageEnabled,
} from '../../src/game/records';

describe('Records 存储与持久化', () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    setStorageEnabled(true);

    const mockStorage: Storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, val: string) => {
        store.set(key, val);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
      key: (index: number) => Array.from(store.keys())[index] ?? null,
      get length() {
        return store.size;
      },
    };

    Object.defineProperty(globalThis, 'localStorage', {
      value: mockStorage,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    setStorageEnabled(true);
  });

  it('能正确保存并读取指定 seed 的最佳成绩与分段时间', () => {
    const record = {
      bestLapTime: 45.32,
      bestSectorTimes: [0, 1.82, 3.54, 5.12, 7.89],
    };

    const saved = saveRecord(42, record);
    expect(saved).toBe(true);

    const loaded = loadRecord(42);
    expect(loaded).not.toBeNull();
    expect(loaded?.bestLapTime).toBeCloseTo(45.32, 2);
    expect(loaded?.bestSectorTimes).toEqual([0, 1.82, 3.54, 5.12, 7.89]);
    expect(typeof loaded?.updatedAt).toBe('number');
  });

  it('不同 seed 的赛道记录相互隔离', () => {
    saveRecord(1, { bestLapTime: 50.1, bestSectorTimes: [0, 2.1] });
    saveRecord(42, { bestLapTime: 42.5, bestSectorTimes: [0, 1.8] });
    saveRecord(1337, { bestLapTime: 38.9, bestSectorTimes: [0, 1.5] });

    expect(loadRecord(1)?.bestLapTime).toBeCloseTo(50.1, 1);
    expect(loadRecord(42)?.bestLapTime).toBeCloseTo(42.5, 1);
    expect(loadRecord(1337)?.bestLapTime).toBeCloseTo(38.9, 1);
    expect(loadRecord(999)).toBeNull();
  });

  it('测试模式下禁用持久化(setStorageEnabled(false)),不读取也不写入', () => {
    saveRecord(1, { bestLapTime: 50.0, bestSectorTimes: [0] });

    setStorageEnabled(false);
    expect(getStorageEnabled()).toBe(false);
    expect(isStorageAvailable()).toBe(false);

    // 禁用时不应读出旧数据
    expect(loadRecord(1)).toBeNull();

    // 禁用时不应写入新数据
    const saved = saveRecord(2, { bestLapTime: 40.0, bestSectorTimes: [0] });
    expect(saved).toBe(false);

    // 重新开启后能恢复访问
    setStorageEnabled(true);
    expect(loadRecord(1)?.bestLapTime).toBeCloseTo(50.0, 1);
  });

  it('非法/损坏的 JSON 能够优雅降级返回 null 而不抛出异常', () => {
    store.set('driftline:record:42', '{ bad json ...');
    expect(loadRecord(42)).toBeNull();

    store.set('driftline:record:42', JSON.stringify({ bestLapTime: -10, bestSectorTimes: 'not array' }));
    expect(loadRecord(42)).toBeNull();
  });

  it('encodeGhostInput/decodeGhostInput 互为逆运算,含负数字节', () => {
    const data = Int8Array.from([0, 1, -1, 127, -127, 63, -63, 0]);
    const encoded = encodeGhostInput(data);
    expect(typeof encoded).toBe('string');
    const decoded = decodeGhostInput(encoded);
    expect(decoded).not.toBeNull();
    expect(Array.from(decoded ?? [])).toEqual(Array.from(data));
  });

  it('decodeGhostInput 对损坏/非法输入返回 null,不抛异常', () => {
    expect(decodeGhostInput('不是合法的 base64 ! ! !')).toBeNull();
    // 长度不是 4 的倍数:btoa('abc') 编出 3 字节,不是合法的一帧记录。
    expect(decodeGhostInput(btoa('abc'))).toBeNull();
  });

  it('saveRecord/loadRecord 原样透传 ghostInput,旧记录没有这个字段也能读', () => {
    const encoded = encodeGhostInput(Int8Array.from([127, 0, -127, 0]));
    saveRecord(1, { bestLapTime: 30, bestSectorTimes: [0, 15], ghostInput: encoded });
    expect(loadRecord(1)?.ghostInput).toBe(encoded);

    // 没有 ghostInput 字段的旧记录(M4 之前存的)按「没有幽灵」处理,不是错误。
    store.set('driftline:record:2', JSON.stringify({ bestLapTime: 20, bestSectorTimes: [0, 10] }));
    const legacy = loadRecord(2);
    expect(legacy).not.toBeNull();
    expect(legacy?.ghostInput).toBeUndefined();
  });

  it('clearRecord 与 clearAllRecords 能正确清理', () => {
    saveRecord(1, { bestLapTime: 50, bestSectorTimes: [] });
    saveRecord(2, { bestLapTime: 60, bestSectorTimes: [] });

    clearRecord(1);
    expect(loadRecord(1)).toBeNull();
    expect(loadRecord(2)?.bestLapTime).toBe(60);

    clearAllRecords();
    expect(loadRecord(2)).toBeNull();
  });
});

/*
 * 隔离必须由 `setStorageEnabled` 显式守住,不能靠隐式链。
 *
 * 合入时发现:`setStorageEnabled(false)` 在整个 `src/` 里从没被调用过,
 * 测试模式的隔离实际靠的是「testMode → 不建 Hud → 没人调 race.setSeed() →
 * race.seed 为 null → 读写都不发生」。那条链上任何一环被重构掉都会静默断掉,
 * 而且不会有任何测试变红 —— 这个项目最贵的几个 bug 都是这个形状。
 * 现在 main.ts 里显式 `setStorageEnabled(!testMode)`,这条测试守住它。
 */
describe('测试模式下 Race 不碰持久化', () => {
  it('关掉持久化后,即使 setSeed 也不读不写', () => {
    setStorageEnabled(true);
    clearAllRecords();
    saveRecord(4242, { bestLapTime: 61.5, bestSectorTimes: [10, 20, 30] });
    expect(loadRecord(4242)?.bestLapTime).toBeCloseTo(61.5, 3);

    setStorageEnabled(false);
    // 读:拿不到已存在的记录
    expect(loadRecord(4242)).toBeNull();
    // 写:落不下去
    expect(saveRecord(4242, { bestLapTime: 1, bestSectorTimes: [1] })).toBe(false);

    setStorageEnabled(true);
    // 关闭期间那次写入没有污染真实存储
    expect(loadRecord(4242)?.bestLapTime).toBeCloseTo(61.5, 3);
    clearAllRecords();
  });
});

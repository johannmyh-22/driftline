import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllRecords,
  clearRecord,
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

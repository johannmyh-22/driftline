/**
 * 圈速与分段记录的本地持久化。
 *
 * 按 seed 分别存储,避免不同赛道的圈速互相污染。
 * 测试模式下通过 `setStorageEnabled(false)` 完全旁路,防止测试用例污染真实存储或互相影响。
 */

export interface LapRecord {
  /** 最佳单圈用时(秒)。 */
  bestLapTime: number;
  /** 最佳圈在各个检查点处的累计用时(秒)。 */
  bestSectorTimes: number[];
  /** 记录产生的时间戳(毫秒)。 */
  updatedAt?: number | undefined;
}

const STORAGE_PREFIX = 'driftline:record:';
let storageEnabled = true;

/** 获取可用的 Storage 对象(支持浏览器 window.localStorage 与测试环境 globalThis.localStorage)。 */
function getStorage(): Storage | null {
  if (!storageEnabled) {
    return null;
  }
  try {
    if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
      return window.localStorage;
    }
    if (
      typeof globalThis !== 'undefined' &&
      'localStorage' in globalThis &&
      (globalThis as unknown as { localStorage?: Storage }).localStorage
    ) {
      return (globalThis as unknown as { localStorage: Storage }).localStorage;
    }
  } catch {
    return null;
  }
  return null;
}

/** 检查当前环境是否支持并启用了 localStorage。 */
export function isStorageAvailable(): boolean {
  const storage = getStorage();
  if (storage === null) {
    return false;
  }
  try {
    const testKey = '__driftline_storage_probe__';
    storage.setItem(testKey, '1');
    storage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}

/** 开启或关闭持久化(测试模式和无头截图下应设为 false)。 */
export function setStorageEnabled(enabled: boolean): void {
  storageEnabled = enabled;
}

/** 获取持久化开关状态。 */
export function getStorageEnabled(): boolean {
  return storageEnabled;
}

/** 读取指定 seed 赛道的最佳成绩。不存在或解析失败时返回 null。 */
export function loadRecord(seed: number): LapRecord | null {
  const storage = getStorage();
  if (storage === null) {
    return null;
  }
  try {
    const raw = storage.getItem(`${STORAGE_PREFIX}${seed}`);
    if (raw === null) {
      return null;
    }
    const data = JSON.parse(raw) as unknown;
    if (
      typeof data === 'object' &&
      data !== null &&
      'bestLapTime' in data &&
      typeof (data as LapRecord).bestLapTime === 'number' &&
      (data as LapRecord).bestLapTime > 0 &&
      'bestSectorTimes' in data &&
      Array.isArray((data as LapRecord).bestSectorTimes)
    ) {
      const parsed = data as LapRecord;
      return {
        bestLapTime: parsed.bestLapTime,
        bestSectorTimes: parsed.bestSectorTimes.map((t) => (typeof t === 'number' && t >= 0 ? t : 0)),
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** 保存指定 seed 赛道的最佳成绩。 */
export function saveRecord(seed: number, record: LapRecord): boolean {
  const storage = getStorage();
  if (storage === null) {
    return false;
  }
  if (record.bestLapTime <= 0) {
    return false;
  }
  try {
    const payload: LapRecord = {
      bestLapTime: record.bestLapTime,
      bestSectorTimes: record.bestSectorTimes,
      updatedAt: Date.now(),
    };
    storage.setItem(`${STORAGE_PREFIX}${seed}`, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

/** 清除指定 seed 的记录。 */
export function clearRecord(seed: number): void {
  const storage = getStorage();
  if (storage === null) {
    return;
  }
  try {
    storage.removeItem(`${STORAGE_PREFIX}${seed}`);
  } catch {
    // 忽略异常
  }
}

/** 清除所有 driftline 相关的赛道记录。 */
export function clearAllRecords(): void {
  const storage = getStorage();
  if (storage === null) {
    return;
  }
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key !== null && key.startsWith(STORAGE_PREFIX)) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      storage.removeItem(key);
    }
  } catch {
    // 忽略异常
  }
}

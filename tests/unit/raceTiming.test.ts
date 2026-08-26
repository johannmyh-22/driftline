import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type InputFrame, createInputFrame } from '../../src/core/input';
import { FIXED_DT } from '../../src/core/loop';
import { Rng } from '../../src/core/rng';
import { Autopilot } from '../../src/game/autopilot';
import { Course } from '../../src/game/course';
import { Physics, initPhysics } from '../../src/game/physics';
import { Race } from '../../src/game/race';
import { clearAllRecords, loadRecord, setStorageEnabled } from '../../src/game/records';
import { type TrackLayout, generateTrack } from '../../src/game/trackLayout';
import { Vehicle } from '../../src/game/vehicle';

beforeAll(async () => {
  await initPhysics();
});

interface Rig {
  layout: TrackLayout;
  course: Course;
  vehicle: Vehicle;
  race: Race;
  pilot: Autopilot;
  input: InputFrame;
}

function makeRig(seed: number): Rig {
  const rng = new Rng(seed);
  const layout = generateTrack(rng.fork());
  const course = new Course(layout, rng.fork());
  const vehicle = new Vehicle(course, new Physics());
  const start = layout.samples[0];
  if (start === undefined) {
    throw new Error('赛道没有采样点');
  }
  vehicle.reset(start.x, start.z, Math.atan2(start.tangentX, start.tangentZ));

  return {
    layout,
    course,
    vehicle,
    race: new Race(layout),
    pilot: new Autopilot(layout),
    input: createInputFrame(),
  };
}

/** 自动驾驶驱动固定步数或到达指定圈数 */
function driveSteps(rig: Rig, steps: number, maxLaps = 99): void {
  for (let i = 0; i < steps && rig.race.laps < maxLaps; i++) {
    rig.pilot.drive(rig.vehicle, rig.input);
    rig.vehicle.update(rig.input, FIXED_DT);
    rig.race.update(rig.vehicle, FIXED_DT);
  }
}

describe('Race 分段计时与 Delta 计算', () => {
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
    clearAllRecords();
  });

  it('循迹跑过检查点时正确记录分段时间', () => {
    const rig = makeRig(42);
    rig.race.setSeed(42);

    // 自动驾驶跑到越过检查点 1 (最多 600 步 = 10 秒)
    for (let i = 0; i < 600 && rig.race.lastCheckpoint < 1; i++) {
      rig.pilot.drive(rig.vehicle, rig.input);
      rig.vehicle.update(rig.input, FIXED_DT);
      rig.race.update(rig.vehicle, FIXED_DT);
    }

    // 此时应当已经越过检查点 1
    expect(rig.race.lastCheckpoint).toBeGreaterThanOrEqual(1);
    expect(rig.race.currentSectorTimes[1]).toBeGreaterThan(0);
    expect(rig.race.lapTime).toBeGreaterThan(0);
    expect(rig.race.nextCheckpoint).toBeGreaterThanOrEqual(2);
  });

  it('首圈跑完生成最佳成绩并存入 storage,第二圈通过检查点触发 delta', () => {
    const rig = makeRig(42);
    rig.race.setSeed(42);

    // 跑完第 1 圈
    driveSteps(rig, 60 * 120, 1);
    expect(rig.race.laps).toBe(1);
    expect(rig.race.bestLapTime).toBeGreaterThan(0);
    expect(rig.race.bestSectorTimes[1]).toBeGreaterThan(0);

    // 验证 storage 中已保存记录
    const saved = loadRecord(42);
    expect(saved).not.toBeNull();
    expect(saved?.bestLapTime).toBeCloseTo(rig.race.bestLapTime, 2);

    // 跑入第 2 圈并越过检查点 1
    const lapsBefore = rig.race.laps;
    while (rig.race.laps === lapsBefore && rig.race.lastCheckpoint < 2) {
      rig.pilot.drive(rig.vehicle, rig.input);
      rig.vehicle.update(rig.input, FIXED_DT);
      rig.race.update(rig.vehicle, FIXED_DT);
    }

    // 第 2 圈通过检查点 1 时应当有 delta 计算
    expect(rig.race.bestSectorTimes[1]).toBeGreaterThan(0);
    expect(typeof rig.race.delta).toBe('number');
  });

  it('reset 重置比赛时能从 seed 重载历史最佳成绩', () => {
    const rig = makeRig(1337);
    rig.race.setSeed(1337);

    // 跑完第 1 圈
    driveSteps(rig, 60 * 120, 1);
    expect(rig.race.laps).toBe(1);
    const best = rig.race.bestLapTime;
    expect(best).toBeGreaterThan(0);

    // 重置
    rig.race.reset();
    expect(rig.race.laps).toBe(0);
    expect(rig.race.lapTime).toBe(0);
    expect(rig.race.bestLapTime).toBeCloseTo(best, 2);
    expect(rig.race.bestSectorTimes[1]).toBeGreaterThan(0);
  });
});

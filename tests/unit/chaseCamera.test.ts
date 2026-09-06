import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { ChaseCamera } from '../../src/game/chaseCamera';
import { createGroundHit, type GroundHit, type GroundQuery } from '../../src/game/groundQuery';
import { CAMERA, REFERENCE_TOP_SPEED } from '../../src/game/tuning';
import type { Vehicle } from '../../src/game/vehicle';

const flatField: GroundQuery = {
  sample(_x: number, _z: number, out: GroundHit): void {
    Object.assign(out, createGroundHit());
  },
};

/** 只填 ChaseCamera 实际读的那几个字段,其余用 `as unknown as Vehicle` 绕过。 */
function makeVehicle(groundSpeed: number, yawRate: number): Vehicle {
  return {
    position: new Vector3(0, 0, 0),
    velocity: new Vector3(0, 0, groundSpeed),
    yaw: 0,
    yawRate,
    groundSpeed,
  } as unknown as Vehicle;
}

const upX = new Vector3();

function settle(camera: ChaseCamera, vehicle: Vehicle, seconds: number): void {
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) {
    camera.update(vehicle, dt);
  }
  camera.present(1);
}

describe('ChaseCamera 的 prefers-reduced-motion 分支', () => {
  it('不传 reducedMotion 参数时,vitest 的 Node 环境没有 window,默认按不开处理,不抛错', () => {
    expect(() => new ChaseCamera(flatField)).not.toThrow();
  });


  it('默认(reducedMotion=false)高速转弯会滚转、FOV 会拉伸', () => {
    const camera = new ChaseCamera(flatField, 16 / 9, false);
    const vehicle = makeVehicle(REFERENCE_TOP_SPEED * 0.6, 1.5);
    camera.snapTo(vehicle);
    settle(camera, vehicle, 1);

    upX.set(0, 1, 0).applyQuaternion(camera.camera.quaternion);
    expect(Math.abs(upX.x)).toBeGreaterThan(0.01);
    expect(camera.camera.fov).toBeGreaterThan(CAMERA.fovBase + 1);
  });

  it('reducedMotion=true 时滚转完全清零,FOV 拉伸按 reducedMotionFovScale 收窄', () => {
    const speed = REFERENCE_TOP_SPEED * 0.6;
    const yawRate = 1.5;

    const normal = new ChaseCamera(flatField, 16 / 9, false);
    const reduced = new ChaseCamera(flatField, 16 / 9, true);
    const vehicle = makeVehicle(speed, yawRate);

    normal.snapTo(vehicle);
    reduced.snapTo(vehicle);
    settle(normal, vehicle, 1);
    settle(reduced, vehicle, 1);

    upX.set(0, 1, 0).applyQuaternion(reduced.camera.quaternion);
    expect(upX.x).toBe(0);

    const normalGain = normal.camera.fov - CAMERA.fovBase;
    const reducedGain = reduced.camera.fov - CAMERA.fovBase;
    expect(reducedGain).toBeGreaterThan(0);
    expect(reducedGain).toBeLessThan(normalGain);
    expect(reducedGain).toBeCloseTo(normalGain * CAMERA.reducedMotionFovScale, 1);
  });

  it('reducedMotion=false 但 yawRate=0 时不产生滚转 —— 分支只在真的要滚转时才有差异', () => {
    const camera = new ChaseCamera(flatField, 16 / 9, false);
    const vehicle = makeVehicle(REFERENCE_TOP_SPEED * 0.6, 0);
    camera.snapTo(vehicle);
    settle(camera, vehicle, 1);

    upX.set(0, 1, 0).applyQuaternion(camera.camera.quaternion);
    expect(upX.x).toBeCloseTo(0, 6);
  });
});

describe('鼠标自由视角(M7 之外的手感补充)', () => {
  /** 把自由视角角度推到目标值并让相机收敛。 */
  function settleLook(
    camera: ChaseCamera,
    vehicle: Vehicle,
    yaw: number,
    pitch: number,
    seconds = 2,
  ): void {
    const dt = 1 / 60;
    for (let t = 0; t < seconds; t += dt) {
      camera.setLookAngles(yaw, pitch, dt);
      camera.update(vehicle, dt);
    }
    camera.present(1);
  }

  it('不动鼠标时相机位姿和没有这个功能时逐位一致', () => {
    const vehicle = makeVehicle(30, 0);
    const a = new ChaseCamera(flatField, 16 / 9, false);
    a.snapTo(vehicle);
    settle(a, vehicle, 2);
    const withoutLook = a.camera.position.clone();

    const b = new ChaseCamera(flatField, 16 / 9, false);
    b.snapTo(vehicle);
    settleLook(b, vehicle, 0, 0, 2);
    expect(b.camera.position.x).toBe(withoutLook.x);
    expect(b.camera.position.y).toBe(withoutLook.y);
    expect(b.camera.position.z).toBe(withoutLook.z);
  });

  it('偏航 90° 把相机转到车的侧面,而不是原地转头', () => {
    const vehicle = makeVehicle(0, 0);
    const camera = new ChaseCamera(flatField, 16 / 9, false);
    camera.snapTo(vehicle);
    settleLook(camera, vehicle, Math.PI / 2, 0);

    // 车头朝 +Z,默认机位在 -Z 侧。绕 Y 转 90° 之后应该跑到 X 轴一侧去。
    const pos = camera.camera.position;
    expect(Math.abs(pos.x)).toBeGreaterThan(CAMERA.offsetBack * 0.7);
    expect(Math.abs(pos.z)).toBeLessThan(CAMERA.offsetBack * 0.4);
  });

  it('环视时相机到车的水平距离基本不变——是绕着车转,不是拉远或推近', () => {
    const vehicle = makeVehicle(0, 0);
    const base = new ChaseCamera(flatField, 16 / 9, false);
    base.snapTo(vehicle);
    settleLook(base, vehicle, 0, 0);
    const r0 = Math.hypot(base.camera.position.x, base.camera.position.z);

    for (const yaw of [Math.PI / 4, Math.PI / 2, Math.PI]) {
      const camera = new ChaseCamera(flatField, 16 / 9, false);
      camera.snapTo(vehicle);
      settleLook(camera, vehicle, yaw, 0);
      const r = Math.hypot(camera.camera.position.x, camera.camera.position.z);
      expect(Math.abs(r - r0)).toBeLessThan(0.5);
    }
  });

  it('抬高俯仰会把相机抬起来', () => {
    const vehicle = makeVehicle(0, 0);
    const low = new ChaseCamera(flatField, 16 / 9, false);
    low.snapTo(vehicle);
    settleLook(low, vehicle, 0, 0);

    const high = new ChaseCamera(flatField, 16 / 9, false);
    high.snapTo(vehicle);
    settleLook(high, vehicle, 0, CAMERA.lookPitchMax);
    expect(high.camera.position.y).toBeGreaterThan(low.camera.position.y);
  });

  it('snapTo 会把自由视角清零,重开一局不残留上一局的视角', () => {
    const vehicle = makeVehicle(0, 0);
    const camera = new ChaseCamera(flatField, 16 / 9, false);
    camera.snapTo(vehicle);
    settleLook(camera, vehicle, Math.PI / 2, 0);

    camera.snapTo(vehicle);
    const fresh = new ChaseCamera(flatField, 16 / 9, false);
    fresh.snapTo(vehicle);
    expect(camera.camera.position.x).toBeCloseTo(fresh.camera.position.x, 6);
    expect(camera.camera.position.z).toBeCloseTo(fresh.camera.position.z, 6);
  });
});

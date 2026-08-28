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

import {
  DirectionalLight,
  Group,
  HemisphereLight,
  PerspectiveCamera,
  Scene,
  Vector3,
} from 'three';
import type { Rng } from '../core/rng';
import { createGround } from '../gfx/ground';
import { createPalette } from '../gfx/palette';
import { createSky } from '../gfx/sky';
import { createSpinner } from '../gfx/spinner';

/** 弧度/秒。选这个值是为了 120 帧(2 秒)后姿态明显变过,截图一眼能看出步进生效。 */
const SPIN_SPEED = 0.9;
const HOVER_HEIGHT = 4.6;

interface CameraPreset {
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
}

const CAMERA_PRESETS: Readonly<Record<string, CameraPreset>> = {
  // 视线基本水平:地平线落在画面中段,一张图里同时看得到天空渐变和地面网格。
  default: { position: [8, 4.8, 11], target: [0, 4.4, 0] },
  low: { position: [0.4, 1.4, 12], target: [0, 5.2, 0] },
  // 别用正上方俯视:视线与 up 向量共线时 lookAt 的 roll 没有定义,画面会莫名歪掉。
  top: { position: [0, 18, 5], target: [0, 0, 0] },
  wide: { position: [19, 8.5, 21], target: [0, 3.6, 0] },
};

export const CAMERA_PRESET_NAMES = Object.keys(CAMERA_PRESETS);

/**
 * M0 的占位世界:渐变天空 + 网格地面 + 一个受光旋转的多面体。
 *
 * **这不是游戏内容。** 它只用来证明「构建 → 渲染 → 无头截图 → 我能读到图」
 * 这条回路成立。M1 会把这个文件整个删掉。
 */
export class PlaceholderWorld {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(58, 16 / 9, 0.1, 2000);

  private readonly spinner: Group;
  private readonly cameraTarget = new Vector3();
  private previousAngle = 0;
  private angle = 0;
  private preset = 'default';

  constructor(rng: Rng) {
    const palette = createPalette(rng.fork());

    this.scene.add(createSky(palette));
    this.scene.add(createGround(rng.fork(), palette));

    this.spinner = createSpinner(rng.fork(), palette);
    this.spinner.position.y = HOVER_HEIGHT;
    this.scene.add(this.spinner);

    // 一主一补:主光造明暗面,半球光把背光面从死黑里拉回来,低多边形才有体积感。
    const key = new DirectionalLight(palette.keyLight, 2.2);
    key.position.set(6, 11, 4);
    key.name = 'key-light';
    this.scene.add(key);

    const fill = new HemisphereLight(palette.horizon, palette.fillLight, 0.45);
    fill.name = 'fill-light';
    this.scene.add(fill);

    this.setCameraPreset(this.preset);
  }

  /** 当前旋转角(弧度),与 `snapshot()` 报告的值一致。 */
  get spinnerRotation(): number {
    return this.angle;
  }

  update(dt: number): void {
    this.previousAngle = this.angle;
    this.angle += SPIN_SPEED * dt;
  }

  /** 用插值系数把逻辑状态写进 three 对象。这里不分配任何对象。 */
  present(alpha: number): void {
    const shown = this.previousAngle + (this.angle - this.previousAngle) * alpha;
    this.spinner.rotation.set(shown * 0.42, shown, shown * 0.17);
  }

  setCameraPreset(preset: string): void {
    const config = CAMERA_PRESETS[preset];
    if (config === undefined) {
      throw new RangeError(
        `未知机位 "${preset}",可用:${CAMERA_PRESET_NAMES.join(', ')}`,
      );
    }
    this.preset = preset;
    this.camera.position.set(...config.position);
    this.cameraTarget.set(...config.target);
    this.camera.lookAt(this.cameraTarget);
  }

  get cameraPreset(): string {
    return this.preset;
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }
}

import { BufferAttribute, BufferGeometry, Mesh, MeshBasicMaterial } from 'three';
import { clamp, lerp } from '../core/mathx';
import { type GroundHit, type GroundQuery, createGroundHit } from '../game/groundQuery';

const SEGMENTS = 24;
/** 离地多高时完全淡出。再高的落点参照也没有意义了。 */
const FADE_HEIGHT = 14;
const RADIUS_GROUNDED = 1.7;
const RADIUS_HIGH = 3.8;
/** 抬离地面的量。只用来避开共面闪烁,肉眼看不出来。 */
const LIFT = 0.12;

/**
 * 贴地阴影。不是真阴影 —— 是一块跟着车走、按离地高度缩放淡出的圆片。
 *
 * 为什么它属于 M1 而不是 M3:没有落地参照物,玩家判断不出自己离地多高,
 * 「脱离地面再落回」的手感就无从评价 —— 而那正是本里程碑的验收项。
 * 真正的阴影方案(shadow map)留给 M3。
 *
 * 顶点直接存世界坐标并**逐帧重采样地形高度**,而不是摆一个平面圆片:
 * 平的圆片在山包和斜坡上会被地面切掉一半,看起来像渲染坏了。
 */
export class GroundShadow {
  readonly mesh: Mesh;

  private readonly positions: Float32Array;
  private readonly attribute: BufferAttribute;
  private readonly material: MeshBasicMaterial;
  private readonly hit: GroundHit = createGroundHit();

  constructor() {
    this.positions = new Float32Array((SEGMENTS + 1) * 3);
    this.attribute = new BufferAttribute(this.positions, 3);

    const indices: number[] = [];
    for (let i = 1; i <= SEGMENTS; i++) {
      // 绕序:边缘顶点按角度递增排布时,(中心, 下一个, 当前) 才让法线朝上。
      // 反过来整个扇面朝下,会被背面剔除,表现为「阴影根本不出现」。
      indices.push(0, i === SEGMENTS ? 1 : i + 1, i);
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', this.attribute);
    geometry.setIndex(indices);

    this.material = new MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    });

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.name = 'ground-shadow';
    // 顶点是世界坐标,包围球每帧都在变,交给渲染器裁剪只会闪。
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  update(field: GroundQuery, x: number, z: number, y: number): void {
    field.sample(x, z, this.hit);
    const altitude = Math.max(0, y - this.hit.height);
    const t = clamp(altitude / FADE_HEIGHT, 0, 1);

    this.material.opacity = 0.42 * (1 - t) ** 1.5;
    this.mesh.visible = this.material.opacity > 0.01;
    if (!this.mesh.visible) {
      return;
    }

    const radius = lerp(RADIUS_GROUNDED, RADIUS_HIGH, t);

    this.positions[0] = x;
    this.positions[1] = this.hit.height + LIFT;
    this.positions[2] = z;

    for (let i = 0; i < SEGMENTS; i++) {
      const angle = (i / SEGMENTS) * Math.PI * 2;
      const px = x + Math.cos(angle) * radius;
      const pz = z + Math.sin(angle) * radius;
      field.sample(px, pz, this.hit);

      const o = (i + 1) * 3;
      this.positions[o] = px;
      this.positions[o + 1] = this.hit.height + LIFT;
      this.positions[o + 2] = pz;
    }

    this.attribute.needsUpdate = true;
  }
}

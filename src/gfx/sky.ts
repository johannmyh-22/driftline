import { BackSide, Color, Mesh, ShaderMaterial, SphereGeometry } from 'three';
import type { Palette } from './palette';

const VERTEX_SHADER = /* glsl */ `
varying vec3 vDirection;

void main() {
  vDirection = normalize((modelMatrix * vec4(position, 1.0)).xyz - cameraPosition);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uNadir;

varying vec3 vDirection;

void main() {
  float h = normalize(vDirection).y;
  // 地平线附近压窄过渡带,天顶方向拉开,看上去才像大气而不是线性渐变卡片。
  vec3 sky = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.3));
  vec3 below = mix(uHorizon, uNadir, pow(clamp(-h, 0.0, 1.0), 0.6));
  gl_FragColor = vec4(h >= 0.0 ? sky : below, 1.0);
  #include <colorspace_fragment>
}
`;

/**
 * 程序化渐变天空。用一个反面球罩住场景,而不是 `scene.background` 的贴图 ——
 * 零二进制资产,而且渐变参数以后可以直接跟 seed 联动。
 */
export function createSky(palette: Palette): Mesh {
  const material = new ShaderMaterial({
    uniforms: {
      uZenith: { value: new Color().copy(palette.zenith) },
      uHorizon: { value: new Color().copy(palette.horizon) },
      uNadir: { value: new Color().copy(palette.nadir) },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    side: BackSide,
    depthWrite: false,
    fog: false,
  });

  const sky = new Mesh(new SphereGeometry(1, 32, 16), material);
  sky.name = 'sky';
  // 半径要大过任何机位的高度。M2 的俯瞰机位能升到一千多米,
  // 球太小的话相机会跑到球外面,画面四角直接露黑。
  sky.scale.setScalar(2600);
  // 天空永远在最里层且不参与裁剪:相机怎么转都不该看到边界。
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  return sky;
}

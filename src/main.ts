import { WebGLRenderer } from 'three';
import {
  type InputFrame,
  KeyboardInput,
  ScriptedInput,
  createInputFrame,
} from './core/input';
import { Loop } from './core/loop';
import { Rng, parseSeed } from './core/rng';
import { installTestApi } from './core/testApi';
import { Readout } from './game/hud';
import { World } from './game/world';
import './style.css';

const DEFAULT_SEED = 1337;

const params = new URLSearchParams(window.location.search);
const testMode = params.get('test') === '1';
const seed = parseSeed(params.get('seed'), DEFAULT_SEED);

const mount = document.querySelector<HTMLDivElement>('#app');
if (mount === null) {
  throw new Error('缺少 #app 挂载点');
}

try {
  boot(mount);
} catch (error) {
  showFatal(error);
  throw error;
}

function boot(container: HTMLDivElement): void {
  const renderer = new WebGLRenderer({
    // SwiftShader 上 MSAA 又慢又不稳,截图模式直接关掉;像素方差断言不依赖抗锯齿。
    antialias: !testMode,
    powerPreference: 'high-performance',
  });
  // 测试模式锁死 DPR,否则不同机器的 devicePixelRatio 会让截图分辨率漂移。
  renderer.setPixelRatio(testMode ? 1 : Math.min(window.devicePixelRatio, 2));
  container.append(renderer.domElement);

  const world = new World(new Rng(seed));

  const scripted = new ScriptedInput();
  const keyboard = testMode ? null : new KeyboardInput();
  const source = keyboard ?? scripted;
  const frame: InputFrame = createInputFrame();
  const readout = testMode ? null : new Readout(container);

  const loop = new Loop({
    update: (dt) => {
      // 每个固定步采一次输入:采样频率和物理步长绑死,回放才可能逐帧复现。
      source.sample(frame);
      world.update(frame, dt);
    },
    render: (alpha) => {
      world.present(alpha);
      readout?.update(world.vehicle.groundSpeed);
      renderer.render(world.scene, world.camera);
    },
  });

  const resize = (): void => {
    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;
    renderer.setSize(width, height, false);
    world.resize(width, height);
  };
  resize();
  window.addEventListener('resize', resize);

  document.documentElement.dataset['seed'] = String(seed);

  if (testMode) {
    // 测试模式下**绝不**注册 rAF:帧全部由 __DRIFTLINE_TEST__.advance() 推进。
    let resolveReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    installTestApi({
      ready,
      advance: (frames) => {
        loop.advance(frames);
      },
      setCamera: (preset) => {
        world.setCameraPreset(preset);
        world.present(1);
        renderer.render(world.scene, world.camera);
      },
      setInput: (partial) => {
        scripted.set(partial);
      },
      reset: () => {
        scripted.reset();
        world.vehicle.reset();
        world.chase.snapTo(world.vehicle);
        world.present(1);
      },
      snapshot: () => ({
        frame: loop.frame,
        elapsed: loop.elapsed,
        speed: world.vehicle.speed,
        groundSpeed: world.vehicle.groundSpeed,
        x: world.vehicle.position.x,
        y: world.vehicle.position.y,
        z: world.vehicle.position.z,
        yaw: world.vehicle.yaw,
        yawRate: world.vehicle.yawRate,
        clearance: world.vehicle.clearance,
        lateralSpeed: world.vehicle.lateralSpeed,
        grounded: world.vehicle.grounded ? 1 : 0,
      }),
    });

    loop.advance(0);
    resolveReady();
  } else {
    loop.start();
  }
}

function showFatal(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const node = document.createElement('div');
  node.id = 'fatal';
  node.textContent = `driftline 启动失败\n\n${message}`;
  document.body.append(node);
}

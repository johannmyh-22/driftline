import { WebGLRenderer } from 'three';
import { Loop } from './core/loop';
import { Rng, parseSeed } from './core/rng';
import { installTestApi } from './core/testApi';
import { PlaceholderWorld } from './game/placeholderWorld';
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

  const world = new PlaceholderWorld(new Rng(seed));

  const loop = new Loop({
    update: (dt) => {
      world.update(dt);
    },
    render: (alpha) => {
      world.present(alpha);
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
        renderer.render(world.scene, world.camera);
      },
      snapshot: () => ({
        frame: loop.frame,
        elapsed: loop.elapsed,
        spinnerRotation: world.spinnerRotation,
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

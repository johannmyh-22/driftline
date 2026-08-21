import { ACESFilmicToneMapping, PCFSoftShadowMap, WebGLRenderer } from 'three';
import {
  type InputFrame,
  KeyboardInput,
  ScriptedInput,
  createInputFrame,
} from './core/input';
import { Loop } from './core/loop';
import { Rng, parseSeed } from './core/rng';
import { POST, SKY } from './game/tuning';
import { installTestApi } from './core/testApi';
import { ALL_STAGES, DEFAULT_STAGES, type PostStage, Postprocess } from './gfx/postprocess';
import { Readout } from './game/hud';
import { initPhysics } from './game/physics';
import { type CourseKind, World } from './game/world';
import './style.css';

const DEFAULT_SEED = 1337;

const params = new URLSearchParams(window.location.search);
const testMode = params.get('test') === '1';
const seed = parseSeed(params.get('seed'), DEFAULT_SEED);
// ?course=flat 切回 M1 那块带跳台的平地。调手感时没有赛道干扰更干净。
const courseKind: CourseKind = params.get('course') === 'flat' ? 'flat' : 'race';
// ?post=none 关掉整条后处理链,?post=bloom,smaa 只留其中几级。
// 和 ?course=flat 是一类东西:把一个变量单独拿掉,才能判断画面问题出在哪一层。
// bloom 阈值取错导致全屏蒙雾那次,就是靠它一级一级排掉的。
const postParam = params.get('post');
const stages: readonly PostStage[] =
  postParam === null
    ? DEFAULT_STAGES
    : postParam.split(',').filter((name): name is PostStage =>
        (ALL_STAGES as readonly string[]).includes(name),
      );

/*
 * ?exposure=0.42&bloom=0.12 覆盖 tuning 里的两个逆光相关数值。
 *
 * 和 ?post= / ?course= 是同一类东西:把一个变量单独拎出来,才能判断画面问题
 * 出在哪一层。逆光强度已经被人类打回来三次,而每次「再收一档」原本都要
 * 重新 build 才能跟上一版对比 —— 有了这两个开关,一次构建就能拍完两档。
 *
 * **定稿的值仍然只住在 `tuning.ts` 里**,URL 参数不参与部署,也不进任何基准。
 */
const exposure = parseKnob(params.get('exposure'), SKY.exposure);
const bloomStrength = parseKnob(params.get('bloom'), POST.bloomStrength);

const mount = document.querySelector<HTMLDivElement>('#app');
if (mount === null) {
  throw new Error('缺少 #app 挂载点');
}

// 物理引擎的 wasm 要先加载完才能造世界。**这是整个启动路径上唯一的 await** ——
// 它一失败就什么都别渲染了,直接把错误糊到屏幕上,比留一块黑屏好排查。
boot(mount).catch((error: unknown) => {
  showFatal(error);
});

async function boot(container: HTMLDivElement): Promise<void> {
  await initPhysics();

  const renderer = new WebGLRenderer({
    // 后处理链接上之后,canvas 自己的 MSAA 就是纯浪费:画面渲进 composer 的
    // render target,最后只往 canvas 上贴一个全屏 quad,而 quad 没有内部边缘可抗。
    // 抗锯齿由链末的 SMAA 负责。
    antialias: false,
    powerPreference: 'high-performance',
  });
  // 测试模式锁死 DPR,否则不同机器的 devicePixelRatio 会让截图分辨率漂移。
  renderer.setPixelRatio(testMode ? 1 : Math.min(window.devicePixelRatio, 2));
  // ACES:把高动态范围压进屏幕能显示的范围。没有它,亮部会直接切平成一片死白,
  // 那是「电脑画的」最明显的特征之一。
  // 实际做这一步的是链末的 OutputPass,它从 renderer 上读这两个设置。
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = exposure;
  renderer.shadowMap.enabled = true;
  // PCF soft:硬阴影边缘在低仰角太阳下像贴纸,而 VSM 在 SwiftShader 上不稳。
  renderer.shadowMap.type = PCFSoftShadowMap;
  container.append(renderer.domElement);

  const world = new World(new Rng(seed), courseKind);
  // 环境贴图要用渲染器把天空烘出来,所以只能等到这里。烘一次,天空是静态的。
  world.scene.environment = world.atmosphere.buildEnvironment(renderer);
  world.scene.environmentIntensity = SKY.environmentIntensity;

  const post = new Postprocess(renderer, world.scene, world.camera, stages);
  post.setBloomStrength(bloomStrength);

  const scripted = new ScriptedInput();
  const keyboard = testMode ? null : new KeyboardInput();
  const source = keyboard ?? scripted;
  const frame: InputFrame = createInputFrame();
  const readout = testMode ? null : new Readout(container);

  // 首帧画完才在 DOM 上打标记。SwiftShader 上一帧要一秒以上,「canvas 元素出现」
  // 远早于「画面上有东西」—— 冒烟测试拿前者当后者用,后处理一接上就开始拍到空白。
  let painted = false;

  const loop = new Loop({
    update: (dt) => {
      // 每个固定步采一次输入:采样频率和物理步长绑死,回放才可能逐帧复现。
      source.sample(frame);
      world.update(frame, dt);
    },
    render: (alpha) => {
      world.present(alpha);
      readout?.update(world.vehicle.groundSpeed, world.race);
      post.render(world.camera);
      if (!painted) {
        painted = true;
        document.documentElement.dataset['painted'] = '1';
      }
    },
  });

  const resize = (): void => {
    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;
    renderer.setSize(width, height, false);
    world.resize(width, height);
    post.setSize(width, height);
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
        post.render(world.camera);
      },
      setInput: (partial) => {
        scripted.set(partial);
      },
      reset: () => {
        scripted.reset();
        world.spawnAtStart();
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
        onTrack: world.vehicle.onTrack ? 1 : 0,
        lateral: world.vehicle.lateral,
        arc: world.vehicle.arc,
        laps: world.race?.laps ?? 0,
        lapTime: world.race?.lapTime ?? 0,
        lastLapTime: world.race?.lastLapTime ?? 0,
        bestLapTime: world.race?.bestLapTime ?? 0,
        checkpoint: world.race?.lastCheckpoint ?? 0,
        resets: world.race?.resets ?? 0,
        // 1 = 车头正对太阳(逆光),-1 = 太阳在背后。逆光路段靠它搜,不靠猜帧数。
        sunAhead: world.sunAhead,
      }),
    });

    loop.advance(0);
    resolveReady();
  } else {
    loop.advance(0);
    loop.start();
  }
}

/**
 * 解析一个调试用的数值 URL 参数。**拿不准就退回 tuning 里的默认值** ——
 * 打错一个字母不该让画面变成黑屏,那会把排查引到完全错误的方向上去。
 */
function parseKnob(raw: string | null, fallback: number): number {
  if (raw === null) {
    return fallback;
  }
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function showFatal(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const node = document.createElement('div');
  node.id = 'fatal';
  node.textContent = `driftline 启动失败\n\n${message}`;
  document.body.append(node);
}

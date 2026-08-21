import { ACESFilmicToneMapping, PCFSoftShadowMap, WebGLRenderer } from 'three';
import {
  type InputFrame,
  KeyboardInput,
  ScriptedInput,
  createInputFrame,
} from './core/input';
import { Loop } from './core/loop';
import { Rng, parseSeed } from './core/rng';
import { SKY } from './game/tuning';
import { installTestApi } from './core/testApi';
import { ALL_STAGES, DEFAULT_STAGES, type PostStage, Postprocess } from './gfx/postprocess';
import { Readout } from './game/hud';
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
  renderer.toneMappingExposure = SKY.exposure;
  renderer.shadowMap.enabled = true;
  // PCF soft:硬阴影边缘在低仰角太阳下像贴纸,而 VSM 在 SwiftShader 上不稳。
  renderer.shadowMap.type = PCFSoftShadowMap;
  container.append(renderer.domElement);

  const world = new World(new Rng(seed), courseKind);
  // 环境贴图要用渲染器把天空烘出来,所以只能等到这里。烘一次,天空是静态的。
  world.scene.environment = world.atmosphere.buildEnvironment(renderer);
  world.scene.environmentIntensity = SKY.environmentIntensity;

  const post = new Postprocess(renderer, world.scene, world.camera, stages);

  const scripted = new ScriptedInput();
  const keyboard = testMode ? null : new KeyboardInput();
  const source = keyboard ?? scripted;
  const frame: InputFrame = createInputFrame();
  const readout = testMode ? null : new Readout(container);

  // 首帧画完才在 DOM 上打标记。SwiftShader 上一帧要一秒以上,「canvas 元素出现」
  // 远早于「画面上有东西」—— 冒烟测试拿前者当后者用,后处理一接上就开始拍到空白。
  let painted = false;
  let dbgFrame = 0;

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
      dbgFrame++;
      if (dbgFrame === 1 || dbgFrame === 5) {
        console.warn(`DBG f${dbgFrame} ${post.debugSizes(renderer)}`);
      }
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
      }),
    });

    loop.advance(0);
    resolveReady();
  } else {
    loop.advance(0);
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

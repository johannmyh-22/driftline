import { ACESFilmicToneMapping, PCFSoftShadowMap, WebGLRenderer } from 'three';
import { decodeGhostInput, loadRecord, setStorageEnabled } from './game/records';
import {
  type InputFrame,
  KeyboardInput,
  ScriptedInput,
  createInputFrame,
} from './core/input';
import { Loop } from './core/loop';
import { Rng, parseSeed } from './core/rng';
import { getCuratedTrack } from './game/curatedTracks';
import { AUDIO, PERF, POST, SKY } from './game/tuning';
import { installTestApi } from './core/testApi';
import {
  readTelemetry as readVehicleTelemetry,
  setTelemetryEnabled,
} from './game/diagnostics';
import { ALL_STAGES, DEFAULT_STAGES, type PostStage, Postprocess } from './gfx/postprocess';
import { AudioDirector } from './audio/director';
import { type PerfLevel, PerfGovernor } from './core/perfGovernor';
import { Hud } from './game/hud';
import { MouseLook } from './core/mouseLook';
import { CAMERA } from './game/tuning';
import { Menu } from './game/menu';
import { initPhysics } from './game/physics';
import { initCraftModel } from './gfx/craftModel';
import { type CourseKind, World } from './game/world';
import './style.css';

const DEFAULT_SEED = 1337;

const params = new URLSearchParams(window.location.search);
const testMode = params.get('test') === '1';

/*
 * 测试模式必须**显式**关掉本地成绩持久化。
 *
 * 隔离本来是「成立」的,但靠的是一条没人守的隐式链:testMode → 不建 Hud →
 * 没人调 race.setSeed() → race.seed 保持 null → loadRecord 不执行、saveRecord
 * 被 seed !== null 挡住。链上任何一环被重构掉(比如把 setSeed 挪进 world.ts ——
 * seed 本来就是世界状态而不是表现状态),截图测试就会开始互相污染,**而且不会
 * 有任何测试变红**。这个项目最贵的几个 bug 都是这个形状:测试因为错误的原因而绿。
 */
setStorageEnabled(!testMode);
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
/**
 * `?quality=N` 把画质锁在第 N 档,不再自动调。
 *
 * 两个用处:低配机器上人可以自己钉死一档(自动调是试探式的,画面会来回变,
 * 有人更愿意一直低画质);以及**拍一张降档之后的图**来核这条路是通的 ——
 * SwiftShader 上每帧一秒多,间隔全被 `PERF.outlierMs` 当异常丢掉,自动调
 * 在无头环境里根本触发不了。
 */
const qualityParam = params.get('quality');
const forcedQuality =
  qualityParam === null ? null : Math.min(PERF.levels.length - 1, Math.max(0, Number(qualityParam) | 0));

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
  /*
   * 物理引擎与车辆模型都要在造 World 之前就绪:`createCraft()` 是同步的,
   * 而且 `?test=1` 要求场景一造好就能逐帧步进,不能让第一帧去等异步加载。
   * 模型加载失败不致命 —— `createCraft()` 会回退到程序化造型。
   */
  await initPhysics();
  try {
    await initCraftModel();
  } catch (error) {
    console.warn('车辆模型加载失败,回退到程序化造型', error);
  }

  const renderer = new WebGLRenderer({
    // 后处理链接上之后,canvas 自己的 MSAA 就是纯浪费:画面渲进 composer 的
    // render target,最后只往 canvas 上贴一个全屏 quad,而 quad 没有内部边缘可抗。
    // 抗锯齿由链末的 SMAA 负责。
    antialias: false,
    powerPreference: 'high-performance',
  });
  /*
   * 测试模式锁死 DPR,否则不同机器的 devicePixelRatio 会让截图分辨率漂移。
   * 实时模式下这个值会被动态画质调节继续乘一个倍率,见下面的 `governor`。
   */
  const basePixelRatio = testMode ? 1 : Math.min(window.devicePixelRatio, PERF.maxPixelRatio);
  renderer.setPixelRatio(basePixelRatio);
  // ACES:把高动态范围压进屏幕能显示的范围。没有它,亮部会直接切平成一片死白,
  // 那是「电脑画的」最明显的特征之一。
  // 实际做这一步的是链末的 OutputPass,它从 renderer 上读这两个设置。
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = exposure;
  renderer.shadowMap.enabled = true;
  // PCF soft:硬阴影边缘在低仰角太阳下像贴纸,而 VSM 在 SwiftShader 上不稳。
  renderer.shadowMap.type = PCFSoftShadowMap;
  container.append(renderer.domElement);

  const rng = new Rng(seed);
  const world = new World(rng, courseKind, { skipCountdown: testMode });
  // 环境贴图要用渲染器把天空烘出来,所以只能等到这里。烘一次,天空是静态的。
  world.scene.environment = world.atmosphere.buildEnvironment(renderer);
  world.scene.environmentIntensity = SKY.environmentIntensity;

  /*
   * 幽灵回放:装载这个 seed 上次留下的最佳圈录制(如果有)。
   *
   * `loadRecord` 内部已经会遵守 `setStorageEnabled(!testMode)`(上面已经
   * 显式调过),测试模式下这里必然拿到 null —— 不需要再判一次 testMode,
   * 存储层的开关本身就是那道闸。
   */
  if (world.ghost !== null) {
    const record = loadRecord(seed);
    const bytes = record?.ghostInput === undefined ? null : decodeGhostInput(record.ghostInput);
    if (bytes !== null) {
      world.ghost.loadRecording(bytes);
      world.ghost.restartLap();
    }
  }

  const post = new Postprocess(renderer, world.scene, world.camera, stages);
  post.setBloomStrength(bloomStrength);

  const scripted = new ScriptedInput();
  const keyboard = testMode ? null : new KeyboardInput();
  const source = keyboard ?? scripted;
  const frame: InputFrame = createInputFrame();
  const readout = testMode
    ? null
    : new Hud(container, seed, world.track, world.race, getCuratedTrack(seed));
  /*
   * 程序化音频。测试模式不构造:`?test=1` 下没有真实用户手势,
   * `AudioContext` 起不来,建了也是空跑。`rng.fork()` 排在 World 已经
   * 消耗完的那些 fork 之后,不影响赛道/地形/配色的既有随机数序列。
   */
  const audio = testMode ? null : new AudioDirector(rng.fork());

  /*
   * 鼠标自由视角。测试模式不构造——`?test=1` 下不该有任何监听器改动相机,
   * 「同 seed 同输入逐帧复现」那条契约要求截图回路里的机位完全确定。
   */
  const mouseLook = testMode
    ? null
    : new MouseLook(renderer.domElement, {
        sensitivity: CAMERA.lookSensitivity,
        yawLimit: CAMERA.lookYawLimit,
        pitchMin: CAMERA.lookPitchMin,
        pitchMax: CAMERA.lookPitchMax,
        recenterDelay: CAMERA.lookRecenterDelay,
        recenterLambda: CAMERA.lookRecenterLambda,
      });

  // 首帧画完才在 DOM 上打标记。SwiftShader 上一帧要一秒以上,「canvas 元素出现」
  // 远早于「画面上有东西」—— 冒烟测试拿前者当后者用,后处理一接上就开始拍到空白。
  let painted = false;

  const loop = new Loop({
    update: (dt) => {
      // 每个固定步采一次输入:采样频率和物理步长绑死,回放才可能逐帧复现。
      source.sample(frame);
      if (mouseLook !== null) {
        mouseLook.update(dt);
        world.chase.setLookAngles(mouseLook.yaw, mouseLook.pitch, dt);
      }
      world.update(frame, dt);
      audio?.update(world.vehicle, frame);
    },
    render: (alpha) => {
      if (governor !== null) {
        const now = performance.now();
        if (lastFrameMs !== null && governor.sample(now - lastFrameMs)) {
          applyLevel(governor.level);
        }
        lastFrameMs = now;
      }
      world.present(alpha);
      readout?.update(
      world.vehicle.groundSpeed,
      world.race,
      world.vehicle.position,
      world.vehicle.yaw,
      world.standings?.rowOf('player'),
      world.standings?.rows.length,
      world.session,
    );
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

  /*
   * 动态画质调节(M6)。**测试模式不构造** —— 分辨率会变,截图就不可复现了,
   * 和 `Hud`/`AudioDirector` 同一条处理方式。
   *
   * 判据喂的是两次渲染之间的墙钟间隔;为什么用「显示器周期的倍数」而不是
   * 绝对毫秒,见 `PerfGovernor` 的类注释。
   */
  const governor = testMode || forcedQuality !== null ? null : new PerfGovernor();
  let lastFrameMs: number | null = null;
  const applyLevel = (level: PerfLevel): void => {
    renderer.setPixelRatio(basePixelRatio * level.scale);
    post.setEffectsEnabled(level.post);
    // setPixelRatio 只改倍率,不会重建渲染目标 —— 尺寸要再走一遍。
    resize();
  };
  if (forcedQuality !== null) {
    applyLevel(PERF.levels[forcedQuality] as PerfLevel);
  }

  document.documentElement.dataset['seed'] = String(seed);

  /*
   * 暂停/换 seed 菜单。测试模式跳过(和 Hud 一样)——测试接口自己驱动
   * advance(),不该有真实按键能让主循环停下来。
   *
   * 换 seed 靠整页跳转:World 只在 boot() 里造一次(赛道+地形+护墙网格要
   * 2 秒多,见 docs/HANDOFF.md 第四节性能一节),没有必要为了换 seed 去写
   * 一套原地重建 World 的逻辑,跳转本来就是现在这条「URL 参数决定 seed」
   * 路径的自然延伸。
   */
  let menu: Menu | null = null;
  if (!testMode) {
    menu = new Menu(
      container,
      seed,
      { volume: audio?.masterVolume ?? AUDIO.masterVolume, muted: audio?.muted ?? false },
      {
        onResume: () => {
          audio?.triggerUiClick();
          menu?.hide();
          loop.start();
        },
        onRestart: () => {
          // 开始按钮自己解锁一次,不指望 pointerdown 冒泡到 window 那个监听器
          // ——按钮的处理器里如果有 stopPropagation,冒泡是收不到的。
          audio?.resume();
          audio?.triggerUiClick();
          mouseLook?.reset();
          world.spawnAtStart();
          world.chase.snapTo(world.vehicle);
          menu?.hide();
          loop.start();
        },
        onChangeSeed: (newSeed) => {
          const url = new URL(window.location.href);
          url.searchParams.set('seed', String(newSeed));
          window.location.href = url.toString();
        },
        onVolumeChange: (volume) => {
          audio?.setMasterVolume(volume);
        },
        onToggleMute: () => {
          if (audio === null) {
            return;
          }
          audio.setMuted(!audio.muted);
          menu?.setMuted(audio.muted);
        },
      },
    );

    window.addEventListener('keydown', (event) => {
      if (event.code !== 'Escape') {
        return;
      }
      event.preventDefault();
      if (menu?.isOpen) {
        menu.hide();
        loop.start();
      } else {
        menu?.show();
        loop.stop();
      }
    });

    /*
     * 浏览器自动播放策略:AudioContext 必须在真实用户手势之后才会出声。
     *
     * **监听器要一直挂到上下文确认在跑为止,不能"调过一次就摘掉"。**
     * 老代码是首次按键/点击就把自己摘掉,可 `resume()` 是异步的、而且第一次
     * 未必成功(手势可能被判定为不合格,或者上下文报告 running 却仍被策略
     * 挡着)。一旦那唯一一次没生效,后面就再也没人调 resume 了——人类实际
     * 听到的「刚进游戏没声音,撞一下车之后才有」就是这么来的:后来的按键
     * 碰巧又触发了别的路径才把它解锁。
     *
     * 现在每次手势都调,直到 `isRunning` 为真才摘监听器。`resume()` 对已经
     * 在跑的上下文是空操作,重复调没有代价。
     */
    const resumeAudio = (): void => {
      if (audio === null) {
        return;
      }
      audio.resume();
      if (audio.isRunning) {
        window.removeEventListener('keydown', resumeAudio);
        window.removeEventListener('pointerdown', resumeAudio);
      }
    };
    window.addEventListener('keydown', resumeAudio);
    window.addEventListener('pointerdown', resumeAudio);
  }

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
      setTelemetryEnabled: (flag) => {
        setTelemetryEnabled(flag);
      },
      readVehicleTelemetry: () => readVehicleTelemetry(),
      setGhostInput: (base64) => {
        if (world.ghost === null) {
          return;
        }
        const bytes = base64 === null ? null : decodeGhostInput(base64);
        world.ghost.loadRecording(bytes);
        if (bytes !== null) {
          world.ghost.restartLap();
        }
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
        // 撞墙的法向/切向速度(m/s)。音频的撞击强度归一化基准要拿真实分布来定,
        // 不能拍脑袋——把它们暴露出来才能在无头环境里量。
        wallNormalSpeed: world.vehicle.wallNormalSpeed,
        wallTangentSpeed: world.vehicle.wallTangentSpeed,
        // 赛制(M7)。phase: 0=倒计时 1=比赛中 2=已结束。
        phase:
          world.session === null
            ? -1
            : world.session.phase === 'countdown'
              ? 0
              : world.session.phase === 'running'
                ? 1
                : 2,
        finishedCount: world.session?.results.length ?? 0,
        totalLaps: world.session?.totalLaps ?? 0,
        // 名次(M7)。没有对手的 flat 场地是 0,不是 1——0 表示「没有名次这回事」。
        position: world.standings?.rowOf('player')?.position ?? 0,
        fieldSize: world.standings?.rows.length ?? 0,
        rivalCount: world.rivals.length,
        rivalDistance: world.standings?.rowOf('rival0')?.distance ?? 0,
        playerDistance: world.standings?.rowOf('player')?.distance ?? 0,
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

import { MINIMAP_TUNING } from './tuning';
import type { Race } from './race';
import type { TrackLayout, TrackSample } from './trackLayout';

interface VectorLike {
  x: number;
  y: number;
  z: number;
}

/**
 * M4 HUD 与小地图系统。
 *
 * 采用 DOM Overlay 实现(不往 WebGL canvas 里排文字)。
 * 包含:
 * - 速度显示(大字数字仪表, km/h)
 * - 圈数、当前圈时、最佳单圈、上一圈用时
 * - 分段 delta(相对历史最佳圈,绿色领先、红色落后)
 * - 程序化 SVG 小地图(显示赛道闭环、起跑线、玩家实时位置与车头朝向)
 * - 操作说明与构建号(__BUILD_ID__,严格保留在左下角)
 *
 * 性能约束:
 * - 每帧更新执行严格的脏检查(数值未变不触碰 DOM)
 * - 格式化采用整数 centiseconds 比对,每帧零 GC 内存分配
 */
export class Hud {
  private readonly root: HTMLDivElement;

  // 速度组件
  private readonly speedNum: HTMLSpanElement;

  // 计时与 Delta 组件
  private readonly timingCard: HTMLDivElement;
  private readonly lapBadge: HTMLSpanElement;
  private readonly currentTime: HTMLDivElement;
  private readonly deltaBadge: HTMLSpanElement;
  private readonly bestTimeVal: HTMLSpanElement;
  private readonly lastTimeVal: HTMLSpanElement;

  // 小地图组件
  private readonly minimapCard: HTMLDivElement;
  private readonly playerMarker: SVGElement | null = null;
  private readonly hasMap: boolean = false;
  private readonly trackCenterX: number = 0;
  private readonly trackCenterZ: number = 0;
  private readonly mapScale: number = 1;
  private readonly mapCenterX: number = MINIMAP_TUNING.viewBoxSize / 2;
  private readonly mapCenterY: number = MINIMAP_TUNING.viewBoxSize / 2;

  // 脏检查缓存
  private lastShownKmh = -1;
  private lastShownLapTimeHundredths = -1;
  private lastShownBestTimeHundredths = -1;
  private lastShownLastTimeHundredths = -1;
  private lastShownLaps = -1;
  private lastShownDeltaText = '';
  /** delta 的整型脏检查键(百分之一秒)。NaN = 尚未显示过。 */
  private lastShownDeltaKey = Number.NaN;
  private lastShownPlayerX = -99999;
  private lastShownPlayerZ = -99999;
  private lastShownPlayerRot = -99999;

  constructor(
    parent: HTMLElement,
    seed: number,
    track: TrackLayout | null,
    race: Race | null,
  ) {
    this.root = document.createElement('div');
    this.root.id = 'readout';
    this.root.className = 'hud-root';

    // 绑定赛道 seed 到 race 实例以加载历史成绩
    if (race !== null) {
      race.setSeed(seed);
    }

    // ── 1. 顶部计时与 Delta 面板 ──
    this.timingCard = document.createElement('div');
    this.timingCard.className = 'hud-card hud-timing-card';

    const timingHeader = document.createElement('div');
    timingHeader.className = 'hud-timing-header';

    this.lapBadge = document.createElement('span');
    this.lapBadge.className = 'hud-lap-badge';
    this.lapBadge.textContent = 'LAP 1';

    this.deltaBadge = document.createElement('span');
    this.deltaBadge.className = 'hud-delta-badge hud-delta-idle';
    this.deltaBadge.textContent = '—';

    timingHeader.append(this.lapBadge, this.deltaBadge);

    this.currentTime = document.createElement('div');
    this.currentTime.className = 'hud-current-time';
    this.currentTime.textContent = '00:00.00';

    const timingFooter = document.createElement('div');
    timingFooter.className = 'hud-timing-footer';

    const bestRow = document.createElement('div');
    bestRow.className = 'hud-record-row';
    const bestLabel = document.createElement('span');
    bestLabel.className = 'hud-record-label';
    bestLabel.textContent = 'BEST';
    this.bestTimeVal = document.createElement('span');
    this.bestTimeVal.className = 'hud-record-val hud-best-val';
    this.bestTimeVal.textContent = formatTime(race?.bestLapTime ?? 0);
    bestRow.append(bestLabel, this.bestTimeVal);

    const lastRow = document.createElement('div');
    lastRow.className = 'hud-record-row';
    const lastLabel = document.createElement('span');
    lastLabel.className = 'hud-record-label';
    lastLabel.textContent = 'LAST';
    this.lastTimeVal = document.createElement('span');
    this.lastTimeVal.className = 'hud-record-val';
    this.lastTimeVal.textContent = formatTime(race?.lastLapTime ?? 0);
    lastRow.append(lastLabel, this.lastTimeVal);

    timingFooter.append(bestRow, lastRow);
    this.timingCard.append(timingHeader, this.currentTime, timingFooter);

    // ── 2. 右上角程序化 SVG 小地图 ──
    this.minimapCard = document.createElement('div');
    this.minimapCard.className = 'hud-card hud-minimap-card';

    if (track !== null && track.samples.length > 0) {
      this.hasMap = true;
      const { svg, marker, centerX, centerZ, scale } = buildMinimapSvg(track.samples);
      this.minimapCard.append(svg);
      this.playerMarker = marker;
      this.trackCenterX = centerX;
      this.trackCenterZ = centerZ;
      this.mapScale = scale;
    } else {
      this.minimapCard.style.display = 'none';
    }

    // ── 3. 右下角时速表 ──
    const speedCard = document.createElement('div');
    speedCard.className = 'hud-card hud-speed-card';

    const speedValue = document.createElement('p');
    speedValue.className = 'readout-speed hud-speed-display';
    this.speedNum = document.createElement('span');
    this.speedNum.className = 'hud-speed-num';
    this.speedNum.textContent = '0';
    const speedUnit = document.createElement('span');
    speedUnit.className = 'hud-speed-unit';
    speedUnit.textContent = ' km/h';

    speedValue.append(this.speedNum, speedUnit);
    speedCard.append(speedValue);

    // ── 4. 左下角操作提示与构建号 ──
    const infoCard = document.createElement('div');
    infoCard.className = 'hud-info-card';

    const help = document.createElement('p');
    help.className = 'readout-help';
    help.textContent = 'W/S 油门倒车 · A/D 转向 · Space 空气刹 · Esc 暂停';

    // 试玩反馈靠构建号识别版本,必须保留在左下角
    const build = document.createElement('p');
    build.className = 'readout-build';
    build.textContent = __BUILD_ID__;

    infoCard.append(help, build);

    // 组装到 DOM 根节点
    this.root.append(this.timingCard, this.minimapCard, speedCard, infoCard);
    parent.append(this.root);
  }

  update(
    metersPerSecond: number,
    race: Race | null,
    vehiclePos?: VectorLike,
    vehicleYaw?: number,
  ): void {
    // 1. 速度更新
    const kmh = Math.round(metersPerSecond * 3.6);
    if (kmh !== this.lastShownKmh) {
      this.lastShownKmh = kmh;
      this.speedNum.textContent = String(kmh);
    }

    // 2. 计时与分段更新
    if (race !== null) {
      // 圈数
      const currentLap = race.laps + 1;
      if (currentLap !== this.lastShownLaps) {
        this.lastShownLaps = currentLap;
        this.lapBadge.textContent = `LAP ${currentLap}`;
      }

      // 当前圈时
      const lapTimeHundredths = Math.floor(race.lapTime * 100);
      if (lapTimeHundredths !== this.lastShownLapTimeHundredths) {
        this.lastShownLapTimeHundredths = lapTimeHundredths;
        this.currentTime.textContent = formatTime(race.lapTime);
      }

      // 最佳圈时
      const bestTimeHundredths = Math.floor(race.bestLapTime * 100);
      if (bestTimeHundredths !== this.lastShownBestTimeHundredths) {
        this.lastShownBestTimeHundredths = bestTimeHundredths;
        this.bestTimeVal.textContent = formatTime(race.bestLapTime);
      }

      // 上一圈用时
      const lastTimeHundredths = Math.floor(race.lastLapTime * 100);
      if (lastTimeHundredths !== this.lastShownLastTimeHundredths) {
        this.lastShownLastTimeHundredths = lastTimeHundredths;
        this.lastTimeVal.textContent = formatTime(race.lastLapTime);
      }

      /*
       * 分段 Delta。**先用整型脏检查,再格式化。**
       *
       * 原来是每帧先 `formatDelta()` 再比字符串 —— delta 显示的那几秒里每帧都在
       * 分配字符串。上面几项读数都是先比整数再格式化,这里跟齐。
       */
      if (race.delta !== null && race.deltaTimer > 0) {
        const deltaKey = Math.round(race.delta * 100);
        if (deltaKey !== this.lastShownDeltaKey) {
          this.lastShownDeltaKey = deltaKey;
          const isAhead = race.delta < 0;
          const isEqual = Math.abs(race.delta) < 0.005;
          const deltaStr = formatDelta(race.delta);
          const deltaClass: string = isEqual
            ? 'hud-delta-equal'
            : isAhead
              ? 'hud-delta-ahead'
              : 'hud-delta-behind';
          this.lastShownDeltaText = deltaStr;
          this.deltaBadge.textContent = `${isAhead ? '▼ ' : isEqual ? '· ' : '▲ '}${deltaStr}`;
          this.deltaBadge.className = `hud-delta-badge ${deltaClass} hud-delta-active`;
        }
      } else if (this.lastShownDeltaText !== '') {
        this.lastShownDeltaKey = Number.NaN;
        this.lastShownDeltaText = '';
        this.deltaBadge.textContent = '—';
        this.deltaBadge.className = 'hud-delta-badge hud-delta-idle';
      }
    }

    // 3. 小地图载具光标更新
    if (this.hasMap && this.playerMarker !== null && vehiclePos !== undefined) {
      const dx = vehiclePos.x - this.lastShownPlayerX;
      const dz = vehiclePos.z - this.lastShownPlayerZ;
      const yaw = vehicleYaw ?? 0;
      const dRot = Math.abs(yaw - this.lastShownPlayerRot);

      // 位移超 0.1m 或旋转超 0.5 度才刷新 DOM 变换
      if (dx * dx + dz * dz > 0.01 || dRot > 0.008) {
        this.lastShownPlayerX = vehiclePos.x;
        this.lastShownPlayerZ = vehiclePos.z;
        this.lastShownPlayerRot = yaw;

        const u = this.mapCenterX + (vehiclePos.x - this.trackCenterX) * this.mapScale;
        const v = this.mapCenterY + (vehiclePos.z - this.trackCenterZ) * this.mapScale;
        const angleDeg = Math.atan2(Math.sin(yaw), -Math.cos(yaw)) * (180 / Math.PI);

        this.playerMarker.setAttribute(
          'transform',
          `translate(${u.toFixed(1)}, ${v.toFixed(1)}) rotate(${angleDeg.toFixed(1)})`,
        );
      }
    }
  }

  dispose(): void {
    this.root.remove();
  }
}

/** 兼容老版导出命名。 */
export { Hud as Readout };

/** 时间格式化为 MM:SS.hh */
export function formatTime(seconds: number): string {
  if (seconds <= 0 || !Number.isFinite(seconds)) {
    return '--:--.--';
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const hundredths = Math.floor((seconds * 100) % 100);

  const m = mins < 10 ? `0${mins}` : String(mins);
  const s = secs < 10 ? `0${secs}` : String(secs);
  const h = hundredths < 10 ? `0${hundredths}` : String(hundredths);
  return `${m}:${s}.${h}`;
}

/** 分段 Delta 格式化为 ±S.hh s */
export function formatDelta(delta: number): string {
  const sign = delta > 0 ? '+' : delta < 0 ? '-' : '±';
  const abs = Math.abs(delta);
  const secs = Math.floor(abs);
  const hundredths = Math.floor((abs * 100) % 100);
  const h = hundredths < 10 ? `0${hundredths}` : String(hundredths);
  return `${sign}${secs}.${h}s`;
}

/** 由赛道采样点程序化生成 SVG 小地图。 */
function buildMinimapSvg(samples: readonly TrackSample[]): {
  svg: SVGSVGElement;
  marker: SVGElement;
  centerX: number;
  centerZ: number;
  scale: number;
} {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (const s of samples) {
    if (s.x < minX) minX = s.x;
    if (s.x > maxX) maxX = s.x;
    if (s.z < minZ) minZ = s.z;
    if (s.z > maxZ) maxZ = s.z;
  }

  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const spanX = Math.max(maxX - minX, 1);
  const spanZ = Math.max(maxZ - minZ, 1);
  const maxSpan = Math.max(spanX, spanZ);

  const size = MINIMAP_TUNING.viewBoxSize;
  const pad = size * MINIMAP_TUNING.paddingRatio;
  const drawSpan = size - pad * 2;
  const scale = drawSpan / maxSpan;
  const halfSize = size / 2;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('class', 'hud-minimap-svg');

  // 构建闭合赛道路径
  let pathD = '';
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    const u = halfSize + (s.x - centerX) * scale;
    const v = halfSize + (s.z - centerZ) * scale;
    pathD += (i === 0 ? 'M ' : ' L ') + `${u.toFixed(1)},${v.toFixed(1)}`;
  }
  pathD += ' Z';

  // 赛道底衬(发光描边)
  const pathBg = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  pathBg.setAttribute('d', pathD);
  pathBg.setAttribute('class', 'hud-map-path-bg');
  pathBg.setAttribute('fill', 'none');
  pathBg.setAttribute('stroke', MINIMAP_TUNING.trackBgColor);
  pathBg.setAttribute('stroke-width', String(MINIMAP_TUNING.trackBgWidth));
  pathBg.setAttribute('stroke-linejoin', 'round');
  pathBg.setAttribute('stroke-linecap', 'round');

  // 赛道主中心线
  const pathLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  pathLine.setAttribute('d', pathD);
  pathLine.setAttribute('class', 'hud-map-path-line');
  pathLine.setAttribute('fill', 'none');
  pathLine.setAttribute('stroke', MINIMAP_TUNING.trackLineColor);
  pathLine.setAttribute('stroke-width', String(MINIMAP_TUNING.trackLineWidth));
  pathLine.setAttribute('stroke-linejoin', 'round');
  pathLine.setAttribute('stroke-linecap', 'round');

  // 起跑线标记点
  const startSample = samples[0];
  const startCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  if (startSample !== undefined) {
    const su = halfSize + (startSample.x - centerX) * scale;
    const sv = halfSize + (startSample.z - centerZ) * scale;
    startCircle.setAttribute('cx', su.toFixed(1));
    startCircle.setAttribute('cy', sv.toFixed(1));
    startCircle.setAttribute('r', '4');
    startCircle.setAttribute('fill', MINIMAP_TUNING.startLineColor);
    startCircle.setAttribute('class', 'hud-map-start-node');
  }

  // 玩家光标组
  const markerGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  markerGroup.setAttribute('class', 'hud-map-player');

  const playerDot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  playerDot.setAttribute('cx', '0');
  playerDot.setAttribute('cy', '0');
  playerDot.setAttribute('r', String(MINIMAP_TUNING.playerDotRadius));
  playerDot.setAttribute('fill', MINIMAP_TUNING.playerColor);

  const playerPointer = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  // 朝向前方(SVG 中为 -Y 方向)
  playerPointer.setAttribute('points', '-3.5,2 0,-8 3.5,2');
  playerPointer.setAttribute('fill', MINIMAP_TUNING.trackLineColor);

  markerGroup.append(playerDot, playerPointer);

  svg.append(pathBg, pathLine, startCircle, markerGroup);

  return {
    svg,
    marker: markerGroup,
    centerX,
    centerZ,
    scale,
  };
}

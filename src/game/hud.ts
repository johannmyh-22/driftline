import type { Race } from './race';

/**
 * 最小读数条 —— **不是 HUD**。
 *
 * 真正的 HUD(分段 delta、小地图、菜单)属于 M4。这里只放让当前里程碑能被
 * 验收的最少信息:操作说明(不然没人知道按什么键)、速度(M1 要求「反馈请给
 * 具体数值方向」),以及 M2 加的圈数与圈时 —— 圈计时是 M2 的交付物,
 * 没有任何显示的话人类无法确认它在工作。M4 接手时整个删掉。
 */
export class Readout {
  private readonly root: HTMLDivElement;
  private readonly speed: HTMLSpanElement;
  private readonly timing: HTMLParagraphElement;
  private shown = -1;
  private shownTiming = '';

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'readout';

    const help = document.createElement('p');
    help.className = 'readout-help';
    help.textContent = 'W/S 油门倒车 · A/D 转向 · Space 空气刹';

    const value = document.createElement('p');
    value.className = 'readout-speed';
    this.speed = document.createElement('span');
    this.speed.textContent = '0';
    value.append(this.speed, document.createTextNode(' km/h'));

    this.timing = document.createElement('p');
    this.timing.className = 'readout-timing';

    // 试玩反馈要能对上具体哪一版,不然手感改动分辨不出新旧。
    const build = document.createElement('p');
    build.className = 'readout-build';
    build.textContent = __BUILD_ID__;

    this.root.append(this.timing, value, help, build);
    parent.append(this.root);
  }

  update(metersPerSecond: number, race: Race | null): void {
    const kmh = Math.round(metersPerSecond * 3.6);
    // DOM 写入比读取贵得多,数字没变就别碰它。
    if (kmh !== this.shown) {
      this.shown = kmh;
      this.speed.textContent = String(kmh);
    }

    const timing =
      race === null
        ? ''
        : `第 ${race.laps + 1} 圈 · ${formatTime(race.lapTime)}` +
          (race.bestLapTime > 0 ? ` · 最快 ${formatTime(race.bestLapTime)}` : '');
    if (timing !== this.shownTiming) {
      this.shownTiming = timing;
      this.timing.textContent = timing;
    }
  }

  dispose(): void {
    this.root.remove();
  }
}

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(2).padStart(5, '0')}`;
}

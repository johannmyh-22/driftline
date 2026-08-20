/**
 * M1 的最小读数条 —— **不是 HUD**。
 *
 * 真正的 HUD(圈时、delta、小地图)属于 M4。这里只放两样东西:
 * 操作说明(不然没人知道按什么键)和速度数字(验收要求「反馈请给具体
 * 数值方向」,没有读数就只能靠形容词)。M4 接手时整个删掉。
 */
export class Readout {
  private readonly root: HTMLDivElement;
  private readonly speed: HTMLSpanElement;
  private shown = -1;

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

    this.root.append(value, help);
    parent.append(this.root);
  }

  update(metersPerSecond: number): void {
    const kmh = Math.round(metersPerSecond * 3.6);
    // DOM 写入比读取贵得多,数字没变就别碰它。
    if (kmh !== this.shown) {
      this.shown = kmh;
      this.speed.textContent = String(kmh);
    }
  }

  dispose(): void {
    this.root.remove();
  }
}

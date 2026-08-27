/**
 * 暂停/设置菜单(M4)。DOM overlay,和 `Hud` 一样不往 canvas 里排文字。
 *
 * 按 Esc 打开/关闭,提供继续、重开本圈、换 seed 三个操作。**没有做成开局
 * 必须先点掉的启动画面**:实时模式的冒烟测试(`不带 test=1 时自行跑主循环`
 * 等,见 `tests/visual/smoke.spec.ts`)在页面 `painted` 之后立刻断言 `#readout`
 * 里能读到 `km/h`,零交互——加一块开局必须点掉的挡板会直接把这些测试和
 * 已经被人类看过、确认过的实时截图基准一起改掉。所以“开始/暂停/重开/seed
 * 输入框”这四件事在这一版里合成同一个 Esc 菜单:游戏照旧立刻可开,菜单只在
 * 玩家主动要暂停或换 seed 时才出现。**这是一个需要和人类核对的产品判断**,
 * 写在 docs/HANDOFF.md 里留给人类确认。
 */
import { CURATED_TRACKS } from './curatedTracks';

export interface MenuAudioState {
  volume: number;
  muted: boolean;
}

export class Menu {
  private readonly root: HTMLDivElement;
  private readonly seedInput: HTMLInputElement;
  private readonly volumeInput: HTMLInputElement;
  private readonly muteButton: HTMLButtonElement;
  private open = false;

  constructor(
    parent: HTMLElement,
    currentSeed: number,
    audio: MenuAudioState,
    callbacks: {
      onResume: () => void;
      onRestart: () => void;
      onChangeSeed: (seed: number) => void;
      onVolumeChange: (volume: number) => void;
      onToggleMute: () => void;
    },
  ) {
    this.root = document.createElement('div');
    this.root.id = 'menu-overlay';
    this.root.className = 'menu-overlay';
    this.root.hidden = true;

    const card = document.createElement('div');
    card.className = 'menu-card';

    const title = document.createElement('h1');
    title.className = 'menu-title';
    title.textContent = '已暂停';

    const resumeButton = document.createElement('button');
    resumeButton.type = 'button';
    resumeButton.className = 'menu-button menu-button-primary';
    resumeButton.textContent = '继续 (Esc)';
    resumeButton.addEventListener('click', () => callbacks.onResume());

    const restartButton = document.createElement('button');
    restartButton.type = 'button';
    restartButton.className = 'menu-button';
    restartButton.textContent = '重开本圈';
    restartButton.addEventListener('click', () => callbacks.onRestart());

    const seedRow = document.createElement('form');
    seedRow.className = 'menu-seed-row';

    const seedLabel = document.createElement('label');
    seedLabel.className = 'menu-seed-label';
    seedLabel.textContent = 'SEED';
    seedLabel.htmlFor = 'menu-seed-input';

    this.seedInput = document.createElement('input');
    this.seedInput.id = 'menu-seed-input';
    this.seedInput.type = 'number';
    this.seedInput.className = 'menu-seed-input';
    this.seedInput.value = String(currentSeed);
    this.seedInput.min = '0';
    this.seedInput.step = '1';

    const seedButton = document.createElement('button');
    seedButton.type = 'submit';
    seedButton.className = 'menu-button menu-button-small';
    seedButton.textContent = '换赛道';

    seedRow.addEventListener('submit', (event) => {
      event.preventDefault();
      const seed = Number.parseInt(this.seedInput.value, 10);
      if (Number.isFinite(seed) && seed >= 0) {
        callbacks.onChangeSeed(seed);
      }
    });

    seedRow.append(seedLabel, this.seedInput, seedButton);

    const curatedRow = document.createElement('div');
    curatedRow.className = 'menu-curated-row';
    for (const track of CURATED_TRACKS) {
      const trackButton = document.createElement('button');
      trackButton.type = 'button';
      trackButton.className = 'menu-button menu-button-small menu-curated-button';
      trackButton.textContent = track.name;
      trackButton.addEventListener('click', () => callbacks.onChangeSeed(track.seed));
      curatedRow.append(trackButton);
    }

    const volumeRow = document.createElement('div');
    volumeRow.className = 'menu-volume-row';

    const volumeLabel = document.createElement('label');
    volumeLabel.className = 'menu-seed-label';
    volumeLabel.textContent = '音量';
    volumeLabel.htmlFor = 'menu-volume-input';

    this.volumeInput = document.createElement('input');
    this.volumeInput.id = 'menu-volume-input';
    this.volumeInput.type = 'range';
    this.volumeInput.className = 'menu-volume-input';
    this.volumeInput.min = '0';
    this.volumeInput.max = '1';
    this.volumeInput.step = '0.01';
    this.volumeInput.value = String(audio.volume);
    this.volumeInput.addEventListener('input', () => {
      const volume = Number.parseFloat(this.volumeInput.value);
      if (Number.isFinite(volume)) {
        callbacks.onVolumeChange(volume);
      }
    });

    this.muteButton = document.createElement('button');
    this.muteButton.type = 'button';
    this.muteButton.className = 'menu-button menu-button-small';
    this.muteButton.textContent = audio.muted ? '取消静音' : '静音';
    this.muteButton.addEventListener('click', () => callbacks.onToggleMute());

    volumeRow.append(volumeLabel, this.volumeInput, this.muteButton);

    const help = document.createElement('p');
    help.className = 'menu-help';
    help.textContent = 'W/S 油门倒车 · A/D 转向 · Space 空气刹 · Esc 暂停';

    const curatedLabel = document.createElement('p');
    curatedLabel.className = 'menu-curated-label';
    curatedLabel.textContent = '精选赛道';

    card.append(title, resumeButton, restartButton, seedRow, curatedLabel, curatedRow, volumeRow, help);
    this.root.append(card);
    parent.append(this.root);
  }

  show(): void {
    this.open = true;
    this.root.hidden = false;
  }

  hide(): void {
    this.open = false;
    this.root.hidden = true;
  }

  toggle(): void {
    if (this.open) {
      this.hide();
    } else {
      this.show();
    }
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** 静音按钮的文案是「取消静音」还是「静音」由外部状态决定,主循环切换后同步一次。 */
  setMuted(muted: boolean): void {
    this.muteButton.textContent = muted ? '取消静音' : '静音';
  }

  dispose(): void {
    this.root.remove();
  }
}

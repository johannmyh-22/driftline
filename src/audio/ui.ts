import { AUDIO } from '../game/tuning';
import type { AudioBus } from './context';

/**
 * UI 音:菜单按钮点击的短促方波脉冲。事件驱动,同 `impact.ts` 的用完即扔。
 */
export function playUiClick(bus: AudioBus): void {
  const context = bus.context;
  const now = context.currentTime;

  const osc = context.createOscillator();
  osc.type = 'square';
  osc.frequency.value = AUDIO.uiClickFreq;

  const gain = context.createGain();
  gain.gain.setValueAtTime(AUDIO.uiClickGain, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + AUDIO.uiClickDuration);

  osc.connect(gain);
  gain.connect(bus.master);

  osc.start(now);
  osc.stop(now + AUDIO.uiClickDuration + 0.01);
  osc.addEventListener('ended', () => {
    osc.disconnect();
    gain.disconnect();
  });
}

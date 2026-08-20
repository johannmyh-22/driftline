import { describe, expect, it } from 'vitest';
import {
  InputRecorder,
  KeyboardInput,
  RecordedInput,
  ScriptedInput,
  createInputFrame,
} from '../../src/core/input';

function press(target: EventTarget, code: string): void {
  const event = new Event('keydown') as Event & { code: string };
  event.code = code;
  target.dispatchEvent(event);
}

function release(target: EventTarget, code: string): void {
  const event = new Event('keyup') as Event & { code: string };
  event.code = code;
  target.dispatchEvent(event);
}

describe('KeyboardInput', () => {
  it('把按键映射成归一化的操作意图', () => {
    const target = new EventTarget();
    const input = new KeyboardInput(target);
    const frame = createInputFrame();

    press(target, 'KeyW');
    press(target, 'KeyD');
    input.sample(frame);
    expect(frame).toEqual({ throttle: 1, reverse: 0, steer: 1, airBrake: 0 });

    release(target, 'KeyD');
    press(target, 'KeyA');
    input.sample(frame);
    expect(frame.steer).toBe(-1);

    input.dispose();
  });

  it('左右同时按下时互相抵消', () => {
    const target = new EventTarget();
    const input = new KeyboardInput(target);
    const frame = createInputFrame();

    press(target, 'KeyA');
    press(target, 'KeyD');
    input.sample(frame);
    expect(frame.steer).toBe(0);

    input.dispose();
  });

  it('方向键与 WASD 等价', () => {
    const target = new EventTarget();
    const input = new KeyboardInput(target);
    const frame = createInputFrame();

    press(target, 'ArrowUp');
    press(target, 'ArrowLeft');
    input.sample(frame);
    expect(frame.throttle).toBe(1);
    expect(frame.steer).toBe(-1);

    input.dispose();
  });

  it('失焦时清空按键 —— 否则切回标签页油门会粘住', () => {
    const target = new EventTarget();
    const input = new KeyboardInput(target);
    const frame = createInputFrame();

    press(target, 'KeyW');
    target.dispatchEvent(new Event('blur'));
    input.sample(frame);
    expect(frame.throttle).toBe(0);

    input.dispose();
  });

  it('dispose 之后不再响应', () => {
    const target = new EventTarget();
    const input = new KeyboardInput(target);
    const frame = createInputFrame();

    input.dispose();
    press(target, 'KeyW');
    input.sample(frame);
    expect(frame.throttle).toBe(0);
  });
});

describe('ScriptedInput', () => {
  it('保持设定值直到下次修改,并截断到合法范围', () => {
    const input = new ScriptedInput();
    const frame = createInputFrame();

    input.set({ throttle: 3, steer: -9 });
    input.sample(frame);
    expect(frame.throttle).toBe(1);
    expect(frame.steer).toBe(-1);

    input.sample(frame);
    expect(frame.throttle).toBe(1);

    input.reset();
    input.sample(frame);
    expect(frame).toEqual({ throttle: 0, reverse: 0, steer: 0, airBrake: 0 });
  });
});

describe('InputRecorder / RecordedInput', () => {
  it('record 会就地量化输入,让实时与回放吃到同一串数字', () => {
    const recorder = new InputRecorder();
    const frame = createInputFrame();
    frame.steer = 0.5;
    recorder.record(frame);

    // 0.5 * 127 = 63.5 → 64,回读是 64/127,不再是 0.5。
    expect(frame.steer).not.toBe(0.5);
    expect(frame.steer).toBeCloseTo(0.5, 2);

    const playback = new RecordedInput(recorder.toRecording());
    const read = createInputFrame();
    playback.sample(read);
    expect(read.steer).toBe(frame.steer);
  });

  it('录制再回放,逐帧还原(量化误差在 1/127 以内)', () => {
    const recorder = new InputRecorder();
    const written = createInputFrame();

    const script = [
      { throttle: 1, reverse: 0, steer: 0, airBrake: 0 },
      { throttle: 1, reverse: 0, steer: -0.5, airBrake: 0 },
      { throttle: 0, reverse: 0.25, steer: 1, airBrake: 1 },
      { throttle: 0, reverse: 0, steer: 0, airBrake: 0 },
    ];

    for (const entry of script) {
      Object.assign(written, entry);
      recorder.record(written);
    }
    expect(recorder.length).toBe(script.length);

    const playback = new RecordedInput(recorder.toRecording());
    const read = createInputFrame();
    for (const entry of script) {
      playback.sample(read);
      expect(read.throttle).toBeCloseTo(entry.throttle, 2);
      expect(read.reverse).toBeCloseTo(entry.reverse, 2);
      expect(read.steer).toBeCloseTo(entry.steer, 2);
      expect(read.airBrake).toBeCloseTo(entry.airBrake, 2);
    }
  });

  it('放完之后输出全零,而不是回绕重播', () => {
    const recorder = new InputRecorder();
    const frame = createInputFrame();
    frame.throttle = 1;
    recorder.record(frame);

    const playback = new RecordedInput(recorder.toRecording());
    playback.sample(frame);
    expect(playback.finished).toBe(true);

    playback.sample(frame);
    expect(frame.throttle).toBe(0);

    playback.rewind();
    playback.sample(frame);
    expect(frame.throttle).toBeCloseTo(1, 2);
  });

  it('拒绝长度不对齐的回放数据', () => {
    expect(() => new RecordedInput(Int8Array.from([1, 2, 3]))).toThrow(RangeError);
  });
});

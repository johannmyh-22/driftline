import { describe, expect, it } from 'vitest';
import { RaceProgress, Standings } from '../../src/game/standings';

const LENGTH = 1000;

describe('RaceProgress', () => {
  it('第一帧只记录起点,不产生位移', () => {
    const p = new RaceProgress(LENGTH);
    p.update(300);
    expect(p.distance).toBe(0);
  });

  it('沿赛道前进按弧长差累加', () => {
    const p = new RaceProgress(LENGTH);
    p.update(0);
    p.update(10);
    p.update(35);
    expect(p.distance).toBeCloseTo(35, 6);
  });

  /*
   * 这条是这个模块存在的理由。用 `laps × 圈长 + arc` 的话,跨线那一两帧
   * `arc` 已经绕回 0 而 `laps` 还没 +1,总距离会凭空少一整圈,名次当场闪一下。
   * 增量法根本不看 laps,所以不存在这个窗口。
   */
  it('跨过起跑线时距离连续,不会掉一整圈', () => {
    const p = new RaceProgress(LENGTH);
    // 单帧位移必须小于半圈,否则和「倒车跨线」无从区分——见下面那条专门的测试。
    for (const arc of [0, 300, 600, 900, 995]) {
      p.update(arc);
    }
    const before = p.distance;
    expect(before).toBeCloseTo(995, 6);
    p.update(3); // arc 绕回 0 附近
    expect(p.distance).toBeGreaterThan(before);
    expect(p.distance).toBeCloseTo(1003, 6);
  });

  it('倒车跨过起跑线记成后退,不会被当成跑完一圈', () => {
    const p = new RaceProgress(LENGTH);
    // 先正常跑过起跑线(累计 1100),再倒着退回线的另一侧。
    for (const arc of [0, 400, 800, 100]) {
      p.update(arc);
    }
    expect(p.distance).toBeCloseTo(1100, 6);
    p.update(995); // 倒退 105 米,跨回上一圈
    expect(p.distance).toBeCloseTo(995, 6);
    expect(p.laps).toBe(0);
  });

  it('距离不会变成负数——没人能比起跑线更靠后', () => {
    const p = new RaceProgress(LENGTH);
    p.update(10);
    p.update(0);
    p.update(990);
    expect(p.distance).toBeGreaterThanOrEqual(0);
  });

  it('laps 由累计距离推出来,跑满一圈才 +1', () => {
    const p = new RaceProgress(LENGTH);
    for (const arc of [0, 400, 800, 999]) {
      p.update(arc);
    }
    expect(p.laps).toBe(0);
    p.update(5); // 累计 1005
    expect(p.laps).toBe(1);
  });

  /*
   * 增量法成立的前提:单帧位移小于半圈。60Hz 下即使 250 km/h 也只跑 1.2 米,
   * 而最短的赛道也有上千米,余量是三个数量级——把这个前提写下来,免得以后有人
   * 把它当成 bug 去"修"。
   */
  it('单帧跳变超过半圈时按跨线处理(增量法的前提)', () => {
    const p = new RaceProgress(LENGTH);
    p.update(0);
    p.update(900); // 超过半圈:判定为倒退 100 米,而不是前进 900 米
    expect(p.distance).toBe(0); // 被 max(0, …) 夹住
  });

  it('reset 把发车位折成相对起跑线的带符号进度,不是一律清零', () => {
    const p = new RaceProgress(LENGTH);
    p.update(0);
    p.update(400);
    // 弧长 700 = 起跑线**后方** 300 米(而不是领先 700 米),折进 (−半圈, 半圈]。
    p.reset(700);
    expect(p.distance).toBeCloseTo(-300, 6);
    p.update(710);
    expect(p.distance).toBeCloseTo(-290, 6);
  });

  it('起跑线前方的发车位保持正值', () => {
    const p = new RaceProgress(LENGTH);
    p.reset(120);
    expect(p.distance).toBeCloseTo(120, 6);
  });

  it('不会退到自己的发车位之前', () => {
    const p = new RaceProgress(LENGTH);
    p.reset(980); // 线后 20 米
    p.update(970);
    p.update(960);
    expect(p.distance).toBeCloseTo(-20, 6);
  });

  it('忽略非有限的弧长,不污染累计值', () => {
    const p = new RaceProgress(LENGTH);
    p.update(0);
    p.update(50);
    p.update(Number.NaN);
    expect(p.distance).toBeCloseTo(50, 6);
    p.update(60);
    expect(p.distance).toBeCloseTo(60, 6);
  });
});

describe('Standings', () => {
  function drive(s: Standings, arcs: number[][]): void {
    for (const frame of arcs) {
      for (let i = 0; i < frame.length; i++) {
        s.setArc(i, frame[i] ?? 0);
      }
      s.update();
    }
  }

  it('跑得远的排前面,名次从 1 开始', () => {
    const s = new Standings(['player', 'rival'], LENGTH);
    drive(s, [
      [0, 0],
      [120, 40],
    ]);
    expect(s.rowOf('player')?.position).toBe(1);
    expect(s.rowOf('rival')?.position).toBe(2);
    expect(s.order[0]?.id).toBe('player');
  });

  it('被超车之后名次会翻过来', () => {
    const s = new Standings(['player', 'rival'], LENGTH);
    drive(s, [
      [0, 0],
      [120, 40],
      [130, 300],
    ]);
    expect(s.rowOf('player')?.position).toBe(2);
    expect(s.rowOf('rival')?.position).toBe(1);
  });

  it('差距按米算:领跑者为 0,后车是和前车的距离差', () => {
    const s = new Standings(['player', 'rival'], LENGTH);
    drive(s, [
      [0, 0],
      [200, 50],
    ]);
    const player = s.rowOf('player');
    const rival = s.rowOf('rival');
    expect(player?.gapToLeader).toBeCloseTo(0, 6);
    expect(player?.gapToAhead).toBeCloseTo(0, 6);
    expect(rival?.gapToLeader).toBeCloseTo(150, 6);
    expect(rival?.gapToAhead).toBeCloseTo(150, 6);
  });

  it('套圈之后仍然按总里程排,不会因为 arc 小就被判在后面', () => {
    const s = new Standings(['player', 'rival'], LENGTH);
    // player 跑完一圈多一点(arc 绕回 30),rival 还在第一圈的 800 米处。
    drive(s, [
      [0, 0],
      [300, 250],
      [600, 500],
      [900, 700],
      [30, 800],
    ]);
    const player = s.rowOf('player');
    const rival = s.rowOf('rival');
    expect(player?.laps).toBe(1);
    expect(player?.position).toBe(1);
    expect(rival?.position).toBe(2);
    expect(rival?.gapToLeader).toBeCloseTo(230, 6);
  });

  it('三辆车时中间那辆的 gapToAhead 是和第二名的差,不是和领跑者', () => {
    const s = new Standings(['a', 'b', 'c'], LENGTH);
    drive(s, [
      [0, 0, 0],
      [300, 200, 50],
    ]);
    const b = s.rowOf('b');
    expect(b?.position).toBe(2);
    expect(b?.gapToAhead).toBeCloseTo(100, 6);
    expect(b?.gapToLeader).toBeCloseTo(100, 6);
    const c = s.rowOf('c');
    expect(c?.position).toBe(3);
    expect(c?.gapToAhead).toBeCloseTo(150, 6);
    expect(c?.gapToLeader).toBeCloseTo(250, 6);
  });

  it('reset 把所有车清回起跑线并重排', () => {
    const s = new Standings(['player', 'rival'], LENGTH);
    drive(s, [
      [0, 0],
      [400, 100],
    ]);
    /*
     * 这就是 world.ts 里真实的发车布局:玩家在起跑线(弧长 0),对手在线后
     * 20 米(弧长 = 圈长 − 20)。这条测试是拿截图快照核对时补上的——当时对手
     * 明明在后面,名次却显示玩家 P2,根因就是把「跑了多远」当成了「在赛道上
     * 的位置」,发车位不同就会错。
     */
    s.reset([0, LENGTH - 20]);
    expect(s.rowOf('player')?.distance).toBeCloseTo(0, 6);
    expect(s.rowOf('rival')?.distance).toBeCloseTo(-20, 6);
    expect(s.rowOf('player')?.position).toBe(1);
    expect(s.rowOf('rival')?.position).toBe(2);
    expect(s.rowOf('rival')?.gapToAhead).toBeCloseTo(20, 6);

    // 两辆车各前进 10 米,名次和差距都不该变。
    s.setArc(0, 10);
    s.setArc(1, LENGTH - 10);
    s.update();
    expect(s.rowOf('player')?.position).toBe(1);
    expect(s.rowOf('rival')?.gapToAhead).toBeCloseTo(20, 6);
  });

  it('每帧不新建行对象——order/rows 共享同一批实例', () => {
    const s = new Standings(['player', 'rival'], LENGTH);
    const before = s.rowOf('player');
    drive(s, [
      [0, 0],
      [100, 500],
      [900, 600],
    ]);
    expect(s.rowOf('player')).toBe(before);
    expect(s.order).toContain(before);
  });
});

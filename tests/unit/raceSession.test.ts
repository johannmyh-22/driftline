import { describe, expect, it } from 'vitest';
import { RaceSession } from '../../src/game/raceSession';
import { Standings } from '../../src/game/standings';
import { RACE_FORMAT } from '../../src/game/tuning';

const LENGTH = 1000;
const DT = 1 / 60;

function makeStandings(): Standings {
  const s = new Standings(['player', 'rival'], LENGTH);
  s.reset([0, 0]);
  return s;
}

/** 把两辆车分别推进到指定的累计里程。每步小于半圈,满足增量法的前提。 */
function advanceTo(standings: Standings, targets: number[]): void {
  const step = LENGTH * 0.25;
  let done = false;
  const current = [0, 0];
  while (!done) {
    done = true;
    for (let i = 0; i < targets.length; i++) {
      const goal = targets[i] ?? 0;
      if (current[i]! < goal) {
        current[i] = Math.min(goal, current[i]! + step);
        done = false;
      }
      standings.setArc(i, current[i]! % LENGTH);
    }
    standings.update();
  }
}

describe('RaceSession 发车', () => {
  it('默认从倒计时开始,期间输入被锁住', () => {
    const session = new RaceSession();
    session.begin();
    expect(session.phase).toBe('countdown');
    expect(session.inputLocked).toBe(true);
  });

  it('倒计时走完自动进入比赛,输入解锁', () => {
    const session = new RaceSession();
    session.begin();
    const standings = makeStandings();
    for (let t = 0; t < RACE_FORMAT.countdownSeconds + 0.1; t += DT) {
      session.update(DT, standings);
    }
    expect(session.phase).toBe('running');
    expect(session.inputLocked).toBe(false);
  });

  it('倒计时期间比赛用时不走 —— 站着不动不该扣时间', () => {
    const session = new RaceSession();
    session.begin();
    const standings = makeStandings();
    for (let i = 0; i < 60; i++) {
      session.update(DT, standings);
    }
    expect(session.elapsed).toBe(0);
  });

  it('skipCountdown 直接开赛 —— 截图回路不能把前 180 帧耗在倒计时上', () => {
    const session = new RaceSession();
    session.begin({ skipCountdown: true });
    expect(session.phase).toBe('running');
    expect(session.countdown).toBe(0);
    expect(session.inputLocked).toBe(false);
  });
});

describe('RaceSession 完赛', () => {
  function running(): { session: RaceSession; standings: Standings } {
    const session = new RaceSession(2);
    session.begin({ skipCountdown: true });
    return { session, standings: makeStandings() };
  }

  it('跑满圈数才算完赛,差一点点不算', () => {
    const { session, standings } = running();
    advanceTo(standings, [LENGTH * 2 - 50, 0]);
    session.update(DT, standings);
    expect(session.hasFinished('player')).toBe(false);

    advanceTo(standings, [LENGTH * 2 + 10, 0]);
    session.update(DT, standings);
    expect(session.hasFinished('player')).toBe(true);
  });

  it('先冲线的拿 P1,后冲线的拿 P2', () => {
    const { session, standings } = running();
    advanceTo(standings, [0, LENGTH * 2 + 10]);
    session.update(DT, standings);
    advanceTo(standings, [LENGTH * 2 + 10, LENGTH * 2 + 20]);
    session.update(DT, standings);

    expect(session.resultOf('rival')?.position).toBe(1);
    expect(session.resultOf('player')?.position).toBe(2);
  });

  it('所有车完赛后进入 finished,输入锁住', () => {
    const { session, standings } = running();
    advanceTo(standings, [LENGTH * 2 + 10, LENGTH * 2 + 10]);
    session.update(DT, standings);
    expect(session.phase).toBe('finished');
    expect(session.inputLocked).toBe(true);
    expect(session.results).toHaveLength(2);
  });

  it('冠军冲线后超过宽限时间就强制结算,没冲线的记 DNF(time = 0)', () => {
    const { session, standings } = running();
    advanceTo(standings, [LENGTH * 2 + 10, LENGTH * 0.3]);
    session.update(DT, standings);
    expect(session.phase).toBe('running');

    // 只推时间,对手原地不动(被撞坏爬不回来的情形)。
    for (let t = 0; t < RACE_FORMAT.finishGrace + 0.2; t += DT) {
      session.update(DT, standings);
    }
    expect(session.phase).toBe('finished');
    expect(session.resultOf('player')?.time).toBeGreaterThan(0);
    // 没冲线的车也要有名次,不能从结算画面里凭空消失。
    expect(session.resultOf('rival')?.position).toBe(2);
    expect(session.resultOf('rival')?.time).toBe(0);
  });

  it('完赛之后不会被重复记录', () => {
    const { session, standings } = running();
    advanceTo(standings, [LENGTH * 2 + 10, 0]);
    for (let i = 0; i < 30; i++) {
      session.update(DT, standings);
    }
    expect(session.results.filter((r) => r.id === 'player')).toHaveLength(1);
  });

  it('begin 重开会清空上一局的结果', () => {
    const { session, standings } = running();
    advanceTo(standings, [LENGTH * 2 + 10, LENGTH * 2 + 10]);
    session.update(DT, standings);
    expect(session.results.length).toBe(2);

    session.begin({ skipCountdown: true });
    expect(session.results).toHaveLength(0);
    expect(session.phase).toBe('running');
    expect(session.elapsed).toBe(0);
  });

  it('圈数至少为 1,传 0 或负数不会变成一开赛就结束', () => {
    expect(new RaceSession(0).totalLaps).toBe(1);
    expect(new RaceSession(-3).totalLaps).toBe(1);
  });
});

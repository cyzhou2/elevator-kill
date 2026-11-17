/* AI：小孩（孤立、逃跑为主）与杀人犯（共享频道、围猎）
 *
 * v6 升级（"更像人"，不是超人类）：
 *  - 小孩不再全知：只记得「自己最近在哪儿看见过杀人犯」，形成一个会衰减的危险区；
 *  - 小孩换层要"认准"：目标锁定几秒，到了先歇一会儿再重新决定；
 *  - 杀人犯扫楼按楼层序列推进，查过的层短期不重复；
 *  - 杀人犯坐电梯发现方向不对，下一站就下车改走楼梯。
 */
(function () {
  const EK = (globalThis.EK = globalThis.EK || {});
  const U = EK.util;
  const P = EK.Perception;

  const ai = (world) => world.cfg.ai || {};
  const num = (world, key, dflt) => {
    const v = ai(world)[key];
    return v == null ? dflt : v;
  };

  function nearestThreat(world, a, seen) {
    let best = null;
    for (const k of seen) {
      const d = world.sameSpaceDist(a, k);
      const dd = isFinite(d) ? d : 99;
      if (!best || dd < best.d) best = { actor: k, d: dd };
    }
    return best;
  }

  /** 小孩只在"看见"时才记住杀人犯的位置，会随时间淡忘 */
  function rememberThreat(world, a, seen) {
    if (!seen.length) return;
    const k = seen[0];
    const sp = P.spaceOf(world, k);
    const floor = sp.floor != null ? sp.floor : a.location.floor;
    a.threatMem = { floor, x: sp.x != null ? sp.x : world.building.L / 2, t: world.time };
  }

  /** 目标层在记忆危险区里的"烫度"：0 = 安全，1 = 刚看见 */
  function memHot(world, a, floor) {
    const m = a.threatMem;
    if (!m) return 0;
    const age = world.time - m.t;
    const ttl = num(world, 'kidMemorySec', 8);
    if (age > ttl) return 0;
    if (Math.abs(floor - m.floor) > num(world, 'kidDangerRadius', 1)) return 0;
    return 1 - age / ttl;
  }

  /** 躲去哪一层：只用自己的记忆 + 一点随机，不看杀人犯的真实位置 */
  function safeFloor(world, a) {
    const floors = world.cfg.floors;
    const here = a.location.floor;
    const m = a.threatMem;
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < 10; i++) {
      const f = 1 + Math.floor(Math.random() * floors);
      if (Math.abs(f - here) < 2) continue;
      let score = Math.random() * 3;
      score -= memHot(world, a, f) * 8;                       // 记忆里的危险区，别去
      if (m) score += Math.min(Math.abs(f - m.floor), 10) * 1.2;  // 离上次见到的地方越远越好
      if (score > bestScore) { bestScore = score; best = f; }
    }
    return best == null ? here : best;
  }

  const ChildAI = {
    update(world, a, dt) {
      a.aiTimer -= dt;
      const seen = P.visibleActors(world, a).filter((o) => o.kind === 'killer');
      if (seen.length) rememberThreat(world, a, seen);
      const threat = nearestThreat(world, a, seen);

      if (threat && threat.d <= world.cfg.kid.dangerM) {
        // 反应时间：刚看到威胁还要愣一下才跑
        if (a.threatAt == null) a.threatAt = world.time;
        const delay = a.reactionSec != null ? a.reactionSec : (world.cfg.kid.reactionSec || 0);
        if (world.time - a.threatAt < delay) return;
        a.goal = null;
        return flee(world, a, threat);
      }
      a.threatAt = null;

      if (a.location.type !== 'floor') return;

      if (a.nav) {
        if (a.nav.phase === 'wait' && seen.length && seen.some((k) => world.sameSpaceDist(a, k) < 7)) {
          a.boardRequest = false;
          a.nav = null;
          a.goal = null;
          a.aiTimer = 0.1;
        }
        return;
      }

      // 认准这一层：没到之前不反复改主意
      if (a.goal != null) {
        if (a.location.floor === a.goal) {
          a.goal = null;
          a.restUntil = world.time + num(world, 'kidRestSec', 2);
          a.aiState = 'rest';
          a.moveTarget = null;
          return;
        }
        if (world.time < (a.goalUntil || 0)) {
          world.navTo(a, a.goal);
          return;
        }
        a.goal = null;         // 超时了，重新想
      }

      // 到站先歇一会儿（人不会像机器一样立刻掉头）
      if (world.time < (a.restUntil || 0)) { a.moveTarget = null; return; }
      if (a.aiTimer > 0) return;
      a.aiTimer = 0.5 + Math.random() * 0.5;

      // 假动作：在电梯厅按一下呼梯然后走人，给杀人犯留一个「电梯停过这里」的假线索
      const bait = num(world, 'kidBait', 0);
      const baitCd = num(world, 'kidBaitCooldown', 40);
      if (bait > 0 && !seen.length && world.building.inLobby(a.location.x)
          && world.time > (a.baitCd || 0) && Math.random() < bait) {
        world.pressHallAt(a.location.floor, Math.random() < 0.5 ? 1 : -1, a.location.x);
        world.log(`${a.name} 按了呼梯却没等梯`, 'ai', a.location.floor);
        a.baitCd = world.time + baitCd;
      }

      // 这层在记忆的危险区里，或者单纯想换个地方
      const hotHere = memHot(world, a, a.location.floor) > 0;
      if (hotHere || Math.random() < 0.25) {
        const target = safeFloor(world, a);
        if (target !== a.location.floor) {
          a.goal = target;
          a.goalUntil = world.time + num(world, 'kidCommitSec', 4);
          world.navTo(a, target);
          a.aiState = 'travel';
          return;
        }
      }

      // 在本层晃：尽量离记忆里的位置远一点
      const b = world.building;
      let tx = U.rnd(1.2, b.L - 1.2);
      if (a.threatMem && world.time - a.threatMem.t < num(world, 'kidMemorySec', 8)) {
        tx = a.threatMem.x < b.L / 2 ? U.rnd(b.L * 0.55, b.L - 1.2) : U.rnd(1.2, b.L * 0.45);
      }
      a.moveTarget = tx;
      a.aiState = 'wander';
    },

    inCar(world, a, car, dt) {
      if (car.doorsOpen && world.killersInCar(car).length > 0) { world.exitCar(a, car); return; }
      if (a.carTargetFloor != null) return;
      const f = a.goal != null ? a.goal : safeFloor(world, a);
      a.carTargetFloor = f;
      world.pressCarFloor(a, car, f);
    }
  };

  function flee(world, a, threat) {
    const b = world.building;
    a.boardRequest = false;
    a.nav = null;              // 被追时放弃原计划
    a.aiTimer = 0.12;
    a.aiState = 'flee';
    const sp = P.spaceOf(world, threat.actor);
    const x = a.location.x;

    if (sp.floor !== a.location.floor) { a.moveTarget = b.L / 2; return; }

    // 威胁在电梯厅：往更远的一侧楼梯口跑
    const awayLeft = sp.x >= x;
    const landing = awayLeft ? 'A' : 'B';
    const tx = b.landingX(landing);

    if (Math.abs(x - tx) < 1.1) {
      const dir = Math.random() < 0.5 ? 1 : -1;
      const f = b.stairFlight(a.location.floor, landing, dir) ||
                b.stairFlight(a.location.floor, landing, -dir);
      if (f) { world.takeStairs(a, f); return; }
    }
    a.moveTarget = tx;
  }

  /** 扫楼的下一层：沿当前方向跨几层，跳过最近查过的 */
  function nextSweepFloor(world, a) {
    const floors = world.cfg.floors;
    const span = num(world, 'killerSweepSpan', 3);
    const cooldown = num(world, 'killerCheckedSec', 25);
    a.checked = a.checked || {};
    if (a.patrolDir == null) a.patrolDir = Math.random() < 0.5 ? 1 : -1;
    let base = a.patrolFloor != null ? a.patrolFloor : Math.round(a.location.floor);
    for (let tries = 0; tries < 4; tries++) {
      let next = base + a.patrolDir * span;
      if (next > floors) { a.patrolDir = -1; next = floors - 1; }
      if (next < 1) { a.patrolDir = 1; next = 2; }
      next = U.clamp(next, 1, floors);
      const t = a.checked[next];
      if (!t || world.time - t > cooldown) return next;
      base = next;
    }
    return 1 + Math.floor(Math.random() * floors);
  }

  const KillerAI = {
    update(world, a, dt) {
      const seen = P.visibleActors(world, a).filter((o) => o.kind === 'kid');
      if (seen.length && !a.nav) {
        const kid = seen.sort((p, q) => world.sameSpaceDist(a, p) - world.sameSpaceDist(a, q))[0];
        const sp = P.spaceOf(world, kid);
        if (sp.kind === 'floor' && sp.floor === a.location.floor) {
          a.moveTarget = sp.x;
          a.aiState = 'chase';
          a.aiTimer = 0.2;
          return;
        }
        if (sp.kind === 'car') {
          const car = world.elev.get(sp.carId);
          if (car && Math.abs(car.floor - a.location.floor) < 0.05) {
            const doorX = world.carDoorX(car.id);
            a.moveTarget = doorX;
            if (car.doorsOpen && Math.abs(a.location.x - doorX) <= world.cfg.elevator.doorZoneM) {
              a.boardRequest = true;      // 跟进轿厢
            }
            a.aiState = 'chase';
            return;
          }
        }
        if (sp.kind === 'stair' && kid.location.fromFloor === a.location.floor) {
          const flight = { stair: kid.location.stair, from: { floor: kid.location.fromFloor, landing: kid.location.fromLanding },
                           to: { floor: kid.location.toFloor, landing: kid.location.toLanding }, dir: kid.location.dir };
          if (Math.abs(a.location.x - world.building.landingX(kid.location.fromLanding)) < 2.5) {
            world.takeStairs(a, flight);
            return;
          }
        }
      }

      a.aiTimer -= dt;
      if (a.aiTimer > 0) return;
      if (a.nav) return;
      a.aiTimer = 0.3;

      const intel = world.channel.filter((e) => world.time - e.t < world.cfg.channel.ttlSec);
      const curFloor = a.location.floor;

      if (intel.length) {
        const same = intel.filter((e) => e.floor === curFloor);
        const tgt = (same.length ? same : intel).sort((p, q) => q.t - p.t)[0];
        a.aiState = 'hunt';
        if (tgt.floor === curFloor) a.moveTarget = tgt.x;
        else world.navTo(a, tgt.floor);
        return;
      }

      // 电梯线索：站在电梯厅读到某部梯停在别的楼层 → 那里可能刚有人下梯
      const clueUse = ai(world).clueUse !== false;
      if (clueUse && P.canReadPanel(world, a)) {
        for (const car of world.elev.cars) {
          const parked = car.dir === 0 && (car.state === 'idle' || car.state === 'open');
          const f = Math.round(car.floor);
          if (!parked || Math.abs(car.floor - f) > 0.05) continue;
          if (f === curFloor || a.clueDone === f) continue;
          if (!a.clue || a.clue.floor !== f) a.clue = { floor: f, t: world.time };
        }
      }

      // 没有情报：按楼层序列扫楼
      if (a.patrolFloor == null) a.patrolFloor = Math.round(a.location.floor);
      a.aiState = 'patrol';
      if (a.clue && world.time - a.clue.t < (ai(world).clueTtl || 15)) {
        if (a.location.floor === a.clue.floor) {
          a.clueDone = a.clue.floor;      // 查过了
          a.clue = null;
        } else {
          a.patrolFloor = a.clue.floor;
          a.aiState = 'clue';
        }
      }
      if (a.location.floor !== a.patrolFloor || a.location.type === 'car') {
        world.navTo(a, a.patrolFloor);
        return;
      }
      // 站到了目标层：记下"查过"
      a.checked = a.checked || {};
      a.checked[a.location.floor] = world.time;

      const b = world.building;
      const spots = [world.carDoorX('C'), world.carDoorX('D'), b.landingX('A'), b.landingX('B')];
      if (a.patrolSpot == null) a.patrolSpot = 0;
      const spot = spots[a.patrolSpot % spots.length];
      if (Math.abs(a.location.x - spot) > 0.8) { a.moveTarget = spot; return; }
      a.patrolSat = (a.patrolSat || 0) + 1;
      a.moveTarget = null;
      if (a.patrolSat >= 2) {
        a.patrolSat = 0;
        a.patrolSpot++;
        a.patrolFloor = nextSweepFloor(world, a);
      }
    },

    inCar(world, a, car, dt) {
      const intel = world.channel.filter((e) => world.time - e.t < world.cfg.channel.ttlSec);
      const tgt = intel.sort((p, q) => q.t - p.t)[0];
      const want = tgt ? tgt.floor : (a.patrolFloor != null ? a.patrolFloor : a.carTargetFloor);
      if (want != null) {
        a.carTargetFloor = want;
        world.pressCarFloor(a, car, want);
      }

      // 发现电梯往反方向走：忍一会儿，下一站门开就下车改走楼梯（像人一样"不坐了"）
      const wrongWay = car.dir !== 0 && a.carTargetFloor != null
        && ((car.dir > 0 && a.carTargetFloor < car.floor - 0.05) || (car.dir < 0 && a.carTargetFloor > car.floor + 0.05));
      if (wrongWay) {
        if (a.wrongWayAt == null) a.wrongWayAt = world.time;
      } else {
        a.wrongWayAt = null;
      }
      if (wrongWay && world.time - a.wrongWayAt > num(world, 'killerWrongWaySec', 3)) {
        a.wrongWayAt = null;
        a.carTargetFloor = null;
        if (car.doorsOpen) {
          world.exitCar(a, car);
          a.forceStairsUntil = world.time + 8;    // 刚被电梯坑过，这一趟走楼梯
        }
        return;
      }

      if (car.doorsOpen && a.carTargetFloor === Math.round(car.floor)) {
        world.exitCar(a, car);
      }
    }
  };

  EK.ChildAI = ChildAI;
  EK.KillerAI = KillerAI;
})();

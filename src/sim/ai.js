/* AI：小孩（孤立、逃跑为主）与杀人犯（共享频道、围猎）
 */
(function () {
  const EK = (globalThis.EK = globalThis.EK || {});
  const U = EK.util;
  const P = EK.Perception;

  function nearestThreat(world, a, seen) {
    let best = null;
    for (const k of seen) {
      const d = world.sameSpaceDist(a, k);
      const dd = isFinite(d) ? d : 99;
      if (!best || dd < best.d) best = { actor: k, d: dd };
    }
    return best;
  }

  function safeFloor(world, a) {
    const b = world.building;
    const danger = world.killersAlive().map((k) => ({ floor: k.location.floor, w: k.kind === 'killer' ? 1 : 0 }));
    let best = a.location.floor, bestScore = -Infinity;
    for (let i = 0; i < 12; i++) {
      const f = 1 + Math.floor(Math.random() * world.cfg.floors);
      if (Math.abs(f - a.location.floor) < 2) continue;
      let score = Math.random() * 2;
      for (const d of danger) score += Math.min(Math.abs(f - d.floor), 8) * 1.5;
      for (const e of world.channel) score -= Math.max(0, 6 - Math.abs(f - e.floor)) * 2;
      if (score > bestScore) { bestScore = score; best = f; }
    }
    return best;
  }

  const ChildAI = {
    update(world, a, dt) {
      a.aiTimer -= dt;
      const seen = P.visibleActors(world, a).filter((o) => o.kind === 'killer');
      const threat = nearestThreat(world, a, seen);

      if (threat && threat.d <= world.cfg.kid.dangerM) {
        // 反应时间：刚看到威胁还要愣一下才跑
        if (a.threatAt == null) a.threatAt = world.time;
        const delay = a.reactionSec != null ? a.reactionSec : (world.cfg.kid.reactionSec || 0);
        if (world.time - a.threatAt < delay) return;
        return flee(world, a, threat);
      }
      a.threatAt = null;

      if (a.nav) {
        if (a.nav.phase === 'wait' && seen.length && seen.some((k) => world.sameSpaceDist(a, k) < 7)) {
          a.boardRequest = false;
          a.nav = null;
          a.aiTimer = 0.1;
        }
        return;
      }
      if (a.location.type !== 'floor') return;
      if (a.aiTimer > 0) return;
      a.aiTimer = 0.45 + Math.random() * 0.4;

      // 假动作：在电梯厅按一下呼梯然后走人，给杀人犯留一个「电梯停过这里」的假线索
      const aiCfgK = world.cfg.ai || {};
      const bait = aiCfgK.kidBait || 0;
      const baitCd = aiCfgK.kidBaitCooldown != null ? aiCfgK.kidBaitCooldown : 40;
      if (bait > 0 && !seen.length && world.building.inLobby(a.location.x)
          && world.time > (a.baitCd || 0) && Math.random() < bait) {
        world.pressHallAt(a.location.floor, Math.random() < 0.5 ? 1 : -1, a.location.x);
        world.log(`${a.name} 按了呼梯却没等梯`, 'ai', a.location.floor);
        a.baitCd = world.time + baitCd;
      }

      // 有威胁刚经过的楼层，别在大厅逗留
      if (Math.random() < 0.28) {
        const target = safeFloor(world, a);
        if (target !== a.location.floor) {
          world.navTo(a, target);
          a.aiState = 'travel';
          return;
        }
      }
      const b = world.building;
      let tx = U.rnd(1.5, b.L - 1.5);
      if (seen.length) tx = a.location.x < b.L / 2 ? U.rnd(1.2, b.aX + 1) : U.rnd(b.bX - 1, b.L - 1.2);
      a.moveTarget = tx;
      a.aiState = 'wander';
    },

    inCar(world, a, car, dt) {
      if (car.doorsOpen && world.killersInCar(car).length > 0) { world.exitCar(a, car); return; }
      if (a.carTargetFloor != null) return;
      const f = safeFloor(world, a);
      a.carTargetFloor = f;
      car.requestFloor(f);
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
      const curFloor = a.location.type === 'car' ? a.location.floor : a.location.floor;

      if (intel.length) {
        const same = intel.filter((e) => e.floor === curFloor);
        const tgt = (same.length ? same : intel).sort((p, q) => q.t - p.t)[0];
        a.aiState = 'hunt';
        if (tgt.floor === curFloor) a.moveTarget = tgt.x;
        else world.navTo(a, tgt.floor);
        return;
      }

      // 电梯线索：站在电梯厅读到某部梯停在别的楼层 → 那里可能刚有人下梯
      const aiCfg = world.cfg.ai || {};
      if (aiCfg.clueUse && P.canReadPanel(world, a)) {
        for (const car of world.elev.cars) {
          const parked = car.dir === 0 && (car.state === 'idle' || car.state === 'open');
          const f = Math.round(car.floor);
          if (!parked || Math.abs(car.floor - f) > 0.05) continue;
          if (f === a.location.floor || a.clueDone === f) continue;
          if (!a.clue || a.clue.floor !== f) a.clue = { floor: f, t: world.time };
        }
      }

      // 没有情报：扫楼（一次跨几层，优先坐电梯，别一层层爬楼梯）
      if (a.patrolFloor == null) a.patrolFloor = Math.round(a.location.floor);
      if (a.patrolDir == null) a.patrolDir = Math.random() < 0.5 ? 1 : -1;
      a.aiState = 'patrol';
      if (a.clue && world.time - a.clue.t < (aiCfg.clueTtl || 15)) {
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
        const hop = 3 + Math.floor(Math.random() * 4);          // 跨 3~6 层
        let next = a.patrolFloor + a.patrolDir * hop;
        if (next > world.cfg.floors) { next = world.cfg.floors - 2; a.patrolDir = -1; }
        if (next < 1) { next = 3; a.patrolDir = 1; }
        a.patrolFloor = U.clamp(next, 1, world.cfg.floors);
      }
    },

    inCar(world, a, car, dt) {
      const intel = world.channel.filter((e) => world.time - e.t < world.cfg.channel.ttlSec);
      const tgt = intel.sort((p, q) => q.t - p.t)[0];
      const want = tgt ? tgt.floor : (a.patrolFloor != null ? a.patrolFloor : a.carTargetFloor);
      if (want != null) {
        a.carTargetFloor = want;
        car.requestFloor(want);
      }
      if (car.doorsOpen && a.carTargetFloor === Math.round(car.floor)) {
        world.exitCar(a, car);
      }
    }
  };

  EK.ChildAI = ChildAI;
  EK.KillerAI = KillerAI;
})();

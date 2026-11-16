/* 路线选择：楼梯 vs 电梯，估算时间后择优
 */
(function () {
  const EK = (globalThis.EK = globalThis.EK || {});

  const Nav = {};

  /** 某部梯到达 floor 大概要多少「层」的时间（含方向不顺的修正） */
  function carCost(car, floor, dir) {
    const d = Math.abs(car.floor - floor);
    if (car.dir === 0) return d;
    const ahead = car.dir * (floor - car.floor) > 0;
    if (ahead && car.dir === dir) return d;
    if (ahead) return d + 6;
    return d + 9;
  }

  Nav.bestCar = function (world, floor, dir) {
    let best = null, bestCost = Infinity;
    for (const c of world.elev.cars) {
      const cost = carCost(c, floor, dir);
      if (cost < bestCost) { bestCost = cost; best = c; }
    }
    return { car: best, cost: bestCost };
  };

  Nav.estimateElevator = function (world, actor, targetFloor) {
    const here = actor.location.floor;
    const dir = targetFloor > here ? 1 : -1;
    const { cost } = Nav.bestCar(world, here, dir);
    const { secPerFloor, doorOpenSec, doorHoldSec, doorCloseSec } = world.cfg.elevator;
    const wait = cost * secPerFloor + doorOpenSec + doorHoldSec;
    const ride = Math.abs(targetFloor - here) * secPerFloor + doorOpenSec;
    return wait + ride + 1.0;
  };

  Nav.nearestLanding = function (world, actor) {
    const b = world.building;
    const x = actor.location.x;
    const toA = Math.abs(x - b.aX), toB = Math.abs(x - b.bX);
    return toA <= toB ? 'A' : 'B';
  };

  Nav.estimateStairs = function (world, actor, targetFloor) {
    const b = world.building;
    const landing = Nav.nearestLanding(world, actor);
    const walk = Math.abs(actor.location.x - b.landingX(landing)) / actor.speed;
    const climbSpeed = actor.stairSpeed || 0.22;
    const climb = Math.abs(targetFloor - actor.location.floor) / climbSpeed;
    // 每层在 A/B 之间交替落地，但两个楼梯口都能继续上下，不需要横穿走廊
    return walk + climb;
  };

  /**
   * @param {object} prefer 'auto' | 'elevator' | 'stairs'
   * @returns route 描述
   */
  Nav.choose = function (world, actor, targetFloor, prefer) {
    const b = world.building;
    const here = actor.location.floor;
    const dir = targetFloor > here ? 1 : -1;

    if (prefer === 'stairs') {
      const landing = Nav.nearestLanding(world, actor);
      return { kind: 'stairs', landing, dir, walkX: b.landingX(landing) };
    }
    if (prefer === 'elevator') {
      const { car } = Nav.bestCar(world, here, dir);
      return { kind: 'elevator', carId: car ? car.id : 'C', dir, walkX: world.carDoorX(car ? car.id : 'C') };
    }

    const tEl = Nav.estimateElevator(world, actor, targetFloor);
    const tSt = Nav.estimateStairs(world, actor, targetFloor);
    // 距离很近（1-2 层）时随机偏向楼梯，避免 AI 全挤电梯
    const bias = Math.abs(targetFloor - here) <= 2 ? 0.75 : 1.0;
    if (tSt * bias <= tEl) {
      const landing = Nav.nearestLanding(world, actor);
      return { kind: 'stairs', landing, dir, walkX: b.landingX(landing) };
    }
    const { car } = Nav.bestCar(world, here, dir);
    return { kind: 'elevator', carId: car.id, dir, walkX: world.carDoorX(car.id) };
  };

  EK.Nav = Nav;
})();

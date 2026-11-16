/* 视野与信息读取
 * 规则见 docs/DESIGN.md 4.2。核心：A、B 之间永远不可见；关门后轿厢内外互不可见；
 * 楼梯段是独立空间，只有同一段里的人才互相看得见。
 */
(function () {
  const EK = (globalThis.EK = globalThis.EK || {});

  const P = {};

  P.spaceOf = function (world, a) {
    const loc = a.location;
    if (loc.type === 'car') {
      const car = world.elev.get(loc.carId);
      return { kind: 'car', floor: car.floor, x: world.carDoorX(car.id), carId: car.id };
    }
    if (loc.type === 'stair') {
      return {
        kind: 'stair', floor: loc.fromFloor, x: world.building.landingX(loc.fromLanding),
        stairKey: `${loc.stair}:${loc.fromFloor}`, progress: loc.progress, dir: loc.dir
      };
    }
    return { kind: 'floor', floor: loc.floor, x: loc.x };
  };

  /** a 能否看见 b（只看几何与门状态，不考虑 a 的视距衰减以外的因素） */
  P.canSee = function (world, a, b) {
    if (a === b) return true;
    const sa = P.spaceOf(world, a), sb = P.spaceOf(world, b);
    const vis = a.vision || 12;

    if (sa.kind === 'stair' || sb.kind === 'stair') {
      if (sa.kind === 'stair' && sb.kind === 'stair') return P.flightKey(a.location) === P.flightKey(b.location);
      // 楼梯口附近：能看到刚上/下楼、还在门洞里的人；走深了就看不见
      const stair = sa.kind === 'stair' ? a.location : b.location;
      const other = sa.kind === 'stair' ? sb : sa;
      if (other.kind !== 'floor') return false;
      const mouthM = world.cfg.stairMouthM != null ? world.cfg.stairMouthM : 2.0;
      const mouthP = world.cfg.stairMouthProgress != null ? world.cfg.stairMouthProgress : 0.18;
      const p = stair.progress;
      if (p <= mouthP) {
        return other.floor === stair.fromFloor
          && Math.abs(other.x - world.building.landingX(stair.fromLanding)) <= mouthM;
      }
      if (p >= 1 - mouthP) {
        return other.floor === stair.toFloor
          && Math.abs(other.x - world.building.landingX(stair.toLanding)) <= mouthM;
      }
      return false;
    }
    if (sa.kind === 'car' && sb.kind === 'car') return sa.carId === sb.carId;
    if (sa.kind === 'car' || sb.kind === 'car') {
      const carSide = sa.kind === 'car' ? sa : sb;
      const floorSide = sa.kind === 'car' ? sb : sa;
      const car = world.elev.get(carSide.carId);
      if (Math.abs(car.floor - floorSide.floor) > 0.05) return false;
      if (!car.doorsOpen) return false;                 // 关门后看不到轿厢里
      if (!world.building.inLobby(floorSide.x)) return false;
      return Math.abs(floorSide.x - world.carDoorX(car.id)) <= vis;
    }
    // 都在楼层走廊
    if (sa.floor !== sb.floor) return false;
    const ra = world.building.region(sa.x), rb = world.building.region(sb.x);
    if ((ra === 'A' && rb === 'B') || (ra === 'B' && rb === 'A')) return false;  // 两个楼梯口互不可见
    return Math.abs(sa.x - sb.x) <= vis;
  };

  P.visibleActors = function (world, a) {
    const out = [];
    for (const b of world.actors) {
      if (b === a || !b.alive) continue;
      if (P.canSee(world, a, b)) out.push(b);
    }
    return out;
  };

  /** 站在电梯厅才能读楼层显示屏 */
  P.canReadPanel = function (world, a) {
    if (a.location.type !== 'floor') return false;
    return world.building.inLobby(a.location.x);
  };

  /** 站在电梯厅时，两部梯的状态都读得到 */
  P.panelInfo = function (world, a) {
    if (!P.canReadPanel(world, a)) return null;
    return world.elev.cars.map((c) => ({ id: c.id, floor: c.floor, dir: c.dir }));
  };

  /** 观者的「视野来源」：杀人犯之间共享视野，小孩只有自己 */
  P.viewersFor = function (world, viewer) {
    if (!viewer) return null;                       // 上帝视角
    if (viewer.kind === 'killer') {
      const mates = world.killersAlive();
      return mates.length ? mates : [viewer];
    }
    return [viewer];
  };

  /** 共享视野下的可见性：任何一名队友看得到，就算看得到 */
  P.canSeeShared = function (world, viewer, b) {
    const list = P.viewersFor(world, viewer);
    if (!list) return true;
    return list.some((v) => P.canSee(world, v, b));
  };

  /** 观者对某部轿厢的认知：精确 / 按记忆匀速外推 / 完全不知道 */
  P.seesCar = function (world, viewer, car) {
    const list = P.viewersFor(world, viewer);
    if (!list) return true;                         // 上帝视角
    return list.some((v) => {
      if (v.location.type === 'car' && v.location.carId === car.id) return true;
      return P.canReadPanel(world, v);
    });
  };

  /** 楼梯段的物理标识：同一段楼梯，上下两个方向是同一个空间 */
  P.flightKey = function (loc) {
    const minF = Math.min(loc.fromFloor, loc.toFloor);
    const lowerLanding = loc.fromFloor <= loc.toFloor ? loc.fromLanding : loc.toLanding;
    return `${minF}:${lowerLanding}`;
  };

  /** 在楼梯段里的位置（从低处那一端算 0 → 1） */
  P.flightPos = function (loc) {
    const minF = Math.min(loc.fromFloor, loc.toFloor);
    return loc.fromFloor === minF ? loc.progress : 1 - loc.progress;
  };

  /**
   * 显示用的轿厢状态。
   * exact=false 时给出「最后看到的位置按当时方向匀速推算」的估计值，
   * 以及一个问号标记——再次看到就刷新。
   */
  P.carDisplay = function (world, viewer, car) {
    if (P.seesCar(world, viewer, car)) {
      return { exact: true, known: true, floor: car.floor, dir: car.dir, doorsOpen: car.doorsOpen };
    }
    const mem = viewer && viewer.carMemory ? viewer.carMemory[car.id] : null;
    if (!mem) return { exact: false, known: false, floor: null, dir: 0, doorsOpen: false };
    const dt = Math.max(0, world.time - mem.t);
    let f = mem.floor;
    if (mem.dir !== 0) f += (mem.dir * dt) / world.cfg.elevator.secPerFloor;
    const floors = world.cfg.floors;
    // 碰到了端点就当作停在那里
    if (f > floors) f = floors;
    if (f < 1) f = 1;
    return { exact: false, known: true, floor: f, dir: mem.dir, doorsOpen: false, memory: mem, age: dt };
  };

  /** 记录「看到的」电梯状态，供之后外推 */
  P.rememberCars = function (world, a) {
    if (!a || !a.alive) return;
    const readPanel = P.canReadPanel(world, a);
    const inCar = a.location.type === 'car' ? a.location.carId : null;
    if (!readPanel && !inCar) return;
    a.carMemory = a.carMemory || {};
    for (const car of world.elev.cars) {
      const observed = readPanel || inCar === car.id;
      if (!observed) continue;
      a.carMemory[car.id] = { floor: car.floor, dir: car.dir, t: world.time, doorsOpen: car.doorsOpen };
    }
  };

  EK.Perception = P;
})();

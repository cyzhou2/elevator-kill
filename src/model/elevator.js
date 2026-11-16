/* 电梯：单轿厢 FSM + 两部梯的群控派梯
 * 运行逻辑（SCAN）：保持方向、顺路停靠、不中途掉头；完成一个方向再反向；无任务原地待机。
 */
(function () {
  const EK = (globalThis.EK = globalThis.EK || {});

  class ElevatorCar {
    constructor(id, world) {
      this.id = id;                 // 'C' | 'D'
      this.world = world;
      this.cfg = world.cfg.elevator;
      this.floor = 1;               // 连续值，1..N
      this.dir = 0;                 // -1 下 / 0 待机 / 1 上
      this.state = 'idle';          // idle|opening|open|closing|moving
      this.timer = 0;
      this.doorsOpen = false;
      this.blocked = false;         // 关门被打断
      this.pressOpen = false;
      this.carCalls = new Set();
      this.claims = new Set();      // 已派给本梯的呼梯楼层
      this.passengers = new Set();
    }

    get doorX() { return this.world.carDoorX(this.id); }
    get floorsPerSec() { return 1 / this.cfg.secPerFloor; }

    isOpenOn(floor, tol) {
      return this.doorsOpen && Math.abs(this.floor - floor) < (tol || 0.05);
    }

    requestFloor(f) {
      if (!this.world.building.validFloor(f)) return;
      this.carCalls.add(f);
    }

    requestOpen() { this.pressOpen = true; }

    /** 强制关门：还在开门保持阶段就直接进入关门 */
    requestClose() {
      if (this.state !== 'open') return false;
      this.timer = 0;
      this.state = 'closing';
      this.doorsOpen = false;
      this.blocked = false;
      this.world.onDoorsClosing(this);
      return true;
    }

    /** 有人进出：延长开门保持 */
    extendHold() { if (this.state === 'open') this.timer = 0; }

    /** 关门途中被人挡：重新开门（同一次停靠最多挡 3 次，防止被永久卡住） */
    interruptClose() {
      if (this.state !== 'closing') return;
      if ((this.reopenCount || 0) >= 3) return;
      this.blocked = true;
      this.reopenCount = (this.reopenCount || 0) + 1;
    }

    /** 该方向前方是否还有任务 */
    farStop() {
      let best = null;
      for (const f of this.allStops()) {
        if (this.dir === 0) continue;
        if (this.dir > 0 ? f > this.floor + 1e-6 : f < this.floor - 1e-6) {
          if (best === null || Math.abs(f - this.floor) < Math.abs(best - this.floor)) best = f;
        }
      }
      return best;
    }

    allStops() {
      const s = new Set(this.carCalls);
      for (const f of this.claims) s.add(f);
      return s;
    }

    /** 本梯能响应的本层呼梯：公用按钮(null) 或 指定本梯的按钮 */
    callsFor(f) {
      return this.world.hallCallsAt(f).filter((c) => !c.carId || c.carId === this.id);
    }

    shouldStopAt(f) {
      if (this.carCalls.has(f)) return true;
      if (!this.claims.has(f)) return false;
      const calls = this.callsFor(f);
      if (!calls.length) { this.claims.delete(f); return false; }   // 幽灵停靠，清掉
      if (this.dir === 0) return true;
      if (calls.some((c) => c.dir === this.dir)) return true;
      // 等太久的反方向呼梯也停，别让人一直等不到（但已经停在这一层就不要再反复开门）
      if (Math.abs(this.floor - f) > 0.05 && calls.some((c) => this.world.time - (c.t0 || 0) > 8)) return true;
      return false;
    }

    update(dt) {
      switch (this.state) {
        case 'opening':
          this.timer += dt;
          if (this.timer >= this.cfg.doorOpenSec) {
            this.timer = 0; this.state = 'open'; this.doorsOpen = true;
            this.world.onDoorsOpened(this);
          }
          return;
        case 'open': {
          this.timer += dt;
          if (this.pressOpen) { this.pressOpen = false; this.timer = 0; }
          if (this.timer >= this.cfg.doorHoldSec) {
            this.timer = 0; this.state = 'closing'; this.doorsOpen = false; this.blocked = false;
            this.world.onDoorsClosing(this);
          }
          return;
        }
        case 'closing':
          if (this.blocked) {
            this.blocked = false; this.timer = 0; this.state = 'opening'; this.doorsOpen = false;
            return;
          }
          this.timer += dt;
          if (this.timer >= this.cfg.doorCloseSec) { this.timer = 0; this.state = 'idle'; this.world.onDoorsClosed(this); }
          return;
        case 'idle':
          this.plan();
          return;
        case 'moving':
          this.move(dt);
          return;
      }
    }

    plan() {
      const at = Math.round(this.floor);
      const atStop = this.shouldStopAt(at) && Math.abs(this.floor - at) < 0.05;
      if (atStop) { this.openDoors(at); return; }

      // 这个方向已经跑完（前方没有任务），而本层还留着反方向的呼梯 → 原地再开一次门把它清掉
      if (this.cfg.reopenForOpposite !== false
          && this.dir !== 0 && !this.reopenedForOpposite
          && Math.abs(this.floor - at) < 0.05 && !this.stopsAhead(this.dir)) {
        const opp = this.callsFor(at).filter((c) => c.dir !== this.dir);
        if (opp.length) {
          this.reopenedForOpposite = true;
          this.serveDir = 0;                       // 两个方向一起清
          this.floor = at;
          this.state = 'opening';
          this.timer = 0;
          this.doorsOpen = false;
          this.reopenCount = 0;
          this.world.onCarOpening(this, at);
          return;
        }
      }

      const stops = this.allStops();
      if (stops.size === 0) { this.dir = 0; return; }

      // 保持方向；没有前方任务则反向；都没有就选最近
      if (this.dir !== 0) {
        if (this.stopsAhead(this.dir)) { this.state = 'moving'; return; }
        if (this.stopsBehind(this.dir)) { this.dir = -this.dir; this.state = 'moving'; return; }
        this.dir = 0;
      }
      let best = null;
      for (const f of stops) {
        if (best === null || Math.abs(f - this.floor) < Math.abs(best - this.floor)) best = f;
      }
      if (best === null) { this.dir = 0; return; }
      this.dir = best > this.floor ? 1 : best < this.floor ? -1 : 1;
      this.state = 'moving';
    }

    stopsAhead(dir) {
      for (const f of this.allStops()) if (dir > 0 ? f > this.floor + 1e-6 : f < this.floor - 1e-6) return true;
      // 前方还有未到但需停的呼梯（已派给本梯，方向一致）
      for (const f of this.claims) {
        if (dir > 0 ? f > this.floor + 1e-6 : f < this.floor - 1e-6) return true;
      }
      return false;
    }

    stopsBehind(dir) {
      for (const f of this.allStops()) if (dir > 0 ? f < this.floor - 1e-6 : f > this.floor + 1e-6) return true;
      return false;
    }

    openDoors(f) {
      this.floor = f;
      this.state = 'opening';
      this.timer = 0;
      this.doorsOpen = false;
      this.reopenCount = 0;
      this.serveDir = this.dir;          // 这次停靠是「朝哪个方向」服务的
      this.world.onCarOpening(this, f);
    }

    move(dt) {
      if (this.dir === 0) { this.plan(); return; }
      let remain = this.floorsPerSec * dt;
      let guard = 0;
      while (remain > 1e-9 && guard++ < 64) {
        const nextInt = this.dir > 0
          ? Math.floor(this.floor + 1e-9) + 1
          : Math.ceil(this.floor - 1e-9) - 1;
        if (!this.world.building.validFloor(nextInt)) {
          // 到端点：停在端层，掉头，并检查端层是否要停
          this.floor = this.dir > 0 ? this.world.cfg.floors : 1;
          this.dir = -this.dir;
          this.state = 'idle';
          this.plan();
          return;
        }
        const gap = Math.abs(nextInt - this.floor);
        if (remain >= gap - 1e-9) {
          this.floor = nextInt;
          remain -= gap;
          if (this.shouldStopAt(nextInt)) { this.openDoors(nextInt); return; }
        } else {
          this.floor += this.dir * remain;
          remain = 0;
        }
      }
    }
  }

  class ElevatorGroup {
    constructor(world) {
      this.world = world;
      this.cfg = world.cfg.elevator;
      this.cars = [];
      const n = this.cfg.cars;
      for (let i = 0; i < n; i++) {
        const c = new ElevatorCar(i === 0 ? 'C' : 'D', world);
        c.floor = i === 0 ? 1 : world.cfg.floors;
        this.cars.push(c);
      }
    }

    get(id) { return this.cars.find((c) => c.id === id); }

    /** 按下某层呼梯键；carId 为 null 表示公用按钮，否则是那部梯专属按钮 */
    press(floor, dir, carId) {
      carId = carId || null;
      const existed = this.world.hallCalls.some(
        (c) => c.floor === floor && c.dir === dir && (c.carId || null) === carId
      );
      if (!existed) this.world.hallCalls.push({ floor, dir, carId, t0: this.world.time, claimedBy: null });
      return !existed;
    }

    update(dt) {
      this.sanitizeClaims();
      this.assign();
      for (const c of this.cars) c.update(dt);
    }

    /** 清掉已经没有对应呼梯的停靠点（防止幽灵楼层让电梯空跑） */
    sanitizeClaims() {
      for (const c of this.cars) {
        for (const f of Array.from(c.claims)) {
          if (!c.callsFor(f).length) c.claims.delete(f);
        }
      }
    }

    /** 派梯：专属按钮直接给那部梯；公用按钮给代价最小的轿厢 */
    assign() {
      for (const call of this.world.hallCalls) {
        const holder = call.claimedBy && call.claimedBy !== 'all' ? this.get(call.claimedBy) : null;
        if (holder && holder.claims.has(call.floor)) continue;
        call.claimedBy = null;                       // 派单丢了（被别的停靠点覆盖），重新派

        if (call.carId) {
          const own = this.get(call.carId);
          if (own) { own.claims.add(call.floor); call.claimedBy = own.id; }
          continue;
        }

        let best = null, bestCost = Infinity;
        for (const c of this.cars) {
          const cost = estimate(c, call);
          if (cost < bestCost) { bestCost = cost; best = c; }
        }
        if (best) { best.claims.add(call.floor); call.claimedBy = best.id; }
      }
    }

    /** 呼梯被服务（到达/开门）后清除 */
    serve(floor) {
      this.world.hallCalls = this.world.hallCalls.filter((c) => c.floor !== floor);
      for (const c of this.cars) c.claims.delete(floor);
    }  }

  function estimate(car, call) {
    const d = Math.abs(car.floor - call.floor);
    if (car.dir === 0) return d;
    const ahead = car.dir * (call.floor - car.floor) > 0;
    const sameDir = call.dir === car.dir;
    if (ahead && sameDir) return d;              // 顺路，最理想
    if (ahead) return d + 6;                     // 顺路但方向不同，要先走完再回来
    return d + 9;                                // 在身后，必须跑完当前方向
  }

  EK.ElevatorCar = ElevatorCar;
  EK.ElevatorGroup = ElevatorGroup;
})();

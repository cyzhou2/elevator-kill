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
      this.target = null;           // 正在赶去的呼梯楼层（方向队列之外的单点目标）
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

    /**
     * 开门键：
     * - 门开着 → 刷新关门倒计时
     * - 正在关门 → 立刻变回开门状态，并刷新倒计时
     * - 闲置（门关着、停在整层）→ 直接把门打开
     */
    requestOpen() {
      if (this.state === 'open') {
        this.pressOpen = true;          // update() 里把计时器清零
        this.timer = 0;
        return true;
      }
      if (this.state === 'closing') {
        this.state = 'opening';
        this.timer = 0;
        this.doorsOpen = false;
        this.blocked = false;
        return true;
      }
      if (this.state === 'idle' && Math.abs(this.floor - Math.round(this.floor)) < 0.05) {
        this.openDoors(Math.round(this.floor));
        return true;
      }
      return false;
    }

    /** 关门键：门开着 → 立刻进入关门过程 */
    requestClose() {
      if (this.state !== 'open') return false;
      this.timer = 0;
      this.state = 'closing';
      this.doorsOpen = false;
      this.blocked = false;
      this.world.onDoorsClosing(this);
      return true;
    }

    /** 开门键现在能不能按 */
    canOpen() {
      if (this.state === 'open' || this.state === 'closing') return true;
      return this.state === 'idle' && Math.abs(this.floor - Math.round(this.floor)) < 0.05;
    }

    /** 关门键现在能不能按 */
    canClose() { return this.state === 'open'; }

    /** 有人进出：延长开门保持 */
    extendHold() { if (this.state === 'open') this.timer = 0; }

    /** 关门途中被人挡：重新开门（同一次停靠最多挡 3 次，防止被永久卡住） */
    interruptClose() {
      if (this.state !== 'closing') return;
      if ((this.reopenCount || 0) >= 3) return;
      this.blocked = true;
      this.reopenCount = (this.reopenCount || 0) + 1;
    }

    /** 本梯能响应的本层呼梯：公用按钮(null) 或 指定本梯的按钮 */
    callsFor(f) {
      return this.world.hallCallsAt(f).filter((c) => !c.carId || c.carId === this.id);
    }

    /** 该楼层是否需要在「某个方向」停靠：轿厢指令、正在赶去的目标层，或同方向的呼梯 */
    wantsStopAt(f, dir) {
      if (this.carCalls.has(f)) return true;
      if (this.target != null && Math.abs(f - this.target) < 0.05) return true;
      const calls = this.callsFor(f);
      if (!calls.length) return false;
      if (dir === 0) return true;                       // 待机时任何呼梯都算
      return calls.some((c) => c.dir === dir);          // 只顺路停：同方向
    }

    /** 当前方向上、从本层（含）开始还要停的楼层，按行进顺序排序 —— 这就是「事件队列」 */
    queueFor(dir) {
      if (dir === 0) return [];
      const list = [];
      for (let f = 1; f <= this.world.cfg.floors; f++) {
        if (dir > 0 ? f < this.floor - 0.05 : f > this.floor + 0.05) continue;
        if (this.wantsStopAt(f, dir)) list.push(f);
      }
      list.sort((a, b) => (dir > 0 ? a - b : b - a));
      return list;
    }

    /** 最近的任务层：轿厢里按下的楼层，或还没被响应的呼梯（闲置时据此立刻出发） */
    nearestCall() {
      let best = null;
      for (let f = 1; f <= this.world.cfg.floors; f++) {
        const has = this.carCalls.has(f) || this.callsFor(f).length > 0;
        if (!has) continue;
        if (best === null || Math.abs(f - this.floor) < Math.abs(best - this.floor)) best = f;
      }
      return best;
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
      const here = Math.abs(this.floor - at) < 0.05;

      // 1. 就在这一层：本层的「正方向事件」= 轿厢指令 + 同方向呼梯；反方向呼梯只补开一次门
      if (here) {
        const calls = this.callsFor(at);
        const carHere = this.carCalls.has(at);
        const sameDir = this.dir !== 0 && calls.some((c) => c.dir === this.dir);
        if (carHere || sameDir || (this.dir === 0 && calls.length)) {
          this.openDoors(at);
          return;
        }
        // 只剩反方向呼梯：原地补开一次，把两个方向一起清掉（每次停靠只补一次，避免反复开门）
        if (calls.length && this.dir !== 0 && !this.reopenedForOpposite) {
          this.reopenedForOpposite = true;
          this.serveDir = 0;
          this.state = 'opening';
          this.timer = 0;
          this.doorsOpen = false;
          this.reopenCount = 0;
          this.world.onCarOpening(this, at);
          return;
        }
      }

      // 2. 正方向队列还没跑完 → 继续走（队列每帧重算，「延长线」上有新任务会自动续上）
      if (this.dir !== 0 && this.aheadStops(this.dir).length) {
        this.state = 'moving';
        return;
      }

      // 3. 正方向空了，反方向有任务 → 立即掉头
      if (this.dir !== 0 && this.aheadStops(-this.dir).length) {
        this.dir = -this.dir;
        this.state = 'moving';
        return;
      }

      // 4. 正反都没任务：只要还有没被处理的呼梯，立刻去最近的那层（待机不摸鱼）
      const target = this.nearestCall();
      if (target != null) {
        if (Math.abs(target - this.floor) < 0.05) { this.openDoors(at); return; }
        this.target = target;
        this.dir = target > this.floor ? 1 : -1;
        this.state = 'moving';
        return;
      }

      // 5. 真的没事：原地待机；不在整层就沿当前方向挪到最近的整层
      this.dir = 0;
      if (!here) {
        this.settleDir = this.dir || 1;
        this.state = 'moving';
      }
    }

    openDoors(f) {
      this.floor = f;
      this.state = 'opening';
      this.timer = 0;
      this.doorsOpen = false;
      this.reopenCount = 0;
      this.reopenedForOpposite = false;   // 每次正常停靠都重新给一次「原地补开门」的机会
      this.target = null;                // 到站目标已兑现
      this.serveDir = this.dir;          // 这次停靠是「朝哪个方向」服务的
      this.world.onCarOpening(this, f);
    }

    /** 当前方向严格前方的停靠点（不含本层） */
    aheadStops(dir) {
      if (dir === 0) return [];
      return this.queueFor(dir).filter((f) => (dir > 0 ? f > this.floor + 0.05 : f < this.floor - 0.05));
    }

    move(dt) {
      // 目标层的呼梯没了就别再追
      if (this.target != null && !this.callsFor(this.target).length) this.target = null;

      // 0) 已经在整层，而且这层要停 → 先开门，绝不跳过（修：车正好压在整层线时会直接掉头）
      const atFloor = Math.round(this.floor);
      if (Math.abs(this.floor - atFloor) < 0.02 && this.wantsStopAt(atFloor, this.dir)) {
        this.floor = atFloor;
        this.openDoors(atFloor);
        return;
      }

      if (this.dir === 0) {
        // 待机中：还有任务就重新出发，没有就继续往整层挪（不再乱动）
        if (this.nearestCall() == null && Math.abs(this.floor - Math.round(this.floor)) < 0.02) {
          this.floor = Math.round(this.floor);
          return;
        }
        this.plan();
        if (this.state !== 'moving' || this.dir === 0) {
          // plan 没给出方向（只可能是要挪到整层），沿用上一次的方向
          this.dir = this.settleDir || 1;
        }
      }

      // 每一帧复核：正方向没任务就盯着反方向（掉头只在整层做，避免两层之间来回摆）
      if (this.dir !== 0 && this.aheadStops(this.dir).length === 0) {
        const atInt = Math.abs(this.floor - Math.round(this.floor)) < 0.02;
        if (!atInt) {
          // 不在整层：先把手头这一层走完，到整层再决定掉头还是待机
        } else if (this.aheadStops(-this.dir).length) {
          this.floor = Math.round(this.floor);
          this.dir = -this.dir;                          // 反方向有任务 → 立即掉头
        } else {
          this.floor = Math.round(this.floor);
          this.state = 'idle';                           // 两边都空 → 原地待机
          this.dir = 0;
          return;
        }
      }

      let remain = this.floorsPerSec * dt;
      let guard = 0;
      while (remain > 1e-9 && guard++ < 64) {
        const nextInt = this.dir > 0
          ? Math.floor(this.floor + 1e-9) + 1
          : Math.ceil(this.floor - 1e-9) - 1;
        if (!this.world.building.validFloor(nextInt)) {
          this.floor = this.dir > 0 ? this.world.cfg.floors : 1;
          this.state = 'idle';
          if (this.wantsStopAt(this.floor, this.dir)) { this.openDoors(this.floor); return; }
          this.dir = 0;
          return;
        }
        const gap = Math.abs(nextInt - this.floor);
        if (remain >= gap - 1e-9) {
          this.floor = nextInt;
          remain -= gap;
          // 每经过一层都确认一次：这层的呼梯方向和行进方向一致就停
          if (this.wantsStopAt(nextInt, this.dir)) { this.openDoors(nextInt); return; }
        } else {
          this.floor += this.dir * remain;
          remain = 0;
          // 恰好落在整层线上也要确认一次（否则下一帧可能先掉头、不开门）
          const land = Math.round(this.floor);
          if (Math.abs(this.floor - land) < 1e-6 && this.wantsStopAt(land, this.dir)) {
            this.floor = land;
            this.openDoors(land);
            return;
          }
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

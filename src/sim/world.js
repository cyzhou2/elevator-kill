/* 世界：实体、移动、上下电梯、楼梯、抓捕、计分、事件
 */
(function () {
  const EK = (globalThis.EK = globalThis.EK || {});
  const U = EK.util;
  const P = EK.Perception;

  class World {
    constructor(cfg, opts) {
      this.cfg = cfg;
      this.opts = Object.assign({ mode: 'escape', view: 'god' }, opts || {});
      this.building = new EK.Building(cfg);
      this.elev = new EK.ElevatorGroup(this);
      this.hallCalls = [];          // {floor, dir, claimedBy}
      this.actors = [];
      this.channel = [];            // 杀人犯频道情报
      this.events = [];
      this.time = 0;
      this.finished = false;
      this.endReason = null;
      this.kills = 0;
      this.spawn();
    }

    /* ---------- 基础工具 ---------- */

    log(text, kind, floor) {
      this.events.push({ t: this.time, text, kind: kind || 'info', floor: typeof floor === 'number' ? floor : null });
      if (this.onEvent) this.onEvent(this.events[this.events.length - 1]);
    }

    carDoorX(carId) {
      const mid = (this.building.lobbyStart + this.building.lobbyEnd) / 2;
      return carId === 'C' ? mid - 0.9 : mid + 0.9;
    }

    hallCallsAt(floor) {
      return this.hallCalls.filter((c) => Math.abs(c.floor - floor) < 0.05);
    }

    kidsAlive() { return this.actors.filter((a) => a.kind === 'kid' && a.alive); }
    killersAlive() { return this.actors.filter((a) => a.kind === 'killer' && a.alive); }

    /* ---------- 生成 ---------- */

    spawn() {
      const cfg = this.cfg, b = this.building;
      const kidFloors = [];
      for (let i = 0; i < cfg.kids; i++) {
        let f;
        let guard = 0;
        do { f = 2 + Math.floor(Math.random() * (cfg.floors - 2)); } while (kidFloors.includes(f) && guard++ < 50);
        kidFloors.push(f);
      }
      kidFloors.forEach((f, i) => {
        const x = U.rnd(1.5, b.L - 1.5);
        this.actors.push(this.makeActor('kid', i + 1, f, x));
      });
      for (let i = 0; i < cfg.killers; i++) {
        const f = i === 0 ? 1 : cfg.floors;
        const x = this.carDoorX('C');
        this.actors.push(this.makeActor('killer', i + 1, f, x));
      }
      this.log(`开局：${cfg.kids} 个小孩 / ${cfg.killers} 个杀人犯 / ${cfg.floors} 层`, 'start');
    }

    /** 各角色的爬楼速度（层/秒），角色表里可分别调 */
    stairSpeedOf(a) {
      const base = a.kind === 'killer' ? this.cfg.killer : this.cfg.kid;
      return base.stairSpeed != null ? base.stairSpeed : 0.22;
    }

    makeActor(kind, n, floor, x) {
      const base = kind === 'kid' ? this.cfg.kid : this.cfg.killer;
      const a = {
        id: `${kind === 'kid' ? 'K' : 'X'}${n}`,
        kind, num: n,
        name: `${kind === 'kid' ? '小孩' : '杀人犯'}${n}`,
        speed: base.speed,
        stairSpeed: base.stairSpeed != null ? base.stairSpeed : 0.22,
        vision: base.vision,
        reactionSec: base.reactionSec != null ? base.reactionSec : 0,
        location: { type: 'floor', floor, x },
        facing: 1,
        alive: true,
        controlled: false,
        moveTarget: null,
        input: 0,
        nav: null,
        boardRequest: false,
        carTargetFloor: null,
        grab: null,
        aiState: 'idle',
        aiTimer: Math.random() * 0.4,
        kills: 0,
        score: 0,
        intel: null
      };
      return a;
    }

    /* ---------- 主循环 ---------- */

    start() { this.started = true; }

    step(dt) {
      if (!this.started || this.finished) return;
      dt = Math.min(dt, 0.1);
      this.time += dt;

      this.elev.update(dt);
      this.checkDoorBlock();

      for (const a of this.actors) {
        if (!a.alive) continue;
        this.updateActor(a, dt);
        P.rememberCars(this, a);          // 看到过的电梯状态记下来，之后用来外推
      }

      this.resolveBoarding();
      this.resolveAlighting();
      this.resolveCapture(dt);
      this.updateChannel();
      this.scoreTick(dt);

      if (this.time >= this.cfg.roundSeconds) this.end('time');
      else if (this.kidsAlive().length === 0) this.end('allcaught');
    }

    updateActor(a, dt) {
      if (a.location.type === 'stair') return this.stairTick(a, dt);
      if (a.location.type === 'car') return this.carTick(a, dt);

      if (a.controlled) this.humanTick(a, dt);
      else if (a.nav) this.updateNav(a, dt);
      else if (a.kind === 'kid') EK.ChildAI.update(this, a, dt);
      else EK.KillerAI.update(this, a, dt);

      this.moveOnFloor(a, dt);
    }

    /* ---------- 楼层移动 ---------- */

    moveOnFloor(a, dt) {
      const b = this.building;
      if (Math.abs(a.input) > 0) {
        a.facing = Math.sign(a.input);
        a.x = U.clamp(a.location.x + a.input * a.speed * dt, 0.2, b.L - 0.2);
        a.location.x = a.x;
        a.moveTarget = null;
        return;
      }
      if (a.moveTarget != null) {
        const d = a.moveTarget - a.location.x;
        const step = a.speed * dt;
        if (Math.abs(d) <= step) { a.location.x = a.moveTarget; a.moveTarget = null; }
        else {
          a.location.x += Math.sign(d) * step;
          a.facing = Math.sign(d);
        }
        a.x = a.location.x;
      }
    }

    humanTick(a, dt) {
      // 输入已由外部写入 a.input；这里只处理朝向
      if (a.input !== 0) a.facing = Math.sign(a.input);
      if (a.nav) a.nav = null;   // 手动操作打断自动导航
    }

    /* ---------- 电梯上下 ---------- */

    openCarAt(floor) {
      return this.elev.cars.filter((c) => c.doorsOpen && Math.abs(c.floor - floor) < 0.05);
    }

    enterCar(a, car) {
      const old = a.location;
      a.location = { type: 'car', carId: car.id, floor: car.floor, fromFloor: old.floor };
      car.passengers.add(a);
      car.extendHold();
      a.boardRequest = false;
      a.moveTarget = null;
      a.nav = a.nav ? Object.assign({}, a.nav, { phase: 'ride', carId: car.id }) : null;
      a.log = true;
      this.log(`${a.name} 进了 ${car.id} 梯（${Math.round(car.floor)}F）`, a.controlled ? 'you' : 'move', car.floor);
    }

    exitCar(a, car) {
      const off = (Math.random() < 0.5 ? -1 : 1) * 0.95;
      const x = U.clamp(this.carDoorX(car.id) + off, 0.3, this.building.L - 0.3);
      a.location = { type: 'floor', floor: car.floor, x };
      a.x = x;
      car.passengers.delete(a);
      car.extendHold();
      a.carTargetFloor = null;
      if (a.nav) a.nav = null;
      this.log(`${a.name} 出了 ${car.id} 梯（${Math.round(car.floor)}F）`, a.controlled ? 'you' : 'move', car.floor);
    }

    carTick(a, dt) {
      const car = this.elev.get(a.location.carId);
      if (!car) { a.location = { type: 'floor', floor: 1, x: this.carDoorX('C') }; return; }
      a.location.floor = car.floor;
      a.x = this.carDoorX(car.id);

      if (!a.controlled) {
        if (a.kind === 'kid') EK.ChildAI.inCar(this, a, car, dt);
        else EK.KillerAI.inCar(this, a, car, dt);
      }

      // 到目标楼层且门开着 → 出去
      const wantOut = a.carTargetFloor != null && car.doorsOpen && Math.abs(car.floor - a.carTargetFloor) < 0.05;
      const fleeCar = a.kind === 'kid' && car.doorsOpen && this.killersInCar(car).length > 0;
      if (wantOut || (fleeCar && a.kind === 'kid')) {
        this.exitCar(a, car);
        a.carTargetFloor = null;
        if (a.nav) a.nav = null;
      }
    }

    killersInCar(car) {
      const out = [];
      for (const a of car.passengers) if (a.kind === 'killer' && a.alive) out.push(a);
      return out;
    }

    resolveBoarding() {
      for (const a of this.actors) {
        if (!a.alive || a.location.type !== 'floor' || !a.boardRequest) continue;
        const open = this.openCarAt(a.location.floor);
        for (const car of open) {
          // 两部梯门挨着，电梯厅是一整个地点：站在厅里就能走到任一部开门的梯
          if (Math.abs(a.location.x - this.carDoorX(car.id)) > this.cfg.elevator.boardRangeM) continue;
          if (a.kind === 'kid' && this.killersInCar(car).length > 0) { a.boardRequest = false; break; }
          this.enterCar(a, car);
          break;
        }
      }
    }

    resolveAlighting() {
      for (const car of this.elev.cars) {
        for (const a of Array.from(car.passengers)) {
          if (!a.alive) { car.passengers.delete(a); continue; }
          const t = a.carTargetFloor;
          if (car.doorsOpen && t != null && Math.abs(car.floor - t) < 0.05) {
            this.exitCar(a, car);
          } else if (a.kind === 'kid' && car.doorsOpen && this.killersInCar(car).length > 0) {
            this.exitCar(a, car);
          }
        }
      }
    }

    /* ---------- 楼梯 ---------- */

    takeStairs(a, flight) {
      a.location = {
        type: 'stair', stair: flight.stair,
        fromFloor: flight.from.floor, fromLanding: flight.from.landing,
        toFloor: flight.to.floor, toLanding: flight.to.landing,
        dir: flight.dir, progress: 0
      };
      a.x = null;
      a.moveTarget = null;
      a.nav = a.nav ? Object.assign({}, a.nav, { phase: 'climb' }) : null;
      this.log(`${a.name} 走楼梯 ${flight.from.floor}F→${flight.to.floor}F`, 'move', flight.from.floor);
    }

    stairTick(a, dt) {
      const loc = a.location;
      loc.progress += this.stairSpeedOf(a) * dt;
      if (loc.progress >= 1) {
        const to = loc.toLanding, f = loc.toFloor;
        a.location = { type: 'floor', floor: f, x: this.building.landingX(to) };
        a.x = a.location.x;
        if (a.nav) {
          const target = a.nav.targetFloor;
          if (target === f) a.nav = null;
          else a.nav = Object.assign({}, a.nav, { phase: 'plan' });
        }
      }
    }

    /* ---------- 导航（AI 用） ---------- */

    navTo(a, targetFloor) {
      a.nav = { targetFloor, phase: 'plan', timer: 0 };
    }

    updateNav(a, dt) {
      const nav = a.nav;
      if (!nav) return;
      if (nav.phase === 'plan') {
        const cur = a.location.floor;
        if (cur === nav.targetFloor) { a.nav = null; return; }
        const route = EK.Nav.choose(this, a, nav.targetFloor, nav.forceStairs ? 'stairs' : 'auto');
        Object.assign(nav, route, { phase: 'walk', timer: 0 });
      }
      if (nav.phase === 'walk') {
        a.moveTarget = nav.walkX;
        if (Math.abs(a.location.x - nav.walkX) < 0.2) {
          a.moveTarget = null;
          if (nav.kind === 'elevator') {
            this.pressHallAt(a.location.floor, nav.dir, a.location.x);
            a.boardRequest = true;
            nav.phase = 'wait';
          } else {
            const fl = this.building.stairFlight(a.location.floor, nav.landing, nav.dir);
            if (fl) this.takeStairs(a, fl);
            else { a.nav = null; }
          }
        }
        return;
      }
      if (nav.phase === 'wait') {
        nav.timer += dt;
        if (nav.timer > (this.cfg.aiWaitTimeout || 10)) {
          this.log(`${a.name} 等不到电梯，改走楼梯`, 'ai', a.location.floor);
          a.boardRequest = false;
          a.nav = { targetFloor: nav.targetFloor, phase: 'plan', forceStairs: true };
        }
        return;
      }
      if (nav.phase === 'ride') {
        // 在 carTick 里处理上下车；这里只保证目标层被按过一次
        a.carTargetFloor = nav.targetFloor;
        const car = a.location.type === 'car' ? this.elev.get(a.location.carId) : null;
        if (car && Math.abs(car.floor - nav.targetFloor) > 0.05) car.requestFloor(nav.targetFloor);
        return;
      }
    }

    /* ---------- 电梯事件 ---------- */

    checkDoorBlock() {
      for (const car of this.elev.cars) {
        if (car.state !== 'closing' || car.reopenCount >= 3) continue;
        for (const a of this.actors) {
          if (!a.alive || a.location.type !== 'floor') continue;
          if (Math.abs(a.location.floor - car.floor) > 0.05) continue;
          const d = Math.abs(a.location.x - this.carDoorX(car.id));
          if (d > this.cfg.elevator.doorZoneM) continue;
          // 只有“在等这部梯”或“停住不动堵在门口”会挡住关门；路过的人不挡
          const waiting = a.boardRequest;
          const standing = a.moveTarget == null && !a.input;
          if (waiting || (standing && d <= 0.7)) {
            car.interruptClose();
            break;
          }
        }
      }
    }

    onCarOpening(car, floor) {
      car.carCalls.delete(floor);
      this.log(`${car.id} 梯到 ${floor}F 开门`, 'elev', floor);
      // 只解除「本梯 / 公用」且与本方向一致的呼梯：反方向的按钮留着，等掉头再来
      // （clearOppositeCall = true 时退回旧行为，一次清掉两方向）
      const dir = car.serveDir != null ? car.serveDir : car.dir;
      const clearAll = !!this.cfg.elevator.clearOppositeCall;
      const served = this.hallCalls.filter((c) =>
        c.floor === floor &&
        (!c.carId || c.carId === car.id) &&
        (clearAll || dir === 0 || c.dir === dir)
      );
      if (served.length) this.hallCalls = this.hallCalls.filter((c) => served.indexOf(c) < 0);

      // 本层还有属于本梯的呼梯 → 停靠点保留；否则用掉
      const remainForCar = this.hallCalls.some((c) => c.floor === floor && (!c.carId || c.carId === car.id));
      if (!remainForCar) car.claims.delete(floor);
      if (!this.hallCalls.some((c) => c.floor === floor)) {
        for (const c of this.elev.cars) c.claims.delete(floor);
      }
    }
    onDoorsOpened(car) {
      car.passengers.forEach((p) => car.extendHold());
    }
    onDoorsClosing(car) { }
    onDoorsClosed(car) { }
    onCarArrive(car, floor) { }

    /* ---------- 抓捕 ---------- */

    sameSpaceDist(a, b) {
      const la = a.location, lb = b.location;
      if (la.type === 'car' && lb.type === 'car') return la.carId === lb.carId ? 0 : Infinity;
      if (la.type === 'stair' && lb.type === 'stair') {
        // 同一段楼梯：上下两个方向算同一个空间，迎面撞上也会被抓
        if (P.flightKey(la) !== P.flightKey(lb)) return Infinity;
        const perFloor = this.cfg.stairMetersPerFloor || 4.5;
        return Math.abs(P.flightPos(la) - P.flightPos(lb)) * perFloor;
      }
      if (la.type === 'floor' && lb.type === 'floor') {
        if (la.floor !== lb.floor) return Infinity;
        return Math.abs(la.x - lb.x);
      }
      return Infinity;
    }

    resolveCapture(dt) {
      const cfg = this.cfg.capture;
      for (const k of this.killersAlive()) {
        let target = null;
        for (const kid of this.kidsAlive()) {
          const inStair = k.location.type === 'stair' && kid.location.type === 'stair';
          const range = inStair ? (cfg.stairRangeM || cfg.rangeM) : cfg.rangeM;
          const d = this.sameSpaceDist(k, kid);
          if (d <= range) { target = kid; }
        }
        if (!target) { k.grab = null; continue; }
        if (!k.grab || k.grab.kidId !== target.id) k.grab = { kidId: target.id, t: 0 };
        k.grab.t += dt;
        if (k.grab.t >= cfg.gripSec) this.capture(k, target);
      }
    }

    capture(killer, kid) {
      kid.alive = false;
      kid.capturedAt = this.time;
      if (kid.location.type === 'car') {
        const car = this.elev.get(kid.location.carId);
        if (car) car.passengers.delete(kid);
      }
      this.kills++;
      killer.kills++;
      killer.grab = null;
      this.log(`💀 ${killer.name} 抓住了 ${kid.name}（${this.fmtWhere(kid.location)}，${U.fmtTime(this.time)}）`, 'kill', kid.location.floor || null);
      if (this.onCapture) this.onCapture(killer, kid);
    }

    fmtWhere(loc) {
      if (loc.type === 'car') return `${loc.carId} 梯内`;
      if (loc.type === 'stair') return `${loc.fromFloor}F 楼梯`;
      return `${loc.floor}F`;
    }

    /* ---------- 频道与计分 ---------- */

    updateChannel() {
      const ttl = this.cfg.channel.ttlSec;
      this.channel = this.channel.filter((e) => this.time - e.t < ttl);
      for (const k of this.killersAlive()) {
        for (const other of P.visibleActors(this, k)) {
          if (other.kind !== 'kid') continue;
          const sp = P.spaceOf(this, other);
          const e = this.channel.find((c) => c.kidId === other.id);
          const rec = {
            kidId: other.id, name: other.name, floor: sp.floor, x: sp.x,
            space: sp.kind, carId: sp.carId || null, t: this.time, by: k.id
          };
          if (e) Object.assign(e, rec); else this.channel.push(rec);
        }
      }
    }

    scoreTick(dt) {
      for (const kid of this.kidsAlive()) kid.score += dt * this.cfg.scoring.kidPerSecond;
      for (const k of this.killersAlive()) k.score = k.kills * this.cfg.scoring.killerPerKill;
    }

    totalKidScore() {
      return this.actors.filter((a) => a.kind === 'kid').reduce((s, a) => s + a.score, 0);
    }

    end(reason) {
      this.finished = true;
      this.endReason = reason;
      const kids = this.actors.filter((a) => a.kind === 'kid');
      const alive = kids.filter((a) => a.alive).length;
      this.log(reason === 'time'
        ? `时间到！存活 ${alive}/${kids.length}，总分 ${Math.round(this.totalKidScore())}`
        : `所有小孩都被抓了，用时 ${U.fmtTime(this.time)}`, 'end');
      if (this.onEnd) this.onEnd(reason);
    }

    /* ---------- 人类操作 ---------- */

    /** 站在这层、且人在电梯厅才能按到墙上的按钮 */
    /** 站在这层、且人在电梯厅（或紧挨着按钮墙）才能按到墙上的按钮 */
    canPressHall(a) {
      if (!a || a.location.type !== 'floor') return false;
      if (this.building.inLobby(a.location.x)) return true;
      const near = this.hallButtonSpecs().some((sp) => Math.abs(a.location.x - sp.x) <= 1.0);
      return near;
    }

    /** 旁观者+上帝视角：可以替任何人按任何按钮 */
    freePlay() {
      return this.opts.mode === 'spectate' && this.opts.view === 'god';
    }

    humanPressHall(a, floor, dir, carId) {
      if (!this.freePlay()) {
        if (!a.alive || a.location.type !== 'floor') return false;
        if (a.location.floor !== floor) return false;
        if (!this.canPressHall(a)) return false;
      }
      const own = carId || null;
      const fresh = this.elev.press(floor, dir, own);
      const label = dir > 0 ? '▲' : '▼';
      // 同一层同一方向已经按过：只表示「等得着急」，不重复记事件
      if (fresh) this.log(`你按了 ${own ? own + '梯 ' : ''}${floor}F ${label} 呼梯`, 'you', floor);
      return true;
    }

    /** 轿厢内的楼层按键：只有身处那部梯里才能按；旁观者+上帝视角例外 */
    canPressCarButton(carId) {
      if (this.freePlay()) return true;
      const a = this.actors.find((x) => x.controlled && x.alive);
      return !!a && a.location.type === 'car' && a.location.carId === carId;
    }

    /** 登记 / 取消轿厢里某一层（点一下按、再点一下取消） */
    toggleCarButton(carId, floor) {
      const car = this.elev.get(carId);
      if (!car) return false;
      if (car.carCalls.has(floor)) {
        car.carCalls.delete(floor);
        this.log(`你在 ${carId} 梯里取消了 ${floor}F`, 'you', floor);
      } else {
        car.carCalls.add(floor);
        this.log(`你在 ${carId} 梯里按了 ${floor}F`, 'you', floor);
      }
      return true;
    }

    /** AI 在轿厢里按楼层：只在新登记时记事件，重复按不刷屏 */
    pressCarFloor(a, car, floor) {
      if (car.carCalls.has(floor)) { car.requestFloor(floor); return false; }
      car.requestFloor(floor);
      this.log(`${a.name} 在 ${car.id} 梯里按了 ${floor}F`, 'move', car.floor);
      return true;
    }

    /** 站在楼梯口就能上下楼 */
    humanTakeStairs(a, dir) {
      if (!a.alive || a.location.type !== 'floor') return false;
      const landing = this.atLanding(a);
      if (!landing) return false;
      const fl = this.building.stairFlight(a.location.floor, landing, dir);
      if (!fl) { this.log(dir > 0 ? '已经在顶层，上不去了' : '已经在一层，下不去了', 'you', a.location.floor); return false; }
      this.takeStairs(a, fl);
      return true;
    }

    atLanding(a) {
      const b = this.building;
      const x = a.location.x;
      if (Math.abs(x - b.aX) <= (this.cfg.stairReachM || 1.6)) return 'A';
      if (Math.abs(x - b.bX) <= (this.cfg.stairReachM || 1.6)) return 'B';
      return null;
    }

    /** 按当前按钮模式选一部梯（公用按钮 → null，独立按钮 → 离得近的那部） */
    pressHallAt(floor, dir, x) {
      let carId = null;
      if (this.cfg.elevator.hallButtons === 'split') {
        const dC = Math.abs(x - this.carDoorX('C'));
        const dD = Math.abs(x - this.carDoorX('D'));
        carId = dC <= dD ? 'C' : 'D';
      }
      return this.elev.press(floor, dir, carId);
    }

    /** 每层墙上的呼梯按钮位置：C 的全部在电梯厅左边，D 的全部在右边（公用模式只有左右各一个） */
    hallButtonSpecs() {
      const b = this.building;
      const clampX = (x) => U.clamp(x, 0.18, b.L - 0.18);
      if (this.cfg.elevator.hallButtons === 'split') {
        return [
          { carId: 'C', dir: -1, x: clampX(b.lobbyStart - 0.85) },
          { carId: 'C', dir: 1, x: clampX(b.lobbyStart - 0.2) },
          { carId: 'D', dir: -1, x: clampX(b.lobbyEnd + 0.2) },
          { carId: 'D', dir: 1, x: clampX(b.lobbyEnd + 0.85) }
        ];
      }
      return [
        { carId: null, dir: -1, x: clampX(b.lobbyStart - 0.55) },
        { carId: null, dir: 1, x: clampX(b.lobbyEnd + 0.55) }
      ];
    }

    /** 空格：按身边的按钮，或者进出电梯 */
    humanSpace(a) {
      if (!a.alive) return false;
      if (a.location.type === 'car') {
        const car = this.elev.get(a.location.carId);
        if (car && car.doorsOpen) { this.exitCar(a, car); this.log('你下了电梯', 'you', car.floor); return true; }
        return false;
      }
      if (a.location.type !== 'floor') return false;

      const floor = a.location.floor;
      const x = a.location.x;
      const openCar = this.openCarAt(floor)
        .map((c) => ({ c, d: Math.abs(x - this.carDoorX(c.id)) }))
        .sort((p, q) => p.d - q.d)[0];
      const doorReach = this.cfg.elevator.boardRangeM;

      // 站在开着的门前 → 上下梯优先
      if (openCar && openCar.d <= doorReach) { a.boardRequest = true; return true; }

      if (!this.canPressHall(a)) {
        this.log('走到电梯厅才能按呼梯键', 'you', floor);
        return false;
      }
      // 电梯厅左半边 = ▼，右半边 = ▲（和墙上的布局一致）
      const mid = (this.building.lobbyStart + this.building.lobbyEnd) / 2;
      const dir = x <= mid ? -1 : 1;
      if (this.cfg.elevator.hallButtons === 'split') {
        const dC = Math.abs(x - this.carDoorX('C'));
        const dD = Math.abs(x - this.carDoorX('D'));
        return this.humanPressHall(a, floor, dir, dC <= dD ? 'C' : 'D');
      }
      return this.humanPressHall(a, floor, dir, null);
    }

    humanAction(a, action) {
      if (!a.alive) return;
      const b = this.building;
      if (a.location.type === 'floor') {
        const floor = a.location.floor;
        if (action === 'space') {
          this.humanSpace(a);
        } else if (action === 'callUp' || action === 'callDown') {
          const dir = action === 'callUp' ? 1 : -1;
          if (!this.canPressHall(a)) return;
          if (this.cfg.elevator.hallButtons === 'split') {
            // 独立按钮：离哪部梯近就按哪部
            const dC = Math.abs(a.location.x - this.carDoorX('C'));
            const dD = Math.abs(a.location.x - this.carDoorX('D'));
            this.humanPressHall(a, floor, dir, dC <= dD ? 'C' : 'D');
          } else {
            this.humanPressHall(a, floor, dir, null);
          }
        } else if (action === 'stairUp' || action === 'stairDown') {
          this.humanTakeStairs(a, action === 'stairUp' ? 1 : -1);
        } else if (action === 'openDoor') {
          for (const car of this.openCarAt(floor)) car.requestOpen();
        }
      } else if (a.location.type === 'car') {
        const car = this.elev.get(a.location.carId);
        if (action === 'openDoor') car.requestOpen();
        else if (action === 'closeDoor') car.requestClose();
        else if (action === 'space' && car.doorsOpen) { this.exitCar(a, car); this.log('你下了电梯', 'you', car.floor); }
      }
    }

    /** 楼梯段里按反方向键：原地掉头，走回出发的那个楼梯口 */
    humanStairReverse(a, dir) {
      if (!a.alive || a.location.type !== 'stair') return false;
      const loc = a.location;
      if (loc.dir === dir) return false;                 // 同方向不用掉头
      const back = {
        type: 'stair', stair: loc.stair,
        fromFloor: loc.toFloor, fromLanding: loc.toLanding,
        toFloor: loc.fromFloor, toLanding: loc.fromLanding,
        dir: -loc.dir, progress: 1 - loc.progress
      };
      a.location = back;
      this.log(`你掉头走回 ${loc.fromFloor}F`, 'you', loc.fromFloor);
      return true;
    }

    /** 轿厢里点楼层按钮：按一下登记，再按一下取消 */
    toggleCarCall(a, floor) {
      if (!a.alive || a.location.type !== 'car') return null;
      const car = this.elev.get(a.location.carId);
      if (!car) return null;
      if (car.carCalls.has(floor)) {
        car.carCalls.delete(floor);
        this.log(`你取消了 ${floor}F`, 'you', a.location.floor);
        return false;
      }
      car.requestFloor(floor);
      this.log(`你按了 ${floor}F`, 'you', a.location.floor);
      return true;
    }
  }

  EK.World = World;
})();

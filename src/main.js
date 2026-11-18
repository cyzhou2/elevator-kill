/* 入口：装配、游戏循环、键盘与鼠标输入、简介教程
 */
(function () {
  const EK = (globalThis.EK = globalThis.EK || {});
  const U = EK.util;

  const $ = (id) => document.getElementById(id);
  let world = null, renderer = null, settings = null, human = null;
  let paused = false, lastTs = 0, raf = 0;
  let introSeen = false;
  const keys = { left: false, right: false };
  // v8：全鼠标「一键到底」——点击地面/楼梯/电梯后自动走过去并执行
  let intent = null;

  function currentFocus() {
    if (!world) return null;
    if (human && human.alive) return human;
    if (settings.mode === 'spectate') {
      return world.kidsAlive()[0] || world.killersAlive()[0] || null;
    }
    return null;   // 玩家出局后转为观战
  }

  function assignHuman(w) {
    if (settings.mode === 'escape') {
      const kid = w.actors.find((a) => a.kind === 'kid');
      if (kid) kid.controlled = true;
      return kid || null;
    }
    if (settings.mode === 'hunt') {
      const k = w.actors.find((a) => a.kind === 'killer');
      if (k) k.controlled = true;
      return k || null;
    }
    return null;
  }

  function boot(opts) {
    const showIntro = !!(opts && opts.intro);
    cancelAnimationFrame(raf);
    settings = EK.UI.readSettings();
    const cfg = EK.makeConfig(settings.cfg);
    world = new EK.World(cfg, { mode: settings.mode, view: settings.view });
    human = assignHuman(world);
    world.start();
    renderer = renderer || new EK.Renderer($('stage'));
    renderer.resize(world);
    renderer.clearTrails();
    setPaused(false);
    lastTs = 0;
    EK.UI.resetLog();
    EK.UI.hideOverlay();
    EK.UI.loadInputs(settings);
    EK.UI.update(world, settings, human);
    raf = requestAnimationFrame(loop);
    if (showIntro) {
      introSeen = true;
      setPaused(true);
      EK.UI.openMenu('guide');
    }
  }

  function loop(ts) {
    if (!world) return;
    const now = ts / 1000;
    if (!lastTs) lastTs = now;
    let dt = Math.min(0.12, now - lastTs);
    lastTs = now;

    applyInput();
    if (!paused && !world.finished) {
      const total = dt * settings.speed;
      const slice = 0.05;
      for (let t = 0; t < total; t += slice) world.step(Math.min(slice, total - t));
    }

    renderer.draw(world, settings.view, currentFocus());
    EK.UI.update(world, settings, human);
    if (world.finished && $('overlay').classList.contains('hidden')) showEnd();

    raf = requestAnimationFrame(loop);
  }

  function applyInput() {
    if (!human || !human.alive) return;
    if (intent) driveIntent();
    if (human.location.type === 'floor') {
      human.input = (keys.right ? 1 : 0) + (keys.left ? -1 : 0);
    } else {
      human.input = 0;
    }
  }

  function showEnd() {
    const kids = world.actors.filter((a) => a.kind === 'kid');
    const alive = kids.filter((a) => a.alive).length;
    const total = Math.round(world.totalKidScore());
    const title = world.endReason === 'time' ? '时间到' : '全员被抓';
    const best = kids.slice().sort((a, b) => b.score - a.score)[0];
    EK.UI.overlay(
      `<h2>${title}</h2>` +
      `<p class="big">${total}</p><p>小孩总分</p>` +
      `<p>存活 ${alive}/${kids.length} · 用时 ${U.fmtTime(Math.min(world.time, world.cfg.roundSeconds))}</p>` +
      `<p>最佳小孩：${best ? best.name + ' ' + Math.round(best.score) : '-'}</p>` +
      `<p style="margin-top:12px"><button id="againBtn" class="primary" style="width:120px">再来一局</button></p>`
    );
    const btn = $('againBtn');
    if (btn) btn.onclick = () => boot();
  }

  /* ---------- 输入 ---------- */

  /** W/↑：楼梯间里 = 掉头往上；楼梯口 = 上楼；电梯厅里不响应呼梯 */
  function actUp() {
    if (!human || !human.alive) return;
    const loc = human.location;
    if (loc.type === 'stair') { world.humanStairReverse(human, 1); return; }
    if (loc.type === 'floor' && world.atLanding(human)) world.humanAction(human, 'stairUp');
  }

  function actDown() {
    if (!human || !human.alive) return;
    const loc = human.location;
    if (loc.type === 'stair') { world.humanStairReverse(human, -1); return; }
    if (loc.type === 'floor' && world.atLanding(human)) world.humanAction(human, 'stairDown');
  }

  /** Q：电梯厅 = 按▼ / 轿厢 = 开门 */
  function actQ() {
    if (!human || !human.alive) return;
    if (human.location.type === 'floor') world.humanAction(human, 'callDown');
    else if (human.location.type === 'car') world.humanAction(human, 'closeDoor');   // 下键=关门，和轿厢面板下格一致
  }

  /** E：电梯厅 = 按▲ / 轿厢 = 开门（上键=开门，和轿厢面板上格一致） */
  function actE() {
    if (!human || !human.alive) return;
    if (human.location.type === 'floor') world.humanAction(human, 'callUp');
    else if (human.location.type === 'car') world.humanAction(human, 'openDoor');
  }

  const KEY_ACTIONS = {
    KeyW: 'up', ArrowUp: 'up',
    KeyS: 'down', ArrowDown: 'down',
    KeyQ: 'q', KeyE: 'e',
    Space: 'space',
    KeyP: 'pause', Escape: 'cancel'
  };

  /** 统一的一次性动作入口：键盘和触屏都走这里 */
  function doAction(act) {
    if (!human || !human.alive || paused || world.finished) return;
    if (EK.UI.menuOpen && EK.UI.menuOpen()) return;
    if (act === 'space') world.humanAction(human, 'space');
    else if (act === 'up') actUp();
    else if (act === 'down') actDown();
    else if (act === 'q') actQ();
    else if (act === 'e') actE();
  }

  /** 触屏：left/right 是按住持续走，其余是点一下触发一次 */
  function touch(action, pressed) {
    if (action === 'left') { keys.left = pressed; return; }
    if (action === 'right') { keys.right = pressed; return; }
    if (!pressed) return;
    if (action === 'pause') { togglePause(); return; }
    doAction(action);
  }

  document.addEventListener('keydown', (e) => {
    // 长按产生的系统重复事件：不重复执行动作（否则按住键超过 1 秒会一顿一顿的）
    if (e.repeat) {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
      return;
    }
    if (e.code === 'KeyA' || e.code === 'ArrowLeft') { keys.left = true; clearIntent(); }
    if (e.code === 'KeyD' || e.code === 'ArrowRight') { keys.right = true; clearIntent(); }

    const act = KEY_ACTIONS[e.code];
    if (!act) return;
    e.preventDefault();
    if (act === 'pause') { togglePause(); return; }
    if (act === 'cancel') { if (EK.UI.menuOpen()) cancelMenu(); return; }
    if (EK.UI.menuOpen()) return;          // 菜单开着时不吃游戏按键
    doAction(act);
  });

  document.addEventListener('keyup', (e) => {
    if (e.code === 'KeyA' || e.code === 'ArrowLeft') keys.left = false;
    if (e.code === 'KeyD' || e.code === 'ArrowRight') keys.right = false;
  });

  /* ---------- v8：鼠标意图（点一下，自动走过去并执行） ---------- */

  function setIntent(next) {
    intent = next;
    if (intent) intent.t = world.time;
  }
  function clearIntent() { intent = null; }

  function nearestLanding() {
    const b = world.building;
    return Math.abs(human.location.x - b.aX) <= Math.abs(human.location.x - b.bX) ? 'A' : 'B';
  }

  /** 每帧驱动：把「想去哪」翻译成走动 + 到点后的动作 */
  function driveIntent() {
    if (!intent) return;
    if (!human || !human.alive || world.finished || paused) { intent = null; keys.left = keys.right = false; return; }
    const b = world.building;
    const loc = human.location;

    if (loc.type === 'stair') { keys.left = keys.right = false; return; }   // 正在爬，等落地

    if (loc.type === 'car') {
      const car = world.elev.get(loc.carId);
      if (intent.kind === 'goto' && intent.targetFloor != null && !intent.selected && car) {
        world.toggleCarButton(car.id, intent.targetFloor);
        intent.selected = true;
      }
      if (car && car.doorsOpen && intent.targetFloor != null && Math.abs(car.floor - intent.targetFloor) < 0.05) {
        world.humanAction(human, 'space');               // 到站下梯
        intent = intent.x != null ? { kind: 'walk', x: intent.x, t: world.time } : null;
      } else if (car && car.doorsOpen && intent.kind === 'exitHere') {
        world.humanAction(human, 'space');
        intent = null;
      }
      return;
    }

    // —— 在楼层上 ——
    const walkTo = (x) => {
      const d = x - loc.x;
      if (Math.abs(d) <= 0.12) { keys.left = keys.right = false; return true; }
      keys.right = d > 0; keys.left = d < 0;
      return false;
    };

    if (intent.kind === 'walk') {
      if (walkTo(intent.x)) clearIntent();
      return;
    }

    if (intent.kind === 'call') {                       // 走到电梯厅按呼梯
      const lx = (b.lobbyStart + b.lobbyEnd) / 2;
      if (walkTo(lx)) {
        world.humanPressHall(human, loc.floor, intent.dir, intent.carId || null);
        clearIntent();
      }
      return;
    }

    if (intent.kind === 'board') {                      // 走到开门的电梯旁并进梯
      const car = world.elev.get(intent.carId);
      if (!car) { clearIntent(); return; }
      const doorX = world.carDoorX(car.id);
      const reach = walkTo(doorX);
      const openHere = car.doorsOpen && Math.abs(car.floor - loc.floor) < 0.05;
      if (openHere && (reach || Math.abs(loc.x - doorX) <= world.cfg.elevator.boardRangeM)) {
        human.boardRequest = true;
        clearIntent();
      } else if (!openHere && reach && !intent.waited) {
        // 门没开：帮他按一下这一侧的呼梯
        world.humanPressHall(human, loc.floor, intent.dir != null ? intent.dir : 1, car.id);
        intent.waited = true;
      }
      return;
    }

    if (intent.kind === 'goto') {
      if (loc.floor === intent.targetFloor) {
        const done = intent.x != null ? walkTo(intent.x) : (keys.left = keys.right = false, true);
        if (done) clearIntent();
        return;
      }
      const dir = intent.targetFloor > loc.floor ? 1 : -1;
      // 路线：1~2 层走楼梯，更远等电梯
      if (intent.route == null) intent.route = Math.abs(intent.targetFloor - loc.floor) <= 2 ? 'stairs' : 'lift';

      if (intent.route === 'stairs') {
        const landing = nearestLanding();
        const lx = b.landingX(landing);
        if (walkTo(lx)) {
          keys.left = keys.right = false;
          world.humanAction(human, dir > 0 ? 'stairUp' : 'stairDown');
        }
        return;
      }

      // 电梯：先到电梯厅，按目标方向的呼梯，等门开就进
      const lx = (b.lobbyStart + b.lobbyEnd) / 2;
      if (!walkTo(lx)) return;
      const open = world.openCarAt(loc.floor);
      if (open.length) { human.boardRequest = true; return; }
      if (!intent.pressed) {
        world.humanPressHall(human, loc.floor, dir, null);
        intent.pressed = true;
      }
      return;
    }
  }

  /* 鼠标：按钮 / 轿厢 / 楼梯 / 地面 */
  const stage = $('stage');
  stage.addEventListener('click', (e) => {
    if (!world || !renderer) return;
    if (paused || world.finished) return;
    if (!world.freePlay() && (!human || !human.alive)) return;
    const r = stage.getBoundingClientRect();
    const hit = renderer.hitTest(e.clientX - r.left, e.clientY - r.top);
    if (!hit) return;
    const b = world.building;

    if (hit.type === 'carBtn') {
      if (!world.canPressCarButton(hit.carId)) { world.log(`只有身处 ${hit.carId} 梯里才能按它的轿厢按键`, 'you', hit.floor); return; }
      world.toggleCarButton(hit.carId, hit.floor);
      return;
    }
    if (hit.type === 'carDoor') {
      const carId = hit.carId;
      if (!world.canPressCarButton(carId)) { world.log(`只有身处 ${carId} 梯里才能按它的开/关门键`, 'you', hit.floor); return; }
      const car = world.elev.get(carId);
      if (car) { if (hit.action === 'open') car.requestOpen(); else car.requestClose(); }
      return;
    }
    if (hit.type === 'hall') {
      const ok = world.humanPressHall(human, hit.floor, hit.dir, hit.carId);
      if (!ok) setIntent({ kind: 'call', floor: hit.floor, dir: hit.dir, carId: hit.carId });
      return;
    }
    if (hit.type === 'carBody') {                       // 点轿厢：走过去进梯 / 或按呼梯
      if (human.location.type === 'car') return;
      const car = world.elev.get(hit.carId);
      const here = Math.abs(car.floor - human.location.floor) < 0.05;
      const dir = hit.floor > human.location.floor ? 1 : -1;
      setIntent({ kind: 'board', carId: hit.carId, dir, targetFloor: Math.round(hit.floor) });
      if (!here) setIntent({ kind: 'call', floor: human.location.floor, dir, carId: null });
      return;
    }
    if (hit.type === 'shaft') {                          // 点楼梯：自动用楼梯去那一层
      const g = renderer.geo;
      const targetFloor = Math.max(1, Math.min(g.floors, g.floorFromY(hit.y)));
      setIntent({ kind: 'goto', targetFloor, route: 'stairs' });
      return;
    }
    if (hit.type === 'floor') {                          // 点地面：走过去；点别的楼层：自动前往
      if (human.location.type === 'car') { setIntent({ kind: 'exitHere' }); return; }
      if (hit.floor !== human.location.floor) {
        setIntent({ kind: 'goto', targetFloor: hit.floor, x: hit.x });
      } else {
        setIntent({ kind: 'walk', x: hit.x });
      }
      return;
    }
  });

  stage.addEventListener('mousemove', (e) => {
    if (!renderer) return;
    const r = stage.getBoundingClientRect();
    const hit = renderer.hitTest(e.clientX - r.left, e.clientY - r.top);
    stage.style.cursor = hit ? 'pointer' : 'default';
  });

  window.addEventListener('resize', () => { if (world) renderer.resize(world); });

  /* ---------- 触屏手柄 ---------- */
  (function initTouch() {
    const box = $('touch');
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    const narrow = () => window.innerWidth <= 900 || window.innerHeight > window.innerWidth;
    const sync = () => { box.classList.toggle('hidden', !(coarse || narrow())); };
    sync();
    window.addEventListener('resize', sync);
    window.addEventListener('orientationchange', () => setTimeout(() => { sync(); if (world) renderer.resize(world); }, 120));

    for (const btn of box.querySelectorAll('.tb')) {
      const act = btn.dataset.act;
      const down = (e) => {
        e.preventDefault();
        btn.classList.add('on');
        if (btn.setPointerCapture && e.pointerId != null) { try { btn.setPointerCapture(e.pointerId); } catch (_) {} }
        touch(act, true);
      };
      const up = (e) => {
        if (e) e.preventDefault();
        btn.classList.remove('on');
        touch(act, false);
      };
      btn.addEventListener('pointerdown', down);
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
      btn.addEventListener('pointerleave', up);
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    }
  })();

  function setPaused(v) {
    paused = !!v;
    const btn = $('btnPause');
    if (btn) btn.textContent = paused ? '继续' : '暂停';
  }

  function togglePause() {
    if (world && world.finished) return;
    if (paused) { EK.UI.closeMenu(); setPaused(false); return; }   // 继续
    setPaused(true);
    EK.UI.openMenu('guide');
  }

  /** 取消：丢弃菜单里的改动，回到暂停中的这一局 */
  function cancelMenu() {
    EK.UI.loadInputs(settings);
    EK.UI.closeMenu();
    setPaused(true);
  }

  /** 应用：按菜单里的参数立刻重开一局 */
  function applyMenu() {
    EK.UI.closeMenu();
    boot();
    EK.UI.saveSettings();               // 记住这次用的参数，刷新页面也不丢
    const c = settings.cfg;
    if (world) {
      world.log('参数已应用：小孩 ' + c.kids + ' · 杀人犯 ' + c.killers + ' · 时长 ' + c.roundSeconds + 's'
        + ' · 楼道长 ' + c.corridorSideM + 'm · 小孩速 ' + c.kid.speed + ' · 杀人犯速 ' + c.killer.speed, 'sys', null);
    }
  }

  /* ---------- 按钮 ---------- */
  $('btnStart').onclick = () => { EK.UI.closeMenu(); boot(); };
  $('btnPause').onclick = () => togglePause();
  $('menuApply').onclick = () => applyMenu();
  $('menuCancel').onclick = () => cancelMenu();

  EK.UI.init();
  boot({ intro: !introSeen });

  // 调试/自动化入口
  globalThis.EK.game = {
    get world() { return world; },
    get human() { return human; },
    get settings() { return settings; },
    get paused() { return paused; },
    get renderer() { return renderer; },
    keys,
    touch,
    boot,
    get intent() { return intent; },
    setIntent,
    clearIntent,
    setPaused(v) { paused = !!v; },
    showEnd,
    focus: currentFocus,
    /** 手动推进（自动化测试用） */
    tick(seconds) {
      applyInput();
      const total = (seconds || 0.05) * (settings.speed || 1);
      const slice = 0.05;
      for (let t = 0; t < total; t += slice) world.step(Math.min(slice, total - t));
      renderer.draw(world, settings.view, currentFocus());
      EK.UI.update(world, settings, human);
    }
  };
})();

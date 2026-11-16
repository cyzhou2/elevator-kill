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
    EK.UI.update(world, settings, human);
    raf = requestAnimationFrame(loop);
    if (showIntro) {
      setPaused(true);
      EK.UI.showIntro(() => { introSeen = true; setPaused(false); });
    }
  }

  function loop(ts) {
    if (!world) return;
    const now = ts / 1000;
    if (!lastTs) lastTs = now;
    let dt = Math.min(0.12, now - lastTs);
    lastTs = now;

    settings.speed = parseFloat($('speedSel').value) || 1;
    settings.view = $('viewSel').value;

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
    else if (human.location.type === 'car') world.humanAction(human, 'openDoor');
  }

  /** E：电梯厅 = 按▲ / 轿厢 = 关门 */
  function actE() {
    if (!human || !human.alive) return;
    if (human.location.type === 'floor') world.humanAction(human, 'callUp');
    else if (human.location.type === 'car') world.humanAction(human, 'closeDoor');
  }

  const KEY_ACTIONS = {
    KeyW: 'up', ArrowUp: 'up',
    KeyS: 'down', ArrowDown: 'down',
    KeyQ: 'q', KeyE: 'e',
    Space: 'space',
    KeyP: 'pause', KeyR: 'reset'
  };

  /** 统一的一次性动作入口：键盘和触屏都走这里 */
  function doAction(act) {
    if (!human || !human.alive || paused || world.finished) return;
    if (EK.UI.introOpen && EK.UI.introOpen()) return;
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
    if (action === 'pause') { setPaused(!paused); return; }
    if (action === 'reset') { boot(); return; }
    doAction(action);
  }

  document.addEventListener('keydown', (e) => {
    if (e.code === 'KeyA' || e.code === 'ArrowLeft') keys.left = true;
    if (e.code === 'KeyD' || e.code === 'ArrowRight') keys.right = true;
    if (e.repeat) { if (['ArrowUp', 'ArrowDown', 'Space'].includes(e.code)) e.preventDefault(); return; }

    const act = KEY_ACTIONS[e.code];
    if (!act) return;
    e.preventDefault();
    if (act === 'pause') { setPaused(!paused); return; }
    if (act === 'reset') { boot(); return; }
    doAction(act);
  });

  document.addEventListener('keyup', (e) => {
    if (e.code === 'KeyA' || e.code === 'ArrowLeft') keys.left = false;
    if (e.code === 'KeyD' || e.code === 'ArrowRight') keys.right = false;
  });

  /* 鼠标：电梯按钮 + 轿厢选层面板 + 开门/关门 */
  const stage = $('stage');
  stage.addEventListener('click', (e) => {
    if (!world || !renderer || !human || !human.alive || paused || world.finished) return;
    const r = stage.getBoundingClientRect();
    const hit = renderer.hitTest(e.clientX - r.left, e.clientY - r.top);
    if (!hit) return;
    if (hit.type === 'car') world.toggleCarCall(human, hit.floor);
    else if (hit.type === 'carDoor') {
      const car = human.location.type === 'car' ? world.elev.get(human.location.carId) : null;
      if (car) { if (hit.action === 'open') car.requestOpen(); else car.requestClose(); }
    } else if (hit.type === 'hall') {
      const ok = world.humanPressHall(human, hit.floor, hit.dir, hit.carId);
      if (!ok) world.log('要站在这一层的电梯厅里才按得到墙上的按钮', 'you', human.location.floor);
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
    // 手机上没有键盘，靠这两个键暂停/重开
    $('btnPause').addEventListener('click', () => {});
  })();

  function setPaused(v) {
    paused = !!v;
    const btn = $('btnPause');
    if (btn) btn.textContent = paused ? '继续' : '暂停';
  }

  /* ---------- 按钮 ---------- */
  $('btnStart').onclick = () => boot();
  $('btnPause').onclick = () => setPaused(!paused);
  $('btnReset').onclick = () => boot();
  $('btnHelp').onclick = () => {
    setPaused(true);
    EK.UI.showIntro(() => setPaused(false));
  };

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
    setPaused(v) { paused = !!v; },
    showEnd,
    focus: currentFocus,
    /** 手动推进（自动化测试用） */
    tick(seconds) {
      applyInput();
      const total = (seconds || 0.05) * (parseFloat($('speedSel').value) || 1);
      const slice = 0.05;
      for (let t = 0; t < total; t += slice) world.step(Math.min(slice, total - t));
      renderer.draw(world, settings.view, currentFocus());
      EK.UI.update(world, settings, human);
    }
  };
})();

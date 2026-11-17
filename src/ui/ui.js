/* 界面：参数读取、HUD 刷新、事件日志、简介教程
 */
(function () {
  const EK = (globalThis.EK = globalThis.EK || {});
  const U = EK.util;

  const $ = (id) => document.getElementById(id);

  const SLIDERS = [
    ['pSecFloor', 'vSecFloor'], ['pDoorOpen', 'vDoorOpen'], ['pDoorHold', 'vDoorHold'],
    ['pDoorClose', 'vDoorClose'], ['pCorridor', 'vCorridor'],
    ['pKidSpeed', 'vKidSpeed'], ['pKidStair', 'vKidStair'],
    ['pKillerSpeed', 'vKillerSpeed'], ['pKillerStair', 'vKillerStair'],
    ['pVision', 'vVision'], ['pReaction', 'vReaction'],
    ['pGrip', 'vGrip'], ['pChannel', 'vChannel']
  ];

  const INTRO = [
    {
      title: '这是个什么游戏',
      html: `
        <p>20 层公寓，两部电梯、两部楼梯。楼里有 <b class="kid">3 个小孩</b> 和 <b class="killer">2 个杀人犯</b>（人数可调）。</p>
        <ul>
          <li><b class="kid">小孩</b>：没有出口，唯一的得分方式是活着——每活 1 秒 1 分，撑到时间结束。</li>
          <li><b class="killer">杀人犯</b>：移速更快，抓住小孩得 100 分。他们之间用共享频道互通情报，但只共享各自<b>亲眼看到</b>的东西。</li>
          <li>一局默认 180 秒；小孩全被抓则提前结束。</li>
        </ul>
        <p class="tiny">左侧可以切模式（我当小孩 / 我当杀人犯 / 纯观战）和视角（有限视角只能看到自己视野内，上帝视角全楼可见）。</p>`
    },
    {
      title: '楼里怎么走',
      html: `
        <p>每层从左到右是：<b>楼梯口 A — 左楼道 — 电梯厅（C 梯、D 梯）— 右楼道 — 楼梯口 B</b>。走廊是一条直线，左右楼道等长（侧栏「楼道长」可调）。</p>
        <ul>
          <li><b>楼梯</b>：A(n) 的楼梯通到 B(n+1) 和 B(n−1)；B(n) 的楼梯通到 A(n+1) 和 A(n−1)。所以每上一层，落点是另一侧的楼梯口。站在楼梯口按 W/S 就能上下楼。</li>
          <li>两条楼梯互不可见，楼梯段里也看不到楼层；A 和 B 在同一层互相看不见。</li>
          <li><b>电梯</b>：恒定 2 秒/层，开门 1.5 秒、保持 3 秒、关门 1.5 秒。保持方向顺路停靠，不中途掉头；没任务就原地待机。</li>
          <li>站在电梯厅能读到两部梯的楼层和方向；进了轿厢就只知道自己在哪一层、往哪走。</li>
          <li>电梯里会被抓——跟杀人犯同乘就是送。</li>
        </ul>`
    },
    {
      title: '看到的不一定是真的',
      html: `
        <ul>
          <li>看不到电梯的时候，显示的不是实时状态：它会按<b>你最后一次看到的方向匀速往前推算</b>，楼层后面带一个 <b>?</b>，表示「估计在这附近」。</li>
          <li>再回到电梯厅（或进轿厢）就会刷新成真实状态。</li>
          <li>轿厢里只看得到自己这一部，另一部的读数会变成 ?? 或旧的估计值。</li>
          <li>这条规则对 AI 同样生效：<b class="killer">杀人犯</b>会把「电梯停在某层」当线索去查，因为那通常意味着刚有人在那儿下梯；<b class="kid">小孩</b>偶尔会按了呼梯就跑，故意留一个假停靠来骗人。</li>
        </ul>`
    },
    {
      title: '怎么操作',
      html: `
        <table class="keys">
          <tr><td><kbd>A</kbd><kbd>D</kbd> / <kbd>←</kbd><kbd>→</kbd></td><td>左右移动</td></tr>
          <tr><td><kbd>W</kbd><kbd>S</kbd></td><td>楼梯口上楼 / 下楼；楼梯上按反方向键，原地掉头走回出发点</td></tr>
          <tr><td><kbd>Q</kbd><kbd>E</kbd></td><td>电梯厅里按 ▼ / ▲ 呼梯（画面最左一列是 C 的按钮，最右一列是 D 的，和楼层对齐）；进轿厢后是开门 / 关门</td></tr>
          <tr><td><kbd>空格</kbd></td><td>站在电梯厅左半边按 ▼、右半边按 ▲；电梯门开着时进 / 出电梯</td></tr>
          <tr><td><kbd>P</kbd></td><td>暂停</td></tr>
          <tr><td>鼠标</td><td>点墙上的 ▲▼ 呼梯；轿厢里点左右两侧选层（再点取消），旁边一列是开门 / 关门</td></tr>
        </table>
        <p class="tiny">侧栏「呼梯按钮」那个小圆点：亮 = 两部梯公用一套按钮（按下后由系统派梯）；灭 = 每部梯一套按钮（各按各的）。</p>`
    }
  ];

  const UI = {
    intro: { page: 0, onDone: null, bound: false },
    hallMode: 'shared',   // 'shared' 公用一套（点亮）| 'split' 每部梯一套（熄灭）

    init() {
      // 用 config.js 的 DEFAULTS 初始化界面，config 改了就真的生效
      const D = EK.DEFAULTS;
      const setVal = (id, v) => { const el = $(id); if (el && v != null) el.value = v; };
      setVal('pSecFloor', D.elevator.secPerFloor);
      setVal('pDoorOpen', D.elevator.doorOpenSec);
      setVal('pDoorHold', D.elevator.doorHoldSec);
      setVal('pDoorClose', D.elevator.doorCloseSec);
      setVal('pCorridor', D.corridorSideM);
      setVal('pKidSpeed', D.kid.speed);
      setVal('pKidStair', D.kid.stairSpeed);
      setVal('pKillerSpeed', D.killer.speed);
      setVal('pKillerStair', D.killer.stairSpeed);
      setVal('pVision', D.kid.vision);
      setVal('pReaction', D.kid.reactionSec);
      setVal('pGrip', D.capture.gripSec);
      setVal('pChannel', D.channel.ttlSec);
      setVal('kidsNum', D.kids);
      setVal('killersNum', D.killers);
      setVal('roundNum', D.roundSeconds);

      for (const [sid, vid] of SLIDERS) {
        const s = $(sid), v = $(vid);
        const sync = () => { v.textContent = s.value; };
        s.addEventListener('input', sync);
        sync();
      }
      $('hallToggle').addEventListener('click', () => this.setHallMode(this.hallMode === 'shared' ? 'split' : 'shared'));
      this.setHallMode(D.elevator.hallButtons || 'shared');
      $('ver').textContent = EK.VERSION;
      $('introVer').textContent = EK.VERSION;
      document.title = `电梯公寓大逃杀 ${EK.VERSION}`;
    },

    setHallMode(m) {
      this.hallMode = m;
      $('hallDot').classList.toggle('on', m === 'shared');
      $('hallModeText').textContent = m === 'shared' ? '公用一套' : '每部梯一套';
    },

    readSettings() {
      const num = (id) => parseFloat($(id).value);
      const vision = num('pVision');
      return {
        mode: $('modeSel').value,
        view: $('viewSel').value,
        speed: parseFloat($('speedSel').value),
        cfg: {
          kids: parseInt($('kidsNum').value, 10) || 3,
          killers: parseInt($('killersNum').value, 10) || 2,
          roundSeconds: parseInt($('roundNum').value, 10) || 180,
          corridorSideM: num('pCorridor'),
          elevator: {
            secPerFloor: num('pSecFloor'),
            doorOpenSec: num('pDoorOpen'),
            doorHoldSec: num('pDoorHold'),
            doorCloseSec: num('pDoorClose'),
            hallButtons: this.hallMode
          },
          kid: { speed: num('pKidSpeed'), stairSpeed: num('pKidStair'), vision, reactionSec: num('pReaction') },
          killer: { speed: num('pKillerSpeed'), stairSpeed: num('pKillerStair'), vision },
          capture: { gripSec: num('pGrip') },
          channel: { ttlSec: num('pChannel') }
        }
      };
    },

    /* ---------- 简介 / 教程 ---------- */

    showIntro(onDone) {
      this.intro.onDone = onDone || null;
      this.intro.page = 0;
      $('intro').classList.remove('hidden');
      this.renderIntro();
      if (!this.intro.bound) {
        this.intro.bound = true;
        $('introSkip').onclick = () => this.closeIntro();
        $('introPrev').onclick = () => { if (this.intro.page > 0) { this.intro.page--; this.renderIntro(); } };
        $('introNext').onclick = () => {
          if (this.intro.page < INTRO.length - 1) { this.intro.page++; this.renderIntro(); }
          else this.closeIntro();
        };
        document.addEventListener('keydown', (e) => {
          if ($('intro').classList.contains('hidden')) return;
          if (e.code === 'Escape') this.closeIntro();
          else if (e.code === 'ArrowRight' || e.code === 'Enter') $('introNext').click();
          else if (e.code === 'ArrowLeft') $('introPrev').click();
        });
      }
    },

    renderIntro() {
      const p = INTRO[this.intro.page];
      $('introBody').innerHTML = `<h3>${p.title}</h3>${p.html}`;
      $('introDots').innerHTML = INTRO.map((_, i) => `<i class="${i === this.intro.page ? 'on' : ''}"></i>`).join('');
      $('introPrev').disabled = this.intro.page === 0;
      $('introNext').textContent = this.intro.page === INTRO.length - 1 ? '开始游戏' : '下一页';
      $('introBody').scrollTop = 0;
    },

    closeIntro() {
      $('intro').classList.add('hidden');
      const cb = this.intro.onDone;
      this.intro.onDone = null;
      if (cb) cb();
    },

    introOpen() { return !$('intro').classList.contains('hidden'); },

    /* ---------- HUD ---------- */

    update(world, settings, human) {
      const cfg = world.cfg;
      $('clock').textContent = U.fmtTime(Math.max(0, cfg.roundSeconds - Math.min(world.time, cfg.roundSeconds)));
      $('aliveKids').textContent = world.kidsAlive().length;
      $('caught').textContent = world.kills;

      // 电梯板：精确读数 / 按记忆外推的虚影（带 ?） / 完全不知道
      const board = $('elevBoard');
      const viewer = settings.view === 'god' ? null : human;
      board.innerHTML = world.elev.cars.map((c) => {
        const d = EK.Perception.carDisplay(world, viewer, c);
        if (!d.known) {
          return `<div class="elevrow"><span>${c.id}梯</span><span class="unk">??</span><span class="dir">-</span><span></span></div>`;
        }
        const dir = d.dir > 0 ? '▲' : d.dir < 0 ? '▼' : '■';
        const open = d.exact && c.doorsOpen ? '<span class="open">开门</span>' : '';
        const q = d.exact ? '' : '<span class="q">?</span>';
        return `<div class="elevrow"><span>${c.id}梯</span><span>${Math.round(d.floor)}F${q}</span>` +
               `<span class="dir">${dir}</span><span>${open}</span></div>`;
      }).join('');

      const rows = [];
      for (const a of world.actors) {
        if (!a.alive && a.kind === 'kid') {
          rows.push(`<div class="scoreline"><span class="${a === human ? 'human' : 'kid'}">${a.name}</span><span>被抓 ${U.fmtTime(a.capturedAt || 0)}</span></div>`);
        } else if (a.kind === 'kid') {
          rows.push(`<div class="scoreline"><span class="${a === human ? 'human' : 'kid'}">${a.name}</span><span>${Math.round(a.score)}</span></div>`);
        } else {
          rows.push(`<div class="scoreline"><span class="${a === human ? 'human' : 'killer'}">${a.name}</span><span>抓 ${a.kills}</span></div>`);
        }
      }
      $('scoreList').innerHTML = rows.join('');

      this.renderYou(world, human);
      this.renderTouch(human);
      this.renderLog(world, human, settings.view === 'fog');
    },

    /** 触屏上 ▲/▼ 两个小键：电梯厅里是呼梯，轿厢里变成开/关门（用电梯符号：尖角朝外=开门，朝内=关门） */
    renderTouch(human) {
      const q = $('tbQ'), e = $('tbE');
      if (!q || !e) return;
      const inCar = human && human.location.type === 'car';
      q.innerHTML = inCar ? '<span class="dooricon">&#9654;<i></i>&#9664;</span>' : '▼';
      e.innerHTML = inCar ? '<span class="dooricon">&#9664;<i></i>&#9654;</span>' : '▲';
    },

    renderYou(world, human) {
      const el = $('youStatus');
      if (!human) { el.textContent = '观战中 · 全 AI 对局'; return; }
      const b = world.building;
      const L = human.location;
      if (!human.alive) {
        el.textContent = `你已被抓（${U.fmtTime(human.capturedAt || 0)}） · 转为观战`;
        return;
      }
      if (L.type === 'car') {
        const car = world.elev.get(L.carId);
        const dir = car.dir > 0 ? '▲上行' : car.dir < 0 ? '▼下行' : '■待机';
        const pressed = [...car.carCalls].sort((x, y) => x - y).map((f) => f + 'F').join(' ');
        const tail = car.doorsOpen ? ' · 空格下梯 · Q 开门 · E 关门' : ' · Q 开门 · E 关门';
        el.textContent = `${car.id} 梯内 · ${Math.round(car.floor)}F ${dir} · 已按 ${pressed || '无'}${tail}`;
        return;
      }
      if (L.type === 'stair') {
        const back = L.dir > 0 ? 'S' : 'W';
        el.textContent = `楼梯上 · ${L.fromFloor}F → ${L.toFloor}F（${Math.round(L.progress * 100)}%）· 按 ${back} 掉头`;
        return;
      }
      const region = b.regionName(L.x, world.cfg.stairReachM);
      let hint = '';
      if (region === '电梯厅') {
        const open = world.openCarAt(L.floor);
        if (open.length) hint = ' · 门开着，空格上梯';
        else if (!world.hallCallsAt(L.floor).length) hint = ' · Q ▼ / E ▲，或空格按脚下的按钮';
        else hint = ' · 等梯中';
      } else if (region === '楼梯口A' || region === '楼梯口B') {
        hint = ' · W 上楼 / S 下楼';
      } else {
        hint = ' · 走到楼梯口才能上下楼';
      }
      el.textContent = `你在 ${L.floor}F ${region}${hint}`;
    },

    _logCount: 0,
    renderLog(world, human, fog) {
      const box = $('log');
      const events = world.events;
      if (this._logCount > events.length) this._logCount = 0;   // 重开
      if (this._logCount === events.length) return;

      const keepScroll = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
      const onlyHere = fog && human && human.alive;
      let html = '';
      for (let i = this._logCount; i < events.length; i++) {
        const e = events[i];
        if (onlyHere && e.floor != null && e.floor !== human.location.floor && !e.text.includes(human.name)) continue;
        html += `<div class="${e.kind}">${U.fmtTime(e.t)} ${escapeHtml(e.text)}</div>`;
      }
      this._logCount = events.length;
      if (!html) return;
      box.insertAdjacentHTML('beforeend', html);
      while (box.childElementCount > 200) box.removeChild(box.firstElementChild);
      if (keepScroll) box.scrollTop = box.scrollHeight;
    },

    resetLog() { this._logCount = 0; $('log').innerHTML = ''; },

    overlay(html) {
      $('overlayCard').innerHTML = html;
      $('overlay').classList.remove('hidden');
    },
    hideOverlay() { $('overlay').classList.add('hidden'); }
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  EK.UI = UI;
})();

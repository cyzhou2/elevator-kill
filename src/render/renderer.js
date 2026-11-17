/* Canvas 渲染：楼层剖面 + 电梯竖井 + 楼梯竖井 + 角色 + 呼梯按钮 + 轿厢选层面板
 */
(function () {
  const EK = (globalThis.EK = globalThis.EK || {});
  const P = EK.Perception;
  const U = EK.util;

  const COL = {
    bg: '#0d1117', row: '#161d27', rowAlt: '#131a23', line: '#232d3a',
    label: '#7c8b9d', landing: '#2b3a4d', lobby: '#1d2836',
    shaft: '#10161e', car: '#3a4b60', carEdge: '#5d748d',
    kid: '#3ddc84', killer: '#ff4d5f', you: '#ffd166', intel: '#ff9aa4',
    call: '#8fd3ff', floorLabel: '#8fa2b6', floorMajor: '#cfe3ff'
  };

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.geo = null;
      this.hallHits = [];
      this.carHits = [];
      this.carBtnHits = [];
      this.trails = new Map();
    }

    resize(world) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
      this.canvas.width = Math.round(W * dpr);
      this.canvas.height = Math.round(H * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const padTop = 20, padBottom = 18;
      // 窄屏（手机竖屏）把两侧收窄，把空间留给楼层本身
      const narrow = W < 640;
      const btnW = narrow ? 15 : 20, btnH = narrow ? 12 : 16, btnGap = narrow ? 3 : 4;
      const groupW = btnW * 2 + btnGap;
      const labelRight = narrow ? 24 : 30;
      const groupX = narrow ? 30 : 36;
      const padLeft = narrow ? 86 : 108, padRight = narrow ? 86 : 108;
      const floors = world.cfg.floors;
      const rowH = (H - padTop - padBottom) / floors;
      const cw = W - padLeft - padRight;
      const L = world.building.L;
      this.geo = {
        W, H, padTop, padBottom, padLeft, padRight, floors, rowH, cw, L,
        narrow, btnW, btnH, btnGap, groupW, labelRight, groupX,
        xM: (m) => padLeft + (m / L) * cw,
        yFloor: (f) => padTop + (floors - f) * rowH + rowH * 0.5,
        yRowTop: (f) => padTop + (floors - f) * rowH,
        shaftA: padLeft - 12,
        shaftB: W - padRight + 12
      };
      return this.geo;
    }

    draw(world, view, focus) {
      const g = this.geo || this.resize(world);
      const ctx = this.ctx;
      const fog = view === 'fog' && !!focus;
      this.hallHits = [];
      this.carHits = [];
      this.carBtnHits = [];
      this.focusCarId = focus && focus.location && focus.location.type === 'car' ? focus.location.carId : null;

      ctx.clearRect(0, 0, g.W, g.H);
      ctx.fillStyle = COL.bg;
      ctx.fillRect(0, 0, g.W, g.H);

      for (let f = 1; f <= g.floors; f++) this.drawFloor(world, f, g);

      const focusFloor = focus && focus.location ? focus.location.floor : null;
      if (focusFloor) {
        ctx.fillStyle = 'rgba(143, 211, 255, 0.06)';
        ctx.fillRect(g.padLeft, g.yRowTop(focusFloor) + 1, g.cw, g.rowH - 2);
      }

      this.drawStairShaft('A', g.shaftA, g);
      this.drawStairShaft('B', g.shaftB, g);

      for (const car of world.elev.cars) {
        const x = g.xM(world.carDoorX(car.id));
        this.drawShaft(x, g);
        const disp = P.carDisplay(world, fog ? focus : null, car);
        this.drawCar(world, car, x, g, fog, focus, disp);
      }

      // 呼梯按钮：画布最左 = C 的一组，最右 = D 的一组，按楼层对齐；
      // 人在轿厢里时这两列换成选层面板
      this.drawHallButtons(world, g, fog, focus);

      // 角色：先画拖尾再画点（有限视角下看不见的人不画，避免泄露位置）
      const shown = [];
      for (const a of world.actors) {
        if (!a.alive) continue;
        if (fog && a !== focus && !P.canSeeShared(world, focus, a)) continue;
        shown.push(a);
      }
      for (const a of shown) {
        const p = this.actorPoint(world, a, g);
        if (p) this.recordTrail(world, a, p.x, p.y);
        this.drawTrail(world, a);
      }
      for (const a of shown) this.drawActor(world, a, g, true);

      if (focus && focus.location.type === 'car') {
        this.drawCarPanel(world, world.elev.get(focus.location.carId), focus, g);
      }

      this.drawFrame(g);
    }

    hitTest(mx, my) {
      for (const b of this.carHits) {
        if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) {
          return b.door ? { type: 'carDoor', action: b.door } : { type: 'car', floor: b.floor };
        }
      }
      for (const b of this.carBtnHits) {
        if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) {
          return { type: 'carBtn', floor: b.floor, carId: b.carId };
        }
      }
      for (const b of this.hallHits) {
        if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) {
          return { type: 'hall', floor: b.floor, dir: b.dir, carId: b.carId };
        }
      }
      return null;
    }

    drawFrame(g) {
      const ctx = this.ctx;
      ctx.strokeStyle = '#2a3646';
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, g.W - 1, g.H - 1);
    }

    drawFloor(world, f, g) {
      const ctx = this.ctx;
      const top = g.yRowTop(f);
      const y = g.yFloor(f);
      const h = g.rowH;
      ctx.fillStyle = f % 2 ? COL.row : COL.rowAlt;
      ctx.fillRect(g.padLeft, top + 1, g.cw, h - 2);

      ctx.strokeStyle = COL.line;
      ctx.beginPath();
      ctx.moveTo(g.padLeft, y + h * 0.3);
      ctx.lineTo(g.padLeft + g.cw, y + h * 0.3);
      ctx.stroke();

      const lx0 = g.xM(world.building.lobbyStart), lx1 = g.xM(world.building.lobbyEnd);
      ctx.fillStyle = COL.lobby;
      ctx.fillRect(lx0, top + 1, lx1 - lx0, h - 2);

      ctx.strokeStyle = '#2b3746';
      ctx.lineWidth = 1;
      const doorTop = y + h * 0.36, doorBot = y + h * 0.72;
      for (const [m0, m1] of [[2.2, 9.4], [14.6, 21.8]]) {
        for (let m = m0; m <= m1; m += 2.4) {
          const x = g.xM(m);
          ctx.beginPath();
          ctx.moveTo(x, doorTop);
          ctx.lineTo(x, doorBot);
          ctx.stroke();
        }
      }

      for (const [k, x] of [['A', g.xM(world.building.aX)], ['B', g.xM(world.building.bX)]]) {
        ctx.fillStyle = COL.landing;
        ctx.fillRect(x - 9, top + h * 0.1, 18, h * 0.8);
        ctx.fillStyle = COL.label;
        ctx.font = '10px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(k, x, top + h * 0.5 + 3);
      }

      if (f === 1) {
        ctx.fillStyle = '#3d4f63';
        ctx.font = '8px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillText('左楼道', g.xM((world.building.aX + world.building.lobbyStart) / 2), top + h * 0.42);
        ctx.fillText('电梯厅', g.xM((world.building.lobbyStart + world.building.lobbyEnd) / 2), top + h * 0.42);
        ctx.fillText('右楼道', g.xM((world.building.lobbyEnd + world.building.bX) / 2), top + h * 0.42);
        ctx.textAlign = 'left';
      }

      // 楼层标识挪到 drawHallButtons 里画（要带轿厢按键框）
    }

    drawStairShaft(landing, x, g) {
      const ctx = this.ctx;
      const top = g.yRowTop(g.floors) + 2, bottom = g.yRowTop(1) + g.rowH - 2;
      ctx.strokeStyle = '#28323f';
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      ctx.strokeStyle = '#3c5069';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = COL.label;
      ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(landing === 'A' ? '梯0' : '梯1', x, top - 5);
      ctx.textAlign = 'left';
    }

    drawShaft(x, g) {
      const ctx = this.ctx;
      ctx.fillStyle = COL.shaft;
      ctx.fillRect(x - 15, g.yRowTop(g.floors) + 4, 30, g.rowH * g.floors - 8);
      ctx.strokeStyle = '#202b38';
      ctx.strokeRect(x - 15, g.yRowTop(g.floors) + 4, 30, g.rowH * g.floors - 8);
    }

    drawCar(world, car, x, g, fog, focus, disp) {
      const ctx = this.ctx;
      if (!disp || !disp.known) return;               // 从没见过，不画
      const cy = g.yFloor(disp.floor);
      const h = Math.min(g.rowH * 0.6, 20);
      const w = 16;

      if (!disp.exact) {
        // 按最后一次看到的方向匀速外推的虚影 + 问号
        ctx.save();
        ctx.globalAlpha = 0.6;
        ctx.setLineDash([3, 3]);
        ctx.fillStyle = 'rgba(90, 120, 150, 0.22)';
        ctx.fillRect(x - w / 2, cy - h / 2, w, h);
        ctx.strokeStyle = '#7f9ab5';
        ctx.lineWidth = 1;
        ctx.strokeRect(x - w / 2 + 0.5, cy - h / 2 + 0.5, w - 1, h - 1);
        ctx.setLineDash([]);
        ctx.fillStyle = '#a9d8ff';
        ctx.font = '9px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillText('?', x, cy - h / 2 - 4);
        ctx.fillText(car.id, x, cy + 3);
        ctx.textAlign = 'left';
        ctx.restore();
        return;
      }

      const inside = fog && focus && focus.location.type === 'car' && focus.location.carId === car.id;
      const throughDoors = fog && focus && focus.location.type === 'floor'
        && car.doorsOpen && Math.abs(car.floor - focus.location.floor) < 0.05
        && world.building.inLobby(focus.location.x);
      const panelOnly = fog && !inside && !throughDoors;

      if (panelOnly) {
        // 只在电梯厅能看到楼层显示屏：给一个读数块，不暴露轿厢里的人
        ctx.fillStyle = 'rgba(143, 211, 255, 0.16)';
        ctx.fillRect(x - 9, cy - 6, 18, 12);
        ctx.fillStyle = COL.call;
        ctx.font = '9px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(car.dir > 0 ? '▲' : car.dir < 0 ? '▼' : '■', x, cy + 3);
        ctx.textAlign = 'left';
        return;
      }

      ctx.fillStyle = COL.car;
      ctx.fillRect(x - w / 2, cy - h / 2, w, h);
      ctx.strokeStyle = car.doorsOpen ? COL.call : COL.carEdge;
      ctx.lineWidth = car.doorsOpen ? 1.6 : 1;
      ctx.strokeRect(x - w / 2, cy - h / 2, w, h);

      if (!car.doorsOpen) {
        ctx.strokeStyle = '#22303f';
        ctx.beginPath();
        ctx.moveTo(x, cy - h / 2);
        ctx.lineTo(x, cy + h / 2);
        ctx.stroke();
      }

      ctx.fillStyle = car.dir === 0 ? '#5a6b7c' : COL.call;
      ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(car.dir > 0 ? '▲' : car.dir < 0 ? '▼' : '■', x, cy - h / 2 - 3);
      ctx.fillText(car.id, x, cy + 3);
      ctx.textAlign = 'left';

      const pax = Array.from(car.passengers).filter((p) => p.alive);
      pax.forEach((p, i) => {
        const px = x - w / 2 + 5 + (i % 3) * 7;
        const py = cy + h / 2 - 5 - Math.floor(i / 3) * 7;
        ctx.fillStyle = p.kind === 'kid' ? COL.kid : COL.killer;
        ctx.beginPath();
        ctx.arc(px, py, 2.6, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    /** 每层墙上的呼梯按钮：位置以 world.hallButtonSpecs() 为准（C 全在左、D 全在右） */
    hallButtonSpecs(world) {
      return world.hallButtonSpecs();
    }

    /** 呼梯按钮：回到 v4 的位置——C 的贴在电梯厅左边、D 的贴在右边；楼层标识两端加「轿厢按键框」 */
    drawHallButtons(world, g, fog, focus) {
      const ctx = this.ctx;
      const b = world.building;
      const split = world.cfg.elevator.hallButtons === 'split';
      const bw = g.narrow ? 14 : 18, bh = g.narrow ? 11 : 14;
      const focusFloor = focus && focus.location.type === 'floor' ? focus.location.floor : null;
      const active = (f) => !fog && (!focus || focusFloor === f);

      // 轿厢按键框：只有「看得到电梯状态」的时候才画（上帝视角 / 在轿厢里 / 杀人犯共享视野）
      const focusK = focus && focus.kind === 'killer';
      const inCar = focus && focus.location.type === 'car';
      const showFrames = !fog || inCar || focusK;
      const myCar = inCar ? focus.location.carId : null;

      for (let f = 1; f <= g.floors; f++) {
        const dim = fog && !inCar && focusFloor !== f;
        const y = g.yFloor(f);
        const by = y - bh / 2;

        // —— 呼梯按钮（墙上的，C 左 D 右）——
        // 有限视角：只看得见自己所在那层的按钮；在轿厢里看不见墙上的按钮
        const hallVisible = !fog || (!inCar && focusFloor === f);
        const specs = split
          ? [
              { x: b.lobbyStart - 0.85, dir: -1, carId: 'C' },
              { x: b.lobbyStart - 0.2, dir: 1, carId: 'C' },
              { x: b.lobbyEnd + 0.2, dir: -1, carId: 'D' },
              { x: b.lobbyEnd + 0.85, dir: 1, carId: 'D' }
            ]
          : [
              { x: b.lobbyStart - 0.55, dir: -1, carId: null },
              { x: b.lobbyEnd + 0.55, dir: 1, carId: null }
            ];
        for (const sp of specs) {
          if (!hallVisible) break;
          const cx = g.xM(sp.x);
          const x = cx - bw / 2;
          const lit = !dim && world.hallCalls.some((c) => c.floor === f && c.dir === sp.dir
            && (c.carId || null) === (sp.carId || null));
          ctx.globalAlpha = dim ? 0.25 : active(f) ? 1 : 0.65;
          ctx.fillStyle = lit ? COL.call : '#243244';
          ctx.fillRect(x, by, bw, bh);
          ctx.strokeStyle = lit ? '#d6efff' : '#4d6378';
          ctx.lineWidth = 1;
          ctx.strokeRect(x + 0.5, by + 0.5, bw - 1, bh - 1);
          ctx.fillStyle = lit ? '#0d1117' : '#a9d8ff';
          ctx.font = `${g.narrow ? 7 : 9}px ui-monospace, monospace`;
          ctx.textAlign = 'center';
          ctx.fillText(sp.dir > 0 ? '▲' : '▼', x + bw / 2, by + bh - 4);
          ctx.textAlign = 'left';
          ctx.globalAlpha = 1;
          if (!dim) this.hallHits.push({ x, y: by, w: bw, h: bh, floor: f, dir: sp.dir, carId: sp.carId });
        }

        // —— 楼层标识 + 轿厢按键框（左 = C 梯，右 = D 梯）——
        if (!showFrames) {
          // 看不到电梯状态：只画纯楼层号
          const isMajor = f % 5 === 0;
          ctx.fillStyle = dim ? '#4a5a6c' : isMajor ? COL.floorMajor : COL.floorLabel;
          ctx.font = `bold ${g.narrow ? 9 : 11}px ui-monospace, monospace`;
          ctx.textAlign = 'right';
          ctx.fillText(`${f}F`, g.labelRight, y + 4);
          ctx.textAlign = 'left';
          ctx.fillText(`${f}F`, g.W - g.labelRight, y + 4);
          ctx.textAlign = 'left';
          continue;
        }
        for (const side of ['C', 'D']) {
          const car = world.elev.get(side);
          if (!car) continue;
          const pressed = car.carCalls.has(f);
          const here = Math.abs(car.floor - f) < 0.05 && car.doorsOpen;
          const fw = g.narrow ? 24 : 30, fh = g.narrow ? 12 : 15;
          const fx = side === 'C' ? (g.labelRight - fw + 2) : (g.W - g.labelRight - 2);
          const fy = y - fh / 2;
          // 框：没按就是背景色（只有细边），按下变高亮，到层/取消自动弹起
          ctx.globalAlpha = dim ? 0.3 : 1;
          ctx.fillStyle = pressed ? COL.call : 'rgba(13,17,23,0.6)';
          ctx.fillRect(fx, fy, fw, fh);
          ctx.strokeStyle = pressed ? '#d6efff' : here ? COL.you : '#3a4a5c';
          ctx.lineWidth = pressed ? 1.4 : 1;
          ctx.strokeRect(fx + 0.5, fy + 0.5, fw - 1, fh - 1);
          ctx.fillStyle = pressed ? '#0d1117' : COL.floorLabel;
          ctx.font = `bold ${g.narrow ? 8 : 10}px ui-monospace, monospace`;
          ctx.textAlign = 'center';
          ctx.fillText(`${f}F`, fx + fw / 2, fy + fh - (g.narrow ? 3 : 4));
          ctx.textAlign = 'left';
          ctx.globalAlpha = 1;
          this.carBtnHits.push({ x: fx, y: fy, w: fw, h: fh, floor: f, carId: side, pressable: this.canPressCarButton(world, side) });
        }
      }
    }

    canPressCarButton(world, carId) {
      if (world.freePlay && world.freePlay()) return true;
      const focusCar = this.focusCarId || null;
      return focusCar === carId;
    }
    /** 进了轿厢才出现：开门 / 关门（现代电梯符号：尖角朝内=关门，朝外=开门，中间一条竖线） */
    drawCarPanel(world, car, focus, g) {
      if (g.narrow) return;                       // 手机用底部触控栏
      const ctx = this.ctx;
      const bw = 44, bh = 26, gap = 6;
      const x = 40;
      // 按楼层对齐：开门键在 10F 那一行，关门键在 9F 那一行
      const y = g.yFloor(Math.min(10, g.floors)) - bh / 2;
      const doors = [
        { icon: 'open', enabled: car.canOpen(), y },
        { icon: 'close', enabled: car.canClose(), y: y + bh + gap }
      ];
      const totalH = doors.length * (bh + gap) + 4;
      ctx.fillStyle = 'rgba(16, 23, 32, 0.92)';
      ctx.fillRect(x - 5, y - 5, bw + 10, totalH);
      ctx.strokeStyle = '#26323f';
      ctx.lineWidth = 1;
      ctx.strokeRect(x - 5, y - 5, bw + 10, totalH);
      for (const d of doors) {
        ctx.fillStyle = d.enabled ? '#20303f' : '#151d26';
        ctx.fillRect(x, d.y, bw, bh);
        ctx.strokeStyle = d.enabled ? '#5b7288' : '#2a3644';
        ctx.strokeRect(x + 0.5, d.y + 0.5, bw - 1, bh - 1);
        this.drawDoorIcon(x, d.y, bw, bh, d.icon, d.enabled ? '#cfe6ff' : '#44556a');
        this.carHits.push({ x, y: d.y, w: bw, h: bh, door: d.icon });
      }
    }

    /** 电梯门符号：中间一条细竖线，两侧各一个正三角形 */
    drawDoorIcon(x, y, w, h, kind, color) {
      const ctx = this.ctx;
      const cx = x + w / 2, cy = y + h / 2;
      const th = Math.min(h * 0.78, 18);
      const tw = th * 0.5;
      const gapHalf = 1.5;                        // 三角形顶点离中线的距离
      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      // 中垂线
      ctx.beginPath();
      ctx.moveTo(cx + 0.5, cy - th / 2);
      ctx.lineTo(cx + 0.5, cy + th / 2);
      ctx.stroke();
      // 三角形：dir = +1 表示顶点朝右
      const tri = (apexX, dir) => {
        const baseX = apexX - dir * tw;
        ctx.beginPath();
        ctx.moveTo(apexX, cy);
        ctx.lineTo(baseX, cy - th / 2);
        ctx.lineTo(baseX, cy + th / 2);
        ctx.closePath();
        ctx.fill();
      };
      if (kind === 'close') {
        tri(cx - gapHalf, 1);          // 左边顶点朝右（朝内）
        tri(cx + gapHalf, -1);         // 右边顶点朝左（朝内）
      } else {
        tri(cx - gapHalf - tw, -1);    // 左边顶点朝左（朝外）
        tri(cx + gapHalf + tw, 1);     // 右边顶点朝右（朝外）
      }
    }
    drawActor(world, a, g, visible) {
      const ctx = this.ctx;
      const p = this.actorPoint(world, a, g);
      if (!p) return;
      const x = p.x, y = p.y;
      const color = a.kind === 'kid' ? COL.kid : COL.killer;
      ctx.globalAlpha = visible ? 1 : 0.18;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, a.kind === 'killer' ? 5.5 : 4.8, 0, Math.PI * 2);
      ctx.fill();

      if (a.controlled) {
        ctx.strokeStyle = COL.you;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(x, y, 8.5, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (visible) {
        ctx.fillStyle = color;
        ctx.font = '9px ui-monospace, monospace';
        ctx.fillText(a.id, x + 7, y + 3);
      }
      ctx.globalAlpha = 1;
    }

    /* ---------- 拖尾 ---------- */

    /** 角色在画面上的位置；轿厢里的人不画（由轿厢内部小点表示） */
    actorPoint(world, a, g) {
      const loc = a.location;
      if (loc.type === 'car') return null;
      if (loc.type === 'stair') {
        // 楼梯走成斜线：从出发楼梯口斜着走到楼层另一侧的落点
        const b = world.building;
        const x0 = g.xM(b.landingX(loc.fromLanding));
        const y0 = g.yFloor(loc.fromFloor) - g.rowH * 0.16;
        const x1 = g.xM(b.landingX(loc.toLanding));
        const y1 = g.yFloor(loc.toFloor) - g.rowH * 0.16;
        return { x: U.lerp(x0, x1, loc.progress), y: U.lerp(y0, y1, loc.progress) };
      }
      return { x: g.xM(loc.x), y: g.yFloor(loc.floor) - g.rowH * 0.16 };
    }

    clearTrails() { this.trails = new Map(); }

    recordTrail(world, a, x, y) {
      const cfg = world.cfg.trail || {};
      if (cfg.enabled === false) return;
      let arr = this.trails.get(a.id);
      if (!arr) { arr = []; this.trails.set(a.id, arr); }
      const last = arr[arr.length - 1];
      const jump = last ? Math.hypot(x - last.x, y - last.y) : 0;
      // 换空间（地面/楼梯）或瞬移就断开，不要拉一条假线
      if (!last || last.space !== a.location.type || jump > (cfg.maxJumpPx || 80)) arr.length = 0;
      arr.push({ t: world.time, x, y, space: a.location.type });
      const life = cfg.lifeSec || 1.4;
      while (arr.length > 2 && world.time - arr[0].t > life) arr.shift();
      const max = cfg.maxPoints || 90;
      while (arr.length > max) arr.shift();
    }

    drawTrail(world, a) {
      const arr = this.trails.get(a.id);
      if (!arr || arr.length < 2) return;
      const cfg = world.cfg.trail || {};
      const life = cfg.lifeSec || 1.4;
      const alpha = cfg.alpha != null ? cfg.alpha : 0.5;
      const headW = cfg.headWidth || 5;
      const tailW = cfg.tailWidth || 1;
      const ctx = this.ctx;
      const color = a.kind === 'kid' ? COL.kid : COL.killer;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let i = 1; i < arr.length; i++) {
        const p0 = arr[i - 1], p1 = arr[i];
        const k = 1 - (world.time - p1.t) / life;       // 1 = 最新
        if (k <= 0) continue;
        const head = i / (arr.length - 1);              // 越靠近头部越粗越亮
        ctx.globalAlpha = alpha * k * k * (0.3 + 0.7 * head);
        ctx.strokeStyle = color;
        ctx.lineWidth = tailW + (headW - tailW) * k * head;
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }

  EK.Renderer = Renderer;
  EK.COLORS = COL;
})();

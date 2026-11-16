/* 建筑拓扑（1D 走廊版）
 * 每层从左到右：楼梯口A — 左楼道 — 电梯厅 — 右楼道 — 楼梯口B
 * 左右楼道等长（corridorSideM），电梯厅宽 lobbyWidthM。
 * 楼梯连接：A(n)↔B(n±1) 属于楼梯0；B(n)↔A(n±1) 属于楼梯1。
 */
(function () {
  const EK = (globalThis.EK = globalThis.EK || {});

  const U = (EK.util = EK.util || {});
  U.clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  U.lerp = (a, b, t) => a + (b - a) * t;
  U.sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
  U.dist = (a, b) => Math.abs(a - b);
  U.rnd = (a, b) => a + Math.random() * (b - a);
  U.pick = (arr) => arr[(Math.random() * arr.length) | 0];
  U.fmtTime = (s) => {
    s = Math.max(0, Math.ceil(s));
    return `${String((s / 60) | 0).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };

  EK.Building = class Building {
    constructor(cfg) {
      this.cfg = cfg;
      this.floorCount = cfg.floors;
      this.side = cfg.corridorSideM;
      this.lobbyWidth = cfg.lobbyWidthM;
      this.inset = cfg.landingInsetM;
      this.L = this.side * 2 + this.lobbyWidth;
      this.lobbyStart = this.side;
      this.lobbyEnd = this.side + this.lobbyWidth;
      this.aX = this.inset;
      this.bX = this.L - this.inset;
    }

    /** 楼层内区域：'A' | 'L'（电梯厅）| 'B' */
    region(x) {
      if (x < this.lobbyStart) return 'A';
      if (x <= this.lobbyEnd) return 'L';
      return 'B';
    }

    /** 给玩家看的区域名：楼梯口A / 左楼道 / 电梯厅 / 右楼道 / 楼梯口B */
    regionName(x, reachM) {
      const r = reachM || 1.2;
      if (this.inLobby(x)) return '电梯厅';
      if (Math.abs(x - this.aX) <= r) return '楼梯口A';
      if (Math.abs(x - this.bX) <= r) return '楼梯口B';
      return x < this.lobbyStart ? '左楼道' : '右楼道';
    }

    landingX(landing) { return landing === 'A' ? this.aX : this.bX; }

    inLobby(x) { return x >= this.lobbyStart && x <= this.lobbyEnd; }

    /** 楼层是否可用（1..N） */
    validFloor(f) { return f >= 1 && f <= this.floorCount; }

    /**
     * 某个楼梯口出发的楼梯段。
     * dir: +1 上楼, -1 下楼。返回 null 表示端点层没有这个方向。
     */
    stairFlight(floor, landing, dir) {
      const toFloor = floor + dir;
      if (!this.validFloor(toFloor)) return null;
      return {
        stair: landing === 'A' ? 0 : 1,
        from: { floor, landing },
        to: { floor: toFloor, landing: landing === 'A' ? 'B' : 'A' },
        dir
      };
    }

    /** 该层该楼梯口是否存在上下两个方向 */
    stairDirs(floor, landing) {
      return [-1, 1].filter((d) => !!this.stairFlight(floor, landing, d));
    }

    label(floor) { return `${floor}F`; }
  };
})();

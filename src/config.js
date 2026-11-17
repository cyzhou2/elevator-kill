/* 电梯公寓大逃杀 — 参数中心
 * 所有可调数值集中在此。界面滑块只改这里的一份运行时副本。
 */
(function () {
  const EK = (globalThis.EK = globalThis.EK || {});

  EK.VERSION = 'v6.2';

  const DEFAULTS = {
    floors: 20,
    kids: 3,
    killers: 2,
    roundSeconds: 180,

    // 每层布局：楼梯口A — 左楼道 — 电梯厅 — 右楼道 — 楼梯口B
    corridorSideM: 1.0,       // 左/右楼道长度（两边相等）
    lobbyWidthM: 3.6,       // 电梯厅宽度
    landingInsetM: 0.7,     // 楼梯口离楼层两端的距离

    // 角色：走廊速度 / 爬楼速度（层每秒）/ 视距
    kid:    { speed: 2.2,  stairSpeed: 0.22, vision: 14, dangerM: 9, reactionSec: 0.2 },
    killer: { speed: 2.6,  stairSpeed: 0.26, vision: 14 },

    elevator: {
      cars: 2,
      secPerFloor: 2.0,
      doorOpenSec: 1.5,
      doorHoldSec: 3.0,
      doorCloseSec: 1.5,
      doorZoneM: 1.6,
      boardRangeM: 2.0,       // 电梯厅算一个地点：站厅里就能上任何一部开门的梯
      // 呼梯按钮：'shared' 每层公用一套（C 梯左边是下、D 梯右边是上）
      //          'split'  每部梯一套（各自左边为下、右边为上）
      hallButtons: 'shared',
      clearOppositeCall: false,   // false: 停靠只清本方向；true: 老行为，一次清两方向
      reopenForOpposite: true     // 方向跑完时，本层还有反方向呼梯就原地再开一次门
    },

    stairReachM: 1.6,                 // 站在楼梯口多近才能上下楼
    stairMouthM: 1.5,                 // 楼梯口多近能看见「刚进楼梯间」的人
    stairMouthProgress: 0.12,         // 走到楼梯段的这个比例之前还算看得见
    stairMetersPerFloor: 4.5,         // 楼梯段一层的「长度」，用来换算抓捕距离
    aiWaitTimeout: 10,                // 等电梯超过这么多秒就改走楼梯

    ai: {
      clueUse: true,                  // 杀人犯会不会拿「电梯停在几楼」当线索去查
      clueTtl: 15,                    // 线索保鲜时间
      kidBait: 0.3,                   // 小孩偶尔按了呼梯就跑，制造假停靠
      kidBaitCooldown: 40,            // 每个小孩两次假动作之间的冷却
      // —— v6：更像人的行为参数 ——
      kidMemorySec: 8,                // 小孩记住「刚才在哪儿看见杀人犯」的时间
      kidDangerRadius: 1,             // 记忆的危险区半径（层）
      kidCommitSec: 4,                // 决定换层后至少坚持多久
      kidRestSec: 2,                  // 到目标层后先喘口气，不立刻再跑
      killerSweepSpan: 3,             // 杀人犯扫楼时一次跨几层
      killerCheckedSec: 25,           // 刚查过的楼层多久内不重复查
      killerWrongWaySec: 3            // 坐反方向超过这么久就在下一站下车
    },

    capture: { rangeM: 0.8, gripSec: 0.4, stairRangeM: 1.2 },

    // 角色拖尾（纯视觉，不在界面上暴露）
    trail: {
      enabled: true,
      lifeSec: 1.6,        // 拖尾存活时间
      maxPoints: 110,      // 最多保留多少个采样点
      maxJumpPx: 80,       // 位置跳变超过这个像素就断开（防止拉出假线）
      headWidth: 5.2,      // 头部粗细
      tailWidth: 0.8,      // 尾部粗细
      alpha: 0.5           // 最大不透明度
    },

    channel: { ttlSec: 6 },

    scoring: { kidPerSecond: 1, killerPerKill: 100 },

    // 地图版本：'line' 一维走廊（MVP），'grid' 二维平面（二期）
    map: 'line'
  };

  function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

  function merge(base, over) {
    const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    if (!over) return out;
    for (const k of Object.keys(over)) {
      if (isObj(base && base[k]) && isObj(over[k])) out[k] = merge(base[k], over[k]);
      else out[k] = over[k];
    }
    return out;
  }

  EK.DEFAULTS = DEFAULTS;
  EK.makeConfig = function (overrides) {
    const cfg = merge(DEFAULTS, overrides || {});
    cfg.kids = Math.max(1, Math.round(cfg.kids));
    cfg.killers = Math.max(1, Math.round(cfg.killers));
    cfg.floors = Math.max(3, Math.round(cfg.floors));
    return cfg;
  };
  EK.merge = merge;

  EK.uid = (function () {
    let n = 0;
    return () => ++n;
  })();
})();

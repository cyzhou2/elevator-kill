/* 参数扫描：找出抓捕率与电梯使用都比较合理的默认值
 */
const { run, summarize } = require('./mc');

const baseKid = 2.2;
const grid = [];
for (const secPerFloor of [2.0, 2.5]) {
  for (const stair of [0.22, 0.3]) {
    for (const mult of [1.25, 1.4, 1.55]) {
      for (const danger of [6, 8]) {
        grid.push({ secPerFloor, stair, mult, danger });
      }
    }
  }
}

const N = 6, SEC = 180;
console.log('secPerFloor stair killerMult danger | 抓捕 乘车 呼梯 开门 卡住');
for (const g of grid) {
  const over = {
    elevator: { secPerFloor: g.secPerFloor },
    stairs: { floorsPerSec: g.stair },
    kid: { dangerM: g.danger },
    killer: { speed: +(baseKid * g.mult).toFixed(2) }
  };
  const runs = [];
  for (let s = 1; s <= N; s++) runs.push(run(s * 104729, SEC, over));
  const m = summarize(runs);
  console.log(`${g.secPerFloor} ${g.stair} ${g.mult} ${g.danger} | ${m.kills.toFixed(2)} ${m.rides.toFixed(1)} ${m.presses.toFixed(1)} ${m.doors.toFixed(1)} ${m.stuckRuns}`);
}

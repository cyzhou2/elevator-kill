/* 无头自测：在 Node 里用 vm 跑完整一局，检查逻辑与不变量
 * 用法：node tools/headless.js [秒数]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FILES = [
  'src/config.js',
  'src/model/building.js',
  'src/model/elevator.js',
  'src/sim/perception.js',
  'src/sim/nav.js',
  'src/sim/world.js',
  'src/sim/ai.js'
];

const sandbox = { console, Math, Date, JSON, Set, Map, isFinite, parseFloat, parseInt };
const ctx = vm.createContext(sandbox);
for (const f of FILES) {
  const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
  vm.runInContext(code, ctx, { filename: f });
}

const EK = sandbox.EK;
if (!EK) { console.error('EK 未定义'); process.exit(1); }

const seconds = parseFloat(process.argv[2] || '180');
const cfg = EK.makeConfig({ kids: 3, killers: 2, roundSeconds: seconds });
const world = new EK.World(cfg, { mode: 'spectate' });
world.start();

let problems = [];
function check(cond, msg) {
  if (!cond) problems.push(msg);
}

const dt = 0.05;
let steps = 0;
const t0 = Date.now();
while (!world.finished) {
  world.step(dt);
  steps++;
  if (steps % 20 === 0) {
    for (const a of world.actors) {
      if (!a.alive) continue;
      const loc = a.location;
      check(['floor', 'car', 'stair'].includes(loc.type), `${a.id} 位置类型异常 ${loc.type}`);
      if (loc.type === 'floor') check(loc.floor >= 1 && loc.floor <= cfg.floors, `${a.id} 楼层越界 ${loc.floor}`);
      if (loc.type === 'floor') check(Number.isFinite(loc.x), `${a.id} x 非数值`);
      if (loc.type === 'car') check(!!world.elev.get(loc.carId), `${a.id} 在未知轿厢`);
    }
    for (const c of world.elev.cars) {
      check(c.floor >= 1 - 1e-6 && c.floor <= cfg.floors + 1e-6, `${c.id} 梯越界 ${c.floor}`);
      check(Number.isFinite(c.floor), `${c.id} 梯楼层非数值`);
    }
  }
  if (steps > 200000) { problems.push('步数过多，可能死循环'); break; }
}

const wall = (Date.now() - t0) / 1000;
const kids = world.actors.filter((a) => a.kind === 'kid');
const killers = world.actors.filter((a) => a.kind === 'killer');

console.log('=== 模拟结果 ===');
console.log(`模拟时长 ${world.time.toFixed(1)}s / ${seconds}s，结束原因 ${world.endReason}，步数 ${steps}，耗时 ${wall.toFixed(2)}s`);
console.log(`存活小孩 ${kids.filter((k) => k.alive).length}/${kids.length}，抓捕 ${world.kills}`);
for (const k of kids) console.log(`  ${k.name}: ${k.alive ? '存活' : '被抓@' + k.capturedAt.toFixed(1)} 分数 ${k.score.toFixed(1)}`);
for (const k of killers) console.log(`  ${k.name}: 抓 ${k.kills}`);
console.log(`电梯：${world.elev.cars.map((c) => `${c.id}@${c.floor.toFixed(1)}F dir=${c.dir} ${c.state}`).join(' | ')}`);
console.log(`事件数 ${world.events.length}`);
for (const e of world.events.slice(-12)) console.log(`  [${e.t.toFixed(1)}] ${e.text}`);

if (problems.length) {
  console.log('\n!!! 不变量问题：');
  for (const p of problems.slice(0, 20)) console.log('  - ' + p);
  process.exit(1);
}
console.log('\n不变量检查通过');

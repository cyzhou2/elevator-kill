/* 诊断：电梯开关门次数、乘车次数、停滞角色、方向抖动
 */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
const FILES = ['src/config.js','src/model/building.js','src/model/elevator.js','src/sim/perception.js','src/sim/nav.js','src/sim/world.js','src/sim/ai.js'];
const sandbox = { console, Math, Date, JSON, Set, Map, isFinite, parseFloat, parseInt };
vm.createContext(sandbox);
for (const f of FILES) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
const EK = sandbox.EK;

const cfg = EK.makeConfig({ kids: 3, killers: 2, roundSeconds: 180 });
const w = new EK.World(cfg, { mode: 'spectate' });
w.start();

const stats = { doors: {}, hallPress: 0, rides: 0, dirFlips: {} };
for (const c of w.elev.cars) { stats.doors[c.id] = 0; stats.dirFlips[c.id] = 0; }
const lastState = {};
const lastDir = {};
const presses = new Set();
const origOnDoorsOpened = w.onDoorsOpened.bind(w);
w.onDoorsOpened = (car) => { stats.doors[car.id]++; origOnDoorsOpened(car); };
const origEnter = w.enterCar.bind(w);
w.enterCar = (a, car) => { stats.rides++; origEnter(a, car); };
const origPress = w.elev.press.bind(w.elev);
w.elev.press = (f, d) => { stats.hallPress++; return origPress(f, d); };

const stay = new Map();
const flags = [];
const dt = 0.05;
for (let i = 0; i < 180 / dt && !w.finished; i++) {
  w.step(dt);
  for (const c of w.elev.cars) {
    if (lastDir[c.id] != null && c.dir !== lastDir[c.id] && c.dir !== 0) stats.dirFlips[c.id]++;
    lastDir[c.id] = c.dir;
  }
  for (const a of w.actors) {
    if (!a.alive) continue;
    const key = a.location.type + ':' + (a.location.type === 'floor' ? a.location.floor : a.location.carId || a.location.fromFloor);
    const prev = stay.get(a.id);
    if (!prev || prev.key !== key) stay.set(a.id, { key, t: w.time });
    else if (w.time - prev.t > 25) {
      flags.push(`${a.id} 在 ${key} 停留 ${(w.time - prev.t).toFixed(0)}s（ai=${a.aiState} nav=${a.nav ? a.nav.phase : '-'}）`);
      prev.t = w.time;
    }
  }
}
console.log('开关门次数', stats.doors, '呼梯按下', stats.hallPress, '乘车人次', stats.rides, '方向翻转', stats.dirFlips);
console.log('died', w.kills);
if (flags.length) { console.log('停滞：'); for (const f of flags.slice(0, 15)) console.log(' - ' + f); }

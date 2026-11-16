/* 多局蒙特卡洛：跑 N 局，统计抓捕率、电梯使用、卡死情况
 * 用法：node tools/mc.js [局数] [秒数] '{"killer":{"speed":3.0}}'
 */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
const FILES = ['src/config.js','src/model/building.js','src/model/elevator.js','src/sim/perception.js','src/sim/nav.js','src/sim/world.js','src/sim/ai.js'];

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function run(seed, seconds, overrides) {
  const sandbox = { console, Math, Date, JSON, Set, Map, isFinite, parseFloat, parseInt };
  const seeded = Object.create(Math);
  seeded.random = mulberry32(seed);
  sandbox.Math = seeded;
  vm.createContext(sandbox);
  for (const f of FILES) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
  const EK = sandbox.EK;
  const cfg = EK.makeConfig(Object.assign({ roundSeconds: seconds }, overrides));
  const w = new EK.World(cfg, { mode: 'spectate' });
  w.start();

  const stats = { rides: 0, presses: 0, doors: 0 };
  const origEnter = w.enterCar.bind(w);
  w.enterCar = (a, car) => { stats.rides++; origEnter(a, car); };
  const origPress = w.elev.press.bind(w.elev);
  w.elev.press = (f, d) => { stats.presses++; return origPress(f, d); };
  const origDoors = w.onDoorsOpened.bind(w);
  w.onDoorsOpened = (c) => { stats.doors++; origDoors(c); };

  const dt = 0.05;
  const still = new Map();
  const stuck = new Set();
  while (!w.finished) {
    w.step(dt);
    for (const a of w.actors) {
      if (!a.alive) continue;
      const L = a.location;
      const key = L.type === 'floor'
        ? `f${L.floor}x${Math.round(L.x)}`
        : L.type === 'car' ? `car${L.carId}` : `stair${L.stair}:${L.fromFloor}`;
      const prev = still.get(a.id);
      if (!prev || prev.key !== key) still.set(a.id, { key, t: w.time });
      else if (w.time - prev.t > 35 && L.type !== 'car') stuck.add(a.id);
    }
  }
  return {
    kills: w.kills, kids: w.actors.filter((a) => a.kind === 'kid').length,
    score: Math.round(w.totalKidScore()), rides: stats.rides, presses: stats.presses,
    doors: stats.doors, stuck: [...stuck], endReason: w.endReason
  };
}

function summarize(runs) {
  const n = runs.length;
  const sum = (k) => runs.reduce((s, r) => s + r[k], 0);
  return {
    n,
    kills: sum('kills') / n,
    rides: sum('rides') / n,
    presses: sum('presses') / n,
    doors: sum('doors') / n,
    stuckRuns: runs.filter((r) => r.stuck.length).length
  };
}

if (require.main === module) {
  const N = parseInt(process.argv[2] || '8', 10);
  const SEC = parseFloat(process.argv[3] || '180');
  const over = process.argv[4] ? JSON.parse(process.argv[4]) : {};
  const runs = [];
  for (let s = 1; s <= N; s++) {
    const r = run(s * 7919, SEC, over);
    runs.push(r);
    console.log(`seed ${s}: 抓 ${r.kills}/${r.kids} 存活分 ${r.score} 乘车 ${r.rides} 呼梯 ${r.presses} 开门 ${r.doors}` +
      (r.stuck.length ? ` 卡住:${r.stuck.join(',')}` : ''));
  }
  const s = summarize(runs);
  console.log('---');
  console.log(`平均抓捕 ${s.kills.toFixed(2)}/${runs[0].kids}，乘车 ${s.rides.toFixed(1)}，呼梯 ${s.presses.toFixed(1)}，开门 ${s.doors.toFixed(1)}，卡住局 ${s.stuckRuns}/${s.n}`);
}

module.exports = { run, summarize };

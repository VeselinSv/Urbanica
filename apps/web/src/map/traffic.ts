/**
 * Трафик и пешеходци (само визуално, в браузъра).
 *
 * Коли:
 *  - движат се в дясната лента, по плавни криви в завоите и около кръговите кръстовища (обратно на часовника);
 *  - пазят дистанция (модел на „интелигентния шофьор“ – плавно ускоряване и спиране), не се застъпват;
 *  - на кръстовище влизат само с разрешение: светофар (зелено за тяхната посока), кръгово (предимство имат
 *    колите в кръга), обикновено (главен път, после „дясна ръка“, завиващите наляво пропускат насрещните);
 *  - не влизат в кръстовището, ако изходът след него е задръстен; спират пред пешеходци на пътното платно;
 *  - видът на колите следва града: автобуси при автобусно депо, полиция при полицейски участък, камиони при индустрия.
 * Пешеходци:
 *  - вървят само по тротоари и пешеходни алеи; пресичат на кръстовищата, когато няма приближаваща кола.
 */
import { Container, Graphics, Sprite, type Texture } from 'pixi.js';
import { hasSidewalk, isWalkable, parseKey, tileKey, type RoadClass, type TileState } from '@gce/shared';
import { BEACON, CAR_ANCHOR, CAR_LEN, CAR_PALETTE, PED_ANCHOR, PED_VARIANTS, carFrames, headingFrame, personFrames, type CarModel } from './vehicles';
import { ROAD_GEOM, walkOffset } from './roadgeom';
import { coneTex, glowTex } from './atmosphere';

type Dir = 0 | 1 | 2 | 3;
/** E, S, W, N (y расте на юг). Дясно от посока (dx,dy) е (-dy, dx). */
const DV: readonly [number, number][] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];
const rev = (d: Dir) => ((d + 2) % 4) as Dir;
const leftOf = (d: Dir) => ((d + 3) % 4) as Dir;
const axis = (d: Dir) => d % 2;

const iso = (x: number, y: number) => ({ x: (x - y) * 32, y: (x + y) * 16 });

type RoadT = Extract<TileState, { t: 'road' }>;

/** Сегмент през една плочка: квадратна крива или дъга около кръговото кръстовище. */
interface Seg {
  p0x: number;
  p0y: number;
  cx: number;
  cy: number;
  p1x: number;
  p1y: number;
  ring: { ox: number; oy: number; a0: number; da: number; r0: number; r1: number; R: number } | null;
  len: number;
}

function segAt(s: Seg, t: number, out: number[]) {
  if (s.ring) {
    const r = s.ring;
    const a = r.a0 - r.da * t;
    const base = r.r0 + (r.r1 - r.r0) * t;
    const rad = base + (r.R - base) * Math.min(1, Math.sin(Math.PI * t) * 1.8);
    out[0] = r.ox + Math.cos(a) * rad;
    out[1] = r.oy + Math.sin(a) * rad;
    return;
  }
  const u = 1 - t;
  out[0] = u * u * s.p0x + 2 * u * t * s.cx + t * t * s.p1x;
  out[1] = u * u * s.p0y + 2 * u * t * s.cy + t * t * s.p1y;
}

function finishSeg(s: Seg) {
  const p: number[] = [0, 0];
  let len = 0;
  segAt(s, 0, p);
  let px = p[0];
  let py = p[1];
  for (let i = 1; i <= 8; i++) {
    segAt(s, i / 8, p);
    len += Math.hypot(p[0] - px, p[1] - py);
    px = p[0];
    py = p[1];
  }
  s.len = Math.max(0.05, len);
  return s;
}

/** Път през плочка (x,y): влиза в посока din, излиза в посока dout; offIn/offOut – отстояние надясно от оста. */
function makeSeg(x: number, y: number, din: Dir, dout: Dir, offIn: number, offOut: number, ringR: number | null): Seg {
  const cx = x + 0.5;
  const cy = y + 0.5;
  const [dx, dy] = DV[din];
  const [ox, oy] = DV[dout];
  const p0x = cx - dx * 0.5 - dy * offIn;
  const p0y = cy - dy * 0.5 + dx * offIn;
  const p1x = cx + ox * 0.5 - oy * offOut;
  const p1y = cy + oy * 0.5 + ox * offOut;
  const s: Seg = { p0x, p0y, cx: (p0x + p1x) / 2, cy: (p0y + p1y) / 2, p1x, p1y, ring: null, len: 1 };
  if (ringR !== null) {
    const a0 = Math.atan2(p0y - cy, p0x - cx);
    const a1 = Math.atan2(p1y - cy, p1x - cx);
    let da = (((a0 - a1) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    if (da < 0.5) da += Math.PI * 2;
    s.ring = { ox: cx, oy: cy, a0, da, r0: Math.hypot(p0x - cx, p0y - cy), r1: Math.hypot(p1x - cx, p1y - cy), R: ringR };
  } else if (dout === rev(din)) {
    s.cx = (p0x + p1x) / 2 + dx * 0.32;
    s.cy = (p0y + p1y) / 2 + dy * 0.32;
  } else if (dout !== din) {
    if (dx !== 0) {
      s.cx = p1x;
      s.cy = p0y;
    } else {
      s.cx = p0x;
      s.cy = p1y;
    }
  }
  return finishSeg(s);
}

interface Car {
  sp: Sprite;
  /** Фар (конус) и стоп – само нощем. */
  hl: Sprite | null;
  tl: Sprite | null;
  frames: Texture[];
  len: number;
  x: number;
  y: number;
  hx: number;
  hy: number;
  tx: number;
  ty: number;
  din: Dir;
  dout: Dir;
  /** Планирана посока на излизане от следващата плочка. */
  next: Dir | null;
  seg: Seg;
  t: number;
  v: number;
  vmax: number;
  wait: number;
  stuck: number;
  trip: number;
  alpha: number;
  fade: number;
  /** Ключ на кръстовището, за което има разрешение / в което е. */
  granted: string | null;
  /** Чака пред това кръстовище. */
  waitingAt: string | null;
  jIn: Dir;
  remove: boolean;
  /** Специален маршрут (посоки за следващите плочки) – екип към сигнал. */
  route: Dir[] | null;
  /** Плочка, на която колата спира и чака (ремонт). */
  park: string | null;
  /** Сигнал, по който работи екипът. */
  job: string | null;
  beacon: Sprite | null;
  /** Автобусна линия: посоките на целия кръг (повтаря се), спирките и престой на спирка. */
  loopDirs: Dir[] | null;
  stopsAt: Set<string> | null;
  dwell: number;
  lastStop: string | null;
}

/** Сигнал за екипите (подмножество от IssueMarker). */
export interface IssueJob {
  id: string;
  kind: string;
  x: number;
  y: number;
  status: string;
}

/** Какво возило отива на сигнала и от коя обществена сграда тръгва. */
const JOB_VEHICLE: Record<string, { model: CarModel; color: number; from?: string }> = {
  accident: { model: 'ambulance', color: 0xf4f6f7, from: 'clinic' },
  garbage: { model: 'garbage', color: 0x2e7d4f, from: 'landfill' },
  water_leak: { model: 'crew', color: 0x1f6fb2, from: 'water_pump' },
  sewage: { model: 'crew', color: 0x1f6fb2, from: 'sewage_plant' },
  power_outage: { model: 'crew', color: 0xf2c230 },
  fallen_tree: { model: 'crew', color: 0x2f7d32, from: 'park' },
  graffiti: { model: 'crew', color: 0x8e44ad },
  streetlight: { model: 'crew', color: 0xf2c230 },
  pothole: { model: 'crew', color: 0xe67e22 },
};

interface Ped {
  sp: Sprite;
  frames: Texture[];
  x: number;
  y: number;
  hx: number;
  hy: number;
  tx: number;
  ty: number;
  din: Dir;
  dout: Dir;
  seg: Seg;
  t: number;
  v: number;
  side: 1 | -1;
  phase: number;
  wait: number;
  trip: number;
  alpha: number;
  fade: number;
  jitter: number;
  onRoad: boolean;
  remove: boolean;
}

const tmp: number[] = [0, 0];
const hash = (x: number, y: number, s = 0) => {
  let h = Math.imul(x * 374761393 + y * 668265263 + s * 2246822519, 3266489917);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
};

export class Traffic {
  private tiles = new Map<string, TileState>();
  private roadKeys: string[] = [];
  private walkKeys: string[] = [];
  private carSpawn: string[] = [];
  private pedSpawn: string[] = [];
  private blocked = new Set<string>();
  private cars: Car[] = [];
  private peds: Ped[] = [];
  private occupancy = new Map<string, Set<Car>>();
  private waiting = new Map<string, Set<Car>>();
  private grid = new Map<string, Car[]>();
  private pedGrid = new Map<string, Ped[]>();
  private time = 0;
  private fleet: { model: CarModel; w: number }[] = [];
  private signals: { x: number; y: number; arms: Dir[] }[] = [];
  private signalG = new Graphics();
  private lastSignalPaint = -1;
  wantCars = 0;
  wantPeds = 0;
  /** Контейнер за светлините (адитивен) и колко е тъмно (0..1) – задава ги рендерерът. */
  lights: Container | null = null;
  night = 0;

  constructor(readonly layer: Container) {
    layer.sortableChildren = true;
    this.signalG.zIndex = 1e9;
    layer.addChild(this.signalG);
  }

  // ------------------------------------------------------------ данни
  setTiles(tiles: Map<string, TileState>) {
    this.tiles = tiles;
    this.roadKeys = [];
    this.walkKeys = [];
    this.carSpawn = [];
    this.pedSpawn = [];
    this.signals = [];
    let rLevels = 0;
    let industry = 0;
    let bus = false;
    let police = false;
    for (const [k, t] of tiles) {
      if (t.t === 'road') this.roadKeys.push(k);
      if (isWalkable(t)) this.walkKeys.push(k);
      if (t.t === 'zone' && t.lvl > 0) {
        if (t.z === 'R') rLevels += t.lvl;
        if (t.z === 'I' || t.z === 'L') industry++;
      }
      if (t.t === 'facility') industry++;
      if (t.t === 'service' && t.s === 'bus_depot') bus = true;
      if (t.t === 'service' && t.s === 'police_station') police = true;
    }
    const nearBuilding = (k: string) => {
      const [x, y] = parseKey(k);
      for (const [dx, dy] of DV) {
        const n = tiles.get(tileKey(x + dx, y + dy));
        if (n && (n.t === 'service' || n.t === 'facility' || (n.t === 'zone' && n.lvl > 0))) return true;
      }
      return false;
    };
    for (const k of this.roadKeys) {
      const [x, y] = parseKey(k);
      if (this.arms(x, y).length === 2 && nearBuilding(k)) this.carSpawn.push(k);
      const t = tiles.get(k) as RoadT;
      if (t.j === 'signals') this.signals.push({ x, y, arms: this.arms(x, y) });
    }
    for (const k of this.walkKeys) if (nearBuilding(k)) this.pedSpawn.push(k);
    if (!this.carSpawn.length) this.carSpawn = this.roadKeys.filter((k) => this.arms(...parseKey(k)).length === 2);
    if (!this.pedSpawn.length) this.pedSpawn = [...this.walkKeys];
    this.fleet = [
      { model: 'sedan', w: 5 },
      { model: 'hatch', w: 4 },
      { model: 'suv', w: 2.5 },
      { model: 'van', w: 1.2 },
      { model: 'taxi', w: 0.7 },
      ...(bus ? [{ model: 'bus' as CarModel, w: 0.9 }] : []),
      ...(police ? [{ model: 'police' as CarModel, w: 0.35 }] : []),
      ...(industry ? [{ model: 'truck' as CarModel, w: Math.min(2.5, 0.4 + industry * 0.05) }] : []),
    ];
    // без паркинги колите обикалят – повече трафик
    let shops = 0;
    let parkings = 0;
    for (const t of tiles.values()) {
      if (t.t === 'zone' && (t.z === 'C' || t.z === 'O') && t.lvl > 0) shops++;
      if (t.t === 'service' && t.s === 'parking') parkings++;
    }
    this.parkingShort = shops > 8 && shops > parkings * 14;
    this.stopKeys = this.roadKeys.filter((k) => (tiles.get(k) as RoadT).st);
    this.hasDepot = bus;
    this.lineDirty = true;
    this.recount();
    this.wantPeds = Math.min(260, Math.floor(this.walkKeys.length * 0.35 + rLevels * 0.25));
    // премахва колите/хората, чиито плочки вече не съществуват
    for (const c of this.cars) if (!this.isRoad(c.tx, c.ty)) c.remove = true;
    for (const p of this.peds) if (!this.isWalk(p.tx, p.ty)) p.remove = true;
    this.lastSignalPaint = -1;
  }

  /** Плочки вътре в тунел – колите и хората там не се виждат. */
  hidden = new Set<string>();
  /** Вали ли сняг (снегорините излизат). */
  snowing = false;

  /** Екипи към сигналите „в ремонт“: тръгват от съответната обществена сграда и спират на мястото. */
  setIssues(issues: IssueJob[]) {
    const fixing = new Map(issues.filter((i) => i.status === 'FIXING').map((i) => [i.id, i]));
    for (const c of this.cars) {
      if (c.job && !fixing.has(c.job)) {
        // ремонтът приключи – екипът си тръгва
        c.job = null;
        c.park = null;
        c.route = null;
        c.trip = 6;
      }
    }
    const busy = new Set(this.cars.map((c) => c.job).filter(Boolean));
    for (const i of fixing.values()) if (!busy.has(i.id)) this.dispatch(i);
  }

  /** Най-близката пътна плочка до (x,y) в радиус 3. */
  private nearestRoad(x: number, y: number): [number, number] | null {
    for (let d = 0; d <= 3; d++)
      for (let dy = -d; dy <= d; dy++)
        for (let dx = -d; dx <= d; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== d) continue;
          if (this.isRoad(x + dx, y + dy)) return [x + dx, y + dy];
        }
    return null;
  }

  /** Най-кратък път по пътищата (BFS); връща плочките от началото до целта. */
  private bfs(from: [number, number], to: [number, number]): [number, number][] | null {
    const start = tileKey(...from);
    const goal = tileKey(...to);
    const prev = new Map<string, string | null>([[start, null]]);
    const q = [from];
    for (let i = 0; i < q.length && i < 6000; i++) {
      const [x, y] = q[i];
      const k = tileKey(x, y);
      if (k === goal) break;
      for (const [dx, dy] of DV) {
        const n: [number, number] = [x + dx, y + dy];
        const nk = tileKey(...n);
        if (prev.has(nk) || !this.isRoad(...n) || (this.blocked.has(nk) && nk !== goal)) continue;
        prev.set(nk, k);
        q.push(n);
      }
    }
    if (!prev.has(goal)) return null;
    const out: [number, number][] = [];
    for (let k: string | null = goal; k; k = prev.get(k) ?? null) out.unshift(parseKey(k));
    return out;
  }

  private dispatch(issue: IssueJob) {
    const veh = JOB_VEHICLE[issue.kind] ?? { model: 'crew' as CarModel, color: 0xe67e22 };
    const target = this.nearestRoad(issue.x, issue.y);
    if (!target) return;
    // старт: пътят до съответната обществена сграда, иначе случайна улица по-далеч
    let origin: [number, number] | null = null;
    if (veh.from) {
      for (const [k, t] of this.tiles)
        if (t.t === 'service' && t.s === veh.from) {
          const [x, y] = parseKey(k);
          origin = this.nearestRoad(x, y);
          if (origin) break;
        }
    }
    for (let tries = 0; !origin && tries < 20; tries++) {
      const k = this.carSpawn[Math.floor(Math.random() * this.carSpawn.length)];
      if (!k) break;
      const p = parseKey(k);
      if (Math.abs(p[0] - target[0]) + Math.abs(p[1] - target[1]) >= 6) origin = p;
    }
    if (!origin) return;
    const path = this.bfs(origin, target);
    if (!path) return;
    const dirs: Dir[] = [];
    for (let i = 0; i + 1 < path.length; i++) {
      const dx = path[i + 1][0] - path[i][0];
      const dy = path[i + 1][1] - path[i][1];
      dirs.push(DV.findIndex(([a, b]) => a === dx && b === dy) as Dir);
    }
    // на целевата плочка – продължава напред (там спира)
    const lastArms = this.arms(...target);
    const lastIn = dirs.length ? dirs[dirs.length - 1] : (lastArms[0] ?? 0);
    const exit = lastArms.includes(lastIn) ? lastIn : (lastArms.find((a) => a !== rev(lastIn)) ?? rev(lastIn));
    const first = dirs.length ? dirs[0] : exit;
    const arms0 = this.arms(...origin);
    const din: Dir = arms0.includes(rev(first)) ? first : first;
    const car = this.makeCar(veh.model, veh.color, origin[0], origin[1], din, first, 0.3);
    car.route = [...dirs.slice(1), exit];
    car.park = path.length > 1 ? tileKey(...target) : null;
    if (path.length <= 1) car.park = tileKey(...target);
    car.job = issue.id;
    car.trip = 999;
    car.vmax *= 1.15;
    const b = new Sprite(glowTex());
    b.anchor.set(0.5);
    b.blendMode = 'add';
    b.tint = BEACON[veh.model] ?? 0xff9f1a;
    b.scale.set(0.3);
    this.layer.addChild(b);
    car.beacon = b;
  }

  /** Посока на излизане от плочката: по маршрута (екипи) или случайна според правилата. */
  private nextDir(car: Car, x: number, y: number, din: Dir): Dir {
    if (car.loopDirs && car.route && !car.route.length) car.route = [...car.loopDirs];
    if (car.route && car.route.length) return car.route.shift()!;
    return this.chooseCar(x, y, din);
  }

  private stopKeys: string[] = [];
  private hasDepot = false;
  private lineDirty = false;
  private line: { tiles: [number, number][]; dirs: Dir[] } | null = null;

  /** Кръгов маршрут през всички спирки (най-близка следваща спирка, най-кратък път по улиците). */
  private buildLine() {
    this.lineDirty = false;
    this.line = null;
    for (const c of this.cars) if (c.loopDirs) c.fade = -1;
    if (!this.hasDepot || this.stopKeys.length < 2) return;
    const left = this.stopKeys.map(parseKey);
    const order: [number, number][] = [left.shift()!];
    while (left.length) {
      const [lx, ly] = order[order.length - 1];
      let bi = 0;
      let bd = Infinity;
      left.forEach(([x, y], i) => {
        const d = Math.abs(x - lx) + Math.abs(y - ly);
        if (d < bd) {
          bd = d;
          bi = i;
        }
      });
      order.push(left.splice(bi, 1)[0]);
    }
    order.push(order[0]);
    const tiles: [number, number][] = [order[0]];
    for (let i = 0; i + 1 < order.length; i++) {
      const p = this.bfs(order[i], order[i + 1]);
      if (!p) return;
      tiles.push(...p.slice(1));
    }
    const dirs: Dir[] = [];
    for (let i = 0; i + 1 < tiles.length; i++) {
      const dx = tiles[i + 1][0] - tiles[i][0];
      const dy = tiles[i + 1][1] - tiles[i][1];
      dirs.push(DV.findIndex(([a, b]) => a === dx && b === dy) as Dir);
    }
    if (dirs.length < 2) return;
    this.line = { tiles, dirs };
    // автобуси по линията – равномерно разпределени по кръга
    const n = Math.min(5, Math.max(1, Math.ceil(this.stopKeys.length / 3)));
    const stops = new Set(this.stopKeys);
    for (let b = 0; b < n; b++) {
      const i = Math.floor((b * dirs.length) / n);
      const [x, y] = tiles[i];
      const din = i > 0 ? dirs[i - 1] : dirs[dirs.length - 1];
      const car = this.makeCar('bus', b % 2 ? 0x2e8b57 : 0xf2c230, x, y, din, dirs[i], 0.1);
      car.loopDirs = dirs;
      car.route = [...dirs.slice(i + 1)];
      car.stopsAt = stops;
      car.trip = 1e9;
      car.vmax = 0.85;
    }
  }

  private load = new Map<string, number>();
  private loadFactor = 1;
  parkingShort = false;

  /** Натоварване на пътищата от симулацията (сървъра): повече коли и по-бавно движение при задръстване. */
  setLoad(traffic: Record<string, number> | undefined) {
    this.load = new Map(Object.entries(traffic ?? {}));
    const vals = [...this.load.values()];
    const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    this.loadFactor = Math.max(0.7, Math.min(2.2, 0.7 + avg * 0.9));
    this.recount();
  }

  private recount() {
    this.wantCars = Math.min(220, Math.floor(this.roadKeys.length * 0.28 * this.loadFactor * (this.parkingShort ? 1.25 : 1)));
  }

  setBlocked(b: Set<string>) {
    this.blocked = b;
  }

  private road(x: number, y: number): RoadT | null {
    const t = this.tiles.get(tileKey(x, y));
    return t?.t === 'road' ? t : null;
  }
  private isRoad(x: number, y: number) {
    return this.road(x, y) !== null;
  }
  private isWalk(x: number, y: number) {
    return isWalkable(this.tiles.get(tileKey(x, y)));
  }
  private arms(x: number, y: number): Dir[] {
    const out: Dir[] = [];
    for (let d = 0; d < 4; d++) if (this.isRoad(x + DV[d][0], y + DV[d][1])) out.push(d as Dir);
    return out;
  }
  private isJunction(x: number, y: number) {
    return this.isRoad(x, y) && this.arms(x, y).length >= 3;
  }
  private cls(x: number, y: number): RoadClass {
    return this.road(x, y)?.c ?? 'street';
  }
  private lane(x: number, y: number) {
    return ROAD_GEOM[this.cls(x, y)].lane;
  }
  /** Лента на границата между две плочки – средна, за да няма скок. */
  private edgeLane(x: number, y: number, d: Dir) {
    const nx = x + DV[d][0];
    const ny = y + DV[d][1];
    return this.isRoad(nx, ny) ? (this.lane(x, y) + this.lane(nx, ny)) / 2 : this.lane(x, y);
  }
  private ringR(x: number, y: number): number | null {
    const r = this.road(x, y);
    if (r?.j !== 'roundabout') return null;
    return r.c === 'avenue' || r.c === 'highway' ? 0.74 : 0.46;
  }

  private carSeg(x: number, y: number, din: Dir, dout: Dir) {
    return makeSeg(x, y, din, dout, this.edgeLane(x, y, rev(din)), this.edgeLane(x, y, dout), this.ringR(x, y));
  }

  private chooseCar(x: number, y: number, din: Dir): Dir {
    const opts: [Dir, number][] = [];
    for (let d = 0 as Dir; d < 4; d = (d + 1) as Dir) {
      if (d === rev(din)) continue;
      const nx = x + DV[d][0];
      const ny = y + DV[d][1];
      if (!this.isRoad(nx, ny) || this.blocked.has(tileKey(nx, ny))) continue;
      opts.push([d, d === din ? 3 : 1.4]);
    }
    if (!opts.length) return rev(din);
    let sum = opts.reduce((a, o) => a + o[1], 0) * Math.random();
    for (const [d, w] of opts) if ((sum -= w) <= 0) return d;
    return opts[0][0];
  }

  // ------------------------------------------------------------ коли
  private pickModel(): CarModel {
    if (this.snowing && Math.random() < 0.07) return 'plow';
    let sum = this.fleet.reduce((a, f) => a + f.w, 0) * Math.random();
    for (const f of this.fleet) if ((sum -= f.w) <= 0) return f.model;
    return 'sedan';
  }

  private spawnCar(): boolean {
    if (!this.carSpawn.length) return false;
    const k = this.carSpawn[Math.floor(Math.random() * this.carSpawn.length)];
    const [x, y] = parseKey(k);
    if (this.blocked.has(k)) return false;
    // по-натоварените улици получават повече коли
    if (this.load.size && Math.random() > 0.35 + (this.load.get(k) ?? 0)) return false;
    const arms = this.arms(x, y);
    if (!arms.length) return false;
    const dout = arms[Math.floor(Math.random() * arms.length)];
    // идва от рамо срещу изхода (направо), иначе от друго рамо
    const other = arms.find((a) => a !== dout);
    const din: Dir = arms.includes(rev(dout)) ? dout : other !== undefined ? rev(other) : dout;
    const seg = this.carSeg(x, y, din, dout);
    const t = 0.25 + Math.random() * 0.4;
    segAt(seg, t, tmp);
    for (const o of this.cars) if (Math.hypot(o.x - tmp[0], o.y - tmp[1]) < 0.55) return false;
    let model = this.pickModel();
    if (model === 'bus' && (this.cls(x, y) === 'rural' || this.line)) model = 'sedan';
    this.makeCar(model, this.colorFor(model), x, y, din, dout, t);
    return true;
  }

  private colorFor(model: CarModel) {
    return model === 'taxi'
      ? 0xf4d03f
      : model === 'police'
        ? 0xf4f6f7
        : model === 'plow'
          ? 0xf08a24
          : model === 'bus'
            ? Math.random() < 0.6
              ? 0xf2c230
              : 0x2e8b57
            : CAR_PALETTE[Math.floor(Math.random() * CAR_PALETTE.length)];
  }

  private makeCar(model: CarModel, color: number, x: number, y: number, din: Dir, dout: Dir, t: number): Car {
    const seg = this.carSeg(x, y, din, dout);
    segAt(seg, t, tmp);
    const frames = carFrames(model, color);
    const sp = new Sprite(frames[0]);
    sp.anchor.set(CAR_ANCHOR.x, CAR_ANCHOR.y);
    sp.scale.set(CAR_ANCHOR.scale);
    sp.alpha = 0;
    this.layer.addChild(sp);
    const car: Car = {
      sp,
      hl: null,
      tl: null,
      frames,
      len: CAR_LEN[model],
      x: tmp[0],
      y: tmp[1],
      hx: DV[dout][0],
      hy: DV[dout][1],
      tx: x,
      ty: y,
      din,
      dout,
      next: null,
      seg,
      t,
      v: 0,
      vmax: (model === 'bus' || model === 'truck' ? 0.8 : 0.95 + Math.random() * 0.35) * 1.05,
      wait: 0,
      stuck: 0,
      trip: 14 + Math.floor(Math.random() * 40),
      alpha: 0,
      fade: 1,
      granted: null,
      waitingAt: null,
      jIn: dout,
      remove: false,
      route: null,
      park: null,
      job: null,
      beacon: null,
      loopDirs: null,
      stopsAt: null,
      dwell: 0,
      lastStop: null,
    };
    if (this.lights) {
      car.hl = new Sprite(coneTex());
      car.hl.anchor.set(0, 0.5);
      car.hl.tint = 0xfff1c8;
      car.tl = new Sprite(glowTex());
      car.tl.anchor.set(0.5);
      car.tl.tint = 0xff2a1a;
      car.tl.scale.set(0.16, 0.1);
      this.lights.addChild(car.hl, car.tl);
    }
    this.cars.push(car);
    return car;
  }

  private signalGreen(x: number, y: number, ax: number) {
    const T = 12;
    const tt = (this.time + hash(x, y, 3) * T) % T;
    return ax === 0 ? tt < 5 : tt >= 6 && tt < 11;
  }

  private signalState(x: number, y: number, ax: number): 'g' | 'y' | 'r' {
    const T = 12;
    const tt = (this.time + hash(x, y, 3) * T) % T;
    if (ax === 0) return tt < 5 ? 'g' : tt < 6 ? 'y' : 'r';
    return tt >= 6 && tt < 11 ? 'g' : tt >= 11 ? 'y' : 'r';
  }

  /** Може ли колата да влезе в кръстовището (nx,ny), идвайки в посока din и излизайки в посока dout. */
  private canEnter(car: Car, nx: number, ny: number, din: Dir, dout: Dir): boolean {
    const k = tileKey(nx, ny);
    const occ = this.occupancy.get(k);
    // изходът след кръстовището трябва да е свободен („не блокирай кръстовището“)
    const ex = nx + DV[dout][0];
    const ey = ny + DV[dout][1];
    for (const o of this.grid.get(tileKey(ex, ey)) ?? []) if (o.din === dout && o.t < 0.5 && o !== car) return false;
    const r = this.road(nx, ny)!;
    if (r.j === 'signals') {
      if (!this.signalGreen(nx, ny, axis(din))) return false;
      for (const o of occ ?? []) if (axis(o.jIn) !== axis(din)) return false;
      return true;
    }
    if (r.j === 'roundabout') {
      // предимство имат колите, които вече са в кръга
      if (!occ || occ.size === 0) return true;
      if (occ.size >= 2) return false;
      for (const o of occ) if (o.jIn !== din) return false;
      return true;
    }
    if (occ && occ.size) {
      for (const o of occ) if (o.jIn !== din || o.next !== null) return false;
    }
    // главен път, „дясна ръка“, завиващите наляво пропускат насрещните
    const myRank = ROAD_GEOM[this.cls(car.tx, car.ty)].rank;
    for (const w of this.waiting.get(k) ?? []) {
      if (w === car) continue;
      const wRank = ROAD_GEOM[this.cls(w.tx, w.ty)].rank;
      let yieldTo = false;
      if (wRank > myRank) yieldTo = true;
      else if (wRank === myRank && w.dout === leftOf(din)) yieldTo = true;
      else if (wRank === myRank && w.dout === rev(din) && dout === leftOf(din) && w.next !== leftOf(w.dout)) yieldTo = true;
      if (yieldTo && !(car.wait > 3 && car.wait > w.wait + 0.5)) return false;
    }
    return true;
  }

  private releaseJunction(car: Car) {
    if (car.granted) this.occupancy.get(car.granted)?.delete(car);
    car.granted = null;
    if (car.waitingAt) this.waiting.get(car.waitingAt)?.delete(car);
    car.waitingAt = null;
  }

  private updateCar(car: Car, dt: number) {
    // автобус на спирка: спира за 3 s
    const here = tileKey(car.tx, car.ty);
    if (car.stopsAt?.has(here) && car.lastStop !== here && car.t >= 0.45) {
      car.v = 0;
      car.stuck = 0;
      car.dwell += dt;
      if (car.dwell < 3) return;
      car.dwell = 0;
      car.lastStop = here;
    }
    if (car.park && car.park === tileKey(car.tx, car.ty) && car.t >= 0.42) {
      car.v = 0;
      car.stuck = 0;
      return;
    }
    const A = 1.3;
    const geomSpeed = ROAD_GEOM[this.cls(car.tx, car.ty)].speed;
    const turning = car.din !== car.dout || !!car.seg.ring;
    const jam = Math.max(0, (this.load.get(tileKey(car.tx, car.ty)) ?? 0) - 0.8);
    const vDes = (car.vmax * geomSpeed * (turning ? 0.55 : 1)) / (1 + jam * 0.7);
    let gap = Infinity;
    let leaderV = 0;

    // следваща плочка
    const nx = car.tx + DV[car.dout][0];
    const ny = car.ty + DV[car.dout][1];
    const distEdge = (1 - car.t) * car.seg.len;
    if (!this.isRoad(nx, ny) || (this.blocked.has(tileKey(nx, ny)) && car.park !== tileKey(nx, ny))) {
      // пътят напред изчезна или е затворен – обръща в тази плочка, ако още може
      if (car.t < 0.4) {
        car.dout = this.chooseCar(car.tx, car.ty, car.din);
        const old = car.t * car.seg.len;
        car.seg = this.carSeg(car.tx, car.ty, car.din, car.dout);
        car.t = Math.min(0.9, old / car.seg.len);
      } else gap = Math.min(gap, distEdge - 0.05);
    } else if (this.isJunction(nx, ny)) {
      const k = tileKey(nx, ny);
      if (car.granted !== k) {
        if (car.next === null) car.next = this.nextDir(car, nx, ny, car.dout);
        if (distEdge < 0.7) {
          if (!car.waitingAt) {
            car.waitingAt = k;
            let s = this.waiting.get(k);
            if (!s) this.waiting.set(k, (s = new Set()));
            s.add(car);
          }
          if (this.canEnter(car, nx, ny, car.dout, car.next)) {
            if (car.granted) this.occupancy.get(car.granted)?.delete(car);
            car.granted = k;
            car.jIn = car.dout;
            let s = this.occupancy.get(k);
            if (!s) this.occupancy.set(k, (s = new Set()));
            s.add(car);
            this.waiting.get(k)?.delete(car);
            car.waitingAt = null;
          } else gap = Math.min(gap, distEdge - 0.04);
        } else gap = Math.min(gap, distEdge + 0.3);
      }
    }

    // кола или пешеходец отпред
    const fx = Math.floor(car.x);
    const fy = Math.floor(car.y);
    for (let gy = fy - 1; gy <= fy + 1; gy++)
      for (let gx = fx - 1; gx <= fx + 1; gx++) {
        const key = tileKey(gx, gy);
        for (const o of this.grid.get(key) ?? []) {
          if (o === car || o.alpha < 0.3) continue;
          const rx = o.x - car.x;
          const ry = o.y - car.y;
          const along = rx * car.hx + ry * car.hy;
          if (along <= 0 || along > 1.4) continue;
          const lat = Math.abs(rx * car.hy - ry * car.hx);
          if (lat > 0.1) continue;
          const g = along - (car.len + o.len) / 2;
          if (g < gap) {
            gap = g;
            leaderV = o.v;
          }
        }
        for (const p of this.pedGrid.get(key) ?? []) {
          if (!p.onRoad) continue;
          const rx = p.x - car.x;
          const ry = p.y - car.y;
          const along = rx * car.hx + ry * car.hy;
          if (along <= 0 || along > 0.9) continue;
          if (Math.abs(rx * car.hy - ry * car.hx) > 0.13) continue;
          const g = along - car.len / 2 - 0.05;
          if (g < gap) {
            gap = g;
            leaderV = 0;
          }
        }
      }

    // модел на интелигентния шофьор
    let acc = A * (1 - Math.pow(car.v / Math.max(0.05, vDes), 4));
    if (gap < Infinity) {
      const s0 = 0.07;
      const sStar = s0 + car.v * 0.55 + (car.v * (car.v - leaderV)) / (2 * Math.sqrt(A * 2.6));
      acc -= A * Math.pow(Math.max(0, sStar) / Math.max(0.01, gap), 2);
    }
    car.v = Math.max(0, car.v + Math.max(-7, acc) * dt);
    if (gap < 0.015) car.v = 0;
    if (car.v < 0.03) {
      car.wait += dt;
      car.stuck += dt;
    } else {
      car.wait = 0;
      car.stuck = Math.max(0, car.stuck - dt * 2);
    }
    // забравените коли (задръстване без изход) тихо „паркират“
    if (car.stuck > 14 && car.fade >= 0) car.fade = -1;

    car.t += (car.v * dt) / car.seg.len;
    while (car.t >= 1) {
      const oldLen = car.seg.len;
      const leaving = tileKey(car.tx, car.ty);
      if (car.granted === leaving) {
        this.occupancy.get(leaving)?.delete(car);
        car.granted = null;
      }
      car.tx += DV[car.dout][0];
      car.ty += DV[car.dout][1];
      if (!this.isRoad(car.tx, car.ty)) {
        car.remove = true;
        return;
      }
      car.din = car.dout;
      car.dout = car.next ?? this.nextDir(car, car.tx, car.ty, car.din);
      car.next = null;
      car.seg = this.carSeg(car.tx, car.ty, car.din, car.dout);
      car.t = ((car.t - 1) * oldLen) / car.seg.len;
      car.trip--;
      if (car.trip <= 0 && car.fade >= 0 && !this.isJunction(car.tx, car.ty) && this.carSpawn.includes(tileKey(car.tx, car.ty))) car.fade = -1;
    }
    segAt(car.seg, Math.min(1, car.t), tmp);
    const dx = tmp[0] - car.x;
    const dy = tmp[1] - car.y;
    const d = Math.hypot(dx, dy);
    if (d > 1e-4) {
      // плавно завъртане към посоката на движение
      const k = Math.min(1, dt * 10);
      car.hx += (dx / d - car.hx) * k;
      car.hy += (dy / d - car.hy) * k;
      const hl = Math.hypot(car.hx, car.hy) || 1;
      car.hx /= hl;
      car.hy /= hl;
    }
    car.x = tmp[0];
    car.y = tmp[1];
  }

  // ------------------------------------------------------------ пешеходци
  private walkOff(x: number, y: number) {
    const t = this.tiles.get(tileKey(x, y));
    if (t?.t === 'path') return 0.08;
    if (t?.t === 'road') return walkOffset(t.c ?? 'street');
    return 0.1;
  }
  private edgeWalk(x: number, y: number, d: Dir) {
    const nx = x + DV[d][0];
    const ny = y + DV[d][1];
    return this.isWalk(nx, ny) ? (this.walkOff(x, y) + this.walkOff(nx, ny)) / 2 : this.walkOff(x, y);
  }
  private pedSeg(p: { side: number }, x: number, y: number, din: Dir, dout: Dir) {
    const offIn = p.side * this.edgeWalk(x, y, rev(din));
    // при обръщане в задънена улица остава на същия тротоар
    const offOut = dout === rev(din) ? -offIn : p.side * this.edgeWalk(x, y, dout);
    return makeSeg(x, y, din, dout, offIn, offOut, null);
  }
  private choosePed(x: number, y: number, din: Dir): Dir {
    const opts: [Dir, number][] = [];
    for (let d = 0 as Dir; d < 4; d = (d + 1) as Dir) {
      if (d === rev(din)) continue;
      if (!this.isWalk(x + DV[d][0], y + DV[d][1])) continue;
      opts.push([d, d === din ? 2.2 : 1]);
    }
    if (!opts.length) return rev(din);
    let sum = opts.reduce((a, o) => a + o[1], 0) * Math.random();
    for (const [d, w] of opts) if ((sum -= w) <= 0) return d;
    return opts[0][0];
  }

  private spawnPed(): boolean {
    if (!this.pedSpawn.length) return false;
    const k = this.pedSpawn[Math.floor(Math.random() * this.pedSpawn.length)];
    const [x, y] = parseKey(k);
    const dirs = ([0, 1, 2, 3] as Dir[]).filter((d) => this.isWalk(x + DV[d][0], y + DV[d][1]));
    const dout = dirs.length ? dirs[Math.floor(Math.random() * dirs.length)] : (Math.floor(Math.random() * 4) as Dir);
    const din = dirs.includes(rev(dout)) ? dout : dout;
    const side: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
    const seg = this.pedSeg({ side }, x, y, din, dout);
    const t = Math.random() * 0.8;
    segAt(seg, t, tmp);
    const frames = personFrames(Math.floor(Math.random() * PED_VARIANTS));
    const sp = new Sprite(frames[0]);
    sp.anchor.set(PED_ANCHOR.x, PED_ANCHOR.y);
    const kid = Math.random() < 0.12;
    // хората са малко по-едри, за да се виждат добре отблизо
    sp.scale.set(PED_ANCHOR.scale * 1.3 * (kid ? 0.72 : 0.92 + Math.random() * 0.16));
    sp.alpha = 0;
    this.layer.addChild(sp);
    this.peds.push({
      sp,
      frames,
      x: tmp[0],
      y: tmp[1],
      hx: DV[dout][0],
      hy: DV[dout][1],
      tx: x,
      ty: y,
      din,
      dout,
      seg,
      t,
      v: 0.2 + Math.random() * 0.14,
      side,
      phase: Math.random() * 4,
      wait: 0,
      trip: 8 + Math.floor(Math.random() * 30),
      alpha: 0,
      fade: 1,
      jitter: (Math.random() - 0.5) * 0.05,
      onRoad: false,
      remove: false,
    });
    return true;
  }

  private updatePed(p: Ped, dt: number) {
    let go = true;
    // преди пресичане на кръстовище – изчаква, ако наближава кола
    if (p.t > 0.85) {
      const nx = p.tx + DV[p.dout][0];
      const ny = p.ty + DV[p.dout][1];
      if (this.isRoad(nx, ny) && this.arms(nx, ny).length >= 3 && p.wait < 6) {
        for (let gy = ny - 1; gy <= ny + 1 && go; gy++)
          for (let gx = nx - 1; gx <= nx + 1 && go; gx++)
            for (const c of this.grid.get(tileKey(gx, gy)) ?? []) {
              if (c.v < 0.12) continue;
              const rx = nx + 0.5 - c.x;
              const ry = ny + 0.5 - c.y;
              if (Math.hypot(rx, ry) < 0.95 && rx * c.hx + ry * c.hy > -0.2) {
                go = false;
                break;
              }
            }
      }
    }
    if (!go) {
      p.wait += dt;
      return;
    }
    p.wait = 0;
    p.t += (p.v * dt) / p.seg.len;
    p.phase = (p.phase + p.v * dt * 26) % 4;
    while (p.t >= 1) {
      const oldLen = p.seg.len;
      p.tx += DV[p.dout][0];
      p.ty += DV[p.dout][1];
      if (!this.isWalk(p.tx, p.ty)) {
        p.remove = true;
        return;
      }
      if (p.dout === rev(p.din)) p.side = -p.side as 1 | -1;
      p.din = p.dout;
      p.dout = this.choosePed(p.tx, p.ty, p.din);
      p.seg = this.pedSeg(p, p.tx, p.ty, p.din, p.dout);
      p.t = ((p.t - 1) * oldLen) / p.seg.len;
      p.trip--;
      if (p.trip <= 0 && p.fade >= 0 && this.pedSpawn.includes(tileKey(p.tx, p.ty))) p.fade = -1;
    }
    segAt(p.seg, Math.min(1, p.t), tmp);
    const dx = tmp[0] - p.x;
    const dy = tmp[1] - p.y;
    const d = Math.hypot(dx, dy);
    if (d > 1e-5) {
      p.hx = dx / d;
      p.hy = dy / d;
    }
    p.x = tmp[0];
    p.y = tmp[1];
    // на пътното платно ли е (пресича)?
    const r = this.road(p.tx, p.ty);
    if (r) {
      const half = ROAD_GEOM[r.c ?? 'street'].width / 2 + 0.03;
      const lx = Math.abs(p.x - (p.tx + 0.5));
      const ly = Math.abs(p.y - (p.ty + 0.5));
      p.onRoad = this.arms(p.tx, p.ty).length >= 3 ? Math.min(lx, ly) < half || !hasSidewalk(r) : false;
    } else p.onRoad = false;
  }

  // ------------------------------------------------------------ кадър
  update(dt: number, scale: number) {
    this.time += dt;
    const showCars = scale >= 0.42;
    const showPeds = scale >= 0.55;
    this.layer.visible = showCars;
    if (!showCars) return;
    if (this.lineDirty) this.buildLine();
    // попълване до желания брой (постепенно)
    if (this.cars.length < this.wantCars && Math.random() < 0.5) this.spawnCar();
    if (this.peds.length < this.wantPeds && Math.random() < 0.6) this.spawnPed();
    // излишните изчезват плавно
    let extra = this.cars.length - this.wantCars;
    for (const c of this.cars) if (!c.loopDirs && !c.job && extra-- > 0 && c.fade >= 0) c.fade = -1;
    extra = this.peds.length - this.wantPeds;
    for (const p of this.peds) if (extra-- > 0 && p.fade >= 0) p.fade = -1;

    // пространствени решетки
    this.grid.clear();
    for (const c of this.cars) {
      const k = tileKey(Math.floor(c.x), Math.floor(c.y));
      let a = this.grid.get(k);
      if (!a) this.grid.set(k, (a = []));
      a.push(c);
    }
    this.pedGrid.clear();
    for (const p of this.peds) {
      if (!p.onRoad) continue;
      const k = tileKey(Math.floor(p.x), Math.floor(p.y));
      let a = this.pedGrid.get(k);
      if (!a) this.pedGrid.set(k, (a = []));
      a.push(p);
    }

    for (const c of this.cars) {
      if (!c.remove) this.updateCar(c, dt);
      c.alpha = Math.max(0, Math.min(1, c.alpha + c.fade * dt * 1.6));
      if (c.fade < 0 && c.alpha <= 0) c.remove = true;
      const p = iso(c.x, c.y);
      c.sp.position.set(p.x, p.y);
      c.sp.texture = c.frames[headingFrame(c.hx, c.hy)];
      c.sp.zIndex = c.x + c.y;
      c.sp.alpha = c.alpha;
      c.sp.visible = !this.hidden.has(tileKey(Math.floor(c.x), Math.floor(c.y)));
      if (c.beacon) {
        c.beacon.visible = !!c.job;
        c.beacon.position.set(p.x, p.y - 12);
        c.beacon.zIndex = c.sp.zIndex + 0.002;
        c.beacon.alpha = c.alpha * (Math.sin(this.time * 12) > 0 ? 1 : 0.15);
      }
      if (c.hl && c.tl) {
        const on = this.night > 0.3;
        c.hl.visible = on;
        c.tl.visible = on;
        if (on) {
          const f = iso(c.x + (c.hx * c.len) / 2, c.y + (c.hy * c.len) / 2);
          const b = iso(c.x - (c.hx * c.len) / 2, c.y - (c.hy * c.len) / 2);
          c.hl.position.set(f.x, f.y - 2);
          c.hl.rotation = Math.atan2((c.hx + c.hy) * 16, (c.hx - c.hy) * 32);
          c.hl.scale.set(0.5, 0.4);
          c.hl.alpha = c.alpha * 0.4 * this.night;
          c.tl.position.set(b.x, b.y - 2.5);
          c.tl.alpha = c.alpha * this.night * (c.v < 0.1 ? 1 : 0.6);
        }
      }
    }
    for (const p of this.peds) {
      p.sp.visible = showPeds && !this.hidden.has(tileKey(Math.floor(p.x), Math.floor(p.y)));
      if (!p.remove) this.updatePed(p, dt);
      p.alpha = Math.max(0, Math.min(1, p.alpha + p.fade * dt * 1.5));
      if (p.fade < 0 && p.alpha <= 0) p.remove = true;
      const sx = p.hx - p.hy;
      const sy = p.hx + p.hy;
      const away = sy < 0;
      const s = iso(p.x + p.jitter * p.hy, p.y - p.jitter * p.hx);
      p.sp.position.set(s.x, s.y);
      p.sp.texture = p.frames[(away ? 4 : 0) + (p.wait > 0 ? 0 : Math.floor(p.phase))];
      p.sp.scale.x = Math.abs(p.sp.scale.x) * (sx >= 0 ? 1 : -1);
      p.sp.zIndex = p.x + p.y + 0.001;
      p.sp.alpha = p.alpha;
    }
    // почистване
    if (this.cars.some((c) => c.remove)) {
      this.cars = this.cars.filter((c) => {
        if (!c.remove) return true;
        this.releaseJunction(c);
        c.hl?.destroy();
        c.tl?.destroy();
        c.beacon?.destroy();
        c.sp.destroy();
        return false;
      });
    }
    if (this.peds.some((p) => p.remove)) {
      this.peds = this.peds.filter((p) => {
        if (!p.remove) return true;
        p.sp.destroy();
        return false;
      });
    }
    this.paintSignals();
  }

  /** Светофарите светят според фазата (зелено/жълто/червено за всяка посока). */
  private paintSignals() {
    const slot = Math.floor(this.time * 4);
    if (slot === this.lastSignalPaint) return;
    this.lastSignalPaint = slot;
    const g = this.signalG;
    g.clear();
    const COL = { g: 0x3ddc84, y: 0xffc531, r: 0xff3b30 };
    for (const s of this.signals) {
      const cx = s.x + 0.5;
      const cy = s.y + 0.5;
      for (const a of s.arms) {
        // светофарът е вдясно от идващите от това рамо коли
        const din = rev(a);
        const [dx, dy] = DV[din];
        const [ax, ay] = DV[a];
        const half = ROAD_GEOM[this.cls(s.x, s.y)].width / 2 + 0.06;
        const wx = cx + ax * 0.42 - dy * half;
        const wy = cy + ay * 0.42 + dx * half;
        const p = iso(wx, wy);
        const st = this.signalState(s.x, s.y, axis(din));
        g.moveTo(p.x, p.y)
          .lineTo(p.x, p.y - 13)
          .stroke({ width: 1.2, color: 0x2a2d31 });
        g.roundRect(p.x - 2.2, p.y - 20, 4.4, 8.4, 1.2).fill(0x1b1d20);
        g.circle(p.x, p.y - 18, 1.15).fill(st === 'r' ? COL.r : 0x3a1512);
        g.circle(p.x, p.y - 16, 1.15).fill(st === 'y' ? COL.y : 0x3a3112);
        g.circle(p.x, p.y - 14, 1.15).fill(st === 'g' ? COL.g : 0x12301f);
        g.circle(p.x, p.y - (st === 'r' ? 18 : st === 'y' ? 16 : 14), 2.4).fill({ color: COL[st], alpha: 0.25 });
      }
    }
  }

  /** За проверки/отстраняване на грешки. */
  stats() {
    let overlaps = 0;
    for (let i = 0; i < this.cars.length; i++)
      for (let j = i + 1; j < this.cars.length; j++) {
        const a = this.cars[i];
        const b = this.cars[j];
        if (a.alpha < 0.5 || b.alpha < 0.5) continue;
        const rx = b.x - a.x;
        const ry = b.y - a.y;
        const along = Math.abs(rx * a.hx + ry * a.hy);
        const lat = Math.abs(rx * a.hy - ry * a.hx);
        if (along < (a.len + b.len) / 2 - 0.02 && lat < 0.1) overlaps++;
      }
    return { cars: this.cars.length, peds: this.peds.length, overlaps, waiting: this.cars.filter((c) => c.v < 0.03).length };
  }
}

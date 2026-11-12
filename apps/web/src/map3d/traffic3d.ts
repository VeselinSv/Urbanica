/**
 * Движение в 3D: коли в дясната лента по пътната мрежа (по мостовете – по платното, в тунелите – скрити)
 * и пешеходци по тротоарите. Инстанцирани мрежи – стотици коли и хора на един draw call.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { hasSidewalk, type TileMap } from '@gce/shared';

const DIRS: [number, number][] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];
const PALETTE = [0xf2f2ef, 0xf2f2ef, 0xb9bec4, 0xb9bec4, 0x23262b, 0x23262b, 0x5b6068, 0x1f3a5f, 0x8e1b1b, 0x5a1f2b, 0xc9b99a, 0x2f4a3a, 0x6f9bc4];
const SHIRTS = [0xc0392b, 0x2471a3, 0xf2f2ef, 0x1e8449, 0xf1c40f, 0x8e44ad, 0xe67e22, 0x34495e, 0xd35d8a, 0x16a085];

interface Agent {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  s: number;
  speed: number;
  side: number;
}

function carGeometry() {
  // долна каросерия + стеснен горен ръб (капак/багажник)
  const lower = new THREE.BoxGeometry(0.16, 0.026, 0.075).translate(0, 0.025, 0);
  const upper = new THREE.BoxGeometry(0.15, 0.012, 0.068).translate(0, 0.044, 0);
  const roof = new THREE.BoxGeometry(0.07, 0.006, 0.058).translate(-0.01, 0.077, 0);
  return mergeGeometries([lower.toNonIndexed(), upper.toNonIndexed(), roof.toNonIndexed()])!;
}
function cabinGeometry() {
  // стъклена кабина с наклонени стъкла (стеснена отгоре)
  const g = new THREE.CylinderGeometry(0.05, 0.065, 0.026, 4, 1).rotateY(Math.PI / 4);
  g.scale(1.05, 1, 0.68);
  return g.translate(-0.008, 0.063, 0);
}
function wheelGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  for (const x of [-0.05, 0.05])
    for (const z of [-0.036, 0.036])
      parts.push(
        new THREE.CylinderGeometry(0.015, 0.015, 0.012, 10)
          .rotateX(Math.PI / 2)
          .translate(x, 0.015, z)
          .toNonIndexed(),
      );
  return mergeGeometries(parts)!;
}
function personGeometry() {
  const legs = new THREE.CylinderGeometry(0.006, 0.006, 0.022, 6).translate(0, 0.011, 0);
  const body = new THREE.CylinderGeometry(0.008, 0.007, 0.02, 8).translate(0, 0.032, 0);
  return mergeGeometries([legs.toNonIndexed(), body.toNonIndexed()])!;
}

export class Traffic3D {
  readonly group = new THREE.Group();
  private roads: string[] = [];
  private tiles: TileMap = {};
  private cars: Agent[] = [];
  private people: Agent[] = [];
  private carBody: THREE.InstancedMesh;
  private carCabin: THREE.InstancedMesh;
  private carWheels: THREE.InstancedMesh;
  private peopleMesh: THREE.InstancedMesh;
  private heads: THREE.InstancedMesh;
  private readonly MAXC = 220;
  private readonly MAXP = 200;
  /** Височина на платното в точка (мостове, терен). */
  roadY: (x: number, z: number) => number = () => 0;
  /** Плочката е в тунел – колите не се виждат. */
  hidden: (x: number, y: number) => boolean = () => false;
  night = 0;

  constructor() {
    this.carBody = new THREE.InstancedMesh(carGeometry(), new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.45 }), this.MAXC);
    this.carCabin = new THREE.InstancedMesh(cabinGeometry(), new THREE.MeshStandardMaterial({ color: 0x22303d, roughness: 0.08, metalness: 0.6 }), this.MAXC);
    this.carWheels = new THREE.InstancedMesh(wheelGeometry(), new THREE.MeshStandardMaterial({ color: 0x141516, roughness: 0.9 }), this.MAXC);
    this.peopleMesh = new THREE.InstancedMesh(personGeometry(), new THREE.MeshStandardMaterial({ roughness: 0.9 }), this.MAXP);
    this.heads = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.0075, 8, 6),
      new THREE.MeshStandardMaterial({ color: 0xe0ac87, roughness: 0.8 }),
      this.MAXP,
    );
    for (const m of [this.carBody, this.carCabin, this.carWheels, this.peopleMesh, this.heads]) {
      m.castShadow = true;
      m.count = 0;
      m.frustumCulled = false;
      this.group.add(m);
    }
  }

  setTiles(tiles: TileMap, load: number) {
    this.tiles = tiles;
    this.roads = Object.entries(tiles)
      .filter(([, t]) => t.t === 'road')
      .map(([k]) => k);
    const wantC = Math.min(this.MAXC, Math.round(this.roads.length * 0.35 * (0.5 + Math.min(1, load))));
    const walk = this.roads.filter((k) => hasSidewalk(tiles[k]));
    const wantP = Math.min(this.MAXP, Math.round(walk.length * 0.35));
    const valid = (a: Agent) => this.isRoad(a.ax, a.ay) && this.isRoad(a.bx, a.by);
    this.cars = this.cars.filter(valid).slice(0, wantC);
    this.people = this.people.filter(valid).slice(0, wantP);
    while (this.cars.length < wantC && this.roads.length) this.cars.push(this.spawn(this.roads, 0.9 + Math.random() * 0.6, 1));
    while (this.people.length < wantP && walk.length) this.people.push(this.spawn(walk, 0.12 + Math.random() * 0.08, Math.random() < 0.5 ? -1 : 1));
    this.carBody.count = this.carCabin.count = this.carWheels.count = this.cars.length;
    this.peopleMesh.count = this.heads.count = this.people.length;
    const col = new THREE.Color();
    this.cars.forEach((_, i) => this.carBody.setColorAt(i, col.setHex(PALETTE[(i * 7) % PALETTE.length])));
    this.people.forEach((_, i) => this.peopleMesh.setColorAt(i, col.setHex(SHIRTS[(i * 5) % SHIRTS.length])));
    if (this.carBody.instanceColor) this.carBody.instanceColor.needsUpdate = true;
    if (this.peopleMesh.instanceColor) this.peopleMesh.instanceColor.needsUpdate = true;
  }

  private isRoad(x: number, y: number) {
    return this.tiles[`${x},${y}`]?.t === 'road';
  }

  private spawn(list: string[], speed: number, side: number): Agent {
    const [x, y] = list[Math.floor(Math.random() * list.length)].split(',').map(Number);
    const n = this.next(x, y, x, y);
    return { ax: x, ay: y, bx: n[0], by: n[1], s: Math.random(), speed, side };
  }

  /** Следваща плочка: случаен съсед (без обратно, освен в задънена улица). */
  private next(x: number, y: number, px: number, py: number): [number, number] {
    const opts = DIRS.map(([dx, dy]) => [x + dx, y + dy] as [number, number]).filter(([nx, ny]) => this.isRoad(nx, ny));
    const fwd = opts.filter(([nx, ny]) => nx !== px || ny !== py);
    const list = fwd.length ? fwd : opts;
    return list.length ? list[Math.floor(Math.random() * list.length)] : [x, y];
  }

  update(dt: number) {
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);
    const zero = new THREE.Vector3(0, 0, 0);
    const step = (a: Agent) => {
      a.s += a.speed * dt;
      while (a.s >= 1) {
        a.s -= 1;
        const n = this.next(a.bx, a.by, a.ax, a.ay);
        a.ax = a.bx;
        a.ay = a.by;
        a.bx = n[0];
        a.by = n[1];
      }
    };
    this.cars.forEach((a, i) => {
      step(a);
      const fx = a.bx - a.ax;
      const fz = a.by - a.ay;
      const len = Math.hypot(fx, fz) || 1;
      // дясна лента: вдясно от посоката на движение
      const rx = -fz / len;
      const rz = fx / len;
      const x = a.ax + 0.5 + fx * a.s + rx * 0.13;
      const z = a.ay + 0.5 + fz * a.s + rz * 0.13;
      const tx = Math.floor(x);
      const tz = Math.floor(z);
      const hide = this.hidden(tx, tz);
      q.setFromAxisAngle(up, Math.atan2(-fz, fx));
      m4.compose(new THREE.Vector3(x, this.roadY(x, z), z), q, hide ? zero : one);
      this.carBody.setMatrixAt(i, m4);
      this.carCabin.setMatrixAt(i, m4);
      this.carWheels.setMatrixAt(i, m4);
    });
    this.people.forEach((a, i) => {
      step(a);
      const fx = a.bx - a.ax;
      const fz = a.by - a.ay;
      const len = Math.hypot(fx, fz) || 1;
      const rx = -fz / len;
      const rz = fx / len;
      const off = 0.33 * a.side;
      const x = a.ax + 0.5 + fx * a.s + rx * off;
      const z = a.ay + 0.5 + fz * a.s + rz * off;
      const bob = Math.abs(Math.sin((a.s + i) * Math.PI * 8)) * 0.003;
      m4.compose(new THREE.Vector3(x, this.roadY(x, z) + 0.02 + bob, z), q.identity(), this.hidden(Math.floor(x), Math.floor(z)) ? zero : one);
      this.peopleMesh.setMatrixAt(i, m4);
      m4.compose(new THREE.Vector3(x, this.roadY(x, z) + 0.02 + 0.05 + bob, z), q, one);
      this.heads.setMatrixAt(i, m4);
    });
    for (const m of [this.carBody, this.carCabin, this.carWheels, this.peopleMesh, this.heads]) m.instanceMatrix.needsUpdate = true;
  }
}

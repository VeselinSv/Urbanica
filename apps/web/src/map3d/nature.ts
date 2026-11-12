/**
 * Дървета и скали в 3D: инстанцирани обеми (ствол + корона с неравна форма, иглолистни – конуси на етажи),
 * разположени по гъстотата на горите. Показват се в прозорец около камерата и се преизчисляват при
 * придвижване. На територията на градовете дървета няма.
 */
import * as THREE from 'three';
import { MOUNTAINS, type WorldGenerator } from '@gce/world-generation';
import type { Season3, Terrain3D } from './terrain';

function h01(...n: number[]): number {
  let h = 2166136261;
  for (const v of n) {
    h ^= Math.floor(v * 1000) | 0;
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Корона: икосаедър с разместени върхове – не изглежда като топка. */
function crownGeometry(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 0);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const k = 0.82 + h01(i, 3) * 0.36;
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 0.85, p.getZ(i) * k);
  }
  g.computeVertexNormals();
  return g;
}

function coniferGeometry(): THREE.BufferGeometry {
  // три конуса един над друг – като истинска ела
  const parts = [
    new THREE.ConeGeometry(1, 0.9, 8).translate(0, 0.45, 0),
    new THREE.ConeGeometry(0.78, 0.8, 8).translate(0, 0.85, 0),
    new THREE.ConeGeometry(0.52, 0.7, 8).translate(0, 1.25, 0),
  ];
  const pos: number[] = [];
  const nrm: number[] = [];
  for (const g of parts) {
    const ng = g.toNonIndexed();
    ng.computeVertexNormals();
    pos.push(...(ng.getAttribute('position').array as Float32Array));
    nrm.push(...(ng.getAttribute('normal').array as Float32Array));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return g;
}

export class Nature3D {
  readonly group = new THREE.Group();
  private center = { x: -1e9, z: -1e9 };
  private trunks: THREE.InstancedMesh | null = null;
  private crowns: THREE.InstancedMesh | null = null;
  private conifers: THREE.InstancedMesh | null = null;
  private rocks: THREE.InstancedMesh | null = null;
  private readonly crownGeo = crownGeometry();
  private readonly coniferGeo = coniferGeometry();
  private readonly trunkGeo = new THREE.CylinderGeometry(0.6, 1, 1, 6).translate(0, 0.5, 0);
  private readonly rockGeo = new THREE.DodecahedronGeometry(1, 0);
  season: Season3 = 'summer';
  /** Плочки без дървета (градска територия, пътища). */
  cleared: (x: number, y: number) => boolean = () => false;

  constructor(
    private gen: WorldGenerator,
    private terrain: Terrain3D,
  ) {}

  /** Прерисува, ако камерата се е отместила достатъчно (или force). */
  update(cx: number, cz: number, force = false) {
    if (!force && Math.hypot(cx - this.center.x, cz - this.center.z) < 14) return;
    this.center = { x: cx, z: cz };
    this.rebuild();
  }

  private rebuild() {
    for (const m of [this.trunks, this.crowns, this.conifers, this.rocks]) if (m) this.group.remove(m);
    const R = 42;
    const c = this.gen.country;
    const N = this.gen.size;
    type T = { x: number; z: number; y: number; s: number; con: boolean; v: number };
    const trees: T[] = [];
    const rocks: { x: number; z: number; y: number; s: number; v: number }[] = [];
    const x0 = Math.max(1, Math.floor(this.center.x - R));
    const x1 = Math.min(N - 2, Math.ceil(this.center.x + R));
    const z0 = Math.max(1, Math.floor(this.center.z - R));
    const z1 = Math.min(N - 2, Math.ceil(this.center.z + R));
    for (let y = z0; y <= z1; y++)
      for (let x = x0; x <= x1; x++) {
        const k = y * N + x;
        if (c.water[k] || this.cleared(x, y)) continue;
        const f = c.forest[k];
        const h = c.height[k];
        if (h > 0.8) continue;
        let n = 0;
        if (f > 0.5) n = h01(x, y, 1) < 0.15 ? 1 : 4;
        else if (f > 0.3) n = h01(x, y, 2) < f * 1.6 ? 2 : 0;
        else n = h01(x, y, 3) < 0.05 + f * 0.25 ? 1 : 0;
        if (h > 0.74) n = Math.min(n, 1);
        for (let i = 0; i < n; i++) {
          const px = x + 0.15 + h01(x, y, i, 4) * 0.7;
          const pz = y + 0.15 + h01(x, y, i, 5) * 0.7;
          const con = h > 0.58 || h01(x, y, i, 6) < (h > 0.5 ? 0.6 : 0.15);
          trees.push({ x: px, z: pz, y: this.terrain.heightAt(px, pz), s: 0.75 + h01(x, y, i, 7) * 0.6, con, v: h01(x, y, i, 8) });
        }
        if (h > MOUNTAINS - 0.03 && h01(x, y, 9) < 0.35) {
          const px = x + h01(x, y, 10);
          const pz = y + h01(x, y, 11);
          rocks.push({ x: px, z: pz, y: this.terrain.heightAt(px, pz), s: 0.08 + h01(x, y, 12) * 0.16, v: h01(x, y, 13) });
        }
      }
    const winter = this.season === 'winter';
    const autumn = this.season === 'autumn';
    const decid = trees.filter((t) => !t.con);
    const con = trees.filter((t) => t.con);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const col = new THREE.Color();
    // стволове (за всички дървета)
    const trunks = new THREE.InstancedMesh(this.trunkGeo, new THREE.MeshStandardMaterial({ color: 0x5a4130, roughness: 1 }), trees.length);
    trees.forEach((t, i) => {
      const hgt = (t.con ? 0.18 : winter ? 0.42 : 0.3) * t.s;
      m4.compose(new THREE.Vector3(t.x, t.y - 0.02, t.z), q, new THREE.Vector3(0.035 * t.s, hgt, 0.035 * t.s));
      trunks.setMatrixAt(i, m4);
    });
    trunks.castShadow = true;
    // широколистни корони (зимата – голи, само ствол и тънки клони като по-тъмна, по-рядка корона)
    const crowns = new THREE.InstancedMesh(this.crownGeo, new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }), decid.length);
    decid.forEach((t, i) => {
      const r = 0.2 * t.s;
      const sc = winter ? new THREE.Vector3(r * 0.85, r * 1.0, r * 0.85) : new THREE.Vector3(r, r * 1.05, r);
      m4.compose(new THREE.Vector3(t.x, t.y + 0.3 * t.s + r * 0.7, t.z), q.setFromEuler(new THREE.Euler(0, t.v * 6.28, 0)), sc);
      crowns.setMatrixAt(i, m4);
      if (winter) col.setHex(0x6b5a4a).multiplyScalar(0.9 + t.v * 0.2);
      else if (autumn) col.setHex([0xc8761e, 0xd9a62b, 0xa8461f, 0x8f9a3a][Math.floor(t.v * 4)]);
      else col.setHex(0x4f7f34).lerp(new THREE.Color(0x7aa846), t.v * 0.6);
      crowns.setColorAt(i, col);
    });
    if (winter) (crowns.material as THREE.MeshStandardMaterial).opacity = 0.45;
    (crowns.material as THREE.MeshStandardMaterial).transparent = winter;
    crowns.castShadow = true;
    // иглолистни
    const conifers = new THREE.InstancedMesh(this.coniferGeo, new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }), con.length);
    con.forEach((t, i) => {
      const r = 0.13 * t.s;
      m4.compose(new THREE.Vector3(t.x, t.y + 0.1 * t.s, t.z), q.setFromEuler(new THREE.Euler(0, t.v * 6.28, 0)), new THREE.Vector3(r, 0.42 * t.s, r));
      conifers.setMatrixAt(i, m4);
      col.setHex(0x2f5a34).lerp(new THREE.Color(0x40683a), t.v);
      if (winter) col.lerp(new THREE.Color(0xe8eef3), 0.35);
      conifers.setColorAt(i, col);
    });
    conifers.castShadow = true;
    const rocksM = new THREE.InstancedMesh(this.rockGeo, new THREE.MeshStandardMaterial({ color: 0x8a857c, roughness: 1, flatShading: true }), rocks.length);
    rocks.forEach((r, i) => {
      m4.compose(
        new THREE.Vector3(r.x, r.y + r.s * 0.3, r.z),
        q.setFromEuler(new THREE.Euler(r.v * 3, r.v * 6, 0)),
        new THREE.Vector3(r.s, r.s * 0.7, r.s * 0.9),
      );
      rocksM.setMatrixAt(i, m4);
    });
    rocksM.castShadow = true;
    rocksM.receiveShadow = true;
    this.trunks = trunks;
    this.crowns = crowns;
    this.conifers = conifers;
    this.rocks = rocksM;
    this.group.add(trunks, crowns, conifers, rocksM);
  }

  setSeason(s: Season3) {
    if (s === this.season) return;
    this.season = s;
    this.rebuild();
  }

  refresh() {
    this.rebuild();
  }
}

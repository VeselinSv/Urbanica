/**
 * Сигналите на гражданите като истински 3D обекти (не картинки):
 *  - дупка – вдлъбнатина в асфалта (изрязана чрез stencil: настилката „се отваря“ в контура на дупката),
 *    с изронени парчета асфалт по ръба, чакъл и вода на дъното;
 *  - теч – шахта, от която блика вода, и локва; канализация – отворена шахта и кална локва;
 *  - боклук – преливащ контейнер, торби и разпилени отпадъци;
 *  - катастрофа – две смачкани коли, стъкла, масло и конуси;
 *  - паднало дърво – ствол с корени и корона през пътя, пън;
 *  - улична лампа – наклонен стълб с разбита глава; ток – разбит трансформатор и паднал кабел;
 *  - графити – изрисувана стена и счупена пейка.
 * Докато екипът работи – заграждения на ленти и работник с каска.
 */
import * as THREE from 'three';
import { carMesh, plain } from './buildings';

function rnd(...n: number[]): number {
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

/** Поставя обекта в точка (position в Three.js е само за четене – не може с Object.assign). */
function at<T extends THREE.Object3D>(o: T, x: number, y: number, z: number): T {
  o.position.set(x, y, z);
  return o;
}

const asphaltDark = () => plain(0x2a2826, 1);
const asphaltRim = () => plain(0x55524d, 1);

/** Неправилен контур около центъра (radius ± jag) – за дупки и локви. */
function blobShape(r: number, seed: number, jag = 0.3, n = 16): THREE.Shape {
  const s = new THREE.Shape();
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const k = 1 - jag / 2 + rnd(seed, i % n) * jag;
    const x = Math.cos(a) * r * k;
    const y = Math.sin(a) * r * k;
    if (i === 0) s.moveTo(x, y);
    else s.lineTo(x, y);
  }
  return s;
}

/** Плоска фигура, легнала хоризонтално – винаги пред асфалта (той е с polygonOffset -2). */
function flat(shape: THREE.Shape, m: THREE.Material, y: number): THREE.Mesh {
  const g = new THREE.ShapeGeometry(shape, 2).rotateX(-Math.PI / 2);
  m.polygonOffset = true;
  m.polygonOffsetFactor = -6;
  m.polygonOffsetUnits = -6;
  const mesh = new THREE.Mesh(g, m);
  mesh.position.y = y + 0.006;
  return mesh;
}

// ------------------------------------------------------------------ дупка (stencil)
const maskMat = new THREE.MeshBasicMaterial({
  colorWrite: false,
  depthWrite: false,
  stencilWrite: true,
  stencilRef: 1,
  stencilFunc: THREE.AlwaysStencilFunc,
  stencilZPass: THREE.ReplaceStencilOp,
});
function inHole(m: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  m.stencilWrite = true;
  m.stencilRef = 1;
  m.stencilFunc = THREE.EqualStencilFunc;
  m.stencilFail = THREE.KeepStencilOp;
  m.stencilZFail = THREE.KeepStencilOp;
  m.stencilZPass = THREE.KeepStencilOp;
  m.depthTest = false;
  m.depthWrite = false;
  return m;
}
const bowlMat = inHole(new THREE.MeshStandardMaterial({ color: 0x4a443d, roughness: 1, side: THREE.BackSide }));
const holeWaterMat = inHole(new THREE.MeshStandardMaterial({ color: 0x5f7f96, roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.85 }));
const gravelMat = inHole(new THREE.MeshStandardMaterial({ color: 0x8b8274, roughness: 1, flatShading: true }));

function pothole(sev: number, seed: number): THREE.Group {
  const g = new THREE.Group();
  const r = 0.06 + sev * 0.03;
  const depth = 0.03 + sev * 0.012;
  const shape = blobShape(r, seed, 0.22, 26);
  // 1) маска: къде настилката „липсва“
  const mask = flat(shape, maskMat, 0.004);
  mask.renderOrder = 3;
  g.add(mask);
  // изронен ръб: по-светъл, натрошен асфалт около отвора
  const edge = blobShape(r * 1.16, seed + 31, 0.3);
  edge.holes.push(blobShape(r * 0.98, seed, 0.22, 26));
  g.add(flat(edge, plain(0x5e5a54, 1), 0.002));
  // 2) самата вдлъбнатина: неправилна купа под нивото на пътя (вижда се само през маската)
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    pts.push(new THREE.Vector2(r * 1.15 * Math.sin((t * Math.PI) / 2) + 0.001, -depth * Math.cos((t * Math.PI) / 2)));
  }
  // гладка купа, по-широка от отвора – контурът на дупката е неравният ръб на маската
  const bowlGeo = new THREE.LatheGeometry(pts, 28);
  bowlGeo.scale(1.15, 1, 1.15);
  const bowl = new THREE.Mesh(bowlGeo, bowlMat);
  bowl.position.y = 0.004;
  bowl.renderOrder = 4;
  g.add(bowl);
  // 3) вода и чакъл на дъното
  if (sev >= 2) {
    const w = flat(blobShape(r * 0.55, seed + 9, 0.3), holeWaterMat, 0.004 - depth * 0.55);
    w.renderOrder = 5;
    g.add(w);
  }
  const gravel = new THREE.DodecahedronGeometry(0.008, 0);
  for (let i = 0; i < 6 + sev * 3; i++) {
    const a = rnd(seed, i, 4) * Math.PI * 2;
    const d = rnd(seed, i, 5) * r * 0.7;
    const s = new THREE.Mesh(gravel, gravelMat);
    s.position.set(Math.cos(a) * d, 0.004 - depth * (0.75 - d / r / 2), Math.sin(a) * d);
    s.renderOrder = 5;
    g.add(s);
  }
  // 4) изронени парчета асфалт по ръба (над пътя – с нормална дълбочина)
  for (let i = 0; i < 7 + sev * 2; i++) {
    const a = rnd(seed, i, 6) * Math.PI * 2;
    const d = r * (1.05 + rnd(seed, i, 7) * 0.35);
    const w = 0.012 + rnd(seed, i, 8) * 0.018;
    const chunk = new THREE.Mesh(
      new THREE.BoxGeometry(w, 0.006 + rnd(seed, i, 9) * 0.006, w * (0.6 + rnd(seed, i, 10) * 0.6)),
      i % 2 ? asphaltRim() : asphaltDark(),
    );
    chunk.position.set(Math.cos(a) * d, 0.006, Math.sin(a) * d);
    chunk.rotation.set(rnd(seed, i, 11) * 0.5, a, rnd(seed, i, 12) * 0.5);
    chunk.castShadow = true;
    g.add(chunk);
  }
  // 5) пукнатини, тръгващи от дупката – тесни тъмни вдлъбнатини
  for (let i = 0; i < 4; i++) {
    const a = rnd(seed, i, 13) * Math.PI * 2;
    const len = r * (0.8 + rnd(seed, i, 14));
    const c = new THREE.Mesh(new THREE.BoxGeometry(len, 0.002, 0.004), asphaltDark());
    c.position.set(Math.cos(a) * (r + len / 2), 0.005, Math.sin(a) * (r + len / 2));
    c.rotation.y = -a;
    g.add(c);
  }
  return g;
}

// ------------------------------------------------------------------ вода
const puddleMat = (dirty: boolean) =>
  new THREE.MeshStandardMaterial({ color: dirty ? 0x5e5c34 : 0x7fa6c2, roughness: 0.02, metalness: 0.45, transparent: true, opacity: dirty ? 0.78 : 0.55 });

function manhole(open: boolean): THREE.Group {
  const g = new THREE.Group();
  const iron = plain(0x3a3f45, 0.6, 0.6);
  if (open) {
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.01, 20), plain(0x0d0e10, 1)));
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.008, 20), iron);
    lid.position.set(0.075, 0.012, 0.02);
    lid.rotation.z = 0.35;
    g.add(lid);
  } else {
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.008, 20), iron);
    lid.position.y = 0.006;
    g.add(lid);
  }
  return g;
}

function waterLeak(sev: number, seed: number, dirty: boolean): THREE.Group {
  const g = new THREE.Group();
  const p = flat(blobShape(0.07 + sev * 0.035, seed, 0.45, 22), puddleMat(dirty), 0.006);
  p.receiveShadow = true;
  g.add(p);
  const m = manhole(true);
  m.position.set(-0.04, 0.004, 0);
  g.add(m);
  if (!dirty) {
    // струя вода от шахтата: колона и пръски отгоре
    const jet = new THREE.MeshStandardMaterial({ color: 0xcfe9f7, transparent: true, opacity: 0.6, roughness: 0.05 });
    const hJet = 0.06 + sev * 0.03;
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.012, hJet, 10, 1, true), jet);
    col.position.set(-0.04, hJet / 2, 0);
    g.add(col);
    const spray = new THREE.Mesh(new THREE.IcosahedronGeometry(0.025 + sev * 0.006, 1), jet);
    spray.position.set(-0.04, hJet, 0);
    spray.scale.y = 0.6;
    g.add(spray);
    for (let i = 0; i < 10; i++) {
      const d = new THREE.Mesh(new THREE.SphereGeometry(0.003, 5, 4), jet);
      const a2 = rnd(seed, i) * Math.PI * 2;
      const r2 = 0.02 + rnd(seed, i, 2) * 0.05;
      d.position.set(-0.04 + Math.cos(a2) * r2, hJet * (0.3 + rnd(seed, i, 3) * 0.6), Math.sin(a2) * r2);
      g.add(d);
    }
  }
  return g;
}

// ------------------------------------------------------------------ боклук
function garbage(sev: number, seed: number): THREE.Group {
  const g = new THREE.Group();
  // контейнер с отворен капак
  const bin = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.08), plain(0x2f6b3a, 0.7, 0.2));
  bin.position.set(-0.06, 0.044, -0.06);
  bin.castShadow = true;
  g.add(bin);
  const lid = new THREE.Mesh(new THREE.BoxGeometry(0.124, 0.006, 0.084), plain(0x245530, 0.6, 0.2));
  lid.position.set(-0.06, 0.1, -0.1);
  lid.rotation.x = -1.1;
  g.add(lid);
  for (const [x, z] of [
    [-0.11, -0.03],
    [-0.01, -0.03],
  ]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.006, 8).rotateX(Math.PI / 2), plain(0x111111));
    w.position.set(x, 0.008, z);
    g.add(w);
  }
  // торби: неравни, лъскави
  const bagGeo = new THREE.IcosahedronGeometry(1, 1);
  const bp = bagGeo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < bp.count; i++) {
    const k = 0.85 + rnd(seed, i) * 0.3;
    bp.setXYZ(i, bp.getX(i) * k, bp.getY(i) * k * 0.8, bp.getZ(i) * k);
  }
  bagGeo.computeVertexNormals();
  const n = 4 + sev * 3;
  for (let i = 0; i < n; i++) {
    const s = 0.025 + rnd(seed, i, 2) * 0.015;
    const bag = new THREE.Mesh(bagGeo, plain(rnd(seed, i, 3) < 0.6 ? 0x1d2023 : 0x2f4a32, 0.25, 0.1));
    bag.scale.setScalar(s);
    bag.position.set((rnd(seed, i, 4) - 0.3) * 0.2, s * 0.75 + (i < 3 ? 0.08 : 0), (rnd(seed, i, 5) - 0.3) * 0.16);
    if (i < 3) bag.position.set(-0.06 + (i - 1) * 0.03, 0.1, -0.06);
    bag.castShadow = true;
    g.add(bag);
    // възел отгоре
    const knot = new THREE.Mesh(new THREE.ConeGeometry(s * 0.25, s * 0.5, 6), bag.material);
    knot.position.copy(bag.position).y += s * 0.85;
    g.add(knot);
  }
  // разпилени отпадъци
  const litter = [0xd9d4c7, 0xc94f3d, 0xe2c25a, 0x7aa3c7];
  for (let i = 0; i < 10 + sev * 6; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.004, 0.009), plain(litter[i % 4]));
    b.position.set((rnd(seed, i, 6) - 0.5) * 0.36, 0.004, (rnd(seed, i, 7) - 0.5) * 0.3);
    b.rotation.y = rnd(seed, i, 8) * 6;
    g.add(b);
  }
  return g;
}

// ------------------------------------------------------------------ катастрофа
function cone(): THREE.Group {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.004, 0.03), plain(0x1d1d1d)));
  const c = new THREE.Mesh(new THREE.ConeGeometry(0.011, 0.045, 12), plain(0xff7a1a, 0.6));
  c.position.y = 0.025;
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.0075, 0.0085, 0.008, 12), plain(0xffffff));
  band.position.y = 0.026;
  g.add(c, band);
  g.traverse((o) => ((o as THREE.Mesh).castShadow = true));
  return g;
}

function accident(seed: number): THREE.Group {
  const g = new THREE.Group();
  const a = carMesh(0xb8312a);
  a.position.set(-0.07, 0, -0.02);
  a.rotation.set(0, 0.5, 0.04);
  const b = carMesh(0xe9ecef);
  b.position.set(0.08, 0, 0.04);
  b.rotation.set(0, -1.1, -0.03);
  // смачкани предници: наклонени капаци
  for (const car of [a, b]) {
    car.traverse((o) => ((o as THREE.Mesh).castShadow = true));
    const hood = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.012, 0.07), plain(0x555555, 0.5, 0.4));
    hood.position.set(0.07, 0.05, 0);
    hood.rotation.z = -0.5;
    car.add(hood);
  }
  g.add(a, b);
  // масло и стъкла
  g.add(
    flat(
      blobShape(0.08, seed, 0.6),
      new THREE.MeshStandardMaterial({ color: 0x15131c, roughness: 0.05, metalness: 0.6, transparent: true, opacity: 0.8 }),
      0.004,
    ),
  );
  const glass = new THREE.MeshStandardMaterial({ color: 0xdff1ff, roughness: 0, metalness: 0.4, transparent: true, opacity: 0.8 });
  for (let i = 0; i < 18; i++) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.002, 0.004), glass);
    s.position.set((rnd(seed, i) - 0.5) * 0.2, 0.004, (rnd(seed, i, 2) - 0.5) * 0.14);
    s.rotation.y = rnd(seed, i, 3) * 6;
    g.add(s);
  }
  for (const [x, z] of [
    [-0.28, -0.12],
    [0.27, 0.13],
    [-0.2, 0.18],
  ]) {
    const c = cone();
    c.position.set(x, 0, z);
    g.add(c);
  }
  return g;
}

// ------------------------------------------------------------------ паднало дърво
function fallenTree(seed: number, season: string): THREE.Group {
  const g = new THREE.Group();
  const bark = plain(0x5d4433, 1);
  const len = 0.62;
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.034, len, 10), bark);
  trunk.rotation.z = Math.PI / 2;
  trunk.rotation.y = 0.5;
  trunk.position.y = 0.034;
  trunk.castShadow = true;
  g.add(trunk);
  const dir = new THREE.Vector3(Math.cos(-0.5), 0, Math.sin(-0.5));
  // корени (откъснати) в единия край, корона в другия
  const base = dir.clone().multiplyScalar(-len / 2);
  const roots = new THREE.Mesh(new THREE.DodecahedronGeometry(0.06, 0), plain(0x5a4a3a, 1));
  roots.position.set(base.x, 0.05, base.z);
  roots.scale.set(0.6, 1, 1);
  roots.castShadow = true;
  g.add(roots);
  const top = dir.clone().multiplyScalar(len / 2);
  const leaf = season === 'autumn' ? 0xc8861e : 0x4f7f34;
  if (season === 'winter')
    for (let i = 0; i < 9; i++) {
      const tw = new THREE.Mesh(new THREE.CylinderGeometry(0.002, 0.005, 0.12 + rnd(seed, i) * 0.06, 5), bark);
      tw.position.set(top.x + (rnd(seed, i, 2) - 0.3) * 0.12, 0.05 + rnd(seed, i, 3) * 0.04, top.z + (rnd(seed, i, 4) - 0.5) * 0.12);
      tw.rotation.set((rnd(seed, i, 5) - 0.5) * 2.4, rnd(seed, i, 6) * 6, (rnd(seed, i, 7) - 0.5) * 2.4);
      tw.castShadow = true;
      g.add(tw);
    }
  else
    for (let i = 0; i < 7; i++) {
      const c = new THREE.Mesh(new THREE.IcosahedronGeometry(0.05 + rnd(seed, i) * 0.03, 0), plain(leaf, 0.9));
      c.position.set(top.x + (rnd(seed, i, 2) - 0.3) * 0.16, 0.05 + rnd(seed, i, 3) * 0.04, top.z + (rnd(seed, i, 4) - 0.5) * 0.14);
      c.castShadow = true;
      g.add(c);
    }
  // счупени клони
  for (let i = 0; i < 4; i++) {
    const br = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.007, 0.12, 6), bark);
    const t = 0.1 + i * 0.12;
    br.position.set(dir.x * (t - 0.1), 0.05, dir.z * (t - 0.1) + (i % 2 ? 0.04 : -0.04));
    br.rotation.set(0.9 * (i % 2 ? 1 : -1), 0, 0.7);
    g.add(br);
  }
  return g;
}

// ------------------------------------------------------------------ улично осветление, ток, графити
function brokenLamp(): THREE.Group {
  const g = new THREE.Group();
  const pole = plain(0x3d4247, 0.5, 0.6);
  const p = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.009, 0.22, 8), pole);
  p.position.y = 0.11;
  const arm = new THREE.Group();
  arm.add(p);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.01, 0.018), plain(0x222222, 0.6));
  head.position.set(0.02, 0.215, 0);
  arm.add(head);
  arm.rotation.z = -0.35;
  g.add(arm);
  const glass = new THREE.MeshStandardMaterial({ color: 0xeef6ff, transparent: true, opacity: 0.8 });
  for (let i = 0; i < 10; i++) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.002, 0.004), glass);
    s.position.set(0.06 + rnd(i) * 0.06, 0.004, (rnd(i, 2) - 0.5) * 0.06);
    g.add(s);
  }
  return g;
}

function transformer(): THREE.Group {
  const g = new THREE.Group();
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 0.07), plain(0x8b9196, 0.6, 0.4));
  box.position.y = 0.06;
  box.castShadow = true;
  g.add(box);
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.1, 0.06), plain(0x8b9196, 0.6, 0.4));
  door.position.set(0.075, 0.06, 0.04);
  door.rotation.y = 0.9;
  g.add(door);
  g.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.002), plain(0xfacc15)), 0, 0.08, 0.036));
  // паднал кабел
  const cable = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.003, 6, 20, Math.PI), plain(0x111111));
  cable.rotation.x = Math.PI / 2;
  cable.position.set(0.06, 0.004, 0.08);
  g.add(cable);
  // овъглено петно
  g.add(flat(blobShape(0.07, 7, 0.5), plain(0x1c1a18, 1), 0.003));
  return g;
}

function graffiti(seed: number): THREE.Group {
  const g = new THREE.Group();
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 96;
  const x = c.getContext('2d')!;
  x.fillStyle = '#b9b2a6';
  x.fillRect(0, 0, 256, 96);
  const cols = ['#d946ef', '#38bdf8', '#facc15', '#ef4444', '#22c55e'];
  x.lineCap = 'round';
  for (let i = 0; i < 9; i++) {
    x.strokeStyle = cols[i % cols.length];
    x.lineWidth = 6 + rnd(seed, i) * 8;
    x.beginPath();
    x.moveTo(rnd(seed, i, 1) * 256, 20 + rnd(seed, i, 2) * 60);
    x.bezierCurveTo(rnd(seed, i, 3) * 256, rnd(seed, i, 4) * 96, rnd(seed, i, 5) * 256, rnd(seed, i, 6) * 96, rnd(seed, i, 7) * 256, 20 + rnd(seed, i, 8) * 60);
    x.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const wall = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.12, 0.02), [
    plain(0xb9b2a6),
    plain(0xb9b2a6),
    plain(0xa8a196),
    plain(0xb9b2a6),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }),
  ]);
  wall.position.set(0, 0.06, -0.12);
  wall.castShadow = true;
  g.add(wall);
  // счупена пейка
  const wood = plain(0x8a5a2b, 0.9);
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.008, 0.04), wood);
  seat.position.set(0.02, 0.03, 0.02);
  seat.rotation.z = 0.25;
  g.add(seat);
  for (const dx of [-0.05, 0.08]) g.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.03, 0.035), plain(0x3d4247)), dx, 0.015, 0.02));
  return g;
}

// ------------------------------------------------------------------ ремонт
let STRIPE: THREE.MeshStandardMaterial | null = null;
function works(seed: number): THREE.Group {
  const g = new THREE.Group();
  const stripe = (STRIPE ??= (() => {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 16;
    const x = c.getContext('2d')!;
    for (let i = 0; i < 8; i++) {
      x.fillStyle = i % 2 ? '#ffffff' : '#e8342b';
      x.beginPath();
      x.moveTo(i * 8, 16);
      x.lineTo(i * 8 + 8, 0);
      x.lineTo(i * 8 + 16, 0);
      x.lineTo(i * 8 + 8, 16);
      x.fill();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return new THREE.MeshStandardMaterial({ map: t, roughness: 0.7 });
  })());
  // заграждения около мястото
  const R = 0.3;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const bar = new THREE.Group();
    const board = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.03, 0.006), stripe);
    board.position.y = 0.05;
    bar.add(board);
    for (const dx of [-0.08, 0.08]) bar.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.06, 0.03), plain(0xf2b632)), dx, 0.03, 0));
    bar.position.set(Math.cos(a) * R, 0, Math.sin(a) * R);
    bar.rotation.y = -a + Math.PI / 2;
    bar.traverse((o) => ((o as THREE.Mesh).castShadow = true));
    g.add(bar);
  }
  // работник с каска и жилетка
  const w = new THREE.Group();
  w.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.022, 6), plain(0x1f2a44)), 0, 0.011, 0));
  w.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.008, 0.022, 8), plain(0xff7a1a, 0.6)), 0, 0.033, 0));
  w.add(at(new THREE.Mesh(new THREE.SphereGeometry(0.007, 8, 6), plain(0xe0ac87)), 0, 0.05, 0));
  w.add(at(new THREE.Mesh(new THREE.SphereGeometry(0.0085, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), plain(0xf2d02c, 0.4)), 0, 0.053, 0));
  w.position.set(0.16 + rnd(seed) * 0.05, 0, -0.1);
  w.traverse((o) => ((o as THREE.Mesh).castShadow = true));
  g.add(w);
  return g;
}

/** 3D обектът за сигнала (координати спрямо центъра на плочката, y = 0 е повърхността). */
export function issueObject(kind: string, severity: number, seed: number, fixing: boolean, season: string): THREE.Group {
  let g: THREE.Group;
  switch (kind) {
    case 'pothole':
      g = pothole(severity, seed);
      break;
    case 'water_leak':
      g = waterLeak(severity, seed, false);
      break;
    case 'sewage':
      g = waterLeak(severity, seed, true);
      break;
    case 'garbage':
      g = garbage(severity, seed);
      break;
    case 'accident':
      g = accident(seed);
      break;
    case 'fallen_tree':
      g = fallenTree(seed, season);
      break;
    case 'streetlight': {
      // стълбът е на тротоара и е наклонен към платното
      g = new THREE.Group();
      const l = brokenLamp();
      l.position.z = 0.34;
      l.rotation.y = -Math.PI / 2;
      g.add(l);
      break;
    }
    case 'power_outage':
      g = transformer();
      break;
    case 'graffiti':
      g = graffiti(seed);
      break;
    default:
      g = new THREE.Group();
  }
  if (fixing) g.add(works(seed));
  return g;
}

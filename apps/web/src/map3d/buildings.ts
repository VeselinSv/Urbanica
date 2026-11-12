/**
 * 3D сгради по състоянието на плочката: къщи с двускатни покриви, блокове, кули, магазини с витрини,
 * стъклени офиси, заводи с комини, складове, ферми и всички обществени сгради (вятърна централа с перки,
 * ТЕЦ с охладителни кули, водна кула, болница с хеликоптерна площадка, пожарна, училище…).
 * Размерите са в „плочки“: етаж ≈ 0.06, кола ≈ 0.16 дължина.
 */
import * as THREE from 'three';
import { FACILITIES, SERVICES, ZONES, type TileState } from '@gce/shared';
import { facadeTextures, roofTexture, shopfrontTexture, type FacadeStyle } from './textures';

export const FH = 0.06;
const BW = 0.07;

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
const pick = <T>(a: T[], t: number) => a[Math.min(a.length - 1, Math.floor(t * a.length))];

const WALLS = [0xf2ead8, 0xe8dcc2, 0xf4f1ea, 0xdcc9a8, 0xe9d3b0, 0xcfc6b8, 0xf0e2c8, 0xd8b99a, 0xe6e1d6, 0xc9b49a];
const ROOFS = [0xa9472f, 0x9b3e2c, 0x7a3b2e, 0x5f5a57, 0x6b4a3a, 0x8c5a3c, 0x4e4d52];
const GLASS = [0x6f93b3, 0x5d86a8, 0x7fa3bf, 0x5a7d96, 0x88a9b9];

// ------------------------------------------------------------------ материали (кеширани)
const mats = new Map<string, THREE.Material>();
/** Материалите на фасадите – за нощно светване на прозорците. */
export const facadeMaterials: THREE.MeshStandardMaterial[] = [];

export function mat(key: string, make: () => THREE.Material): THREE.Material {
  let m = mats.get(key);
  if (!m) {
    m = make();
    mats.set(key, m);
  }
  return m;
}
export const plain = (color: number, rough = 0.85, metal = 0) =>
  mat(`p:${color}:${rough}:${metal}`, () => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal }));
function facadeMat(st: FacadeStyle, seed: number, dim = 1) {
  return mat(`f:${JSON.stringify(st)}:${seed % 3}:${dim}`, () => {
    const t = facadeTextures(st, seed);
    const m = new THREE.MeshStandardMaterial({
      map: t.map,
      emissiveMap: t.emissive,
      emissive: new THREE.Color(0xffd8a0),
      emissiveIntensity: 0,
      roughness: st.curtain ? 0.25 : 0.85,
      metalness: st.curtain ? 0.3 : 0,
      color: new THREE.Color(dim, dim, dim),
    });
    facadeMaterials.push(m);
    return m;
  });
}
function roofMat(color: number, kind: 'tiles' | 'flat') {
  return mat(`r:${color}:${kind}`, () => new THREE.MeshStandardMaterial({ map: roofTexture(color, kind), roughness: 0.9 }));
}

// ------------------------------------------------------------------ геометрия
/** Кутия с фасадна текстура, мащабирана по етажи и оси на прозорците; покрив – отделен материал. */
function facadeBox(w: number, d: number, h: number, side: THREE.Material, top: THREE.Material): THREE.Mesh {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  // групи: +x, -x, +y, -y, +z, -z – по 4 върха
  const scale = (face: number, su: number, sv: number) => {
    for (let i = face * 4; i < face * 4 + 4; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  };
  const floors = Math.max(1, Math.round(h / FH)) / 4;
  scale(0, Math.max(1, Math.round(d / BW)) / 4, floors);
  scale(1, Math.max(1, Math.round(d / BW)) / 4, floors);
  scale(4, Math.max(1, Math.round(w / BW)) / 4, floors);
  scale(5, Math.max(1, Math.round(w / BW)) / 4, floors);
  scale(2, w * 3, d * 3);
  scale(3, w * 3, d * 3);
  const m = new THREE.Mesh(g, [side, side, top, top, side, side]);
  m.position.y = h / 2;
  return m;
}

function box(w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  b.position.set(x, y + h / 2, z);
  return b;
}

function cyl(rt: number, rb: number, h: number, m: THREE.Material, x = 0, y = 0, z = 0, seg = 12): THREE.Mesh {
  const c = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);
  c.position.set(x, y + h / 2, z);
  return c;
}

/** Двускатен покрив по оста X (билото е по X). */
function gableRoof(w: number, d: number, rh: number, m: THREE.Material, y: number): THREE.Mesh {
  const ov = 0.025;
  const W = w / 2 + ov;
  const D = d / 2 + ov;
  const pos = [
    // два ската
    -W,
    0,
    -D,
    W,
    0,
    -D,
    W,
    rh,
    0,
    -W,
    0,
    -D,
    W,
    rh,
    0,
    -W,
    rh,
    0,
    -W,
    0,
    D,
    -W,
    rh,
    0,
    W,
    rh,
    0,
    -W,
    0,
    D,
    W,
    rh,
    0,
    W,
    0,
    D,
    // фронтони
    -W + ov,
    0,
    -D + ov,
    -W + ov,
    rh,
    0,
    -W + ov,
    0,
    D - ov,
    W - ov,
    0,
    -D + ov,
    W - ov,
    0,
    D - ov,
    W - ov,
    rh,
    0,
  ];
  const uv = [
    0,
    0,
    w * 4,
    0,
    w * 4,
    1.6,
    0,
    0,
    w * 4,
    1.6,
    0,
    1.6,
    0,
    0,
    0,
    1.6,
    w * 4,
    1.6,
    0,
    0,
    w * 4,
    1.6,
    w * 4,
    0,
    0,
    0,
    0.5,
    1,
    1,
    0,
    0,
    0,
    1,
    0,
    0.5,
    1,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  const r = new THREE.Mesh(g, m);
  r.position.y = y;
  return r;
}

/** Кола: каросерия с по-тесен горен ръб, стъклена кабина, тъмни гуми. */
export function carMesh(color: number): THREE.Group {
  const g = new THREE.Group();
  const body = box(0.16, 0.035, 0.075, plain(color, 0.35, 0.4), 0, 0.012, 0);
  const cabin = box(0.085, 0.028, 0.066, plain(0x22303d, 0.1, 0.5), -0.008, 0.047, 0);
  const roof = box(0.075, 0.006, 0.06, plain(color, 0.35, 0.4), -0.008, 0.075, 0);
  g.add(body, cabin, roof);
  for (const sx of [-0.05, 0.05])
    for (const sz of [-0.036, 0.036]) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.01, 10), plain(0x161718, 0.9));
      w.rotation.x = Math.PI / 2;
      w.position.set(sx, 0.014, sz);
      g.add(w);
    }
  return g;
}

function treeMesh(s: number, season: string): THREE.Group {
  const g = new THREE.Group();
  g.add(cyl(0.012 * s, 0.018 * s, 0.12 * s, plain(0x5a4130, 1)));
  if (season !== 'winter') {
    const c = new THREE.Mesh(new THREE.IcosahedronGeometry(0.075 * s, 1), plain(season === 'autumn' ? 0xc8861e : 0x4f7f34, 0.9));
    c.position.y = 0.16 * s;
    c.scale.y = 1.1;
    g.add(c);
  }
  return g;
}

// ------------------------------------------------------------------ сгради
interface Ctx {
  seed: number;
  season: string;
  /** Посока към пътя (за ориентация на фасадата): ъгъл в радиани около Y. */
  facing: number;
}

function house(c: Ctx): THREE.Group {
  const g = new THREE.Group();
  const v = c.seed;
  const w = 0.46 + h01(v, 1) * 0.1;
  const d = 0.38 + h01(v, 2) * 0.08;
  const floors = h01(v, 3) < 0.7 ? 2 : 1;
  const st: FacadeStyle = { wall: pick(WALLS, h01(v, 4)), glass: pick(GLASS, h01(v, 5)), frame: 0xf5f2ea, winW: 0.45, winH: 0.55, brick: h01(v, 6) < 0.25 };
  const walls = facadeBox(w, d, floors * FH, facadeMat(st, v), plain(0x8a8278));
  g.add(walls);
  const roofC = pick(ROOFS, h01(v, 7));
  const rf = gableRoof(w, d, 0.07 + h01(v, 8) * 0.03, roofMat(c.season === 'winter' ? 0xe8edf2 : roofC, 'tiles'), floors * FH);
  g.add(rf);
  g.add(box(0.03, 0.06, 0.03, plain(0x8b5e4a), w * 0.25, floors * FH + 0.02, -d * 0.15));
  // врата и стълби към пътя (+z е лицето)
  g.add(box(0.035, 0.05, 0.004, plain(0x6b3f2a), 0, 0, d / 2 + 0.002));
  // двор: ограда, дърво, кола на алеята
  const fence = plain(0xd8d2c4, 0.9);
  g.add(box(0.9, 0.02, 0.008, fence, 0, 0, -0.45), box(0.008, 0.02, 0.9, fence, -0.45, 0, 0), box(0.008, 0.02, 0.9, fence, 0.45, 0, 0));
  const tr = treeMesh(1 + h01(v, 9) * 0.5, c.season);
  tr.position.set(-0.3, 0, -0.3 + h01(v, 10) * 0.2);
  g.add(tr);
  if (h01(v, 11) < 0.6) {
    const car = carMesh(pick([0xf2f2ef, 0xb9bec4, 0x23262b, 0x8e1b1b, 0x1f3a5f, 0x5b6068], h01(v, 12)));
    car.rotation.y = Math.PI / 2;
    car.position.set(w / 2 + 0.1, 0, 0.25);
    g.add(car);
  }
  return g;
}

function block(c: Ctx, floors: number, w: number, d: number, st: FacadeStyle, roof = 0x6f6f6f): THREE.Group {
  const g = new THREE.Group();
  g.add(facadeBox(w, d, floors * FH, facadeMat(st, c.seed), roofMat(roof, 'flat')));
  // парапет и съоръжения на покрива
  const top = floors * FH;
  const p = plain(0x9a958c);
  g.add(box(w, 0.012, 0.01, p, 0, top, d / 2 - 0.005), box(w, 0.012, 0.01, p, 0, top, -d / 2 + 0.005));
  g.add(box(0.01, 0.012, d, p, w / 2 - 0.005, top, 0), box(0.01, 0.012, d, p, -w / 2 + 0.005, top, 0));
  g.add(box(0.08, 0.04, 0.06, plain(0x8f9396), w * 0.2, top, -d * 0.15));
  if (h01(c.seed, 21) < 0.5) g.add(cyl(0.03, 0.03, 0.05, plain(0xa3a7aa), -w * 0.25, top, d * 0.1));
  return g;
}

function shop(c: Ctx, floors: number, w: number, d: number): THREE.Group {
  const g = new THREE.Group();
  const v = c.seed;
  const sign = pick([0xc0392b, 0x1e8449, 0x2471a3, 0xe67e22, 0x8e44ad], h01(v, 1));
  // партер с витрини
  const ground = facadeBox(
    w,
    d,
    FH * 1.2,
    mat(`shop:${sign}`, () => new THREE.MeshStandardMaterial({ map: shopfrontTexture(sign), roughness: 0.5 })),
    plain(0x8a8a8a),
  );
  g.add(ground);
  // сенник
  const aw = box(w + 0.02, 0.008, 0.06, plain(sign, 0.8), 0, FH * 0.95, d / 2 + 0.03);
  aw.rotation.x = 0.25;
  g.add(aw);
  if (floors > 1) {
    const upper = facadeBox(
      w,
      d,
      (floors - 1) * FH,
      facadeMat({ wall: pick(WALLS, h01(v, 2)), glass: pick(GLASS, h01(v, 3)), frame: 0xf0ede6, winW: 0.5, winH: 0.55 }, v),
      roofMat(0x707070, 'flat'),
    );
    upper.position.y += FH * 1.2;
    g.add(upper);
  }
  return g;
}

function tower(c: Ctx, floors: number, w: number, d: number, glass: number): THREE.Group {
  const g = new THREE.Group();
  const podium = facadeBox(
    w + 0.12,
    d + 0.12,
    FH * 2,
    facadeMat({ wall: 0xd9dde2, glass, frame: 0x9aa3ab, winW: 0.8, winH: 0.75, curtain: true }, c.seed + 1),
    roofMat(0x6c6c6c, 'flat'),
  );
  g.add(podium);
  const t = facadeBox(
    w,
    d,
    floors * FH,
    facadeMat({ wall: 0xc7ccd3, glass, frame: 0xb9c0c8, winW: 0.9, winH: 0.8, curtain: true }, c.seed),
    roofMat(0x5c5f63, 'flat'),
  );
  t.position.y += FH * 2;
  g.add(t);
  g.add(box(w * 0.5, 0.05, d * 0.5, plain(0x8f9396), 0, FH * (floors + 2), 0));
  if (floors > 14) g.add(cyl(0.006, 0.006, 0.18, plain(0xc0c4c8, 0.4, 0.6), w * 0.2, FH * (floors + 2) + 0.05, 0, 6));
  return g;
}

function factory(c: Ctx, lvl: number, tint?: number): THREE.Group {
  const g = new THREE.Group();
  const w = 0.62 + lvl * 0.08;
  const d = 0.5 + lvl * 0.05;
  const h = 0.13 + lvl * 0.02;
  const wall = tint ? new THREE.Color(tint).lerp(new THREE.Color(0xb8b2a6), 0.6).getHex() : 0xb8b2a6;
  g.add(facadeBox(w, d, h, facadeMat({ wall, glass: 0x5a7d96, frame: 0x8a8a8a, winW: 0.7, winH: 0.25, brick: h01(c.seed, 1) < 0.5 }, c.seed), plain(0x777777)));
  // назъбен (шедов) покрив
  const teeth = 3 + lvl;
  for (let i = 0; i < teeth; i++) {
    const tooth = gableRoof(d, w / teeth, 0.06, plain(0x8d9196, 0.7, 0.2), h);
    tooth.rotation.y = Math.PI / 2;
    tooth.position.x = -w / 2 + (i + 0.5) * (w / teeth);
    g.add(tooth);
  }
  // комини на червени и бели ивици
  for (let i = 0; i < lvl; i++) {
    const x = w / 2 - 0.08 - i * 0.12;
    g.add(cyl(0.025, 0.035, 0.42 + lvl * 0.08, plain(0xb7b2aa), x, 0, -d / 2 + 0.06));
    g.add(cyl(0.027, 0.027, 0.04, plain(0xc0392b), x, 0.36 + lvl * 0.08, -d / 2 + 0.06));
  }
  if (lvl >= 2) for (let i = 0; i < 2; i++) g.add(cyl(0.06, 0.06, 0.14, plain(0xd8dadc, 0.4, 0.5), -w / 2 + 0.1 + i * 0.14, 0, d / 2 + 0.12));
  return g;
}

function warehouse(c: Ctx, lvl: number): THREE.Group {
  const g = new THREE.Group();
  const w = 0.8;
  const d = 0.55 + lvl * 0.05;
  g.add(facadeBox(w, d, 0.15, facadeMat({ wall: 0xc9cdd1, glass: 0x4a5560, frame: 0x8a9096, winW: 0.2, winH: 0.15 }, c.seed), roofMat(0x8c9094, 'flat')));
  for (let i = 0; i < 3; i++) g.add(box(0.12, 0.09, 0.005, plain(0x5b6068), -0.25 + i * 0.25, 0, d / 2 + 0.003));
  const truck = new THREE.Group();
  truck.add(box(0.16, 0.08, 0.08, plain(0xeeeeee), 0, 0.012, 0), box(0.06, 0.06, 0.08, plain(0x2471a3), 0.11, 0.012, 0));
  truck.position.set(-0.2, 0, d / 2 + 0.13);
  g.add(truck);
  return g;
}

function farm(c: Ctx, lvl: number): THREE.Group {
  const g = new THREE.Group();
  const barn = facadeBox(0.3, 0.2, 0.1, facadeMat({ wall: 0x9b2d22, glass: 0x333333, frame: 0xf0f0f0, winW: 0.2, winH: 0.3 }, c.seed), plain(0x555555));
  barn.position.set(-0.25, barn.position.y, -0.25);
  g.add(barn);
  const r = gableRoof(0.3, 0.2, 0.08, plain(0x4e4d52), 0.1);
  r.position.x = -0.25;
  r.position.z = -0.25;
  g.add(r);
  for (let i = 0; i < lvl; i++) g.add(cyl(0.05, 0.05, 0.22, plain(0xd0d4d8, 0.4, 0.4), 0.05 + i * 0.12, 0, -0.32));
  return g;
}

function windTurbine(): THREE.Group {
  const g = new THREE.Group();
  const white = plain(0xf4f5f6, 0.5);
  g.add(cyl(0.012, 0.025, 1.1, white, 0, 0, 0, 10));
  const hub = new THREE.Group();
  hub.position.set(0, 1.12, 0.03);
  hub.add(box(0.04, 0.035, 0.08, white, 0, -0.018, -0.03));
  const rotor = new THREE.Group();
  rotor.name = 'rotor';
  for (let i = 0; i < 3; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.42, 0.006), white);
    b.position.y = 0.21;
    const arm = new THREE.Group();
    arm.rotation.z = (i * Math.PI * 2) / 3;
    arm.add(b);
    rotor.add(arm);
  }
  rotor.position.z = 0.02;
  hub.add(rotor);
  g.add(hub);
  return g;
}

function coalPlant(c: Ctx): THREE.Group {
  const g = new THREE.Group();
  g.add(factory(c, 2, 0x7f7f7f));
  // хиперболични охладителни кули
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    pts.push(new THREE.Vector2(0.16 - Math.sin(t * Math.PI) * 0.05 + (t > 0.8 ? (t - 0.8) * 0.1 : 0), t * 0.55));
  }
  for (const x of [-0.28, 0.0]) {
    const tw = new THREE.Mesh(new THREE.LatheGeometry(pts, 20), plain(0xcfcac2, 0.9));
    tw.position.set(x, 0, 0.42);
    g.add(tw);
  }
  return g;
}

function waterTower(c: Ctx): THREE.Group {
  const g = new THREE.Group();
  const hs = facadeBox(0.3, 0.24, 0.08, facadeMat({ wall: 0xd9d2c4, glass: 0x5a7d96, frame: 0xffffff, winW: 0.4, winH: 0.4 }, c.seed), plain(0x6a6a6a));
  hs.position.x = -0.2;
  g.add(hs);
  const metal = plain(0x9aa6ad, 0.5, 0.5);
  for (const [x, z] of [
    [0.12, 0.08],
    [0.3, 0.08],
    [0.12, 0.26],
    [0.3, 0.26],
  ])
    g.add(cyl(0.006, 0.006, 0.4, metal, x, 0, z, 6));
  g.add(cyl(0.12, 0.12, 0.14, plain(0x7fa3bf, 0.4, 0.4), 0.21, 0.4, 0.17));
  g.add(cyl(0.02, 0.13, 0.04, plain(0x6f8fa8, 0.4, 0.4), 0.21, 0.54, 0.17));
  return g;
}

function hospital(c: Ctx): THREE.Group {
  const g = block(c, 6, 0.6, 0.45, { wall: 0xf4f6f8, glass: 0x6f93b3, frame: 0xe0e6ea, winW: 0.6, winH: 0.5 }, 0x8a8f94);
  // червен кръст и хеликоптерна площадка
  g.add(box(0.12, 0.04, 0.005, plain(0xd62828, 0.6), 0, 6 * FH - 0.08, 0.228));
  g.add(box(0.04, 0.12, 0.005, plain(0xd62828, 0.6), 0, 6 * FH - 0.12, 0.229));
  const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.006, 24), plain(0x2f3437));
  pad.position.set(-0.1, 6 * FH + 0.01, 0);
  g.add(pad);
  g.add(box(0.06, 0.007, 0.012, plain(0xffffff), -0.1, 6 * FH + 0.012, 0));
  return g;
}

function fireStation(c: Ctx): THREE.Group {
  const g = block(c, 2, 0.6, 0.42, { wall: 0xa8473a, glass: 0x5a7d96, frame: 0xf0e8e0, winW: 0.5, winH: 0.5, brick: true }, 0x6a6a6a);
  for (let i = 0; i < 3; i++) g.add(box(0.13, 0.085, 0.005, plain(0xd62828, 0.5, 0.2), -0.18 + i * 0.18, 0, 0.213));
  g.add(box(0.1, 0.38, 0.1, plain(0xa8473a), 0.25, 0, -0.16));
  return g;
}

function police(c: Ctx): THREE.Group {
  const g = block(c, 3, 0.55, 0.4, { wall: 0xe8ecf0, glass: 0x5d86a8, frame: 0xffffff, winW: 0.55, winH: 0.5 }, 0x707478);
  g.add(box(0.551, 0.025, 0.401, plain(0x1f5fd6, 0.5), 0, FH * 1.05, 0));
  const car = carMesh(0xf2f2ef);
  car.position.set(-0.15, 0, 0.32);
  g.add(car);
  return g;
}

function school(c: Ctx, uni = false): THREE.Group {
  const g = new THREE.Group();
  const st: FacadeStyle = { wall: uni ? 0xe9dcc4 : 0xf0d9a8, glass: 0x6f93b3, frame: 0xffffff, winW: 0.6, winH: 0.55 };
  const a = block(c, uni ? 4 : 3, 0.7, 0.28, st, 0x7a6a5a);
  a.position.z = -0.2;
  const b = block(c, uni ? 4 : 3, 0.26, 0.4, st, 0x7a6a5a);
  b.position.set(-0.22, 0, 0.1);
  g.add(a, b);
  // игрище
  const field = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.26), plain(0x3f8a3a, 1));
  field.rotation.x = -Math.PI / 2;
  field.position.set(0.17, 0.004, 0.18);
  g.add(field);
  if (uni) for (let i = 0; i < 6; i++) g.add(cyl(0.012, 0.012, 4 * FH, plain(0xf2efe6), -0.3 + i * 0.12, 0, -0.03, 8));
  return g;
}

function park(c: Ctx): THREE.Group {
  const g = new THREE.Group();
  const path = plain(0xcfc5b0, 1);
  const p1 = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.08), path);
  p1.rotation.x = -Math.PI / 2;
  p1.position.y = 0.004;
  g.add(p1);
  const p2 = p1.clone();
  p2.rotation.z = Math.PI / 2;
  g.add(p2);
  for (let i = 0; i < 5; i++) {
    const t = treeMesh(1.3 + h01(c.seed, i) * 0.6, c.season);
    t.position.set((h01(c.seed, i, 1) - 0.5) * 0.7, 0, (h01(c.seed, i, 2) - 0.5) * 0.7);
    if (Math.abs(t.position.x) < 0.08 || Math.abs(t.position.z) < 0.08) t.position.x += 0.15;
    g.add(t);
  }
  g.add(cyl(0.08, 0.09, 0.025, plain(0xbab3a6), 0, 0, 0));
  g.add(cyl(0.065, 0.065, 0.026, plain(0x5a9ec0, 0.1, 0.2), 0, 0.001, 0));
  return g;
}

function parkingLot(c: Ctx): THREE.Group {
  const g = new THREE.Group();
  for (let i = 0; i < 6; i++) {
    if (h01(c.seed, i) < 0.25) continue;
    const car = carMesh(pick([0xf2f2ef, 0xb9bec4, 0x23262b, 0x8e1b1b, 0x1f3a5f, 0x6f9bc4], h01(c.seed, i, 3)));
    car.rotation.y = Math.PI / 2;
    car.position.set(-0.3 + (i % 3) * 0.3, 0, i < 3 ? -0.2 : 0.2);
    g.add(car);
  }
  return g;
}

function construction(c: Ctx): THREE.Group {
  const g = new THREE.Group();
  g.add(box(0.6, 0.02, 0.5, plain(0xa89c88)));
  const conc = plain(0xb3b0aa);
  const floors = 1 + Math.floor(h01(c.seed, 1) * 3);
  for (let f = 0; f < floors; f++) g.add(box(0.5, 0.012, 0.4, conc, 0, 0.02 + f * FH, 0));
  for (const x of [-0.24, 0.24]) for (const z of [-0.19, 0.19]) g.add(box(0.02, floors * FH, 0.02, conc, x, 0.02, z));
  // скеле и кран
  const yellow = plain(0xf2b632, 0.6, 0.2);
  g.add(box(0.025, 0.9, 0.025, yellow, 0.3, 0, -0.25));
  const jib = box(0.7, 0.02, 0.02, yellow, 0.1, 0.88, -0.25);
  jib.rotation.y = h01(c.seed, 2) * Math.PI;
  g.add(jib);
  return g;
}

function landfill(): THREE.Group {
  const g = new THREE.Group();
  const m = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.16, 10), plain(0x7a6e5a, 1));
  m.position.y = 0.08;
  m.scale.z = 0.8;
  g.add(m);
  return g;
}

function sewage(): THREE.Group {
  const g = new THREE.Group();
  for (const [x, z] of [
    [-0.2, -0.2],
    [0.2, -0.2],
    [-0.2, 0.2],
  ]) {
    g.add(cyl(0.16, 0.16, 0.05, plain(0xa8a49c), x, 0, z, 20));
    g.add(cyl(0.145, 0.145, 0.051, plain(0x5f7a5a, 0.2), x, 0.001, z, 20));
  }
  return g;
}

/** Сграда за плочката (без основата – тя се добавя от извикващия). null – няма какво да се строи. */
export function buildingFor(t: TileState, seed: number, season: string): THREE.Group | null {
  const c: Ctx = { seed, season, facing: 0 };
  if (t.t === 'zone') {
    if (t.lvl === 0) return t.prog > 0 ? construction(c) : null;
    const v = seed;
    switch (t.z) {
      case 'R':
        if (t.lvl === 1) return house(c);
        if (t.lvl === 2)
          return block(c, 4 + Math.floor(h01(v, 30) * 2), 0.72, 0.42, {
            wall: pick(WALLS, h01(v, 31)),
            glass: pick(GLASS, h01(v, 32)),
            frame: 0xf5f2ea,
            winW: 0.5,
            winH: 0.55,
            brick: h01(v, 33) < 0.3,
          });
        return block(c, 11 + Math.floor(h01(v, 34) * 6), 0.5, 0.5, {
          wall: pick([0xe6e1d6, 0xd9dde2, 0xcfc6b8], h01(v, 35)),
          glass: pick(GLASS, h01(v, 36)),
          frame: 0xffffff,
          winW: 0.55,
          winH: 0.6,
        });
      case 'C':
        if (t.lvl === 1) return shop(c, 2, 0.7, 0.58);
        if (t.lvl === 2) return shop(c, 4, 0.8, 0.64);
        return tower(c, 9, 0.6, 0.6, pick(GLASS, h01(v, 37)));
      case 'O':
      case 'H':
        return tower(
          c,
          t.lvl === 1 ? 3 : t.lvl === 2 ? 8 : 18 + Math.floor(h01(v, 38) * 6),
          t.lvl === 3 ? 0.48 : 0.6,
          t.lvl === 3 ? 0.48 : 0.55,
          t.z === 'H' ? 0x7fb0a8 : pick(GLASS, h01(v, 39)),
        );
      case 'I':
        return factory(c, t.lvl);
      case 'L':
        return warehouse(c, t.lvl);
      case 'A':
        return farm(c, t.lvl);
    }
    return null;
  }
  if (t.t === 'service') {
    switch (t.s) {
      case 'power_wind':
        return windTurbine();
      case 'power_coal':
        return coalPlant(c);
      case 'water_pump':
        return waterTower(c);
      case 'sewage_plant':
        return sewage();
      case 'landfill':
        return landfill();
      case 'school':
        return school(c);
      case 'university':
        return school(c, true);
      case 'clinic':
        return hospital(c);
      case 'fire_station':
        return fireStation(c);
      case 'police_station':
        return police(c);
      case 'bus_depot':
        return warehouse(c, 2);
      case 'park':
        return park(c);
      case 'parking':
        return parkingLot(c);
    }
    return block(c, 2, 0.5, 0.4, { wall: 0xd9d2c4, glass: 0x6f93b3, frame: 0xffffff, winW: 0.5, winH: 0.5 });
  }
  if (t.t === 'facility') {
    const color = FACILITIES[t.f]?.color ?? 0x999999;
    if (t.f.includes('farm') || t.f === 'farm') return farm(c, 2);
    return factory(c, 2, color);
  }
  return null;
}

export const zoneColor = (z: string) => ZONES[z as keyof typeof ZONES]?.color ?? 0xffffff;
export const serviceColor = (s: string) => SERVICES[s as keyof typeof SERVICES]?.color ?? 0xffffff;

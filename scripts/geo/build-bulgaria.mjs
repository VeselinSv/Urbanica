// Изгражда географските данни на България за генератора на света от отворени източници:
//  • релеф: AWS Open Data „Terrain Tiles“ (Terrarium PNG, zoom 7) – https://registry.opendata.aws/terrain-tiles/
//  • области: geoBoundaries BGR ADM1 (CC BY 4.0) – https://www.geoboundaries.org
// Изтеглените файлове се кешират в .data/geo-cache (не се пазят в Git).
// Резултат: packages/world-generation/src/bulgaria-data.ts (височини в метри + номер на област за всяка клетка 512×512).
//
// Проекция: изометричната карта е „север нагоре“ на екрана. Клетка (x, y) от решетката се рисува в
// екранна точка ((x−y)·32, (x+y)·16); затова екранните оси се превръщат в изток/север (вертикалата е
// сплескана 2× от изометрията) и оттам – в географска дължина/ширина около центъра на България.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';

const ROOT = resolve(import.meta.dirname, '../..');
const CACHE = resolve(ROOT, '.data/geo-cache');
const OUT = resolve(ROOT, 'packages/world-generation/src/bulgaria-data.ts');
mkdirSync(CACHE, { recursive: true });

export const N = 512;
export const CENTER = { lon: 25.45, lat: 42.72 };
/** Километри на екранен пиксел (при мащаб 1, плочка = 64 px ширина). */
export const KM_PER_PX = 922 / (N * 64);
const Z = 7;

async function download(url, file) {
  const path = resolve(CACHE, file);
  if (existsSync(path)) return readFileSync(path);
  const res = await fetch(url, { headers: { 'user-agent': 'urbanica-map-builder' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(path, buf);
  return buf;
}

// ---------------------------------------------------------------- PNG (8-bit RGB/RGBA, без interlace)
function decodePng(buf) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
      if (data[8] !== 8 || data[12] !== 0) throw new Error('Неподдържан PNG');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!bpp) throw new Error('Неподдържан тип цвят ' + colorType);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(width * height * bpp);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[y * stride + i - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + i] : 0;
      const c = i >= bpp && y > 0 ? out[(y - 1) * stride + i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + i] = v & 255;
    }
  }
  return { width, height, bpp, data: out };
}

// ---------------------------------------------------------------- проекции
const tileX = (lon) => ((lon + 180) / 360) * 2 ** Z;
const tileY = (lat) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(Math.PI / 4 + r / 2)) / Math.PI) / 2) * 2 ** Z;
};
/** Клетка на решетката → (lon, lat). */
export function cellToLonLat(x, y) {
  const sx = (x - y) * 32;
  const sy = (x + y) * 16 - N * 16;
  const eastKm = sx * KM_PER_PX;
  const northKm = -sy * 2 * KM_PER_PX;
  const lat = CENTER.lat + northKm / 111.32;
  const lon = CENTER.lon + eastKm / (111.32 * Math.cos((CENTER.lat * Math.PI) / 180));
  return [lon, lat];
}
/** (lon, lat) → дробна клетка (обратната трансформация). */
export function lonLatToCell(lon, lat) {
  const eastKm = (lon - CENTER.lon) * 111.32 * Math.cos((CENTER.lat * Math.PI) / 180);
  const northKm = (lat - CENTER.lat) * 111.32;
  const sx = eastKm / KM_PER_PX;
  const sy = -northKm / 2 / KM_PER_PX + N * 16;
  // sx = (x−y)·32, sy = (x+y)·16
  const a = sx / 32;
  const b = sy / 16;
  return [(a + b) / 2, (b - a) / 2];
}

// ---------------------------------------------------------------- релеф
async function elevationGrid() {
  const corners = [cellToLonLat(0, 0), cellToLonLat(N, 0), cellToLonLat(0, N), cellToLonLat(N, N)];
  const lons = corners.map((c) => c[0]);
  const lats = corners.map((c) => c[1]);
  const tx0 = Math.floor(tileX(Math.min(...lons)));
  const tx1 = Math.floor(tileX(Math.max(...lons)));
  const ty0 = Math.floor(tileY(Math.max(...lats)));
  const ty1 = Math.floor(tileY(Math.min(...lats)));
  const tiles = new Map();
  let bytes = 0;
  for (let ty = ty0; ty <= ty1; ty++)
    for (let tx = tx0; tx <= tx1; tx++) {
      const buf = await download(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${tx}/${ty}.png`, `terrarium-${Z}-${tx}-${ty}.png`);
      bytes += buf.length;
      tiles.set(`${tx},${ty}`, decodePng(buf));
    }
  console.log(`релеф: ${tiles.size} плочки (${(bytes / 1e6).toFixed(1)} MB) x ${tx0}–${tx1}, y ${ty0}–${ty1}`);
  const sample = (lon, lat) => {
    const fx = tileX(lon);
    const fy = tileY(lat);
    const t = tiles.get(`${Math.floor(fx)},${Math.floor(fy)}`);
    if (!t) return -50;
    const px = Math.min(t.width - 1, Math.max(0, Math.floor((fx - Math.floor(fx)) * t.width)));
    const py = Math.min(t.height - 1, Math.max(0, Math.floor((fy - Math.floor(fy)) * t.height)));
    const o = (py * t.width + px) * t.bpp;
    return t.data[o] * 256 + t.data[o + 1] + t.data[o + 2] / 256 - 32768;
  };
  const elev = new Int16Array(N * N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      // средно от 4 проби в клетката – по-гладък релеф
      let s = 0;
      for (const [dx, dy] of [
        [0.25, 0.25],
        [0.75, 0.25],
        [0.25, 0.75],
        [0.75, 0.75],
      ]) {
        const [lon, lat] = cellToLonLat(x + dx, y + dy);
        s += sample(lon, lat);
      }
      elev[y * N + x] = Math.max(-2000, Math.min(3000, Math.round(s / 4)));
    }
  return elev;
}

// ---------------------------------------------------------------- области
const BG_NAMES = {
  blagoevgrad: 'Благоевград',
  burgas: 'Бургас',
  dobrich: 'Добрич',
  gabrovo: 'Габрово',
  haskovo: 'Хасково',
  kardzhali: 'Кърджали',
  kyustendil: 'Кюстендил',
  lovech: 'Ловеч',
  montana: 'Монтана',
  pazardzhik: 'Пазарджик',
  pernik: 'Перник',
  pleven: 'Плевен',
  plovdiv: 'Пловдив',
  razgrad: 'Разград',
  ruse: 'Русе',
  shumen: 'Шумен',
  silistra: 'Силистра',
  sliven: 'Сливен',
  smolyan: 'Смолян',
  sofia: 'София област',
  sofiacity: 'София град',
  sofiagrad: 'София град',
  starazagora: 'Стара Загора',
  targovishte: 'Търговище',
  varna: 'Варна',
  velikotarnovo: 'Велико Търново',
  vidin: 'Видин',
  vratsa: 'Враца',
  yambol: 'Ямбол',
};
const norm = (s) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/province|oblast|region|\(.*?\)/g, '')
    .replace(/[^a-z]/g, '');

function bgName(raw) {
  const k = norm(raw);
  if (BG_NAMES[k]) return BG_NAMES[k];
  if (k.includes('sofia') && (k.includes('city') || k.includes('grad') || k.includes('capital'))) return 'София град';
  for (const [key, v] of Object.entries(BG_NAMES)) if (k.startsWith(key) || key.startsWith(k)) return v;
  return raw;
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inPolygon(lon, lat, geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  for (const poly of polys) {
    if (!pointInRing(lon, lat, poly[0])) continue;
    let hole = false;
    for (let h = 1; h < poly.length; h++) if (pointInRing(lon, lat, poly[h])) hole = true;
    if (!hole) return true;
  }
  return false;
}

async function oblasts() {
  const buf = await download(
    'https://github.com/wmgeolab/geoBoundaries/raw/main/releaseData/gbOpen/BGR/ADM1/geoBoundaries-BGR-ADM1_simplified.geojson',
    'geoBoundaries-BGR-ADM1_simplified.geojson',
  );
  const gj = JSON.parse(buf.toString('utf8'));
  const feats = gj.features.map((f) => {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const p of polys)
      for (const [x, y] of p[0]) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    return { name: bgName(f.properties.shapeName), geom: f.geometry, bbox: [minX, minY, maxX, maxY] };
  });
  // София град е вътре в София област – проверяваме я първа
  feats.sort((a, b) => (a.name === 'София град' ? -1 : b.name === 'София град' ? 1 : a.name.localeCompare(b.name, 'bg')));
  const region = new Uint8Array(N * N).fill(255);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const [lon, lat] = cellToLonLat(x + 0.5, y + 0.5);
      for (let i = 0; i < feats.length; i++) {
        const b = feats[i].bbox;
        if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
        if (inPolygon(lon, lat, feats[i].geom)) {
          region[y * N + x] = i;
          break;
        }
      }
    }
  console.log(`области: ${feats.length} – ${feats.map((f) => f.name).join(', ')}`);
  return { region, names: feats.map((f) => f.name) };
}

// ---------------------------------------------------------------- реалните градове (за ориентация) и Дунав
const CITIES = [
  ['София', 23.32, 42.7, 'capital'],
  ['Пловдив', 24.75, 42.14, 'city'],
  ['Варна', 27.91, 43.21, 'city'],
  ['Бургас', 27.47, 42.5, 'city'],
  ['Русе', 25.97, 43.85, 'city'],
  ['Стара Загора', 25.63, 42.43, 'city'],
  ['Плевен', 24.62, 43.42, 'city'],
  ['Сливен', 26.32, 42.68, 'town'],
  ['Добрич', 27.83, 43.57, 'town'],
  ['Шумен', 26.93, 43.27, 'town'],
  ['Перник', 23.04, 42.6, 'town'],
  ['Хасково', 25.55, 41.93, 'town'],
  ['Ямбол', 26.51, 42.48, 'town'],
  ['Пазарджик', 24.33, 42.19, 'town'],
  ['Благоевград', 23.1, 42.02, 'town'],
  ['Велико Търново', 25.63, 43.08, 'town'],
  ['Враца', 23.56, 43.21, 'town'],
  ['Габрово', 25.32, 42.87, 'town'],
  ['Видин', 22.88, 43.99, 'town'],
  ['Монтана', 23.23, 43.41, 'town'],
  ['Кърджали', 25.37, 41.65, 'town'],
  ['Кюстендил', 22.69, 42.28, 'town'],
  ['Търговище', 26.57, 43.25, 'town'],
  ['Ловеч', 24.72, 43.14, 'town'],
  ['Силистра', 27.26, 44.12, 'town'],
  ['Разград', 26.52, 43.53, 'town'],
  ['Смолян', 24.7, 41.58, 'town'],
];
const DANUBE = [
  [21.4, 44.78],
  [21.95, 44.64],
  [22.45, 44.5],
  [22.62, 44.28],
  [22.88, 44.02],
  [23.08, 43.86],
  [23.24, 43.83],
  [23.73, 43.79],
  [23.96, 43.74],
  [24.48, 43.71],
  [24.89, 43.71],
  [25.35, 43.63],
  [25.67, 43.68],
  [25.95, 43.86],
  [26.32, 43.98],
  [26.62, 44.06],
  [27.26, 44.13],
  [27.75, 44.2],
  [28.03, 44.35],
  [27.98, 44.75],
  [27.97, 45.27],
  [28.05, 45.43],
  [28.7, 45.25],
  [29.65, 45.2],
];

const b64 = (arr) => Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64');

const elev = await elevationGrid();
const { region, names } = await oblasts();
let land = 0;
let bg = 0;
let maxE = -1e9;
for (let i = 0; i < N * N; i++) {
  if (elev[i] > 0) land++;
  if (region[i] !== 255) bg++;
  if (region[i] !== 255) maxE = Math.max(maxE, elev[i]);
}
console.log(`суша ${((land / (N * N)) * 100).toFixed(1)}%, България ${((bg / (N * N)) * 100).toFixed(1)}%, най-висока точка в България ${maxE} m`);
const cities = CITIES.map(([name, lon, lat, tier]) => {
  const [x, y] = lonLatToCell(lon, lat);
  return { name, tier, x: Math.round(x), y: Math.round(y) };
});
const danube = DANUBE.map(([lon, lat]) => {
  const [x, y] = lonLatToCell(lon, lat);
  return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
});
const ts = `// АВТОМАТИЧНО ГЕНЕРИРАН ФАЙЛ – не се редактира ръчно. Източник: scripts/geo/build-bulgaria.mjs
// Релеф: AWS Open Data Terrain Tiles (Terrarium). Области: geoBoundaries BGR ADM1, CC BY 4.0 (www.geoboundaries.org).
export const BG_N = ${N};
/** Височина в метри (Int16, little-endian), ред по ред. Отрицателно – море. */
export const BG_ELEVATION_B64 = '${b64(elev)}';
/** Номер на област (Uint8), 255 – извън България. */
export const BG_REGION_B64 = '${b64(region)}';
export const BG_REGION_NAMES: string[] = ${JSON.stringify(names)};
/** Реални градове – само за ориентация на картата (не са построени). */
export const BG_CITIES: { name: string; tier: string; x: number; y: number }[] = ${JSON.stringify(cities)};
/** Река Дунав (по-голямата част от северната граница). */
export const BG_DANUBE: { x: number; y: number }[] = ${JSON.stringify(danube)};
`;
writeFileSync(OUT, ts);
console.log(`записано: ${OUT} (${(ts.length / 1e6).toFixed(2)} MB)`);

import { BALANCE, clamp, hashString, type PlacementRule } from '@gce/shared';
import { Perlin2D } from './noise';
import {
  HILLS,
  MOUNTAINS,
  SEA,
  WATER_LAKE,
  WATER_NONE,
  WATER_OCEAN,
  WATER_RIVER,
  generateCountry,
  type CountryData,
  type Lake,
  type Region,
  type RiverPath,
} from './country';

export { Perlin2D } from './noise';
export { REAL_PLACES } from './country';
export { chaikin, distToPolyline, SEA, HILLS, MOUNTAINS, WATER_NONE, WATER_OCEAN, WATER_LAKE, WATER_RIVER } from './country';
export type { CountryData, Lake, Pt, Region, RiverPath } from './country';

/** Типове терен (числови кодове за компактност при пренос и рендериране). */
export enum Terrain {
  DeepWater = 0,
  Water = 1,
  Beach = 2,
  Plains = 3,
  Forest = 4,
  Hills = 5,
  Mountains = 6,
  River = 7,
}

export const TERRAIN_NAMES: Record<Terrain, string> = {
  [Terrain.DeepWater]: 'deep_water',
  [Terrain.Water]: 'water',
  [Terrain.Beach]: 'beach',
  [Terrain.Plains]: 'plains',
  [Terrain.Forest]: 'forest',
  [Terrain.Hills]: 'hills',
  [Terrain.Mountains]: 'mountains',
  [Terrain.River]: 'river',
};

export const TERRAIN_LABELS: Record<Terrain, string> = {
  [Terrain.DeepWater]: 'Дълбоки води',
  [Terrain.Water]: 'Езеро/плитчина',
  [Terrain.Beach]: 'Бряг',
  [Terrain.Plains]: 'Равнина',
  [Terrain.Forest]: 'Гора',
  [Terrain.Hills]: 'Хълмове',
  [Terrain.Mountains]: 'Планина',
  [Terrain.River]: 'Река',
};

export type Deposit = 'none' | 'iron' | 'coal';
export type Climate = 'arid' | 'temperate' | 'cold';

export interface TerrainTile {
  terrain: Terrain;
  elevation: number; // 0..1
  moisture: number; // 0..1
  fertility: number; // 0..1
  deposit: Deposit;
  richness: number; // 0..1
  floodRisk: number; // 0..1
  climate: Climate;
  /** Административна област (индекс в regions) или -1 в морето. */
  region: number;
}

export interface TerrainChunk {
  cx: number;
  cy: number;
  size: number;
  terrain: Uint8Array;
  fertility: Uint8Array; // 0..255
  deposit: Uint8Array; // 0 none, 1 iron, 2 coal
}

export function isWater(t: Terrain): boolean {
  return t === Terrain.DeepWater || t === Terrain.Water || t === Terrain.River;
}

/**
 * Процедурен генератор на света. Една и съща (seed, x, y) винаги дава една и съща плочка,
 * затова светът не се съхранява плочка по плочка в базата – пазят се само промените (собственост, сгради).
 * Генераторът се използва и от сървъра (валидиране), и от клиента (рендериране) – няма дублиране на логика.
 *
 * Версия 2: светът е една държава (виж country.ts) – релефът, водите, горите и областите се изчисляват
 * веднъж при създаването (~1 s за 512×512). Светът започва празен: няма селища и пътища – всичко строят играчите.
 */
export class WorldGenerator {
  readonly seedHash: number;
  readonly size: number;
  readonly country: CountryData;
  readonly terrain: Uint8Array;
  readonly fertility: Float32Array;
  readonly deposit: Uint8Array;
  readonly richness: Float32Array;
  readonly flood: Float32Array;

  constructor(
    readonly seed: string,
    size: number = BALANCE.world.size,
  ) {
    this.size = size;
    this.seedHash = hashString(seed);
    const N = size;
    const NN = N * N;
    const c = generateCountry(this.seedHash, N);
    this.country = c;

    // ---- Класификация на терена, плодородие, ресурси ----
    const ore = new Perlin2D(this.seedHash ^ 0x0e0e);
    const coal = new Perlin2D(this.seedHash ^ 0xc0a1);
    this.terrain = new Uint8Array(NN);
    this.fertility = new Float32Array(NN);
    this.deposit = new Uint8Array(NN);
    this.richness = new Float32Array(NN);
    this.flood = new Float32Array(NN);
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const k = y * N + x;
        const h = c.height[k];
        const w = c.water[k];
        let t: Terrain;
        if (w === WATER_OCEAN) t = h < SEA - 0.045 ? Terrain.DeepWater : Terrain.Water;
        else if (w === WATER_LAKE) t = Terrain.Water;
        else if (w === WATER_RIVER) t = Terrain.River;
        else if (c.oceanDist[k] <= 2 && h < SEA + 0.03 && c.slope[k] < 0.01) t = Terrain.Beach;
        else if (h > MOUNTAINS) t = Terrain.Mountains;
        else t = c.forest[k] > 0.5 ? Terrain.Forest : h > HILLS ? Terrain.Hills : Terrain.Plains;
        this.terrain[k] = t;
        const m = c.moisture[k];
        let fert = 0;
        if (t === Terrain.Plains || t === Terrain.Forest) {
          fert = clamp(0.2 + m * 0.75 - Math.max(0, h - 0.52) * 2.2 - c.slope[k] * 12, 0, 1);
          let riverNear = false;
          for (let d = -3; d <= 3 && !riverNear; d += 3)
            for (let e = -3; e <= 3 && !riverNear; e += 3) {
              const xx = x + d;
              const yy = y + e;
              if (xx >= 0 && yy >= 0 && xx < N && yy < N && c.water[yy * N + xx] === WATER_RIVER) riverNear = true;
            }
          if (riverNear) fert = clamp(fert + 0.2, 0, 1);
        } else if (t === Terrain.Hills) fert = clamp(0.1 + m * 0.3, 0, 1);
        this.fertility[k] = fert;

        if (w === WATER_NONE) {
          const o = ore.fbm(x / 22, y / 22, 3);
          const cc = coal.fbm(x / 26 + 33, y / 26 + 71, 3);
          if ((t === Terrain.Hills || t === Terrain.Mountains) && o > 0.6) {
            this.deposit[k] = 1;
            this.richness[k] = clamp((o - 0.6) * 4 + 0.4, 0.4, 1);
          } else if ((t === Terrain.Plains || t === Terrain.Hills || t === Terrain.Forest) && cc > 0.64) {
            this.deposit[k] = 2;
            this.richness[k] = clamp((cc - 0.64) * 4 + 0.4, 0.4, 1);
          }
          let fr = clamp((SEA + 0.06 - h) * 8, 0, 1);
          // заливни тераси край реките
          for (let d = -2; d <= 2; d += 2)
            for (let e = -2; e <= 2; e += 2) {
              const xx = x + d;
              const yy = y + e;
              if (xx >= 0 && yy >= 0 && xx < N && yy < N && c.water[yy * N + xx] === WATER_RIVER && h < SEA + 0.08) fr = Math.max(fr, 0.45);
            }
          this.flood[k] = fr;
        }
      }
  }

  get regions(): Region[] {
    return this.country.regions;
  }
  get rivers(): RiverPath[] {
    return this.country.rivers;
  }
  get lakes(): Lake[] {
    return this.country.lakes;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.size && y < this.size;
  }

  tileAt(x: number, y: number): TerrainTile {
    if (!this.inBounds(x, y)) {
      return {
        terrain: Terrain.DeepWater,
        elevation: 0,
        moisture: 0,
        fertility: 0,
        deposit: 'none',
        richness: 0,
        floodRisk: 0,
        climate: 'temperate',
        region: -1,
      };
    }
    const k = y * this.size + x;
    const c = this.country;
    const e = c.height[k];
    const lat = y / this.size; // север е студен
    const temp = 1 - lat * 0.25 - (1 - lat) * 0.25 - Math.max(0, e - 0.6) * 1.6;
    const climate: Climate = temp < 0.35 ? 'cold' : c.moisture[k] < 0.32 && temp > 0.6 ? 'arid' : 'temperate';
    const dep = this.deposit[k];
    return {
      terrain: this.terrain[k] as Terrain,
      elevation: e,
      moisture: c.moisture[k],
      fertility: this.fertility[k],
      deposit: dep === 1 ? 'iron' : dep === 2 ? 'coal' : 'none',
      richness: this.richness[k],
      floodRisk: this.flood[k],
      climate,
      region: c.region[k] === 255 ? -1 : c.region[k],
    };
  }

  chunk(cx: number, cy: number): TerrainChunk {
    const size = BALANCE.world.chunkSize;
    const terrain = new Uint8Array(size * size);
    const fertility = new Uint8Array(size * size);
    const deposit = new Uint8Array(size * size);
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const t = this.tileAt(cx * size + i, cy * size + j);
        const k = j * size + i;
        terrain[k] = t.terrain;
        fertility[k] = Math.round(t.fertility * 255);
        deposit[k] = t.deposit === 'iron' ? 1 : t.deposit === 'coal' ? 2 : 0;
      }
    }
    return { cx, cy, size, terrain, fertility, deposit };
  }

  /** Плочката е на територията на България (строи се само тук; съседните страни са само фон). */
  inCountry(x: number, y: number): boolean {
    return this.inBounds(x, y) && this.country.region[y * this.size + x] !== 255;
  }

  /** Дали плочката е годна за строителство (суша без реки/вода, в България). */
  buildable(x: number, y: number): boolean {
    if (!this.inCountry(x, y)) return false;
    return !isWater(this.terrain[y * this.size + x] as Terrain);
  }

  /** Строителен множител на цената според терена: мост над река 4x, над езеро/залив 6x; в открито море – не. */
  roadCostMult(x: number, y: number): number {
    if (!this.inCountry(x, y)) return Infinity;
    const t = this.terrain[y * this.size + x] as Terrain;
    if (t === Terrain.River) return 4;
    if (t === Terrain.Water) return 6;
    const m = BALANCE.construction.terrainCostMult[TERRAIN_NAMES[t]];
    return m ?? Infinity;
  }

  /** Проверка за изискване при поставяне на съоръжение. */
  satisfiesPlacement(rule: PlacementRule, x: number, y: number): { ok: boolean; factor: number; reason?: string } {
    const t = this.tileAt(x, y);
    if (!this.inCountry(x, y)) return { ok: false, factor: 0, reason: 'Може да се строи само в България' };
    if (isWater(t.terrain)) return { ok: false, factor: 0, reason: 'Не може да се строи върху вода' };
    switch (rule) {
      case 'any':
        return { ok: true, factor: 1 };
      case 'fertile':
        return t.fertility >= 0.3 ? { ok: true, factor: t.fertility } : { ok: false, factor: 0, reason: 'Земята не е достатъчно плодородна (мин. 30%)' };
      case 'forest': {
        let forest = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (this.tileAt(x + dx, y + dy).terrain === Terrain.Forest) forest++;
        return forest >= 4
          ? { ok: true, factor: Math.min(1, forest / 12) }
          : { ok: false, factor: 0, reason: 'Нужна е гора в радиус 2 (поне 4 горски плочки)' };
      }
      case 'iron':
        return t.deposit === 'iron' ? { ok: true, factor: t.richness } : { ok: false, factor: 0, reason: 'Няма находище на желязна руда' };
      case 'coal':
        return t.deposit === 'coal' ? { ok: true, factor: t.richness } : { ok: false, factor: 0, reason: 'Няма находище на въглища' };
    }
  }

  /** Близост до вода (за помпени станции и стойност на земята). */
  nearWater(x: number, y: number, r = 3): boolean {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (isWater(this.tileAt(x + dx, y + dy).terrain)) return true;
    return false;
  }

  /** Оценка на парцел: дял суша, ресурси, плодородие – за цената на земята и избора на начална позиция. */
  parcelProfile(px: number, py: number): { land: number; fertility: number; iron: number; coal: number; forest: number; inCountry: number } {
    const s = BALANCE.world.parcelSize;
    let land = 0,
      fert = 0,
      iron = 0,
      coal = 0,
      forest = 0,
      inside = 0;
    for (let j = 0; j < s; j++)
      for (let i = 0; i < s; i++) {
        const x = px * s + i;
        const y = py * s + j;
        const t = this.tileAt(x, y);
        if (!isWater(t.terrain) && this.inCountry(x, y)) land++;
        if (this.inCountry(x, y)) inside++;
        fert += t.fertility;
        if (t.deposit === 'iron') iron++;
        if (t.deposit === 'coal') coal++;
        if (t.terrain === Terrain.Forest) forest++;
      }
    const n = s * s;
    return { land: land / n, fertility: fert / n, iron, coal, forest, inCountry: inside / n };
  }
}

const generators = new Map<string, WorldGenerator>();
export function getWorld(seed: string): WorldGenerator {
  let g = generators.get(seed);
  if (!g) {
    g = new WorldGenerator(seed);
    generators.set(seed, g);
  }
  return g;
}

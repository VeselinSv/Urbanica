/// <reference lib="webworker" />
/**
 * Рисуване на чанковете във фонова нишка (Web Worker + OffscreenCanvas): главната нишка остава свободна
 * за движението на камерата, трафика и интерфейса. Работникът има собствено копие на генератора на света
 * (същият seed → същата България) и получава само плочките на градовете около чанка.
 */
import type { TileState } from '@gce/shared';
import { getWorld, type WorldGenerator } from '@gce/world-generation';
import { paintChunk, type CityActor } from './paint';
import type { Season } from './sprites';

export interface PaintJob {
  type: 'paint';
  id: number;
  cx: number;
  cy: number;
  res: number;
  detail: 1 | 2;
  zoning: boolean;
  season: Season;
  wantActors: boolean;
  tiles: [string, TileState][];
  cleared: string[];
  parcel: number;
}

export type PaintReply =
  | { type: 'ready' }
  | { type: 'done'; id: number; bmp: ImageBitmap; sx: number; sy: number; res: number; actors?: CityActor[] }
  | { type: 'error'; id: number; message: string };

let gen: WorldGenerator | null = null;
const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<{ type: 'init'; seed: string } | PaintJob>) => {
  const m = e.data;
  if (m.type === 'init') {
    gen = getWorld(m.seed);
    ctx.postMessage({ type: 'ready' } satisfies PaintReply);
    return;
  }
  if (!gen) return;
  try {
    const tiles = new Map(m.tiles);
    const cleared = new Set(m.cleared);
    const actors: CityActor[] | undefined = m.wantActors ? [] : undefined;
    const cc = paintChunk(gen, (x, y) => tiles.get(`${x},${y}`), m.cx, m.cy, {
      res: m.res,
      zoning: m.zoning,
      detail: m.detail,
      season: m.season,
      cleared: (x, y) => cleared.has(`${Math.floor(x / m.parcel)},${Math.floor(y / m.parcel)}`),
      actors,
    });
    const bmp = (cc.canvas as unknown as OffscreenCanvas).transferToImageBitmap();
    ctx.postMessage({ type: 'done', id: m.id, bmp, sx: cc.sx, sy: cc.sy, res: cc.res, actors } satisfies PaintReply, [bmp]);
  } catch (err) {
    ctx.postMessage({ type: 'error', id: m.id, message: (err as Error).message } satisfies PaintReply);
  }
};

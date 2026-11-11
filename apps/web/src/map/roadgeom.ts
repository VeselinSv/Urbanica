/**
 * Обща геометрия на пътищата – използва се и при рисуването (paint.ts), и от трафика/пешеходците (traffic.ts),
 * за да карат колите точно в лентата си, а хората да вървят точно по тротоара.
 * Всички размери са в плочки (ширина спрямо оста на пътя).
 */
import type { RoadClass } from '@gce/shared';

export interface RoadGeom {
  /** Ширина на настилката. */
  width: number;
  /** Обща ширина с тротоарите. */
  sidewalkOuter: number;
  /** Обща ширина без тротоари (банкет/аварийна лента). */
  vergeOuter: number;
  vergeColor: number;
  asphalt: number;
  /** Отстояние на оста на дясната лента от оста на пътя. */
  lane: number;
  /** Относителна скорост на движение. */
  speed: number;
  /** Ранг за предимство (главен път). */
  rank: number;
}

export const ROAD_GEOM: Record<RoadClass, RoadGeom> = {
  street: { width: 0.46, sidewalkOuter: 0.82, vergeOuter: 0.56, vergeColor: 0xa89c7c, asphalt: 0x4a4d52, lane: 0.115, speed: 1, rank: 1 },
  avenue: { width: 0.84, sidewalkOuter: 1.0, vergeOuter: 0.92, vergeColor: 0xa89c7c, asphalt: 0x474a4f, lane: 0.27, speed: 1.45, rank: 2 },
  highway: { width: 0.94, sidewalkOuter: 1.0, vergeOuter: 1.0, vergeColor: 0xa29f97, asphalt: 0x45484d, lane: 0.3, speed: 2, rank: 3 },
  rural: { width: 0.4, sidewalkOuter: 0.76, vergeOuter: 0.62, vergeColor: 0xa89c7c, asphalt: 0x5f6064, lane: 0.1, speed: 0.9, rank: 0 },
  industrial: { width: 0.64, sidewalkOuter: 0.92, vergeOuter: 0.86, vergeColor: 0xb5b1a6, asphalt: 0x505357, lane: 0.16, speed: 0.85, rank: 1 },
};

/** Отстояние на средата на тротоара от оста на пътя. */
export function walkOffset(cls: RoadClass) {
  const g = ROAD_GEOM[cls];
  return (g.sidewalkOuter + g.width) / 4;
}

/** Ширина на пешеходна алея. */
export const PATH_WIDTH = 0.3;

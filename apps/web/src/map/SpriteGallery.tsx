import { useEffect, useRef } from 'react';
import { FACILITY_TYPES, SERVICE_TYPES } from '@gce/shared';
import { getSprite, type BuildingKey, type TreeKind } from './sprites';

/**
 * Само за разработка (`?gallery`): всички сгради, съоръжения и дървета в изометрична решетка
 * върху трева – за бърза визуална проверка на графиката без симулация.
 */
export function SpriteGallery() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current!;
    const scale = Number(new URLSearchParams(location.search).get('scale') ?? '1.6');
    const res = scale;
    const only = new URLSearchParams(location.search).get('only');
    const keys: BuildingKey[] = [];
    for (const z of ['R', 'C', 'O', 'I', 'L', 'A', 'H'])
      for (let lvl = 1; lvl <= 3; lvl++) for (let v = 0; v < 3; v++) keys.push({ k: 'zone', z, lvl, v: v * 4 + lvl, face: 'left' });
    for (const s of SERVICE_TYPES) keys.push({ k: 'service', s, v: 1, face: 'left' });
    for (const f of FACILITY_TYPES) keys.push({ k: 'facility', f, v: 1, face: 'left' });
    for (const t of ['oak', 'birch', 'poplar', 'willow', 'conifer', 'pine', 'bush'] as TreeKind[])
      for (let v = 0; v < 3; v++) keys.push({ k: 'tree', t, v, size: 2.2 + v * 0.3 });
    keys.push({ k: 'construction', v: 3 });
    const want = only?.split(',') ?? [];
    const lvl = new URLSearchParams(location.search).get('lvl');
    const list = keys.filter(
      (k) => (!only || want.includes(k.k) || (k.k === 'zone' && want.includes(k.z))) && (!lvl || k.k !== 'zone' || String(k.lvl) === lvl),
    );
    keys.length = 0;
    keys.push(...list);
    const cols = Number(new URLSearchParams(location.search).get('cols') ?? '12');
    const rows = Math.ceil(keys.length / cols);
    const CW = 120;
    const CH = 130;
    const W = cols * CW * scale;
    const H = (rows * CH + 60) * scale;
    cv.width = W;
    cv.height = H;
    const g = cv.getContext('2d')!;
    g.fillStyle = '#7da653';
    g.fillRect(0, 0, W, H);
    keys.forEach((k, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const cx = (60 + col * CW) * scale;
      const cy = (120 + row * CH) * scale;
      // плочка (ромб) под обекта
      g.fillStyle = '#8fb662';
      g.beginPath();
      g.moveTo(cx, cy - 16 * scale);
      g.lineTo(cx + 32 * scale, cy);
      g.lineTo(cx, cy + 16 * scale);
      g.lineTo(cx - 32 * scale, cy);
      g.closePath();
      g.fill();
      const sp = getSprite(k, res);
      g.drawImage(sp.canvas, cx - sp.ax, cy - sp.ay);
      g.fillStyle = '#0b1220';
      g.font = `${10 * scale}px system-ui`;
      const label = k.k === 'zone' ? `${k.z}${k.lvl}` : k.k === 'service' ? k.s : k.k === 'facility' ? k.f : k.k === 'tree' ? k.t : k.k;
      g.fillText(label, cx - 30 * scale, cy + 28 * scale);
    });
  }, []);
  return (
    <div style={{ overflow: 'auto', height: '100%', background: '#7da653' }}>
      <canvas ref={ref} />
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import {
  BALANCE,
  FACILITIES,
  SERVICES,
  UPGRADE_REQUIREMENT_LABELS,
  ZONES,
  gameDate,
  hasSidewalk,
  tileKey,
  type CityDerived,
  type FacilityType,
  type ServiceType,
  type TileMap,
  type ZoneType,
} from '@gce/shared';
import { REAL_PLACES, getWorld } from '@gce/world-generation';
import { IsoRenderer, toTile, type CityRender } from './renderer';
/** Рисувачът на картата (изометричен 2D). */
type MapRenderer = IsoRenderer;
import { computeNeedBadges } from './needBadges';
import { weatherFor } from './atmosphere';
import { seasonOf } from './sprites';
import { REQ_ICON } from '../ui/needs';

/** „Отмени“ последното строителство (връща и парите). */
export async function undoLast() {
  const c = getState().city;
  if (!c?.isOwner) return;
  try {
    const res = await post<{ restored: number; refund: number }>(`/cities/${c.id}/undo`, {});
    toast(`Отменено (${res.restored} плочки), върнати ${money(res.refund)}`, 'success');
    await refreshCity();
    bumpData();
  } catch (e) {
    errorToast(e);
  }
}

const SEASON_LABEL = { spring: '🌱 Пролет', summer: '☀️ Лято', autumn: '🍂 Есен', winter: '❄️ Зима' } as const;
const WEATHER_LABEL = { clear: '', rain: '🌧 дъжд', snow: '🌨 сняг', storm: '⛈ буря' } as const;

import type { NeedBadge } from './life';
import { Splash } from '../ui/Brand';
import { get, post } from '../api';
import { bumpData, errorToast, getState, refreshCities, refreshCity, setState, toast, useDataVersion, useStore, type Tool } from '../store';
import { money } from '../format';

const PARCEL = BALANCE.world.parcelSize;

interface RegionData {
  parcels: { px: number; py: number; cityId: string }[];
  cities: CityRender[];
}

function lineTiles(a: { x: number; y: number }, b: { x: number; y: number }) {
  // L-образна линия: първо по X, после по Y (удобно за пътища).
  const out: { x: number; y: number }[] = [];
  const sx = b.x >= a.x ? 1 : -1;
  for (let x = a.x; ; x += sx) {
    out.push({ x, y: a.y });
    if (x === b.x) break;
  }
  const sy = b.y >= a.y ? 1 : -1;
  if (b.y !== a.y) {
    for (let y = a.y + sy; ; y += sy) {
      out.push({ x: b.x, y });
      if (y === b.y) break;
    }
  }
  return out.slice(0, 400);
}

function rectTiles(a: { x: number; y: number }, b: { x: number; y: number }) {
  const out: { x: number; y: number }[] = [];
  for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y++) for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) out.push({ x, y });
  return out.slice(0, 400);
}

function toolColor(tool: Tool): number {
  switch (tool.kind) {
    case 'road':
      return 0x9ca3af;
    case 'junction':
      return 0xfacc15;
    case 'sidewalk':
      return tool.remove ? 0xef4444 : 0xe8dcc0;
    case 'busstop':
      return tool.remove ? 0xef4444 : 0x1f6fb2;
    case 'zone':
      return ZONES[tool.zone as ZoneType].color;
    case 'service':
      return SERVICES[tool.service as ServiceType].color;
    case 'facility':
      return FACILITIES[tool.facility as FacilityType].color;
    case 'bulldoze':
    case 'dezone':
      return 0xef4444;
    default:
      return 0xffffff;
  }
}

export function MapView() {
  const host = useRef<HTMLDivElement>(null);
  const r = useRef<MapRenderer | null>(null);
  const region = useRef<RegionData>({ parcels: [], cities: [] });
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [hoverPx, setHoverPx] = useState<{ x: number; y: number } | null>(null);
  const derivedRef = useRef<CityDerived | null>(null);
  const [loading, setLoading] = useState(true);
  const [borders, setBorders] = useState(true);
  const world = useStore((s) => s.world);
  const me = useStore((s) => s.me);
  const city = useStore((s) => s.city);
  const layer = useStore((s) => s.layer);
  const tool = useStore((s) => s.tool);
  const focus = useStore((s) => s.focus);
  const issues = useStore((s) => s.issues);
  const version = useDataVersion();
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const needsRef = useRef<NeedBadge[]>([]);
  const tick = useStore((s) => s.tick);
  const season = seasonOf(gameDate(tick).month);
  const weather = weatherFor(tick, season);

  // Инициализация на рисувача (3D или 2D).
  useEffect(() => {
    if (!host.current || !world) return;
    const renderer: MapRenderer = new IsoRenderer();
    let disposed = false;
    renderer.init(host.current).then(() => {
      if (disposed) {
        renderer.destroy();
        return;
      }
      renderer.setWorld(getWorld(world.seed));
      r.current = renderer;
      renderer.onCameraChange = () => scheduleRegion();
      renderer.setIssues(getState().issues);
      renderer.setNeeds(needsRef.current);
      // Само в режим на разработка: достъп до камерата за визуални проверки от конзолата.
      if (import.meta.env.DEV) (window as unknown as { __gceMap?: MapRenderer }).__gceMap = renderer;
      const c = getState().city;
      if (c) renderer.centerOn(c.originX, c.originY, 0.8);
      else renderer.fitCountry(false);
      renderer.updateTerrain();
      setLoading(false);
      void loadRegion();
    });
    return () => {
      disposed = true;
      r.current = null;
      renderer.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world?.seed]);

  const regionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  async function loadRegion() {
    const rr = r.current;
    if (!rr) return;
    const v = rr.visibleTiles();
    // Сървърът връща най-много 256x256 плочки – ограничаваме около центъра.
    const cx = Math.round((v.x0 + v.x1) / 2);
    const cy = Math.round((v.y0 + v.y1) / 2);
    const half = 127;
    const q = { x0: Math.max(v.x0, cx - half), y0: Math.max(v.y0, cy - half), x1: Math.min(v.x1, cx + half), y1: Math.min(v.y1, cy + half) };
    try {
      const data = await get<RegionData>(`/world/region?x0=${q.x0}&y0=${q.y0}&x1=${q.x1}&y1=${q.y1}`);
      region.current = data;
      redrawCities();
    } catch {
      /* мрежова грешка – следващото движение ще опита пак */
    }
  }
  function scheduleRegion() {
    if (regionTimer.current) clearTimeout(regionTimer.current);
    regionTimer.current = setTimeout(() => void loadRegion(), 250);
  }

  function redrawCities() {
    const rr = r.current;
    if (!rr) return;
    const st = getState();
    rr.myUserId = st.me?.user.id ?? null;
    rr.activeCityId = st.activeCityId;
    // Активният град се рисува от пълните данни (по-свежи от региона).
    const cities = region.current.cities.map((c) => (st.city && c.id === st.city.id ? { ...c, tiles: st.city.tiles } : c));
    if (st.city && !cities.some((c) => c.id === st.city!.id))
      cities.push({ id: st.city.id, ownerId: st.city.ownerId, name: st.city.name, tiles: st.city.tiles, originX: st.city.originX, originY: st.city.originY });
    const parcels = [...region.current.parcels];
    if (st.city) for (const p of st.city.parcels) if (!parcels.some((x) => x.px === p.px && x.py === p.py)) parcels.push({ ...p, cityId: st.city.id });
    const building = st.tool.kind !== 'select';
    rr.drawParcels(parcels, cities, st.layer === 'ownership', building);
    rr.drawCities(cities, st.layer === 'zoning');
  }

  // Презареждане при нов тик / промяна на града.
  useEffect(() => {
    scheduleRegion();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  useEffect(() => {
    redrawCities();
  }, [city, layer, me, tool]);

  // Сигнали на гражданите – маркери на картата.
  useEffect(() => {
    r.current?.setIssues(issues);
  }, [issues, world?.seed]);

  // Магистрали между градовете.
  useEffect(() => {
    get<{ a: { originX: number; originY: number }; b: { originX: number; originY: number } }[]>('/world/links')
      .then((l) => r.current?.setLinks(l))
      .catch(() => undefined);
  }, [version, loading]);

  // Сезон, време и ден/нощ.
  useEffect(() => {
    r.current?.setSeason(season);
    r.current?.setWeather(weather);
    // винаги ден – без смяна на денонощието
    r.current?.setDayMode('day');
  }, [season, weather, loading]);

  // Значки „това трябва“ над сградите (липсващ път, ток, вода, тротоар).
  useEffect(() => {
    if (!city?.isOwner) {
      needsRef.current = [];
      r.current?.setNeeds([]);
      return;
    }
    let dead = false;
    const apply = (d: CityDerived | null) => {
      if (dead) return;
      derivedRef.current = d;
      needsRef.current = computeNeedBadges(city, d);
      r.current?.setNeeds(needsRef.current);
      r.current?.setTrafficLoad(d?.traffic);
    };
    get<CityDerived>(`/cities/${city.id}/layers`)
      .then(apply)
      .catch(() => apply(null));
    return () => {
      dead = true;
    };
  }, [city, version]);

  // Слоеве с данни.
  useEffect(() => {
    const rr = r.current;
    if (!rr) return;
    const wantRes = layer === 'resources';
    if (rr.showResources !== wantRes) {
      rr.showResources = wantRes;
      rr.resetTerrain();
      rr.updateTerrain();
    }
    const dataLayers = ['landValue', 'traffic', 'power', 'water', 'pollution', 'activity'];
    if (!dataLayers.includes(layer) || !city?.isOwner) {
      rr.drawOverlay(null, layer);
      return;
    }
    if (layer === 'power' || layer === 'water') {
      // обхватът се смята направо от плочките: ток и вода стигат до всяка плочка на до 2 плочки от път
      rr.drawOverlay(utilityReach(city, layer), layer);
      return;
    }
    get<Record<string, Record<string, number>>>(`/cities/${city.id}/layers`)
      .then((d) => {
        r.current?.drawOverlay(d[layer] ?? {}, layer);
      })
      .catch(() => undefined);
  }, [layer, city, version]);

  // Фокус (напр. при избор на град).
  useEffect(() => {
    if (focus && r.current) {
      r.current.centerOn(focus.x, focus.y, Math.max(r.current.scale, 0.7), true);
      scheduleRegion();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  // ---------------- Взаимодействие (мишка и докосване) ----------------
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{
    mode: 'pan' | 'build' | 'pinch' | 'none';
    start: { x: number; y: number } | null;
    moved: boolean;
    last: { x: number; y: number };
    pinchDist: number;
  }>({ mode: 'none', start: null, moved: false, last: { x: 0, y: 0 }, pinchDist: 0 });

  function localPos(e: React.PointerEvent | React.WheelEvent) {
    const rect = host.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function inTerritory(x: number, y: number) {
    const c = getState().city;
    if (!c) return false;
    return c.parcels.some((p) => Math.floor(x / PARCEL) === p.px && Math.floor(y / PARCEL) === p.py);
  }

  function previewTiles(t: Tool, a: { x: number; y: number }, b: { x: number; y: number }) {
    if (t.kind === 'road' || t.kind === 'sidewalk') return lineTiles(a, b);
    if (t.kind === 'junction') return [b];
    if (t.kind === 'zone' || t.kind === 'dezone' || t.kind === 'bulldoze') return rectTiles(a, b);
    return [b];
  }

  function showPreview(b: { x: number; y: number }) {
    const rr = r.current;
    if (!rr) return;
    const t = toolRef.current;
    if (t.kind === 'found') {
      const { px0, py0, ok } = foundSpot(b);
      rr.drawFoundCursor(px0, py0, BALANCE.world.startParcels, ok);
      return;
    }
    if (t.kind === 'parcel') {
      const px = Math.floor(b.x / PARCEL);
      const py = Math.floor(b.y / PARCEL);
      const c = getState().city;
      const ok =
        !!c && c.parcels.some((p) => Math.abs(p.px - px) + Math.abs(p.py - py) === 1) && !region.current.parcels.some((p) => p.px === px && p.py === py);
      rr.drawParcelCursor(px, py, ok);
      return;
    }
    const a = drag.current.mode === 'build' && drag.current.start ? drag.current.start : b;
    const tiles = t.kind === 'select' ? [b] : previewTiles(t, a, b);
    const valid = t.kind === 'select' || tiles.every((x) => inTerritory(x.x, x.y));
    rr.drawCursor(tiles, toolColor(t), valid);
  }

  /** Подходящо ли е мястото за нов град (същата проверка като на сървъра: суша в България, свободни парцели). */
  function foundSpot(b: { x: number; y: number }) {
    const n = BALANCE.world.startParcels;
    const px0 = Math.floor(b.x / PARCEL) - 1;
    const py0 = Math.floor(b.y / PARCEL) - 1;
    const gen = world ? getWorld(world.seed) : null;
    let land = 0;
    let taken = false;
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        if (gen) land += gen.parcelProfile(px0 + i, py0 + j).land;
        if (region.current.parcels.some((p) => p.px === px0 + i && p.py === py0 + j)) taken = true;
      }
    return { px0, py0, ok: !taken && land / (n * n) >= 0.8 };
  }

  async function commit(a: { x: number; y: number }, b: { x: number; y: number }) {
    const st = getState();
    const t = toolRef.current;
    const c = st.city;
    if (t.kind === 'select') {
      setState({ selected: b, panel: 'inspect', panelOpen: true });
      return;
    }
    if (t.kind === 'found') {
      const name = t.name.trim();
      if (name.length < 2) {
        toast('Въведете име на града (поне 2 букви) в лентата долу', 'warning');
        return;
      }
      try {
        const res = await post<{ id: string; originX: number; originY: number; name: string }>('/cities', { name, x: b.x, y: b.y }, true);
        toast(`Основан е град „${res.name}“! Започнете с път.`, 'success');
        await refreshCities();
        setState({
          activeCityId: res.id,
          tool: { kind: 'road', cls: 'street' },
          focus: { x: res.originX, y: res.originY, n: Date.now() },
          panel: 'city',
          panelOpen: true,
        });
        await refreshCity();
        bumpData();
      } catch (e) {
        errorToast(e);
      }
      return;
    }
    if (!c || !c.isOwner) {
      toast('Изберете свой град, за да строите', 'warning');
      return;
    }
    try {
      if (t.kind === 'parcel') {
        const px = Math.floor(b.x / PARCEL);
        const py = Math.floor(b.y / PARCEL);
        const res = await post<{ price: number }>(`/cities/${c.id}/parcels`, { px, py }, true);
        toast(`Закупен парцел за ${money(res.price)}`, 'success');
      } else if (t.kind === 'facility') {
        if (!st.activeCompanyId) {
          toast('Първо основете или изберете компания (панел „Компании“)', 'warning');
          return;
        }
        await post(`/companies/${st.activeCompanyId}/facilities`, { cityId: c.id, type: t.facility, x: b.x, y: b.y }, true);
        toast(`Построено: ${FACILITIES[t.facility as FacilityType].name}`, 'success');
      } else {
        const tiles = previewTiles(t, a, b).filter((x) => inTerritory(x.x, x.y));
        if (!tiles.length) {
          toast('Извън територията на града – купете парцел с инструмента „Земя“', 'warning');
          return;
        }
        const body =
          t.kind === 'road'
            ? { action: 'road', roadClass: t.cls ?? 'street', tiles }
            : t.kind === 'sidewalk'
              ? { action: 'sidewalk', remove: !!t.remove, tiles }
              : t.kind === 'busstop'
                ? { action: 'busstop', remove: !!t.remove, tiles: [b] }
                : t.kind === 'junction'
                  ? { action: 'junction', control: t.control, tiles: [b] }
                  : t.kind === 'zone'
                    ? { action: 'zone', zone: t.zone, tiles }
                    : t.kind === 'dezone'
                      ? { action: 'dezone', tiles }
                      : t.kind === 'service'
                        ? { action: 'service', service: t.service, tiles: [b] }
                        : { action: 'bulldoze', tiles };
        const res = await post<{ applied: number; cost: number; reasons: string[] }>(`/cities/${c.id}/build`, body, true);
        if (res.applied) toast(`Изпълнено върху ${res.applied} плочки (${money(res.cost)})`, 'success');
        if (res.reasons?.length) toast(res.reasons.join('; '), 'warning');
      }
      await refreshCity();
      bumpData();
    } catch (e) {
      errorToast(e);
    }
  }

  function onPointerDown(e: React.PointerEvent) {
    const p = localPos(e);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, p);
    const d = drag.current;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      d.mode = 'pinch';
      d.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      d.last = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      return;
    }
    d.moved = false;
    d.last = p;
    const tile = r.current?.screenToTile(p.x, p.y);
    const isPanButton = e.button === 1 || e.button === 2;
    if (isPanButton || toolRef.current.kind === 'select' || toolRef.current.kind === 'found') {
      d.mode = 'pan';
      d.start = tile ?? null;
    } else {
      d.mode = 'build';
      d.start = tile ?? null;
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    const rr = r.current;
    if (!rr) return;
    const p = localPos(e);
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, p);
    const d = drag.current;
    if (d.mode === 'pinch' && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      rr.pan(mid.x - d.last.x, mid.y - d.last.y);
      if (d.pinchDist > 0) rr.zoomNow(mid.x, mid.y, dist / d.pinchDist);
      d.pinchDist = dist;
      d.last = mid;
      rr.updateTerrain();
      scheduleRegion();
      return;
    }
    if (d.mode === 'pan') {
      const dx = p.x - d.last.x;
      const dy = p.y - d.last.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
      rr.pan(dx, dy);
      d.last = p;
      if (d.moved) {
        rr.updateTerrain();
        scheduleRegion();
      }
      return;
    }
    const tile = rr.screenToTile(p.x, p.y);
    setHover(tile);
    setHoverPx(p);
    showPreview(tile);
  }

  function onPointerUp(e: React.PointerEvent) {
    const p = localPos(e);
    const d = drag.current;
    pointers.current.delete(e.pointerId);
    const rr = r.current;
    if (!rr) return;
    if (d.mode === 'pinch') {
      if (pointers.current.size === 0) d.mode = 'none';
      return;
    }
    const tile = rr.screenToTile(p.x, p.y);
    if (d.mode === 'build' && d.start) void commit(d.start, tile);
    else if (d.mode === 'pan' && !d.moved && e.button === 0) {
      // клик върху маркер на сигнал отваря сигнала
      const issueId = toolRef.current.kind === 'select' ? rr.issueAtScreen(p.x, p.y) : null;
      if (issueId) setState({ panel: 'issues', panelOpen: true, selectedIssue: issueId });
      else void commit(tile, tile);
    }
    d.mode = 'none';
    d.start = null;
    showPreview(tile);
  }

  function onWheel(e: React.WheelEvent) {
    const rr = r.current;
    if (!rr) return;
    const p = localPos(e);
    rr.zoomAt(p.x, p.y, e.deltaY < 0 ? 1.18 : 1 / 1.18);
  }

  useEffect(() => {
    const onResize = () => {
      r.current?.updateTerrain();
      scheduleRegion();
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const gen = world && !loading ? getWorld(world.seed) : null;
  const terrainInfo = hover && gen ? gen.tileAt(hover.x, hover.y) : null;
  const regionName = terrainInfo && terrainInfo.region >= 0 ? gen!.regions[terrainInfo.region]?.name : null;
  const tileInfo = hover && city ? (city.tiles as TileMap)[tileKey(hover.x, hover.y)] : undefined;

  return (
    <div className="map-wrap">
      <div
        ref={host}
        className="map-host"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
        role="application"
        aria-label="Изометрична карта на света"
      />
      {tool.kind === 'select' && hover && hoverPx && tileInfo && (tileInfo.t === 'zone' || tileInfo.t === 'service' || tileInfo.t === 'facility') && (
        <HoverCard tile={tileInfo} info={derivedRef.current?.levels?.[tileKey(hover.x, hover.y)]} x={hoverPx.x} y={hoverPx.y} />
      )}
      <div className="map-hud">
        {hover && (
          <span>
            ({hover.x}, {hover.y}) · {terrainInfo ? terrainLabel(terrainInfo.terrain) : ''}
            {terrainInfo && terrainInfo.fertility > 0.3 ? ` · плодородие ${(terrainInfo.fertility * 100).toFixed(0)}%` : ''}
            {terrainInfo && terrainInfo.deposit !== 'none' ? ` · ${terrainInfo.deposit === 'iron' ? 'желязна руда' : 'въглища'}` : ''}
            {terrainInfo && terrainInfo.floodRisk > 0.3 ? ' · риск от наводнение' : ''}
            {tileInfo ? ` · ${describeTile(tileInfo)}` : ''}
            {regionName ? ` · ${regionName}` : ''}
          </span>
        )}
      </div>
      {loading && (
        <div className="map-loading">
          <Splash text="Генериране на държавата…" />
        </div>
      )}
      {!loading && <Minimap renderer={r} />}
      <div className="map-attrib">Релеф: AWS Terrain Tiles · Граници на областите: geoBoundaries (CC BY 4.0)</div>
      {city?.isOwner && (layer === 'power' || layer === 'water') && <UtilityLegend kind={layer} />}
      <div className="map-sky glass" title="Сезон и време">
        <span>{SEASON_LABEL[season]}</span>
        {WEATHER_LABEL[weather] && <span>{WEATHER_LABEL[weather]}</span>}
      </div>
      <div className="map-zoom">
        <button
          aria-label="Приближи"
          onClick={() => {
            const rr = r.current;
            if (rr) {
              rr.zoomAt(rr.app.screen.width / 2, rr.app.screen.height / 2, 1.4);
            }
          }}
        >
          +
        </button>
        <button
          aria-label="Отдалечи"
          onClick={() => {
            const rr = r.current;
            if (rr) {
              rr.zoomAt(rr.app.screen.width / 2, rr.app.screen.height / 2, 1 / 1.4);
            }
          }}
        >
          −
        </button>
        <button
          aria-label="Цяла България"
          title="Цяла България"
          onClick={() => {
            r.current?.fitCountry(true);
          }}
        >
          ◎
        </button>
        <button
          aria-label="Административни граници"
          title="Административни граници (вкл./изкл.)"
          className={borders ? 'active' : ''}
          onClick={() => {
            setBorders(!borders);
            r.current?.setBorders(!borders);
          }}
        >
          ⌗
        </button>
        <button aria-label="Отмени последното строене" title="Отмени последното строене (Ctrl+Z) – връща и парите" onClick={() => void undoLast()}>
          ↶
        </button>
        <button aria-label="Помощ" title="Кратко въведение" onClick={() => setState({ tutorial: 0 })}>
          ?
        </button>
        <button
          aria-label="Към моя град"
          title="Към моя град"
          onClick={() => {
            const c = getState().city;
            if (c) setState({ focus: { x: c.originX, y: c.originY, n: Date.now() } });
          }}
        >
          ⌂
        </button>
      </div>
    </div>
  );
}

/** Карта при посочване на сграда: какво е и какво ѝ липсва (за следващото ниво или за да се построи). */
/**
 * Докъде стигат токът и водата: 1 – има (до път и мощността стига), 0.5 – до път, но централите/помпите
 * не стигат, 0.2 – до път, но още няма централа/помпа, 0 – далеч от път (там няма да има никога).
 */
function utilityReach(city: NonNullable<ReturnType<typeof getState>['city']>, kind: 'power' | 'water'): Record<string, number> {
  const tiles = city.tiles as TileMap;
  const reach = new Set<string>();
  for (const [k, t] of Object.entries(tiles)) {
    if (t.t !== 'road') continue;
    const [x, y] = k.split(',').map(Number);
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (Math.abs(dx) + Math.abs(dy) <= 2) reach.add(tileKey(x + dx, y + dy));
  }
  const st = (city.stats as { power?: { supply: number; ratio: number }; water?: { supply: number; ratio: number } } | undefined)?.[kind];
  const level = !st || st.supply <= 0 ? 0.2 : st.ratio < 0.99 ? 0.5 : 1;
  const P = BALANCE.world.parcelSize;
  const out: Record<string, number> = {};
  for (const p of city.parcels)
    for (let j = 0; j < P; j++)
      for (let i = 0; i < P; i++) {
        const k = tileKey(p.px * P + i, p.py * P + j);
        out[k] = reach.has(k) ? level : 0;
      }
  return out;
}

/** Легенда на слоя „Ток“ / „Вода“: колко се произвежда и трябва, какво значат цветовете, бутон за още мощност. */
function UtilityLegend({ kind }: { kind: 'power' | 'water' }) {
  const city = useStore((s) => s.city);
  const st = (city?.stats as { power?: { supply: number; demand: number }; water?: { supply: number; demand: number } } | undefined)?.[kind];
  const isP = kind === 'power';
  const supply = Math.round(st?.supply ?? 0);
  const demand = Math.round(st?.demand ?? 0);
  const spare = supply - demand;
  return (
    <div className="utility-legend glass">
      <div className="ul-head">
        <b>{isP ? '⚡ Докъде стига токът' : '💧 Докъде стига водата'}</b>
        <button className="link small" onClick={() => setState({ layer: 'none' })}>
          ✕ Затвори
        </button>
      </div>
      <div className="small">
        {isP ? 'Произвеждат се' : 'Подават се'} <b>{supply}</b> · нужни <b>{demand}</b> ·{' '}
        {spare >= 0 ? (
          <span className="good">резерв {spare} – стига и за нови сгради</span>
        ) : (
          <span className="bad">недостиг {-spare} – новите сгради чакат</span>
        )}
      </div>
      <div className="ul-keys small">
        <span>
          <i style={{ background: isP ? '#facc15' : '#38bdf8' }} /> има {isP ? 'ток' : 'вода'}
        </span>
        <span>
          <i style={{ background: '#f97316' }} /> до път, но {isP ? 'централите' : 'помпите'} не стигат
        </span>
        <span>
          <i style={{ background: '#ef4444' }} /> далеч от път – няма да има
        </span>
      </div>
      <div className="small muted">
        {isP ? 'Токът' : 'Водата'} стига до всяка плочка на до 2 плочки от улица. {isP ? '' : 'Помпа до река дава много повече вода. '}
        {spare < 0 || supply <= 0 ? 'Постройте още:' : ''}
      </div>
      {(spare < 0 || supply <= 0 || spare < demand * 0.15) && (
        <button className="btn primary small" onClick={() => setState({ tool: { kind: 'service', service: isP ? 'power_wind' : 'water_pump' }, layer: kind })}>
          {isP ? '+ Вятърна централа' : '+ Помпена станция'}
        </button>
      )}
    </div>
  );
}

function HoverCard({ tile, info, x, y }: { tile: TileMap[string]; info?: { next: string[]; keep: string[] }; x: number; y: number }) {
  const miss = info ? [...new Set([...info.keep, ...info.next])].filter((r) => r !== 'occupancy' && r !== 'demand') : [];
  return (
    <div className="hover-card glass" style={{ left: x + 18, top: y + 18 }} role="tooltip">
      <b>{describeTile(tile)}</b>
      {tile.t === 'zone' && tile.lvl === 0 && !tile.prog && <div className="small muted">Празен парцел – чака път, ток, вода и търсене.</div>}
      {tile.t === 'zone' && tile.lvl > 0 && tile.lvl < 3 && (
        <div className="small">
          {miss.length ? (
            <>
              За ниво {tile.lvl + 1} липсва:{' '}
              {miss.slice(0, 5).map((r) => (
                <span key={r} className="hc-miss">
                  {REQ_ICON[r as keyof typeof REQ_ICON]} {UPGRADE_REQUIREMENT_LABELS[r as keyof typeof UPGRADE_REQUIREMENT_LABELS]}
                </span>
              ))}
            </>
          ) : (
            <span className="hc-ok">✔ Всички условия за ниво {tile.lvl + 1} са изпълнени</span>
          )}
        </div>
      )}
      {info && info.keep.length > 0 && <div className="small hc-warn">⚠ Губи състояние – липсва нещо за текущото ниво</div>}
      <div className="small muted">Щракнете за подробности</div>
    </div>
  );
}

/** Мини-карта на България с рамка на видимата част; щракване премества камерата. Плюс бързо отиване до област или град. */
function Minimap({ renderer }: { renderer: React.RefObject<IsoRenderer | null> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const world = useStore((s) => s.world);
  const me = useStore((s) => s.me);
  // създадените от играчите градове (всички) – обновяват се при всяко отваряне на списъка
  const [played, setPlayed] = useState<{ id: string; name: string; ownerId: string; ownerName: string; originX: number; originY: number; population: number }[]>([]);
  const loadPlayed = () => {
    get<typeof played>('/cities')
      .then(setPlayed)
      .catch(() => {});
  };
  useEffect(loadPlayed, []);
  const mine = played.filter((c) => c.ownerId === me?.user.id);
  const others = played.filter((c) => c.ownerId !== me?.user.id).sort((a, b) => a.name.localeCompare(b.name, 'bg'));
  const W = 220;
  const H = 110;
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      if (t - last < 250) return;
      last = t;
      const rr = renderer.current;
      const cv = canvas.current;
      if (!rr?.far || !cv) return;
      const g = cv.getContext('2d')!;
      const far = rr.far;
      // показваме средната част на текстурата (България), не целия ромб
      const fw = far.canvas.width;
      const fh = far.canvas.height;
      const src = { x: fw * 0.18, y: fh * 0.22, w: fw * 0.64, h: fh * 0.5 };
      g.clearRect(0, 0, W, H);
      g.drawImage(far.canvas, src.x, src.y, src.w, src.h, 0, 0, W, H);
      // екран → свят (px) → пиксел на текстурата → мини-карта
      const toMini = (sx: number, sy: number) => {
        const wx = (sx - rr.world.x) / rr.scale;
        const wy = (sy - rr.world.y) / rr.scale;
        const fx = (wx - far.sx) * far.res;
        const fy = (wy - far.sy) * far.res;
        return [((fx - src.x) / src.w) * W, ((fy - src.y) / src.h) * H] as const;
      };
      const sw = rr.app.screen.width;
      const sh = rr.app.screen.height;
      const pts = [toMini(0, 0), toMini(sw, 0), toMini(sw, sh), toMini(0, sh)];
      g.strokeStyle = '#fde68a';
      g.lineWidth = 1.5;
      g.beginPath();
      pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
      g.stroke();
      (cv as HTMLCanvasElement & { _src?: typeof src })._src = src;
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [renderer]);
  const gen = world ? getWorld(world.seed) : null;
  const goto = (value: string) => {
    const rr = renderer.current;
    if (!rr || !gen || !value) return;
    const [kind, id] = value.split(':');
    if (kind === 'c') {
      const c = played.find((x) => x.id === id);
      if (!c) return;
      rr.centerOn(c.originX, c.originY, 0.7, true);
      // собствен град – става и активен (панелът и строенето са за него)
      if (c.ownerId === me?.user.id && getState().activeCityId !== c.id) {
        setState({ activeCityId: c.id });
        void refreshCity();
      }
    } else if (kind === 'r') {
      const rg = gen.regions[Number(id)];
      rr.centerOn(Math.round(rg.cx), Math.round(rg.cy), 0.3, true);
    } else {
      const pl = REAL_PLACES[Number(id)];
      rr.centerOn(pl.x, pl.y, 0.55, true);
    }
  };
  return (
    <div className="minimap glass">
      <select aria-label="Отиди до област или град" value="" onFocus={loadPlayed} onMouseDown={loadPlayed} onChange={(e) => goto(e.target.value)}>
        <option value="">📍 Отиди до…</option>
        {mine.length > 0 && (
          <optgroup label="Моите градове">
            {mine.map((c) => (
              <option key={c.id} value={`c:${c.id}`}>
                🏙 {c.name} · {c.population.toLocaleString('bg-BG')} жители
              </option>
            ))}
          </optgroup>
        )}
        {others.length > 0 && (
          <optgroup label="Градове на играчите">
            {others.map((c) => (
              <option key={c.id} value={`c:${c.id}`}>
                {c.name} ({c.ownerName}) · {c.population.toLocaleString('bg-BG')} жители
              </option>
            ))}
          </optgroup>
        )}
        <optgroup label="Населени места на картата">
          {REAL_PLACES.map((p, i) => (
            <option key={p.name} value={`p:${i}`}>
              {p.name}
            </option>
          ))}
        </optgroup>
        <optgroup label="Области">
          {gen?.regions
            .map((rg, i) => ({ rg, i }))
            .sort((a, b) => a.rg.name.localeCompare(b.rg.name, 'bg'))
            .map(({ rg, i }) => (
              <option key={rg.id} value={`r:${i}`}>
                {rg.name}
              </option>
            ))}
        </optgroup>
      </select>
      <canvas
        ref={canvas}
        width={W}
        height={H}
        aria-label="Мини-карта – щракнете, за да отидете там"
        onClick={(e) => {
          const rr = renderer.current;
          const cv = canvas.current as (HTMLCanvasElement & { _src?: { x: number; y: number; w: number; h: number } }) | null;
          if (!rr?.far || !cv?._src) return;
          const rect = cv.getBoundingClientRect();
          const mx = ((e.clientX - rect.left) / rect.width) * W;
          const my = ((e.clientY - rect.top) / rect.height) * H;
          const fx = cv._src.x + (mx / W) * cv._src.w;
          const fy = cv._src.y + (my / H) * cv._src.h;
          const t = toTile(fx / rr.far.res + rr.far.sx, fy / rr.far.res + rr.far.sy);
          rr.centerOn(t.x, t.y, Math.max(rr.scale, 0.25), true);
        }}
      />
    </div>
  );
}

const TERRAIN_BG = ['Дълбоки води', 'Езеро', 'Бряг', 'Равнина', 'Гора', 'Хълмове', 'Планина', 'Река'];
function terrainLabel(t: number) {
  return TERRAIN_BG[t] ?? '';
}

const ROAD_NAMES: Record<string, string> = {
  street: 'Улица',
  avenue: 'Булевард',
  highway: 'Градска магистрала',
  rural: 'Селски път',
  industrial: 'Индустриален път',
};

export function describeTile(t: TileMap[string]): string {
  if (t.t === 'road')
    return `${ROAD_NAMES[t.c ?? 'street']}${t.j === 'roundabout' ? ', кръгово движение' : t.j === 'signals' ? ', светофари' : ''}${hasSidewalk(t) ? ', с тротоари' : ', без тротоари'}${t.st ? ', автобусна спирка' : ''}`;
  if (t.t === 'path') return 'Пешеходна алея';
  if (t.t === 'zone')
    return `${ZONES[t.z].name} зона${t.lvl ? `, ниво ${t.lvl}, заетост ${(t.occ * 100).toFixed(0)}%` : t.prog ? ', в строеж' : ', празна'}${t.ab ? ' (изоставена)' : ''}`;
  if (t.t === 'service') return SERVICES[t.s].name;
  return FACILITIES[t.f].name;
}

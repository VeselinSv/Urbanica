import { useSyncExternalStore } from 'react';
import type { CityPolicy, CityStats, PopulationState, TileMap, WorldInfo } from '@gce/shared';
import { get } from './api';

export interface Me {
  user: { id: string; username: string; email: string; role: string };
  wallet: number;
}

export interface CityDetail {
  id: string;
  name: string;
  ownerId: string;
  ownerName: string;
  originX: number;
  originY: number;
  parcels: { px: number; py: number }[];
  tiles: TileMap;
  isOwner: boolean;
  treasury?: number;
  pop?: PopulationState;
  policy?: CityPolicy;
  stats?: Partial<CityStats> & { retailDemand?: Record<string, number> };
  receivership?: boolean;
  deficitDays?: number;
  publicStats: Record<string, unknown>;
  publicPolicy: { taxes: CityPolicy['taxes']; importTariff: number };
}

export interface CompanyBrief {
  id: string;
  name: string;
  status: string;
  rating: string;
  hqCityId: string;
  cash: number | null;
  roles: string[];
  shares: number;
  totalShares: number;
}

export type Tool =
  | { kind: 'select' }
  | { kind: 'found'; name: string }
  | { kind: 'road'; cls?: 'street' | 'avenue' | 'highway' | 'rural' | 'industrial' }
  | { kind: 'junction'; control: 'roundabout' | 'signals' | 'none' }
  /** Тротоари върху път / пешеходна алея на празна земя; remove – премахва. */
  | { kind: 'sidewalk'; remove?: boolean }
  /** Автобусна спирка върху път; remove – премахва. */
  | { kind: 'busstop'; remove?: boolean }
  | { kind: 'zone'; zone: string }
  | { kind: 'dezone' }
  | { kind: 'service'; service: string }
  | { kind: 'facility'; facility: string }
  | { kind: 'bulldoze' }
  | { kind: 'parcel' };

export type Layer = 'none' | 'ownership' | 'resources' | 'zoning' | 'landValue' | 'traffic' | 'power' | 'water' | 'pollution' | 'activity';

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success' | 'warning';
  text: string;
}

export interface Issue {
  id: string;
  kind: string;
  x: number;
  y: number;
  severity: number;
  status: 'OPEN' | 'FIXING' | 'RESOLVED';
  reporter: string;
  message: string;
  createdTick: number;
  fixDoneTick: number | null;
  resolvedTick: number | null;
  resolvedBy: string | null;
  fixCost: number;
}

export interface State {
  me: Me | null;
  world: WorldInfo | null;
  /** Стъпка на въведението (null – скрито). */
  tutorial: number | null;
  cities: { id: string; name: string; ownerId: string; originX: number; originY: number; population: number }[];
  activeCityId: string | null;
  city: CityDetail | null;
  companies: CompanyBrief[];
  activeCompanyId: string | null;
  tool: Tool;
  layer: Layer;
  panel: string;
  selected: { x: number; y: number } | null;
  toasts: Toast[];
  unread: number;
  tick: number;
  focus: { x: number; y: number; n: number } | null;
  panelOpen: boolean;
  /** Отворени сигнали от гражданите на активния град (само за кмета). */
  issues: Issue[];
  recentIssues: Issue[];
  selectedIssue: string | null;
}

let state: State = {
  me: null,
  world: null,
  tutorial: (() => {
    try {
      return localStorage.getItem('gce_tutorial_done') ? null : 0;
    } catch {
      return null;
    }
  })(),
  cities: [],
  activeCityId: null,
  city: null,
  companies: [],
  activeCompanyId: null,
  tool: { kind: 'select' },
  layer: 'none',
  panel: 'city',
  selected: null,
  toasts: [],
  unread: 0,
  tick: 0,
  focus: null,
  // на телефон панелът започва затворен, за да се вижда картата
  panelOpen: typeof window === 'undefined' || window.innerWidth > 760,
  issues: [],
  recentIssues: [],
  selectedIssue: null,
};

const listeners = new Set<() => void>();
export function getState() {
  return state;
}
export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  for (const l of listeners) l();
}
export function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state));
}

let toastId = 0;
export function toast(text: string, kind: Toast['kind'] = 'info') {
  const id = ++toastId;
  setState((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, text }] }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 6000 : 4000);
}

export function errorToast(e: unknown) {
  toast(e instanceof Error ? e.message : String(e), 'error');
}

// ---------------- Зареждане на данни ----------------

export async function refreshMe() {
  const me = await get<Me>('/auth/me');
  setState({ me });
  return me;
}

export async function refreshCities() {
  const cities = await get<State['cities']>('/cities?mine=1');
  setState((s) => ({ cities, activeCityId: s.activeCityId && cities.some((c) => c.id === s.activeCityId) ? s.activeCityId : (cities[0]?.id ?? null) }));
  return cities;
}

export async function refreshCity() {
  const id = state.activeCityId;
  if (!id) {
    // няма град (напр. след „Започни отначало“) – нищо от стария град не остава на екрана
    setState({ city: null, issues: [], recentIssues: [], selectedIssue: null, selected: null });
    return null;
  }
  const city = await get<CityDetail>(`/cities/${id}`);
  if (state.activeCityId === id) setState({ city });
  if (city.isOwner) await refreshIssues();
  else setState({ issues: [], recentIssues: [] });
  return city;
}

export async function refreshIssues() {
  const id = state.activeCityId;
  if (!id) return;
  try {
    const r = await get<{ open: Issue[]; recent: Issue[] }>(`/cities/${id}/issues`);
    if (state.activeCityId === id) setState({ issues: r.open, recentIssues: r.recent });
  } catch {
    /* не е кмет или мрежова грешка */
  }
}

export async function refreshCompanies() {
  const companies = await get<CompanyBrief[]>('/companies/mine');
  setState((s) => ({
    companies,
    activeCompanyId:
      s.activeCompanyId && companies.some((c) => c.id === s.activeCompanyId) ? s.activeCompanyId : (companies.find((c) => c.roles.length)?.id ?? null),
  }));
  return companies;
}

// ---------------- Игрово време ----------------
// Един тик = един игрови ден. Часът от денонощието се изчислява от момента на последния тик на сървъра,
// затова е еднакъв за всички играчи и не се променя при презареждане на страницата.
let tickBase = { tick: 0, at: Date.now(), interval: 20000 };
/** Отместване на часовника на сървъра спрямо локалния (ms). */
let clockOffset = 0;

/** Записва новия тик от сървъра: `at` е началото на игровия ден по часовника на сървъра. */
export function noteTick(tick: number, at?: string, serverNow?: string) {
  if (serverNow) clockOffset = Date.parse(serverNow) - Date.now();
  tickBase = { ...tickBase, tick, at: at ? Date.parse(at) - clockOffset : Date.now() };
}

/** Колко от текущия игрови ден е минал: 0 – изгрев, 1 – краят на деня. */
export function dayFraction(): number {
  const f = (Date.now() - tickBase.at) / tickBase.interval;
  return Math.min(0.999, Math.max(0, f));
}

/** Кога е бил последният тик (локално време) и продължителността на деня – за резервното опресняване. */
export function tickTiming() {
  return tickBase;
}

export async function refreshWorld() {
  const t0 = Date.now();
  const world = await get<WorldInfo>('/world');
  const t1 = Date.now();
  // отместване на часовника на сървъра спрямо локалния (средата на заявката)
  clockOffset = world.serverTime ? Date.parse(world.serverTime) - (t0 + t1) / 2 : 0;
  tickBase = { tick: world.tick, at: Date.parse(world.lastTickAt) - clockOffset, interval: world.tickIntervalMs || 20000 };
  setState({ world, tick: world.tick });
  return world;
}

export async function refreshAll() {
  await Promise.all([refreshWorld(), refreshMe(), refreshCities(), refreshCompanies()]);
  await refreshCity();
}

/** Сигнал "версия на данните" – панелите го използват, за да се презареждат при нов тик. */
let dataVersion = 0;
const versionListeners = new Set<() => void>();
export function bumpData() {
  dataVersion++;
  for (const l of versionListeners) l();
}
export function useDataVersion() {
  return useSyncExternalStore(
    (l) => {
      versionListeners.add(l);
      return () => versionListeners.delete(l);
    },
    () => dataVersion,
  );
}

import { io, type Socket } from 'socket.io-client';
import { getToken } from './api';
import { bumpData, getState, noteTick, refreshCity, refreshMe, refreshWorld, setState, tickTiming, toast } from './store';

export interface ChatMsg {
  id: string;
  channel: string;
  senderId: string;
  senderName: string;
  body: string;
  createdAt: string;
}

let socket: Socket | null = null;
const chatListeners = new Set<(m: ChatMsg) => void>();
export function onChat(fn: (m: ChatMsg) => void) {
  chatListeners.add(fn);
  return () => chatListeners.delete(fn);
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let lastRefresh = 0;
/** Опресняване на града и панелите – най-много веднъж на ~2.5 s (денят е 1 секунда). */
function scheduleRefresh() {
  if (refreshTimer) return;
  const wait = Math.max(300, 2500 - (Date.now() - lastRefresh));
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    lastRefresh = Date.now();
    await Promise.allSettled([refreshCity(), refreshMe()]);
    bumpData();
  }, wait);
}

function onTick(tick: number, at?: string, now?: string) {
  if (tick === getState().tick) return;
  noteTick(tick, at, now);
  setState({ tick, world: getState().world ? { ...getState().world!, tick } : null });
  scheduleRefresh();
}

/**
 * Резервно опресняване: ако връзката в реално време мълчи (сървърът спи, мрежата прекъсва, прокси),
 * питаме сървъра за новия ден сами – парите, датата и градът се обновяват и без презареждане.
 */
let fallback: ReturnType<typeof setInterval> | null = null;
let polling = false;
function startFallback() {
  if (fallback) return;
  fallback = setInterval(async () => {
    const t = tickTiming();
    if (polling || document.hidden || Date.now() - t.at < t.interval * 1.5) return;
    polling = true;
    try {
      const prev = getState().tick;
      const w = await refreshWorld();
      if (w.tick !== prev) {
        await Promise.allSettled([refreshCity(), refreshMe()]);
        bumpData();
      }
    } catch {
      /* мрежова грешка – следващият опит след малко */
    } finally {
      polling = false;
    }
  }, 4000);
}

export function connectSocket() {
  socket?.disconnect();
  socket = io({ path: '/socket.io', auth: { token: getToken() }, transports: ['websocket', 'polling'] });
  // след (пре)свързване може да сме изпуснали събития – опресняваме всичко
  socket.on('connect', () => scheduleRefresh());
  socket.on('tick', (d: { tick: number; at?: string; now?: string }) => onTick(d.tick, d.at, d.now));
  startFallback();
  socket.on('city', (d: { cityId: string }) => {
    if (d.cityId === getState().activeCityId) scheduleRefresh();
  });
  socket.on('notification', (n: { kind: string; message: string }) => {
    setState((s) => ({ unread: s.unread + 1 }));
    toast(n.message, n.kind === 'credit' || n.kind === 'finance' ? 'warning' : 'info');
  });
  socket.on('market', () => bumpData());
  socket.on('chat', (m: ChatMsg) => {
    for (const l of chatListeners) l(m);
  });
  socket.on('disconnect', () => {
    /* socket.io се свързва отново автоматично */
  });
  return socket;
}

export function joinChannel(channel: string) {
  socket?.emit('join', channel);
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
  if (fallback) clearInterval(fallback);
  fallback = null;
}

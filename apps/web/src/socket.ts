import { io, type Socket } from 'socket.io-client';
import { getToken } from './api';
import { bumpData, getState, refreshCity, refreshMe, setState, toast } from './store';

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
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    await Promise.allSettled([refreshCity(), refreshMe()]);
    bumpData();
  }, 300);
}

export function connectSocket() {
  socket?.disconnect();
  socket = io({ path: '/socket.io', auth: { token: getToken() }, transports: ['websocket', 'polling'] });
  socket.on('connect', () => setState({}));
  socket.on('tick', (d: { tick: number }) => {
    setState({ tick: d.tick, world: getState().world ? { ...getState().world!, tick: d.tick } : null });
    scheduleRefresh();
  });
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
}

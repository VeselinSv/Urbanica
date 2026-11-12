/**
 * „Живият“ слой на картата: трафик и пешеходци (traffic.ts), дим от комините, сенки от облаци,
 * сигнали на гражданите (пулсиращи маркери и следи на терена – дупка, локва, боклук, катастрофа…).
 * Всичко е в PixiJS и се обновява всеки кадър; колите и димът се показват само отблизо.
 */
import { Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import { ISSUE_TYPES, parseKey, tileKey, type TileState } from '@gce/shared';
import { Traffic } from './traffic';
import { decalTexture } from './decals';

const TW = 64;
const TH = 32;
const iso = (x: number, y: number) => ({ x: (x - y) * (TW / 2), y: (x + y) * (TH / 2) });

export interface IssueMarker {
  id: string;
  kind: string;
  x: number;
  y: number;
  severity: number;
  status: string;
}

/** Значка „липсва …“ над група сгради (⚡ ток, 💧 вода, 🛣 път, 🚶 тротоар…). */
export interface NeedBadge {
  x: number;
  y: number;
  icon: string;
  count: number;
  /** 2 – сградите губят ниво, 1 – не могат да растат. */
  sev: 1 | 2;
  title: string;
}

interface Puff {
  g: Graphics;
  life: number;
  vx: number;
  x: number;
  y: number;
}

function cloudTexture(): Texture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d')!;
  for (let i = 0; i < 7; i++) {
    const x = 70 + Math.random() * 116;
    const y = 70 + Math.random() * 116;
    const r = 50 + Math.random() * 50;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(10,20,30,0.55)');
    grad.addColorStop(1, 'rgba(10,20,30,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
  }
  return Texture.from(c);
}

export class CityLife {
  /** Следите на сигналите по терена (дупки, теч, боклук…) – текстури, рисувани като истински материали. */
  readonly ground = new Container();
  readonly cars = new Container();
  readonly smoke = new Container();
  readonly clouds = new Container();
  readonly markers = new Container();
  readonly traffic: Traffic;
  private blocked = new Set<string>();
  private puffs: Puff[] = [];
  private chimneys: { x: number; y: number; h: number }[] = [];
  private markerList: { c: Container; issue: IssueMarker; sx: number; sy: number }[] = [];
  private needList: Container[] = [];
  private time = 0;
  private cloudList: { s: Sprite; vx: number; vy: number }[] = [];
  private glints: { g: Graphics; life: number }[] = [];
  readonly water = new Container();

  constructor(private worldSize: number) {
    this.traffic = new Traffic(this.cars);
    const tex = cloudTexture();
    for (let i = 0; i < 9; i++) {
      const s = new Sprite(tex);
      s.anchor.set(0.5);
      const p = iso(Math.random() * worldSize, Math.random() * worldSize);
      s.position.set(p.x, p.y);
      s.scale.set(18 + Math.random() * 22, 9 + Math.random() * 10);
      s.alpha = 0.22;
      this.clouds.addChild(s);
      this.cloudList.push({ s, vx: 9 + Math.random() * 6, vy: 2 + Math.random() * 3 });
    }
  }

  /** Обновява пътищата и комините от плочките на градовете (при всяка промяна в града). */
  setTiles(tiles: Map<string, TileState>) {
    this.chimneys = [];
    for (const [k, t] of tiles) {
      const [x, y] = parseKey(k);
      if (t.t === 'service' && t.s === 'power_coal') this.chimneys.push({ x: x + 0.86, y: y + 0.5, h: 92 });
      else if (t.t === 'facility' && (t.f === 'steel_mill' || t.f === 'coal_power' || t.f === 'factory'))
        this.chimneys.push({ x: x + 0.86, y: y + 0.6, h: 78 });
      else if (t.t === 'zone' && t.z === 'I' && t.lvl >= 2 && (x * 7 + y * 13) % 3 === 0) this.chimneys.push({ x: x + 0.86, y: y + 0.5, h: 48 });
    }
    this.traffic.setTiles(tiles);
  }

  /** Сигнали: маркери над плочките и следи на терена. */
  setIssues(issues: IssueMarker[]) {
    for (const m of this.markerList) m.c.destroy({ children: true });
    this.markerList = [];
    this.blocked = new Set(issues.filter((i) => ISSUE_TYPES[i.kind]?.effects.blocksRoad && i.status !== 'RESOLVED').map((i) => tileKey(i.x, i.y)));
    this.traffic.setBlocked(this.blocked);
    this.traffic.setIssues(issues);
    for (const ch of this.ground.removeChildren()) ch.destroy();
    for (const i of issues) {
      const c = iso(i.x + 0.5, i.y + 0.5);
      const tex = decalTexture(i.kind, i.severity, i.x * 7 + i.y * 13, false);
      if (tex) {
        const d = new Sprite(tex);
        d.anchor.set(0.5);
        d.scale.set(0.5);
        d.position.set(c.x, c.y + 1);
        this.ground.addChild(d);
      }
      const m = new Container();
      const fixing = i.status === 'FIXING';
      const color = fixing ? 0xf59e0b : i.severity >= 3 ? 0xdc2626 : i.severity === 2 ? 0xf97316 : 0xfacc15;
      const pin = new Graphics();
      pin.circle(0, -22, 15).fill({ color: 0x0f172a, alpha: 0.85 }).stroke({ width: 3, color });
      pin.poly([-6, -10, 6, -10, 0, -1]).fill(color);
      const t = new Text({
        text: fixing ? '🔧' : (ISSUE_TYPES[i.kind]?.icon ?? '❗'),
        style: { fontSize: 16, fontFamily: 'Segoe UI Emoji, Apple Color Emoji, sans-serif' },
      });
      t.anchor.set(0.5);
      t.position.set(0, -22);
      m.addChild(pin, t);
      m.position.set(c.x, c.y - 10);
      this.markers.addChild(m);
      this.markerList.push({ c: m, issue: i, sx: c.x, sy: c.y - 10 });
    }
  }

  /** Значки „това трябва“ над групи сгради. */
  setNeeds(list: NeedBadge[]) {
    for (const c of this.needList) c.destroy({ children: true });
    this.needList = [];
    for (const n of list) {
      const c = new Container();
      const label = n.count > 1 ? `${n.icon} ×${n.count}` : n.icon;
      const t = new Text({
        text: label,
        style: { fontSize: 13, fontFamily: 'Segoe UI Emoji, Apple Color Emoji, system-ui, sans-serif', fill: 0xffffff, fontWeight: '700' },
      });
      t.anchor.set(0.5);
      const w = Math.max(24, t.width + 12);
      const bg = new Graphics();
      bg.roundRect(-w / 2, -11, w, 22, 11)
        .fill({ color: 0x0f172a, alpha: 0.82 })
        .stroke({ width: 2, color: n.sev === 2 ? 0xef4444 : 0xf59e0b });
      bg.poly([-4, 10, 4, 10, 0, 16]).fill({ color: n.sev === 2 ? 0xef4444 : 0xf59e0b });
      c.addChild(bg, t);
      const p = iso(n.x + 0.5, n.y + 0.5);
      c.position.set(p.x, p.y - 44);
      c.label = n.title;
      this.markers.addChild(c);
      this.needList.push(c);
    }
  }

  /** Сигнал под екранна точка (в световни координати на контейнера). */
  issueAt(wx: number, wy: number, scale: number): string | null {
    const r = 20 / Math.max(0.25, Math.min(1, scale));
    for (const m of this.markerList) {
      const k = m.c.scale.x;
      const dx = wx - m.sx;
      const dy = wy - (m.sy - 22 * k);
      if (dx * dx + dy * dy < r * r * k * k + 300) return m.issue.id;
    }
    return null;
  }

  /** Отблясък на слънцето върху водата (кратко проблясване). */
  glint(wx: number, wy: number) {
    if (this.glints.length > 90) return;
    const p = iso(wx, wy);
    const g = new Graphics();
    g.poly([-7, 0, 0, -1.4, 7, 0, 0, 1.4]).fill({ color: 0xffffff, alpha: 0.9 });
    g.position.set(p.x, p.y);
    g.alpha = 0;
    this.water.addChild(g);
    this.glints.push({ g, life: 0 });
  }

  update(dt: number, scale: number) {
    this.time += dt;
    const near = scale >= 0.42;
    this.smoke.visible = near;
    this.water.visible = scale >= 0.18;
    for (let i = this.glints.length - 1; i >= 0; i--) {
      const gl = this.glints[i];
      gl.life += dt;
      gl.g.alpha = Math.max(0, Math.sin((gl.life / 1.6) * Math.PI)) * 0.55;
      gl.g.scale.set(0.6 + gl.life * 0.4, 1);
      if (gl.life > 1.6) {
        gl.g.destroy();
        this.glints.splice(i, 1);
      }
    }
    // облаци – бавно се носят над държавата
    const W = this.worldSize;
    for (const c of this.cloudList) {
      c.s.x += c.vx * dt;
      c.s.y += c.vy * dt;
      const left = iso(0, W).x - 3000;
      const right = iso(W, 0).x + 3000;
      if (c.s.x > right) {
        c.s.x = left;
        c.s.y = iso(Math.random() * W, Math.random() * W).y;
      }
    }
    // маркерите пулсират и пазят постоянен екранен размер
    const inv = Math.min(2.5, Math.max(0.6, 1 / scale));
    for (const c of this.needList) {
      c.scale.set(inv * 0.9);
      c.visible = scale >= 0.3;
    }
    for (const m of this.markerList) {
      const pulse = m.issue.status === 'OPEN' ? 1 + Math.sin(this.time * 4 + m.sx * 0.01) * 0.08 * m.issue.severity : 1;
      m.c.scale.set(inv * pulse);
    }
    if (!near) return;
    this.traffic.update(dt, scale);
    // дим
    if (this.chimneys.length && Math.random() < dt * this.chimneys.length * 3) {
      const ch = this.chimneys[Math.floor(Math.random() * this.chimneys.length)];
      const p = iso(ch.x, ch.y);
      const g = new Graphics();
      g.circle(0, 0, 4).fill({ color: 0xe5e7eb, alpha: 0.6 });
      this.smoke.addChild(g);
      this.puffs.push({ g, life: 0, vx: 4 + Math.random() * 4, x: p.x, y: p.y - ch.h });
    }
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const pf = this.puffs[i];
      pf.life += dt;
      pf.g.position.set(pf.x + pf.vx * pf.life * 3, pf.y - pf.life * 14);
      pf.g.scale.set(1 + pf.life * 1.6);
      pf.g.alpha = Math.max(0, 0.7 - pf.life * 0.22);
      if (pf.life > 3.2) {
        pf.g.destroy();
        this.puffs.splice(i, 1);
      }
    }
  }
}

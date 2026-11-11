/**
 * Ден и нощ, време (дъжд, сняг) и светлини.
 *
 *  - Денонощието е визуално: цикъл от 8 минути (ден → залез → нощ → изгрев) или фиксиран ден/нощ.
 *  - Нощем целият свят се затъмнява (слой с „умножение“), а отгоре светят адитивно: уличните лампи,
 *    прозорците на сградите, фаровете и стоповете на колите, градовете при далечен изглед.
 *  - Времето (дъжд/сняг) зависи от сезона и игровия ден – еднакво за всички играчи.
 */
import { Container, Graphics, Sprite, Texture } from 'pixi.js';
import { parseKey, type TileState } from '@gce/shared';
import { lampAt } from './paint';
import { h01, type Season } from './sprites';

export type DayMode = 'auto' | 'day' | 'night';
export type Weather = 'clear' | 'rain' | 'snow' | 'storm';

const iso = (x: number, y: number) => ({ x: (x - y) * 32, y: (x + y) * 16 });
const CYCLE = 480; // секунди за едно денонощие

function glowTexture(): Texture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  return Texture.from(c);
}

function coneTexture(): Texture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 32;
  const g = c.getContext('2d')!;
  const gr = g.createLinearGradient(0, 0, 64, 0);
  gr.addColorStop(0, 'rgba(255,255,255,0.9)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.beginPath();
  g.moveTo(0, 14);
  g.lineTo(64, 0);
  g.lineTo(64, 32);
  g.lineTo(0, 18);
  g.closePath();
  g.fill();
  return Texture.from(c);
}

let GLOW: Texture | null = null;
let CONE: Texture | null = null;
export function glowTex() {
  return (GLOW ??= glowTexture());
}
export function coneTex() {
  return (CONE ??= coneTexture());
}

/** Време за игровия ден според сезона (детерминистично – всички виждат едно и също). */
export function weatherFor(tick: number, season: Season): Weather {
  const r = h01(tick, 71);
  if (season === 'winter') return r < 0.38 ? 'snow' : 'clear';
  if (season === 'autumn') return r < 0.32 ? (r < 0.06 ? 'storm' : 'rain') : 'clear';
  if (season === 'spring') return r < 0.28 ? (r < 0.05 ? 'storm' : 'rain') : 'clear';
  return r < 0.1 ? 'storm' : 'clear';
}

export class Atmosphere {
  /** Затъмняване (умножение) – над земята и сградите. */
  readonly dark = new Graphics();
  /** Адитивни светлини. */
  readonly lights = new Container();
  /** Валежи – в екранни координати (над света). */
  readonly weatherLayer = new Container();
  private lamps: Sprite[] = [];
  private windows: Sprite[] = [];
  private cityGlow = new Graphics();
  private drops: { g: Graphics; x: number; y: number; v: number; s: number }[] = [];
  private flash = 0;
  time = CYCLE * 0.3;
  mode: DayMode = 'auto';
  weather: Weather = 'clear';
  /** 0 – ден, 1 – пълна нощ (за колите и сградите). */
  night = 0;

  constructor(worldSize: number) {
    // голям правоъгълник през целия свят (в световни координати)
    const a = iso(0, 0);
    const b = iso(worldSize, worldSize);
    const l = iso(0, worldSize).x;
    const r = iso(worldSize, 0).x;
    this.dark.rect(l - 4000, a.y - 4000, r - l + 8000, b.y - a.y + 8000).fill(0xffffff);
    this.dark.blendMode = 'multiply';
    this.dark.visible = false;
    this.lights.blendMode = 'add';
    this.lights.addChild(this.cityGlow);
  }

  /** Светлини от плочките на градовете: лампи, прозорци, сияние на града отдалеч. */
  setTiles(tiles: Map<string, TileState>) {
    for (const s of this.lamps) s.destroy();
    for (const s of this.windows) s.destroy();
    this.lamps = [];
    this.windows = [];
    this.cityGlow.clear();
    const lookup = (x: number, y: number) => tiles.get(`${x},${y}`);
    const tex = glowTex();
    for (const [k, t] of tiles) {
      const [x, y] = parseKey(k);
      const lamp = lampAt(x, y, t, lookup);
      if (lamp) {
        // светло петно на земята + ярка глава на лампата
        const p = iso(lamp.wx, lamp.wy);
        const pool = new Sprite(tex);
        pool.anchor.set(0.5);
        pool.position.set(p.x + lamp.arm * 3, p.y + 1);
        pool.scale.set(1.15, 0.55);
        pool.tint = 0xffc977;
        const head = new Sprite(tex);
        head.anchor.set(0.5);
        head.position.set(p.x + lamp.arm * 3.4, p.y - 16.2);
        head.scale.set(0.28);
        head.tint = 0xfff0c0;
        this.lights.addChild(pool, head);
        this.lamps.push(pool, head);
      }
      const lvl = t.t === 'zone' ? (t.ab ? 0 : t.lvl) : t.t === 'service' || t.t === 'facility' ? 1 : 0;
      if (lvl > 0) {
        const p = iso(x + 0.5, y + 0.5);
        // не всички прозорци светят
        if (h01(x, y, 81) < 0.82) {
          const w = new Sprite(tex);
          w.anchor.set(0.5);
          const hgt = t.t === 'zone' ? [10, 26, 60][lvl - 1] : 12;
          w.position.set(p.x, p.y - hgt * 0.55);
          w.scale.set(0.55 + lvl * 0.15, 0.35 + lvl * 0.35);
          w.tint = t.t === 'zone' && (t.z === 'O' || t.z === 'H') ? 0xcfe3ff : 0xffcf7d;
          w.alpha = 0.55;
          this.lights.addChild(w);
          this.windows.push(w);
        }
        this.cityGlow.circle(p.x, p.y - 4, 26 + lvl * 8).fill({ color: 0xffb860, alpha: 0.07 });
      }
    }
  }

  private darkness() {
    if (this.mode === 'day') return 0;
    if (this.mode === 'night') return 1;
    const f = (this.time % CYCLE) / CYCLE; // 0 – изгрев
    // ден 0.05..0.55, залез 0.55..0.65, нощ 0.65..0.95, изгрев 0.95..1.05
    if (f < 0.05) return 0.5 - f * 10;
    if (f < 0.55) return 0;
    if (f < 0.65) return (f - 0.55) * 10;
    if (f < 0.95) return 1;
    return 1 - (f - 0.95) * 10;
  }

  /** Име на частта от денонощието – за индикатора в интерфейса. */
  phaseLabel(): string {
    const d = this.darkness();
    if (this.mode !== 'auto') return this.mode === 'day' ? 'Ден' : 'Нощ';
    const f = (this.time % CYCLE) / CYCLE;
    if (d <= 0.01) return 'Ден';
    if (d >= 0.99) return 'Нощ';
    return f < 0.5 || f > 0.9 ? 'Изгрев' : 'Залез';
  }

  update(dt: number, scale: number, screenW: number, screenH: number) {
    this.time += dt;
    const n = this.darkness();
    this.night = n;
    const overcast = this.weather === 'clear' ? 0 : this.weather === 'snow' ? 0.12 : 0.22;
    const dusk = Math.max(0, 1 - Math.abs(n - 0.45) * 3.2) * (this.mode === 'auto' ? 1 : 0);
    // цвят на затъмняването: оранжев при залез, тъмносин нощем, сив при облачно
    const k = Math.min(0.66, n * 0.62 + overcast);
    this.dark.visible = k > 0.005;
    if (this.dark.visible) {
      const night = { r: 0x26, g: 0x34, b: 0x6a };
      const sun = { r: 0xff, g: 0x9a, b: 0x62 };
      const grey = { r: 0x9a, g: 0xa4, b: 0xb2 };
      const mixc = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
      const base = n > 0.02 ? night : grey;
      const cr = mixc(255, mixc(base.r, sun.r, dusk * 0.6), k / 0.66);
      const cg = mixc(255, mixc(base.g, sun.g, dusk * 0.6), k / 0.66);
      const cb = mixc(255, mixc(base.b, sun.b, dusk * 0.6), k / 0.66);
      this.dark.tint = (cr << 16) | (cg << 8) | cb;
    }
    // светлините
    const near = scale >= 0.42;
    const lightA = Math.max(0, (n - 0.25) / 0.75);
    this.lights.visible = lightA > 0.01;
    for (const s of this.lamps) s.visible = near;
    for (const s of this.windows) s.visible = near;
    for (let i = 0; i < this.lamps.length; i++) this.lamps[i].alpha = lightA * (i % 2 ? 1 : 0.7);
    for (const w of this.windows) w.alpha = lightA * 0.5;
    this.cityGlow.visible = !near;
    this.cityGlow.alpha = lightA;
    // светкавица при буря
    if (this.weather === 'storm' && Math.random() < dt * 0.08) this.flash = 1;
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt * 3);
      this.dark.tint = 0xffffff;
    }
    this.updateWeather(dt, screenW, screenH);
  }

  private updateWeather(dt: number, W: number, H: number) {
    const want = this.weather === 'clear' ? 0 : this.weather === 'snow' ? 260 : this.weather === 'storm' ? 420 : 300;
    while (this.drops.length < want) {
      const g = new Graphics();
      const snow = this.weather === 'snow';
      if (snow) g.circle(0, 0, 1.2 + Math.random() * 1.6).fill({ color: 0xffffff, alpha: 0.85 });
      else g.moveTo(0, 0).lineTo(-3, 14).stroke({ width: 1, color: 0xcfe2ff, alpha: 0.55 });
      this.weatherLayer.addChild(g);
      this.drops.push({ g, x: Math.random() * W, y: Math.random() * H, v: snow ? 40 + Math.random() * 40 : 620 + Math.random() * 300, s: snow ? 1 : 0 });
    }
    while (this.drops.length > want) this.drops.pop()!.g.destroy();
    for (const d of this.drops) {
      if (d.s) {
        d.y += d.v * dt;
        d.x += Math.sin(d.y * 0.02 + d.v) * 12 * dt + 8 * dt;
      } else {
        d.y += d.v * dt;
        d.x -= d.v * 0.2 * dt;
      }
      if (d.y > H + 20) {
        d.y = -20;
        d.x = Math.random() * (W + 100);
      }
      if (d.x < -30) d.x += W + 60;
      if (d.x > W + 30) d.x -= W + 60;
      d.g.position.set(d.x, d.y);
    }
  }
}

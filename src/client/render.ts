import { BALL, FIELD } from '../shared/constants';
import { getCharacter } from '../shared/characters';
import type { RoomMember } from '../shared/types';

export interface ViewPlayer {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  flags: number; // bit0 kick held, bit1 skill active
  cd: number;
}

export interface ViewWorld {
  ball: { x: number; y: number };
  players: ViewPlayer[];
  ph: number;
}

export type EffectKind = 'kick' | 'perfect' | 'goalflash' | 'burst';

export interface Effect {
  kind: EffectKind;
  x: number;
  y: number;
  t0: number;
  color?: string;
}

const TEAM = [
  { fill: '#d8554a', edge: '#511d18' },
  { fill: '#5689e5', edge: '#1b3563' },
];

const LINE = 'rgba(240, 248, 240, 0.75)';

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private fieldCache: HTMLCanvasElement | null = null;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private scale = 1;
  shake = 0; // decaying screen-shake intensity in px

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.w = rect.width;
    this.h = rect.height;
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
    const viewW = (FIELD.halfW + FIELD.goalDepth + 45) * 2;
    const viewH = (FIELD.halfH + 60) * 2;
    this.scale = Math.min(this.w / viewW, this.h / viewH);
    this.fieldCache = null;
  }

  private sx(x: number): number {
    return this.w / 2 + x * this.scale;
  }

  private sy(y: number): number {
    return this.h / 2 + y * this.scale;
  }

  private buildFieldCache(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const g = c.getContext('2d')!;
    g.scale(this.dpr, this.dpr);
    const s = this.scale;
    const { halfW: hw, halfH: hh, goalHalf: gh, goalDepth: gd, postRadius: pr } = FIELD;

    // surroundings
    g.fillStyle = '#173a26';
    g.fillRect(0, 0, this.w, this.h);

    // striped pitch
    const stripes = 10;
    const stripeW = (hw * 2) / stripes;
    for (let i = 0; i < stripes; i++) {
      g.fillStyle = i % 2 === 0 ? '#2c7a45' : '#2f8049';
      g.fillRect(this.sx(-hw + i * stripeW), this.sy(-hh), stripeW * s + 1, hh * 2 * s);
    }

    // nets
    for (const side of [-1, 1]) {
      const x0 = side * hw;
      const x1 = side * (hw + gd);
      g.fillStyle = 'rgba(10, 25, 16, 0.55)';
      g.fillRect(
        Math.min(this.sx(x0), this.sx(x1)),
        this.sy(-gh),
        Math.abs(this.sx(x1) - this.sx(x0)),
        gh * 2 * s,
      );
      g.strokeStyle = 'rgba(220, 235, 225, 0.25)';
      g.lineWidth = 1;
      const step = 11;
      for (let yy = -gh; yy <= gh; yy += step) {
        g.beginPath();
        g.moveTo(this.sx(x0), this.sy(yy));
        g.lineTo(this.sx(x1), this.sy(yy));
        g.stroke();
      }
      for (let k = 0; k <= gd; k += step) {
        g.beginPath();
        g.moveTo(this.sx(side * (hw + k)), this.sy(-gh));
        g.lineTo(this.sx(side * (hw + k)), this.sy(gh));
        g.stroke();
      }
      g.strokeStyle = 'rgba(220, 235, 225, 0.5)';
      g.lineWidth = 2;
      g.strokeRect(
        Math.min(this.sx(x0), this.sx(x1)),
        this.sy(-gh),
        Math.abs(this.sx(x1) - this.sx(x0)),
        gh * 2 * s,
      );
    }

    // pitch lines
    g.strokeStyle = LINE;
    g.lineWidth = 2.5;
    g.strokeRect(this.sx(-hw), this.sy(-hh), hw * 2 * s, hh * 2 * s);
    g.beginPath();
    g.moveTo(this.sx(0), this.sy(-hh));
    g.lineTo(this.sx(0), this.sy(hh));
    g.stroke();
    g.beginPath();
    g.arc(this.sx(0), this.sy(0), 80 * s, 0, Math.PI * 2);
    g.stroke();
    g.beginPath();
    g.arc(this.sx(0), this.sy(0), 4 * s, 0, Math.PI * 2);
    g.fillStyle = LINE;
    g.fill();

    // penalty areas (cosmetic)
    for (const side of [-1, 1]) {
      const bx = side * hw;
      const w = 110 * s * side;
      g.strokeStyle = 'rgba(240, 248, 240, 0.45)';
      g.lineWidth = 2;
      g.strokeRect(Math.min(this.sx(bx), this.sx(bx) + w), this.sy(-150), Math.abs(w), 300 * s);
    }

    // posts
    for (const side of [-1, 1]) {
      for (const yy of [-gh, gh]) {
        g.beginPath();
        g.arc(this.sx(side * hw), this.sy(yy), pr * s, 0, Math.PI * 2);
        g.fillStyle = '#f2f6f2';
        g.fill();
        g.strokeStyle = '#222';
        g.lineWidth = 1.5;
        g.stroke();
      }
    }

    return c;
  }

  draw(
    world: ViewWorld,
    roster: Map<number, RoomMember>,
    myId: number,
    localKick: boolean,
    effects: Effect[],
    now: number,
    aim: { x: number; y: number; dx: number; dy: number } | null = null,
  ): void {
    const ctx = this.ctx;
    const s = this.scale;
    if (!this.fieldCache) this.fieldCache = this.buildFieldCache();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    let ox = 0;
    let oy = 0;
    if (this.shake > 0.3) {
      ox = (Math.random() * 2 - 1) * this.shake;
      oy = (Math.random() * 2 - 1) * this.shake;
      this.shake *= 0.88;
    }
    ctx.setTransform(this.dpr, 0, 0, this.dpr, ox * this.dpr, oy * this.dpr);
    ctx.drawImage(this.fieldCache, 0, 0, this.w, this.h);

    // players
    for (const p of world.players) {
      const member = roster.get(p.id);
      const team = member?.team === 1 ? 1 : 0;
      const char = getCharacter(member?.charId ?? 'classic');
      const skillOn = (p.flags & 2) !== 0;
      // Fortress doubles the disc while active
      const r = char.radius * (skillOn && char.skill?.id === 'fortress' ? 2 : 1) * s;
      const x = this.sx(p.x);
      const y = this.sy(p.y);

      // magnet attraction radius
      if (skillOn && char.skill?.id === 'magnet') {
        ctx.beginPath();
        ctx.arc(x, y, char.skill.magnitude * s, 0, Math.PI * 2);
        ctx.strokeStyle = char.color;
        ctx.globalAlpha = 0.3;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 6]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }

      // skill aura
      if (p.flags & 2) {
        ctx.beginPath();
        ctx.arc(x, y, r + 5, 0, Math.PI * 2);
        ctx.strokeStyle = char.color;
        ctx.lineWidth = 3;
        ctx.globalAlpha = 0.55 + 0.35 * Math.sin(now / 90);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // disc
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = TEAM[team].fill;
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = TEAM[team].edge;
      ctx.stroke();

      // character accent ring
      ctx.beginPath();
      ctx.arc(x, y, Math.max(2, r - 4), 0, Math.PI * 2);
      ctx.strokeStyle = char.color;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.9;
      ctx.stroke();
      ctx.globalAlpha = 1;

      // kick indicator
      const kicking = p.id === myId ? localKick : (p.flags & 1) !== 0;
      if (kicking) {
        ctx.beginPath();
        ctx.arc(x, y, r + 3.5, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.95)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // character initial
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.font = `700 ${Math.max(9, 11 * s)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(char.name[0], x, y + 0.5);

      // name
      const name = member?.name ?? '';
      if (name) {
        ctx.font = `600 ${Math.max(9, 11 * s)}px system-ui, sans-serif`;
        ctx.fillStyle = p.id === myId ? '#7df0a8' : 'rgba(255,255,255,0.85)';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(name, x, y - r - 6);
      }
    }

    // ball
    {
      const x = this.sx(world.ball.x);
      const y = this.sy(world.ball.y);
      const r = BALL.radius * s;
      ctx.beginPath();
      ctx.arc(x + 2, y + 3, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = '#f5f5f5';
      ctx.fill();
      ctx.lineWidth = 1.8;
      ctx.strokeStyle = '#1c1c1c';
      ctx.stroke();
    }

    // aim arrow (Power Shot armed + on the ball): where the kick will send it
    if (aim) {
      const x0 = this.sx(aim.x);
      const y0 = this.sy(aim.y);
      const len = 48 * s;
      const x1 = x0 + aim.dx * len;
      const y1 = y0 + aim.dy * len;
      ctx.strokeStyle = '#ffe44d';
      ctx.lineWidth = 3;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.moveTo(x0 + aim.dx * 14 * s, y0 + aim.dy * 14 * s);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      // arrowhead
      const ang = Math.atan2(aim.dy, aim.dx);
      const hs = 9 * s;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - Math.cos(ang - 0.45) * hs, y1 - Math.sin(ang - 0.45) * hs);
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - Math.cos(ang + 0.45) * hs, y1 - Math.sin(ang + 0.45) * hs);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // effects
    for (const ef of effects) {
      const x = this.sx(ef.x);
      const y = this.sy(ef.y);
      if (ef.kind === 'kick') {
        const t = (now - ef.t0) / 180;
        if (t > 1) continue;
        ctx.beginPath();
        ctx.arc(x, y, (12 + 20 * t) * s, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,255,255,${0.6 * (1 - t)})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      } else if (ef.kind === 'perfect') {
        const t = (now - ef.t0) / 480;
        if (t > 1) continue;
        const a = 1 - t;
        ctx.strokeStyle = `rgba(255, 228, 77, ${a})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(x, y, (14 + 55 * t) * s, 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(x, y, (8 + 80 * t) * s, 0, Math.PI * 2);
        ctx.stroke();
        // radial sparks
        for (let i = 0; i < 8; i++) {
          const ang = (i / 8) * Math.PI * 2;
          const r0 = (16 + 60 * t) * s;
          const r1 = r0 + 12 * s * (1 - t);
          ctx.beginPath();
          ctx.moveTo(x + Math.cos(ang) * r0, y + Math.sin(ang) * r0);
          ctx.lineTo(x + Math.cos(ang) * r1, y + Math.sin(ang) * r1);
          ctx.stroke();
        }
      } else if (ef.kind === 'burst') {
        const t = (now - ef.t0) / 320;
        if (t > 1) continue;
        ctx.beginPath();
        ctx.arc(x, y, (10 + 30 * t) * s, 0, Math.PI * 2);
        ctx.strokeStyle = ef.color ?? 'rgba(255,255,255,0.8)';
        ctx.globalAlpha = 1 - t;
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (ef.kind === 'goalflash') {
        const t = (now - ef.t0) / 450;
        if (t > 1) continue;
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        ctx.fillStyle = `rgba(255,255,255,${0.32 * (1 - t)})`;
        ctx.fillRect(0, 0, this.w, this.h);
      }
    }
  }
}

import { BALL, FIELD, KICKOFF_BARRIER, TEAMS } from '../shared/constants';
import { getCharacter } from '../shared/characters';
import { getGeometry, type Geometry } from '../shared/physics';
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
  ko: number; // kickoff possession team, -1 = free
}

export type EffectKind = 'kick' | 'perfect' | 'goalflash' | 'burst' | 'shot';

export interface Effect {
  kind: EffectKind;
  x: number;
  y: number;
  t0: number;
  color?: string;
  style?: string; // for kind 'shot': the shot-fx id
  seed?: number; // stable randomness for particle layouts
}

const LINE = 'rgba(240, 248, 240, 0.75)';

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private fieldCache: HTMLCanvasElement | null = null;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private scale = 1;
  private geom: Geometry = getGeometry(2);
  private hotball = false;
  shake = 0; // decaying screen-shake intensity in px
  myColor: string | null = null; // personal disc colour, only on this screen

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  setMode(teams: number, hotball: boolean): void {
    const geom = getGeometry(teams);
    if (geom !== this.geom) {
      this.geom = geom;
      this.fieldCache = null;
      if (this.w > 0) this.computeScale();
    }
    this.hotball = hotball;
  }

  private computeScale(): void {
    this.scale = Math.min(this.w / (this.geom.viewX * 2), this.h / (this.geom.viewY * 2));
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.w = rect.width;
    this.h = rect.height;
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
    this.computeScale();
    this.fieldCache = null;
  }

  private sx(x: number): number {
    return this.w / 2 + (x - this.geom.viewCx) * this.scale;
  }

  private sy(y: number): number {
    return this.h / 2 + (y - this.geom.viewCy) * this.scale;
  }

  private tracePoly(g: CanvasRenderingContext2D, pts: { x: number; y: number }[]): void {
    g.beginPath();
    g.moveTo(this.sx(pts[0].x), this.sy(pts[0].y));
    for (let i = 1; i < pts.length; i++) {
      g.lineTo(this.sx(pts[i].x), this.sy(pts[i].y));
    }
    g.closePath();
  }

  private buildFieldCache(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const g = c.getContext('2d')!;
    g.scale(this.dpr, this.dpr);
    const s = this.scale;
    const geom = this.geom;

    // surroundings
    g.fillStyle = '#173a26';
    g.fillRect(0, 0, this.w, this.h);

    // striped pitch, clipped to the polygon
    const xs = geom.pitch.map((p) => p.x);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    g.save();
    this.tracePoly(g, geom.pitch);
    g.clip();
    const stripes = 10;
    const stripeW = (maxX - minX) / stripes;
    for (let i = 0; i < stripes; i++) {
      g.fillStyle = i % 2 === 0 ? '#2c7a45' : '#2f8049';
      g.fillRect(this.sx(minX + i * stripeW), 0, stripeW * s + 1, this.h);
    }
    g.restore();

    // goal nets: dark box + hatching
    for (const goal of geom.goals) {
      g.save();
      this.tracePoly(g, goal.netPoly);
      g.clip();
      g.fillStyle = 'rgba(10, 25, 16, 0.55)';
      g.fillRect(0, 0, this.w, this.h);
      g.strokeStyle = 'rgba(220, 235, 225, 0.25)';
      g.lineWidth = 1;
      const step = 11;
      // lines along the outward normal and along the goal line
      for (let k = -goal.mouthHalf; k <= goal.mouthHalf; k += step) {
        const bx = goal.cx + goal.ux * k;
        const by = goal.cy + goal.uy * k;
        g.beginPath();
        g.moveTo(this.sx(bx), this.sy(by));
        g.lineTo(this.sx(bx + goal.nx * goal.depth), this.sy(by + goal.ny * goal.depth));
        g.stroke();
      }
      for (let k = 0; k <= goal.depth; k += step) {
        const bx = goal.cx + goal.nx * k;
        const by = goal.cy + goal.ny * k;
        g.beginPath();
        g.moveTo(this.sx(bx - goal.ux * goal.mouthHalf), this.sy(by - goal.uy * goal.mouthHalf));
        g.lineTo(this.sx(bx + goal.ux * goal.mouthHalf), this.sy(by + goal.uy * goal.mouthHalf));
        g.stroke();
      }
      g.restore();
      g.strokeStyle = 'rgba(220, 235, 225, 0.5)';
      g.lineWidth = 2;
      this.tracePoly(g, goal.netPoly);
      g.stroke();
    }

    // pitch outline
    g.strokeStyle = LINE;
    g.lineWidth = 2.5;
    this.tracePoly(g, geom.pitch);
    g.stroke();

    // center circle + dot
    g.beginPath();
    g.arc(this.sx(0), this.sy(0), 80 * s, 0, Math.PI * 2);
    g.stroke();
    g.beginPath();
    g.arc(this.sx(0), this.sy(0), 4 * s, 0, Math.PI * 2);
    g.fillStyle = LINE;
    g.fill();

    // classic extras for the 2-team rectangle: midline + penalty boxes
    if (geom.teams === 2) {
      const { halfW: hw, halfH: hh } = FIELD;
      g.strokeStyle = LINE;
      g.lineWidth = 2.5;
      g.beginPath();
      g.moveTo(this.sx(0), this.sy(-hh));
      g.lineTo(this.sx(0), this.sy(hh));
      g.stroke();
      for (const side of [-1, 1]) {
        const bx = side * hw;
        const w = 110 * s * side;
        g.strokeStyle = 'rgba(240, 248, 240, 0.45)';
        g.lineWidth = 2;
        g.strokeRect(Math.min(this.sx(bx), this.sx(bx) + w), this.sy(-150), Math.abs(w), 300 * s);
      }
    }

    // defender-colored goal lines + posts
    for (const goal of geom.goals) {
      g.strokeStyle = TEAMS[goal.team].color;
      g.globalAlpha = 0.85;
      g.lineWidth = 4;
      g.beginPath();
      g.moveTo(
        this.sx(goal.cx - goal.ux * goal.mouthHalf),
        this.sy(goal.cy - goal.uy * goal.mouthHalf),
      );
      g.lineTo(
        this.sx(goal.cx + goal.ux * goal.mouthHalf),
        this.sy(goal.cy + goal.uy * goal.mouthHalf),
      );
      g.stroke();
      g.globalAlpha = 1;
      for (const post of goal.posts) {
        g.beginPath();
        g.arc(this.sx(post.x), this.sy(post.y), FIELD.postRadius * s, 0, Math.PI * 2);
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

    // kickoff possession: highlight the protected center circle
    if (world.ko >= 0) {
      ctx.beginPath();
      ctx.arc(this.sx(0), this.sy(0), KICKOFF_BARRIER * s, 0, Math.PI * 2);
      ctx.fillStyle = TEAMS[world.ko].color;
      ctx.globalAlpha = 0.08;
      ctx.fill();
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = TEAMS[world.ko].color;
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // players
    for (const p of world.players) {
      const member = roster.get(p.id);
      const team = member && member.team >= 0 && member.team <= 3 ? member.team : 0;
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
      if (skillOn) {
        ctx.beginPath();
        ctx.arc(x, y, r + 5, 0, Math.PI * 2);
        ctx.strokeStyle = char.color;
        ctx.lineWidth = 3;
        ctx.globalAlpha = 0.55 + 0.35 * Math.sin(now / 90);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // disc (your own disc can use a personal colour; the border stays team-coloured)
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = p.id === myId && this.myColor ? this.myColor : TEAMS[team].color;
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = TEAMS[team].edge;
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
      if (this.hotball) {
        // hot ball: pulsing fiery aura
        ctx.beginPath();
        ctx.arc(x, y, r + 4 + Math.sin(now / 110) * 2, 0, Math.PI * 2);
        ctx.strokeStyle = '#ff7b2d';
        ctx.globalAlpha = 0.7;
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = this.hotball ? '#ffe1c4' : '#f5f5f5';
      ctx.fill();
      ctx.lineWidth = 1.8;
      ctx.strokeStyle = this.hotball ? '#a3420e' : '#1c1c1c';
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
          const sang = (i / 8) * Math.PI * 2;
          const r0 = (16 + 60 * t) * s;
          const r1 = r0 + 12 * s * (1 - t);
          ctx.beginPath();
          ctx.moveTo(x + Math.cos(sang) * r0, y + Math.sin(sang) * r0);
          ctx.lineTo(x + Math.cos(sang) * r1, y + Math.sin(sang) * r1);
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
      } else if (ef.kind === 'shot') {
        this.drawShot(ctx, ef, x, y, s, now);
      }
    }
  }

  // Cosmetic shot effects (purchasable). All radial so they read well without
  // needing a shot direction. `seed` keeps each burst's particle layout stable.
  private drawShot(
    ctx: CanvasRenderingContext2D,
    ef: Effect,
    x: number,
    y: number,
    s: number,
    now: number,
  ): void {
    const dur =
      ef.style === 'confetti' || ef.style === 'nova' ? 620 : ef.style === 'shock' ? 560 : 420;
    const t = (now - ef.t0) / dur;
    if (t > 1) return;
    const seed = ef.seed ?? 0;
    const a = 1 - t;

    switch (ef.style) {
      case 'flame': {
        // expanding fire ring + rising embers
        const grad = ctx.createRadialGradient(x, y, 2, x, y, (16 + 38 * t) * s);
        grad.addColorStop(0, `rgba(255, 220, 120, ${0.5 * a})`);
        grad.addColorStop(0.5, `rgba(255, 110, 30, ${0.45 * a})`);
        grad.addColorStop(1, 'rgba(255, 60, 0, 0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(x, y, (16 + 38 * t) * s, 0, Math.PI * 2);
        ctx.fill();
        for (let i = 0; i < 9; i++) {
          const ang = seed + i * 2.0;
          const dist = (10 + 50 * t) * s;
          const px = x + Math.cos(ang) * dist * 0.6;
          const py = y + Math.sin(ang) * dist - 40 * t * t * s;
          ctx.fillStyle = `rgba(255, ${150 + ((i * 37) % 90)}, 40, ${a})`;
          ctx.beginPath();
          ctx.arc(px, py, (3.5 - 2.5 * t) * s, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      case 'bolt': {
        // jagged electric arcs radiating outward
        ctx.strokeStyle = `rgba(120, 220, 255, ${a})`;
        ctx.lineWidth = 2.2;
        ctx.shadowColor = '#5ad1ff';
        ctx.shadowBlur = 8;
        const arcs = 6;
        for (let i = 0; i < arcs; i++) {
          const ang = seed + (i / arcs) * Math.PI * 2;
          const reach = (18 + 46 * t) * s;
          ctx.beginPath();
          ctx.moveTo(x, y);
          let px = x;
          let py = y;
          const segs = 4;
          for (let k = 1; k <= segs; k++) {
            const rr = (reach * k) / segs;
            const jitter = ((((i * 7 + k * 13) % 11) - 5) / 5) * 9 * s;
            px = x + Math.cos(ang) * rr + Math.cos(ang + 1.57) * jitter * (1 - t);
            py = y + Math.sin(ang) * rr + Math.sin(ang + 1.57) * jitter * (1 - t);
            ctx.lineTo(px, py);
          }
          ctx.stroke();
        }
        ctx.shadowBlur = 0;
        break;
      }
      case 'confetti': {
        const n = 16;
        for (let i = 0; i < n; i++) {
          const ang = seed + (i / n) * Math.PI * 2 + i;
          const speed = 40 + ((i * 53) % 40);
          const dist = speed * t * s;
          const px = x + Math.cos(ang) * dist;
          const py = y + Math.sin(ang) * dist + 26 * t * t * s; // gravity
          const hues = ['#ff5db4', '#5ad1ff', '#ffe44d', '#43c46b', '#ff9d42'];
          ctx.fillStyle = hues[i % hues.length];
          ctx.globalAlpha = a;
          ctx.save();
          ctx.translate(px, py);
          ctx.rotate(ang + t * 6);
          ctx.fillRect(-3 * s, -1.5 * s, 6 * s, 3 * s);
          ctx.restore();
        }
        ctx.globalAlpha = 1;
        break;
      }
      case 'shock': {
        for (let r = 0; r < 3; r++) {
          const rt = t - r * 0.12;
          if (rt < 0 || rt > 1) continue;
          ctx.strokeStyle = `rgba(190, 170, 255, ${(1 - rt) * 0.9})`;
          ctx.lineWidth = (4 - r) * 1.2;
          ctx.beginPath();
          ctx.arc(x, y, (10 + 70 * rt) * s, 0, Math.PI * 2);
          ctx.stroke();
        }
        break;
      }
      case 'nova': {
        // golden starburst + drifting sparkles
        ctx.strokeStyle = `rgba(255, 228, 77, ${a})`;
        ctx.lineWidth = 2.5;
        const rays = 10;
        for (let i = 0; i < rays; i++) {
          const ang = seed + (i / rays) * Math.PI * 2;
          const r0 = 8 * s;
          const r1 = (20 + 55 * t) * s;
          ctx.beginPath();
          ctx.moveTo(x + Math.cos(ang) * r0, y + Math.sin(ang) * r0);
          ctx.lineTo(x + Math.cos(ang) * r1, y + Math.sin(ang) * r1);
          ctx.stroke();
        }
        for (let i = 0; i < 7; i++) {
          const ang = seed * 2 + i * 1.6;
          const dist = (14 + 40 * t) * s;
          const px = x + Math.cos(ang) * dist;
          const py = y + Math.sin(ang) * dist;
          ctx.fillStyle = `rgba(255, 245, 190, ${a})`;
          ctx.beginPath();
          ctx.arc(px, py, (2.5 - 1.5 * t) * s, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      default: {
        // classic white shockring
        ctx.beginPath();
        ctx.arc(x, y, (12 + 26 * t) * s, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,255,255,${0.65 * a})`;
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }
    }
  }
}

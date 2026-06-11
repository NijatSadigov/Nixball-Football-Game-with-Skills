import { BALL, FIELD, TEAMS } from '../shared/constants';
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

const LINE = 'rgba(240, 248, 240, 0.75)';

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private fieldCache: HTMLCanvasElement | null = null;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private scale = 1;
  private teams = 2;
  private hotball = false;
  shake = 0; // decaying screen-shake intensity in px

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  setMode(teams: number, hotball: boolean): void {
    if (teams !== this.teams) this.fieldCache = null; // field layout changes
    this.teams = teams;
    this.hotball = hotball;
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
    const topGoal = this.teams >= 3;
    const bottomGoal = this.teams >= 4;

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

    // each goal: net box, hatching, defender-colored goal line, posts
    // goals: [team, net rect in world coords, mouth line p0->p1]
    interface GoalDef {
      team: number;
      net: { x0: number; y0: number; x1: number; y1: number };
      mouth: { x0: number; y0: number; x1: number; y1: number };
      posts: { x: number; y: number }[];
    }
    const goals: GoalDef[] = [
      {
        team: 0,
        net: { x0: -hw - gd, y0: -gh, x1: -hw, y1: gh },
        mouth: { x0: -hw, y0: -gh, x1: -hw, y1: gh },
        posts: [
          { x: -hw, y: -gh },
          { x: -hw, y: gh },
        ],
      },
      {
        team: 1,
        net: { x0: hw, y0: -gh, x1: hw + gd, y1: gh },
        mouth: { x0: hw, y0: -gh, x1: hw, y1: gh },
        posts: [
          { x: hw, y: -gh },
          { x: hw, y: gh },
        ],
      },
    ];
    if (topGoal) {
      goals.push({
        team: 2,
        net: { x0: -gh, y0: -hh - gd, x1: gh, y1: -hh },
        mouth: { x0: -gh, y0: -hh, x1: gh, y1: -hh },
        posts: [
          { x: -gh, y: -hh },
          { x: gh, y: -hh },
        ],
      });
    }
    if (bottomGoal) {
      goals.push({
        team: 3,
        net: { x0: -gh, y0: hh, x1: gh, y1: hh + gd },
        mouth: { x0: -gh, y0: hh, x1: gh, y1: hh },
        posts: [
          { x: -gh, y: hh },
          { x: gh, y: hh },
        ],
      });
    }

    const step = 11;
    for (const goal of goals) {
      const px0 = this.sx(goal.net.x0);
      const py0 = this.sy(goal.net.y0);
      const pw = (goal.net.x1 - goal.net.x0) * s;
      const ph = (goal.net.y1 - goal.net.y0) * s;
      g.fillStyle = 'rgba(10, 25, 16, 0.55)';
      g.fillRect(px0, py0, pw, ph);
      // hatching
      g.strokeStyle = 'rgba(220, 235, 225, 0.25)';
      g.lineWidth = 1;
      for (let xx = goal.net.x0; xx <= goal.net.x1; xx += step) {
        g.beginPath();
        g.moveTo(this.sx(xx), py0);
        g.lineTo(this.sx(xx), py0 + ph);
        g.stroke();
      }
      for (let yy = goal.net.y0; yy <= goal.net.y1; yy += step) {
        g.beginPath();
        g.moveTo(px0, this.sy(yy));
        g.lineTo(px0 + pw, this.sy(yy));
        g.stroke();
      }
      g.strokeStyle = 'rgba(220, 235, 225, 0.5)';
      g.lineWidth = 2;
      g.strokeRect(px0, py0, pw, ph);
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

    // penalty areas (cosmetic, left/right only)
    for (const side of [-1, 1]) {
      const bx = side * hw;
      const w = 110 * s * side;
      g.strokeStyle = 'rgba(240, 248, 240, 0.45)';
      g.lineWidth = 2;
      g.strokeRect(Math.min(this.sx(bx), this.sx(bx) + w), this.sy(-150), Math.abs(w), 300 * s);
    }

    // defender-colored goal lines + posts (drawn over the border)
    for (const goal of goals) {
      g.strokeStyle = TEAMS[goal.team].color;
      g.globalAlpha = 0.85;
      g.lineWidth = 4;
      g.beginPath();
      g.moveTo(this.sx(goal.mouth.x0), this.sy(goal.mouth.y0));
      g.lineTo(this.sx(goal.mouth.x1), this.sy(goal.mouth.y1));
      g.stroke();
      g.globalAlpha = 1;
      for (const post of goal.posts) {
        g.beginPath();
        g.arc(this.sx(post.x), this.sy(post.y), pr * s, 0, Math.PI * 2);
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
      ctx.fillStyle = TEAMS[team].color;
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

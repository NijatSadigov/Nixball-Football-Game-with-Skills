import { BALL, PLAYER, TEAMS, TICK_MS, TICK_RATE } from '../shared/constants';
import { getCharacter } from '../shared/characters';
import { emptyInput, integratePlayer, type InputState } from '../shared/physics';
import type { RoomMember, RoomSettings, WireEvent, WireState } from '../shared/types';
import { Renderer, type Effect, type ViewPlayer, type ViewWorld } from './render';
import type { Sfx } from './sound';

const INTERP_DELAY = 100; // render this many ms behind the newest server data

export interface HudRefs {
  scores: HTMLElement;
  clock: HTMLElement;
  golden: HTMLElement;
  banner: HTMLElement;
  skill: HTMLElement;
  skillName: HTMLElement;
  skillCd: HTMLElement;
  spectate: HTMLElement;
}

interface TimedSnap {
  time: number; // server timeline ms (tick * TICK_MS)
  s: WireState;
}

export class GameView {
  myId = 0;
  roster = new Map<number, RoomMember>();
  settings: RoomSettings = { scoreLimit: 3, timeLimitMin: 5, maxPlayers: 8, teams: 2, hotball: false };
  localInput: InputState = emptyInput();

  private renderer: Renderer;
  private snaps: TimedSnap[] = [];
  private latest: WireState | null = null;
  private offset = 0;
  private hasOffset = false;
  private effects: Effect[] = [];
  private pred: { x: number; y: number; vx: number; vy: number } | null = null;
  private predAcc = 0;
  private lastFrame = 0;
  private raf = 0;
  private running = false;
  private bannerTimer = 0;
  private lastCd = 0; // previous skill cooldown, to detect "ready" transitions
  private pulseTimer = 0;
  private onResize = () => this.renderer.resize();

  constructor(
    canvas: HTMLCanvasElement,
    private hud: HudRefs,
    private sfx: Sfx,
  ) {
    this.renderer = new Renderer(canvas);
  }

  get isRunning(): boolean {
    return this.running;
  }

  setMyColor(color: string | null): void {
    this.renderer.myColor = color;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.renderer.resize();
    window.addEventListener('resize', this.onResize);
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    this.snaps = [];
    this.latest = null;
    this.hasOffset = false;
    this.pred = null;
    this.effects = [];
    this.lastCd = 0;
    this.setBanner('');
  }

  setRoster(members: RoomMember[], myId: number): void {
    this.myId = myId;
    this.roster = new Map(members.map((m) => [m.id, m]));
    this.renderer.setMode(this.settings.teams, this.settings.hotball);
    const me = this.roster.get(myId);
    // spectator bar
    this.hud.spectate.classList.toggle('hidden', !me || me.team !== -1);
    // skill chip
    const char = getCharacter(me?.charId ?? 'classic');
    if (me && me.team !== -1 && char.skill) {
      this.hud.skill.classList.remove('hidden');
      this.hud.skillName.textContent = char.skill.name;
    } else {
      this.hud.skill.classList.add('hidden');
    }
  }

  onState(s: WireState): void {
    const now = performance.now();
    const timeline = s.k * TICK_MS;
    const off = now - timeline;
    // EMA keeps interpolation smooth despite network jitter
    this.offset = this.hasOffset ? this.offset * 0.92 + off * 0.08 : off;
    this.hasOffset = true;
    this.snaps.push({ time: timeline, s });
    if (this.snaps.length > 40) this.snaps.splice(0, this.snaps.length - 40);
    this.latest = s;
  }

  onEvent(e: WireEvent): void {
    const now = performance.now();
    switch (e.e) {
      case 'kick': {
        const pos = this.latest ? { x: this.latest.b[0], y: this.latest.b[1] } : { x: 0, y: 0 };
        this.effects.push({ kind: 'kick', x: pos.x, y: pos.y, t0: now });
        this.sfx.kick();
        break;
      }
      case 'perfect':
        this.effects.push({ kind: 'perfect', x: e.x, y: e.y, t0: now });
        this.renderer.shake = 7;
        this.sfx.perfect();
        break;
      case 'skill': {
        const p = this.findPlayer(e.id);
        const char = getCharacter(this.roster.get(e.id)?.charId ?? 'classic');
        if (p) this.effects.push({ kind: 'burst', x: p.x, y: p.y, t0: now, color: char.color });
        this.sfx.skill();
        break;
      }
      case 'shove':
        this.effects.push({ kind: 'burst', x: e.x, y: e.y, t0: now, color: '#ff5d7e' });
        this.renderer.shake = 4;
        this.sfx.shove();
        break;
      case 'goal': {
        this.effects.push({ kind: 'goalflash', x: 0, y: 0, t0: now });
        if (e.team >= 0) this.setBanner('GOAL!', TEAMS[e.team].color, 2200);
        else this.setBanner('OWN GOAL!', 'white', 2200);
        this.sfx.goal();
        break;
      }
      case 'kickoff':
        if (typeof e.team === 'number' && e.team >= 0) {
          this.setBanner(`${TEAMS[e.team].name} kicks off`, TEAMS[e.team].color, 1700);
        } else {
          this.setBanner('');
        }
        this.pred = null;
        break;
      case 'end': {
        if (e.winner === -1) this.setBanner('DRAW', 'white', 0);
        else this.setBanner(`${TEAMS[e.winner].name.toUpperCase()} WINS!`, TEAMS[e.winner].color, 0);
        this.sfx.whistle();
        break;
      }
    }
  }

  private findPlayer(id: number): { x: number; y: number } | null {
    if (!this.latest) return null;
    const p = this.latest.p.find((w) => w[0] === id);
    return p ? { x: p[1], y: p[2] } : null;
  }

  private setBanner(text: string, color = 'white', autoHideMs = 0): void {
    clearTimeout(this.bannerTimer);
    if (!text) {
      this.hud.banner.classList.add('hidden');
      return;
    }
    this.hud.banner.textContent = text;
    this.hud.banner.style.color = color;
    this.hud.banner.classList.remove('hidden');
    if (autoHideMs > 0) {
      this.bannerTimer = window.setTimeout(() => this.hud.banner.classList.add('hidden'), autoHideMs);
    }
  }

  private interpolate(renderTime: number): ViewWorld | null {
    const snaps = this.snaps;
    if (snaps.length === 0) return null;
    if (snaps.length === 1 || renderTime <= snaps[0].time) {
      return this.worldFrom(snaps[0].s);
    }
    for (let i = snaps.length - 1; i >= 0; i--) {
      if (snaps[i].time <= renderTime) {
        const a = snaps[i];
        const b = snaps[i + 1];
        if (!b) return this.worldFrom(a.s);
        const f = Math.min(1, (renderTime - a.time) / Math.max(1, b.time - a.time));
        return this.worldLerp(a.s, b.s, f);
      }
    }
    return this.worldFrom(snaps[snaps.length - 1].s);
  }

  private worldFrom(s: WireState): ViewWorld {
    return {
      ball: { x: s.b[0], y: s.b[1] },
      players: s.p.map((w) => ({ id: w[0], x: w[1], y: w[2], vx: w[3], vy: w[4], flags: w[5], cd: w[6] })),
      ph: s.ph,
      ko: s.ko ?? -1,
    };
  }

  private worldLerp(a: WireState, b: WireState, f: number): ViewWorld {
    const lerp = (x: number, y: number) => x + (y - x) * f;
    const players: ViewPlayer[] = [];
    const bById = new Map(b.p.map((w) => [w[0], w]));
    for (const wa of a.p) {
      const wb = bById.get(wa[0]);
      if (!wb) continue; // left between snapshots
      players.push({
        id: wa[0],
        x: lerp(wa[1], wb[1]),
        y: lerp(wa[2], wb[2]),
        vx: wb[3],
        vy: wb[4],
        flags: wb[5],
        cd: wb[6],
      });
    }
    return {
      ball: { x: lerp(a.b[0], b.b[0]), y: lerp(a.b[1], b.b[1]) },
      players,
      ph: b.ph,
      ko: b.ko ?? -1,
    };
  }

  private frame = (now: number): void => {
    if (!this.running) return;
    const dt = Math.min(120, now - this.lastFrame);
    this.lastFrame = now;

    let world = this.hasOffset ? this.interpolate(now - this.offset - INTERP_DELAY) : null;
    if (!world) {
      world = { ball: { x: 0, y: 0 }, players: [], ph: 0, ko: -1 };
    }

    // client-side prediction for own disc: integrate input locally, then blend
    // toward the authoritative position so collisions stay server-decided.
    const me = world.players.find((p) => p.id === this.myId);
    if (me && world.ph === 0) {
      const charId = this.roster.get(this.myId)?.charId ?? 'classic';
      if (!this.pred) {
        this.pred = { x: me.x, y: me.y, vx: me.vx, vy: me.vy };
        this.predAcc = 0;
      }
      this.predAcc += dt;
      let steps = 0;
      while (this.predAcc >= TICK_MS && steps < 4) {
        integratePlayer(this.pred, this.localInput, charId, undefined, this.settings.teams);
        this.predAcc -= TICK_MS;
        steps++;
      }
      const err = Math.hypot(this.pred.x - me.x, this.pred.y - me.y);
      if (err > 80) {
        this.pred = { x: me.x, y: me.y, vx: me.vx, vy: me.vy };
      } else {
        const k = 0.1;
        this.pred.x += (me.x - this.pred.x) * k;
        this.pred.y += (me.y - this.pred.y) * k;
        this.pred.vx += (me.vx - this.pred.vx) * k;
        this.pred.vy += (me.vy - this.pred.vy) * k;
      }
      me.x = this.pred.x;
      me.y = this.pred.y;
    } else if (!me || world.ph !== 0) {
      this.pred = null;
    }

    // Power Shot aim helper: when my skill is armed and I'm on the ball, show
    // where a kick right now would send it.
    let aim: { x: number; y: number; dx: number; dy: number } | null = null;
    if (me && (me.flags & 2) !== 0) {
      const char = getCharacter(this.roster.get(this.myId)?.charId ?? 'classic');
      if (char.skill?.id === 'powershot') {
        const adx = world.ball.x - me.x;
        const ady = world.ball.y - me.y;
        const ad = Math.hypot(adx, ady);
        // powered kicks reach 8px farther, plus a little margin so the arrow
        // appears slightly before contact
        if (ad > 1e-6 && ad <= char.radius + BALL.radius + PLAYER.kickRange + 22) {
          aim = { x: world.ball.x, y: world.ball.y, dx: adx / ad, dy: ady / ad };
        }
      }
    }

    this.effects = this.effects.filter((ef) => now - ef.t0 < 1600);
    this.renderer.draw(world, this.roster, this.myId, this.localInput.kick, this.effects, now, aim);
    this.updateHud(world);

    this.raf = requestAnimationFrame(this.frame);
  };

  private updateHud(world: ViewWorld): void {
    const s = this.latest;
    if (!s) return;
    if (this.hud.scores.childElementCount !== s.s.length) {
      this.hud.scores.innerHTML = '';
      for (let i = 0; i < s.s.length; i++) {
        const span = document.createElement('span');
        span.className = 'score';
        span.style.color = TEAMS[i].color;
        this.hud.scores.appendChild(span);
      }
    }
    for (let i = 0; i < s.s.length; i++) {
      (this.hud.scores.children[i] as HTMLElement).textContent = String(s.s[i]);
    }
    this.hud.golden.classList.toggle('hidden', s.g !== 1);

    const limitTicks = this.settings.timeLimitMin * 60 * TICK_RATE;
    const secs =
      limitTicks > 0
        ? Math.max(0, Math.ceil((limitTicks - s.c) / TICK_RATE))
        : Math.floor(s.c / TICK_RATE);
    const mm = Math.floor(secs / 60);
    const ss = String(secs % 60).padStart(2, '0');
    this.hud.clock.textContent = `${mm}:${ss}`;

    // skill cooldown for my player
    const me = world.players.find((p) => p.id === this.myId);
    const char = getCharacter(this.roster.get(this.myId)?.charId ?? 'classic');
    if (me && char.skill) {
      const frac = 1 - Math.min(1, me.cd / char.skill.cooldown);
      this.hud.skillCd.style.width = `${Math.round(frac * 100)}%`;
      const armed = (me.flags & 2) !== 0;
      const ready = me.cd === 0 && !armed;
      // ping + pulse the chip the moment the skill comes off cooldown
      if (ready && this.lastCd > 0) {
        this.hud.skill.classList.add('pulse');
        clearTimeout(this.pulseTimer);
        this.pulseTimer = window.setTimeout(() => this.hud.skill.classList.remove('pulse'), 700);
        this.sfx.ready();
      }
      this.lastCd = me.cd;
      this.hud.skill.classList.toggle('ready', ready);
      this.hud.skill.classList.toggle('armed', armed);
      this.hud.skillName.textContent = armed ? `${char.skill.name} — ARMED` : char.skill.name;
    }
  }
}

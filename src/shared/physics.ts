// Authoritative match simulation. Pure data + step function so the server can
// run it and the client can reuse pieces (movement integration) for prediction.

import { BALL, FIELD, KICKOFF_PAUSE_TICKS, PERFECT, PLAYER } from './constants';
import { getCharacter } from './characters';

export interface InputState {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  kick: boolean;
}

export function emptyInput(): InputState {
  return { up: false, down: false, left: false, right: false, kick: false };
}

export interface Disc {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface SimPlayer extends Disc {
  id: number;
  team: 0 | 1;
  charId: string;
  input: InputState;
  kickPressTick: number; // tick of the most recent kick press (rising edge)
  kickConsumedTick: number; // press tick already spent on a kick
  kickCooldownUntil: number;
  skillCooldownUntil: number;
  skillActiveUntil: number;
  pendingSkill: boolean;
}

export type SimEvent =
  | { kind: 'kick'; id: number }
  | { kind: 'perfect'; id: number; x: number; y: number; speed: number }
  | { kind: 'skill'; id: number; skill: string }
  | { kind: 'shove'; id: number; x: number; y: number }
  | { kind: 'goal'; team: 0 | 1 }
  | { kind: 'end'; winner: 0 | 1 | -1 }
  | { kind: 'kickoff' };

export interface SimState {
  tick: number;
  phase: 0 | 1 | 2; // 0 play, 1 goal pause, 2 over
  phaseUntil: number;
  clock: number; // elapsed play ticks (paused during goal pause)
  golden: boolean;
  score: [number, number];
  ball: Disc;
  players: SimPlayer[];
}

export interface MatchConfig {
  scoreLimit: number;
  timeLimitTicks: number;
}

const POSTS = [
  { x: -FIELD.halfW, y: -FIELD.goalHalf },
  { x: -FIELD.halfW, y: FIELD.goalHalf },
  { x: FIELD.halfW, y: -FIELD.goalHalf },
  { x: FIELD.halfW, y: FIELD.goalHalf },
];

export function createPlayer(id: number, team: 0 | 1, charId: string): SimPlayer {
  return {
    id,
    team,
    charId,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    input: emptyInput(),
    kickPressTick: -1,
    kickConsumedTick: -1,
    kickCooldownUntil: 0,
    skillCooldownUntil: 0,
    skillActiveUntil: 0,
    pendingSkill: false,
  };
}

export function createMatch(
  roster: { id: number; team: 0 | 1; charId: string }[],
): SimState {
  const state: SimState = {
    tick: 0,
    phase: 0,
    phaseUntil: 0,
    clock: 0,
    golden: false,
    score: [0, 0],
    ball: { x: 0, y: 0, vx: 0, vy: 0 },
    players: roster.map((r) => createPlayer(r.id, r.team, r.charId)),
  };
  placeKickoff(state);
  return state;
}

export function placeKickoff(state: SimState): void {
  state.ball = { x: 0, y: 0, vx: 0, vy: 0 };
  for (const team of [0, 1] as const) {
    const list = state.players.filter((p) => p.team === team);
    const side = team === 0 ? -1 : 1;
    const spacing = Math.min(70, (FIELD.halfH * 2 - 60) / Math.max(1, list.length - 1));
    list.forEach((p, i) => {
      p.x = side * 170;
      p.y = (i - (list.length - 1) / 2) * spacing;
      p.vx = 0;
      p.vy = 0;
      p.kickCooldownUntil = state.tick + 10;
    });
  }
}

export function addPlayerToSim(
  state: SimState,
  id: number,
  team: 0 | 1,
  charId: string,
): SimPlayer {
  const p = createPlayer(id, team, charId);
  const side = team === 0 ? -1 : 1;
  const teammates = state.players.filter((q) => q.team === team).length;
  p.x = side * (FIELD.halfW * 0.6);
  p.y = ((teammates % 5) - 2) * 60;
  state.players.push(p);
  return p;
}

export function removePlayerFromSim(state: SimState, id: number): void {
  const i = state.players.findIndex((p) => p.id === id);
  if (i >= 0) state.players.splice(i, 1);
}

function playerInvMass(p: SimPlayer, tick: number): number {
  const c = getCharacter(p.charId);
  if (c.skill?.id === 'fortress' && tick < p.skillActiveUntil) return c.skill.magnitude;
  return c.invMass;
}

// Fortress also doubles the disc while active.
export function playerRadius(p: SimPlayer, tick: number): number {
  const c = getCharacter(p.charId);
  if (c.skill?.id === 'fortress' && tick < p.skillActiveUntil) return c.radius * 2;
  return c.radius;
}

// Impulse + positional correction between two dynamic discs.
function collide(
  a: Disc,
  b: Disc,
  ra: number,
  rb: number,
  ia: number,
  ib: number,
  e: number,
): void {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  let d = Math.hypot(dx, dy);
  const min = ra + rb;
  if (d >= min) return;
  if (d < 1e-6) {
    dx = 1;
    dy = 0;
    d = 1;
  }
  const nx = dx / d;
  const ny = dy / d;
  const total = ia + ib;
  if (total <= 0) return;
  const overlap = min - d;
  a.x -= nx * overlap * (ia / total);
  a.y -= ny * overlap * (ia / total);
  b.x += nx * overlap * (ib / total);
  b.y += ny * overlap * (ib / total);
  const rv = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (rv < 0) {
    const j = (-(1 + e) * rv) / total;
    a.vx -= nx * j * ia;
    a.vy -= ny * j * ia;
    b.vx += nx * j * ib;
    b.vy += ny * j * ib;
  }
}

// Collision against an immovable circle (goal posts).
function collideStatic(d: Disc, r: number, px: number, py: number, pr: number, e: number): void {
  let dx = d.x - px;
  let dy = d.y - py;
  let dist = Math.hypot(dx, dy);
  const min = r + pr;
  if (dist >= min) return;
  if (dist < 1e-6) {
    dx = 1;
    dy = 0;
    dist = 1;
  }
  const nx = dx / dist;
  const ny = dy / dist;
  d.x = px + nx * min;
  d.y = py + ny * min;
  const vn = d.vx * nx + d.vy * ny;
  if (vn < 0) {
    d.vx -= (1 + e) * vn * nx;
    d.vy -= (1 + e) * vn * ny;
  }
}

function ballWalls(b: Disc): void {
  const r = BALL.radius;
  const { halfW: hw, halfH: hh, goalHalf: gh, goalDepth: gd } = FIELD;
  const e = FIELD.wallRestitution;
  const en = FIELD.netRestitution;
  if (Math.abs(b.x) <= hw) {
    // top/bottom touchlines
    if (b.y > hh - r) {
      b.y = hh - r;
      if (b.vy > 0) b.vy = -b.vy * e;
    }
    if (b.y < -hh + r) {
      b.y = -hh + r;
      if (b.vy < 0) b.vy = -b.vy * e;
    }
  } else {
    // inside a goal: net side walls and back of the net
    if (b.y > gh - r) {
      b.y = gh - r;
      if (b.vy > 0) b.vy = -b.vy * en;
    }
    if (b.y < -gh + r) {
      b.y = -gh + r;
      if (b.vy < 0) b.vy = -b.vy * en;
    }
    if (b.x > hw + gd - r) {
      b.x = hw + gd - r;
      if (b.vx > 0) b.vx = -b.vx * en;
    }
    if (b.x < -hw - gd + r) {
      b.x = -hw - gd + r;
      if (b.vx < 0) b.vx = -b.vx * en;
    }
  }
  // goal lines outside the mouth are solid walls
  if (Math.abs(b.y) >= gh) {
    if (b.x > hw - r && b.x <= hw + 4) {
      b.x = hw - r;
      if (b.vx > 0) b.vx = -b.vx * e;
    }
    if (b.x < -hw + r && b.x >= -hw - 4) {
      b.x = -hw + r;
      if (b.vx < 0) b.vx = -b.vx * e;
    }
  }
}

function playerBounds(p: Disc, r: number): void {
  const mx = FIELD.halfW + FIELD.playerMargin;
  const my = FIELD.halfH + FIELD.playerMargin;
  if (p.x > mx - r) {
    p.x = mx - r;
    if (p.vx > 0) p.vx = 0;
  }
  if (p.x < -mx + r) {
    p.x = -mx + r;
    if (p.vx < 0) p.vx = 0;
  }
  if (p.y > my - r) {
    p.y = my - r;
    if (p.vy > 0) p.vy = 0;
  }
  if (p.y < -my + r) {
    p.y = -my + r;
    if (p.vy < 0) p.vy = 0;
  }
}

// Movement integration for one player. Also used by the client to predict its
// own disc (collisions are ignored there; the server stays authoritative).
export function integratePlayer(p: Disc, input: InputState, charId: string, radius?: number): void {
  const c = getCharacter(charId);
  let ax = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  let ay = (input.down ? 1 : 0) - (input.up ? 1 : 0);
  if (ax !== 0 || ay !== 0) {
    const n = Math.hypot(ax, ay);
    ax /= n;
    ay /= n;
  }
  const a = c.accel * (input.kick ? PLAYER.kickAccelFactor : 1);
  p.vx = (p.vx + ax * a) * PLAYER.damping;
  p.vy = (p.vy + ay * a) * PLAYER.damping;
  p.x += p.vx;
  p.y += p.vy;
  playerBounds(p, radius ?? c.radius);
}

function scoreGoal(state: SimState, team: 0 | 1, events: SimEvent[]): void {
  state.score[team]++;
  state.phase = 1;
  state.phaseUntil = state.tick + KICKOFF_PAUSE_TICKS;
  events.push({ kind: 'goal', team });
}

export function stepMatch(
  state: SimState,
  cfg: MatchConfig,
  rng: () => number,
): SimEvent[] {
  state.tick++;
  const t = state.tick;
  const events: SimEvent[] = [];
  const b = state.ball;

  // --- skill activation ---
  for (const p of state.players) {
    if (!p.pendingSkill) continue;
    p.pendingSkill = false;
    const c = getCharacter(p.charId);
    if (!c.skill || t < p.skillCooldownUntil || state.phase === 2) continue;
    p.skillCooldownUntil = t + c.skill.cooldown;
    if (c.skill.id === 'dash') {
      let dx = (p.input.right ? 1 : 0) - (p.input.left ? 1 : 0);
      let dy = (p.input.down ? 1 : 0) - (p.input.up ? 1 : 0);
      if (dx === 0 && dy === 0) {
        const sp = Math.hypot(p.vx, p.vy);
        if (sp > 0.1) {
          dx = p.vx / sp;
          dy = p.vy / sp;
        } else {
          dx = p.team === 0 ? 1 : -1; // default: toward the enemy goal
        }
      } else {
        const n = Math.hypot(dx, dy);
        dx /= n;
        dy /= n;
      }
      p.vx += dx * c.skill.magnitude;
      p.vy += dy * c.skill.magnitude;
    } else {
      p.skillActiveUntil = t + c.skill.duration;
    }
    events.push({ kind: 'skill', id: p.id, skill: c.skill.id });
  }

  // --- movement ---
  for (const p of state.players) {
    integratePlayer(p, p.input, p.charId, playerRadius(p, t));
  }

  // --- ball ---
  b.vx *= BALL.damping;
  b.vy *= BALL.damping;
  b.x += b.vx;
  b.y += b.vy;

  // --- magnet: attract the ball, hold it when close ---
  for (const p of state.players) {
    const c = getCharacter(p.charId);
    if (c.skill?.id !== 'magnet' || t >= p.skillActiveUntil) continue;
    const pr = playerRadius(p, t);
    const dx = b.x - p.x;
    const dy = b.y - p.y;
    const d = Math.hypot(dx, dy);
    const radius = c.skill.magnitude;
    if (d > radius || d < 1e-6) continue;
    const nx = dx / d;
    const ny = dy / d;
    if (d <= pr + BALL.radius + 8) {
      // held: the ball travels with the player, parked just outside the disc
      b.vx = p.vx;
      b.vy = p.vy;
      const ax = p.x + nx * (pr + BALL.radius + 1);
      const ay = p.y + ny * (pr + BALL.radius + 1);
      b.x += (ax - b.x) * 0.35;
      b.y += (ay - b.y) * 0.35;
    } else {
      const pull = 0.5 * (1 - d / radius) + 0.12;
      b.vx -= nx * pull;
      b.vy -= ny * pull;
    }
  }

  // --- kicks ---
  // Resolved BEFORE ball-player collisions so the perfect-return check sees
  // the ball's true approach speed; otherwise the body bounce on the contact
  // tick would cancel most of it.
  for (const p of state.players) {
    if (!p.input.kick || t < p.kickCooldownUntil) continue;
    const c = getCharacter(p.charId);
    const pr = playerRadius(p, t);
    const dx = b.x - p.x;
    const dy = b.y - p.y;
    const d = Math.hypot(dx, dy);
    const ballInRange = d <= pr + BALL.radius + PLAYER.kickRange;

    // Bodycheck: an armed shove launches nearby opponents on the kick.
    let shoved = false;
    if (c.skill?.id === 'shove' && t < p.skillActiveUntil) {
      for (const q of state.players) {
        if (q.team === p.team) continue;
        const qx = q.x - p.x;
        const qy = q.y - p.y;
        const qd = Math.hypot(qx, qy);
        if (qd > pr + playerRadius(q, t) + PLAYER.kickRange + 8) continue;
        const nqx = qd > 1e-6 ? qx / qd : 1;
        const nqy = qd > 1e-6 ? qy / qd : 0;
        q.vx += nqx * c.skill.magnitude;
        q.vy += nqy * c.skill.magnitude;
        shoved = true;
      }
      if (shoved) {
        p.skillActiveUntil = 0; // bodycheck is spent
        events.push({ kind: 'shove', id: p.id, x: p.x, y: p.y });
      }
    }

    if (!ballInRange) {
      if (shoved) {
        p.kickConsumedTick = Math.max(p.kickPressTick, p.kickConsumedTick);
        p.kickCooldownUntil = t + PLAYER.kickCooldownTicks;
      }
      continue;
    }
    const nx = d > 1e-6 ? dx / d : p.team === 0 ? 1 : -1;
    const ny = d > 1e-6 ? dy / d : 0;

    const powered = c.skill?.id === 'powershot' && t < p.skillActiveUntil;
    const fresh =
      p.kickPressTick > p.kickConsumedTick && t - p.kickPressTick <= PERFECT.windowTicks;
    // approach speed: how fast the ball is closing in on the player
    const approach = -((b.vx - p.vx) * nx + (b.vy - p.vy) * ny);

    if (fresh && approach >= PERFECT.minApproach) {
      // PERFECT RETURN: well-timed press on a fast incoming ball.
      // The ball is sent back hard, with a slightly random direction.
      let out = Math.min(PERFECT.base + approach * PERFECT.factor, PERFECT.maxSpeed);
      if (powered) out = Math.min(out * 1.15, PERFECT.maxSpeed + 1);
      const ang = (rng() * 2 - 1) * PERFECT.jitterRad;
      const cos = Math.cos(ang);
      const sin = Math.sin(ang);
      b.vx = (nx * cos - ny * sin) * out;
      b.vy = (nx * sin + ny * cos) * out;
      events.push({ kind: 'perfect', id: p.id, x: b.x, y: b.y, speed: out });
    } else {
      const strength = c.kickStrength * (powered ? c.skill!.magnitude : 1);
      b.vx += nx * strength;
      b.vy += ny * strength;
      events.push({ kind: 'kick', id: p.id });
    }
    p.kickConsumedTick = Math.max(p.kickPressTick, p.kickConsumedTick);
    p.kickCooldownUntil = t + PLAYER.kickCooldownTicks;
    if (powered) p.skillActiveUntil = 0; // power shot is spent on one kick
    // kicking a magnet-held ball releases it
    if (c.skill?.id === 'magnet' && t < p.skillActiveUntil) p.skillActiveUntil = 0;
  }

  // --- collisions ---
  for (let i = 0; i < state.players.length; i++) {
    for (let j = i + 1; j < state.players.length; j++) {
      const a = state.players[i];
      const q = state.players[j];
      collide(
        a,
        q,
        playerRadius(a, t),
        playerRadius(q, t),
        playerInvMass(a, t),
        playerInvMass(q, t),
        PLAYER.restitution,
      );
    }
  }
  for (const p of state.players) {
    collide(p, b, playerRadius(p, t), BALL.radius, playerInvMass(p, t), BALL.invMass, 0.5);
  }
  for (const post of POSTS) {
    collideStatic(b, BALL.radius, post.x, post.y, FIELD.postRadius, 0.5);
    for (const p of state.players) {
      collideStatic(p, playerRadius(p, t), post.x, post.y, FIELD.postRadius, 0.5);
    }
  }
  ballWalls(b);
  for (const p of state.players) {
    playerBounds(p, playerRadius(p, t));
  }

  // --- goals ---
  if (state.phase === 0) {
    if (Math.abs(b.y) < FIELD.goalHalf) {
      if (b.x > FIELD.halfW + BALL.radius) scoreGoal(state, 0, events);
      else if (b.x < -FIELD.halfW - BALL.radius) scoreGoal(state, 1, events);
    }
  }

  // --- clock and phase transitions ---
  if (state.phase === 0) {
    state.clock++;
    if (!state.golden && cfg.timeLimitTicks > 0 && state.clock >= cfg.timeLimitTicks) {
      if (state.score[0] !== state.score[1]) {
        state.phase = 2;
        events.push({ kind: 'end', winner: state.score[0] > state.score[1] ? 0 : 1 });
      } else {
        state.golden = true; // sudden death: next goal wins
      }
    }
  } else if (state.phase === 1 && t >= state.phaseUntil) {
    const scoreReached =
      cfg.scoreLimit > 0 &&
      (state.score[0] >= cfg.scoreLimit || state.score[1] >= cfg.scoreLimit);
    const goldenDecided = state.golden && state.score[0] !== state.score[1];
    if (scoreReached || goldenDecided) {
      state.phase = 2;
      events.push({ kind: 'end', winner: state.score[0] > state.score[1] ? 0 : 1 });
    } else {
      placeKickoff(state);
      state.phase = 0;
      events.push({ kind: 'kickoff' });
    }
  }

  return events;
}

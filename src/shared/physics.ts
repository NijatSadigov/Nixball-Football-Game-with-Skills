// Authoritative match simulation. Pure data + step function so the server can
// run it and the client can reuse pieces (movement integration) for prediction.
//
// Maps are geometry-driven: 2 teams play on the classic rectangle, 3 teams on
// an equilateral triangle, 4 teams on a square — one goal per side, owned by
// the team listed in `Geometry.goals`. Walls only block the BALL (players roam
// the whole arena, like Haxball); posts block everyone.
//
// Scoring: with 2 teams the opponent scores. With 3+ teams the last team that
// touched the ball scores (+1) and the conceding team LOSES a point (-1); own
// goals credit nobody but still cost the conceder.
//
// Kickoff: after a goal the conceding team restarts — everyone else is held
// outside KICKOFF_BARRIER until the ball is touched.

import { BALL, FIELD, KICKOFF_BARRIER, KICKOFF_PAUSE_TICKS, PERFECT, PLAYER } from './constants';
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
  team: number; // 0..3
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
  | { kind: 'goal'; team: number } // scoring team; -1 = own goal, nobody credited
  | { kind: 'end'; winner: number } // -1 = draw / stopped
  | { kind: 'kickoff'; team: number }; // team that restarts; -1 = free

export interface SimState {
  tick: number;
  phase: 0 | 1 | 2; // 0 play, 1 goal pause, 2 over
  phaseUntil: number;
  clock: number; // elapsed play ticks (paused during goal pause)
  golden: boolean;
  goldenWinner: number; // team that scored during golden goal, -1 = none yet
  teams: number; // 2, 3 or 4
  lastTouchTeam: number; // last team to touch the ball, -1 = nobody yet
  prevTouchTeam: number; // the different team that touched it before that
  kickoffTeam: number; // team with kickoff possession, -1 = free play
  nextKickoffTeam: number; // who restarts after the current goal pause
  score: number[]; // one entry per team
  ball: Disc;
  players: SimPlayer[];
}

export interface MatchConfig {
  scoreLimit: number;
  timeLimitTicks: number;
  hotball?: boolean; // the ball fires itself off any touch
}

// ---------------------------------------------------------------------------
// Arena geometry
// ---------------------------------------------------------------------------

export interface Point {
  x: number;
  y: number;
}

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  e: number; // restitution
}

export interface GoalGeom {
  team: number;
  cx: number; // mouth center on the goal line
  cy: number;
  ux: number; // unit vector along the line
  uy: number;
  nx: number; // outward normal
  ny: number;
  mouthHalf: number;
  depth: number;
  posts: Point[];
  netPoly: Point[]; // [e1, e1+n*d, e2+n*d, e2] for rendering
}

export interface Geometry {
  teams: number;
  pitch: Point[]; // pitch polygon
  walls: Segment[]; // ball-blocking segments
  goals: GoalGeom[];
  minX: number; // player roam limits (margin included)
  maxX: number;
  minY: number;
  maxY: number;
  viewCx: number; // world point the camera centers on
  viewCy: number;
  viewX: number; // view half-extents
  viewY: number;
}

function buildSide(
  a: Point,
  b: Point,
  team: number | null,
  walls: Segment[],
  goals: GoalGeom[],
): void {
  const wallE = FIELD.wallRestitution;
  const netE = FIELD.netRestitution;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  if (team === null) {
    walls.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, e: wallE });
    return;
  }
  // outward normal: perpendicular pointing away from the arena center (origin)
  let nx = uy;
  let ny = -ux;
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  if (nx * mx + ny * my < 0) {
    nx = -nx;
    ny = -ny;
  }
  const mh = FIELD.goalHalf;
  const d = FIELD.goalDepth;
  const e1: Point = { x: mx - ux * mh, y: my - uy * mh };
  const e2: Point = { x: mx + ux * mh, y: my + uy * mh };
  const d1: Point = { x: e1.x + nx * d, y: e1.y + ny * d };
  const d2: Point = { x: e2.x + nx * d, y: e2.y + ny * d };
  walls.push({ x1: a.x, y1: a.y, x2: e1.x, y2: e1.y, e: wallE });
  walls.push({ x1: e2.x, y1: e2.y, x2: b.x, y2: b.y, e: wallE });
  walls.push({ x1: e1.x, y1: e1.y, x2: d1.x, y2: d1.y, e: netE });
  walls.push({ x1: e2.x, y1: e2.y, x2: d2.x, y2: d2.y, e: netE });
  walls.push({ x1: d1.x, y1: d1.y, x2: d2.x, y2: d2.y, e: netE });
  goals.push({
    team,
    cx: mx,
    cy: my,
    ux,
    uy,
    nx,
    ny,
    mouthHalf: mh,
    depth: d,
    posts: [e1, e2],
    netPoly: [e1, d1, d2, e2],
  });
}

const geomCache = new Map<number, Geometry>();

export function getGeometry(teams: number): Geometry {
  const cached = geomCache.get(teams);
  if (cached) return cached;

  const walls: Segment[] = [];
  const goals: GoalGeom[] = [];
  let pitch: Point[];

  if (teams === 3) {
    // equilateral triangle: apex up, goals mid-side
    // team 0 = upper-left side, team 1 = upper-right side, team 2 = bottom
    const ri = 208; // inradius
    const half = ri * Math.sqrt(3); // half side length
    const v0: Point = { x: 0, y: -2 * ri }; // apex
    const v1: Point = { x: half, y: ri }; // bottom-right
    const v2: Point = { x: -half, y: ri }; // bottom-left
    pitch = [v0, v1, v2];
    buildSide(v2, v0, 0, walls, goals); // left side
    buildSide(v0, v1, 1, walls, goals); // right side
    buildSide(v1, v2, 2, walls, goals); // bottom side
  } else if (teams === 4) {
    // square, one goal per side: 0 left, 1 right, 2 top, 3 bottom
    const s = 310;
    const tl: Point = { x: -s, y: -s };
    const tr: Point = { x: s, y: -s };
    const br: Point = { x: s, y: s };
    const bl: Point = { x: -s, y: s };
    pitch = [tl, tr, br, bl];
    buildSide(bl, tl, 0, walls, goals);
    buildSide(tr, br, 1, walls, goals);
    buildSide(tl, tr, 2, walls, goals);
    buildSide(br, bl, 3, walls, goals);
  } else {
    // classic rectangle, goals left/right
    const hw = FIELD.halfW;
    const hh = FIELD.halfH;
    const tl: Point = { x: -hw, y: -hh };
    const tr: Point = { x: hw, y: -hh };
    const br: Point = { x: hw, y: hh };
    const bl: Point = { x: -hw, y: hh };
    pitch = [tl, tr, br, bl];
    buildSide(bl, tl, 0, walls, goals);
    buildSide(tr, br, 1, walls, goals);
    buildSide(tl, tr, null, walls, goals);
    buildSide(br, bl, null, walls, goals);
  }

  // bounding box over pitch + nets
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const consider = (p: Point) => {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  };
  pitch.forEach(consider);
  for (const g of goals) g.netPoly.forEach(consider);

  const m = FIELD.playerMargin;
  const geom: Geometry = {
    teams,
    pitch,
    walls,
    goals,
    minX: minX - m,
    maxX: maxX + m,
    minY: minY - m,
    maxY: maxY + m,
    viewCx: (minX + maxX) / 2,
    viewCy: (minY + maxY) / 2,
    viewX: (maxX - minX) / 2 + 45,
    viewY: (maxY - minY) / 2 + 45,
  };
  geomCache.set(teams, geom);
  return geom;
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

export function createPlayer(id: number, team: number, charId: string): SimPlayer {
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
  roster: { id: number; team: number; charId: string }[],
  teams = 2,
  kickoffTeam = -1,
): SimState {
  const state: SimState = {
    tick: 0,
    phase: 0,
    phaseUntil: 0,
    clock: 0,
    golden: false,
    goldenWinner: -1,
    teams,
    lastTouchTeam: -1,
    prevTouchTeam: -1,
    kickoffTeam: -1,
    nextKickoffTeam: -1,
    score: new Array(teams).fill(0),
    ball: { x: 0, y: 0, vx: 0, vy: 0 },
    players: roster.map((r) => createPlayer(r.id, r.team, r.charId)),
  };
  placeKickoff(state, kickoffTeam);
  return state;
}

// Base spawn point for a team: between the arena center and their own goal.
function teamSpot(geom: Geometry, team: number): { bx: number; by: number; ux: number; uy: number } {
  const goal = geom.goals.find((g) => g.team === team) ?? geom.goals[0];
  const lineDist = goal.cx * goal.nx + goal.cy * goal.ny; // distance of goal line from center
  return {
    bx: goal.cx - goal.nx * lineDist * 0.55,
    by: goal.cy - goal.ny * lineDist * 0.55,
    ux: goal.ux,
    uy: goal.uy,
  };
}

// Remember which teams touched the ball (for goal attribution). Keeps the
// last two DISTINCT teams so panic own-goals still credit the attacker.
function noteTouch(state: SimState, team: number): void {
  if (team === state.lastTouchTeam) return;
  state.prevTouchTeam = state.lastTouchTeam;
  state.lastTouchTeam = team;
}

export function placeKickoff(state: SimState, kickoffTeam = -1): void {
  state.ball = { x: 0, y: 0, vx: 0, vy: 0 };
  state.lastTouchTeam = -1;
  state.prevTouchTeam = -1;
  state.kickoffTeam = kickoffTeam;
  const geom = getGeometry(state.teams);
  for (let team = 0; team < state.teams; team++) {
    const list = state.players.filter((p) => p.team === team);
    const spot = teamSpot(geom, team);
    list.forEach((p, i) => {
      const off = (i - (list.length - 1) / 2) * 60;
      p.x = spot.bx + spot.ux * off;
      p.y = spot.by + spot.uy * off;
      p.vx = 0;
      p.vy = 0;
      p.kickCooldownUntil = state.tick + 10;
    });
  }
}

export function addPlayerToSim(
  state: SimState,
  id: number,
  team: number,
  charId: string,
): SimPlayer {
  const p = createPlayer(id, team, charId);
  const geom = getGeometry(state.teams);
  const spot = teamSpot(geom, team);
  const teammates = state.players.filter((q) => q.team === team).length;
  const off = ((teammates % 5) - 2) * 60;
  p.x = spot.bx + spot.ux * off;
  p.y = spot.by + spot.uy * off;
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

// ---------------------------------------------------------------------------
// Collision primitives
// ---------------------------------------------------------------------------

// Impulse + positional correction between two dynamic discs.
function collide(
  a: Disc,
  b: Disc,
  ra: number,
  rb: number,
  ia: number,
  ib: number,
  e: number,
): boolean {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  let d = Math.hypot(dx, dy);
  const min = ra + rb;
  if (d >= min) return false;
  if (d < 1e-6) {
    dx = 1;
    dy = 0;
    d = 1;
  }
  const nx = dx / d;
  const ny = dy / d;
  const total = ia + ib;
  if (total <= 0) return false;
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
  return true;
}

// Ball vs player, Haxball-style. The player resists the ball (its inverse mass
// is scaled down) so the ball barely shoves players, and the restitution ramps
// in with the approach speed — slow touches settle/dribble the ball, only a
// fast ball bumps off. Returns true on contact.
function collideBallPlayer(p: SimPlayer, b: Disc, pr: number, pInvMass: number): boolean {
  let dx = b.x - p.x;
  let dy = b.y - p.y;
  let d = Math.hypot(dx, dy);
  const min = pr + BALL.radius;
  if (d >= min) return false;
  if (d < 1e-6) {
    dx = 1;
    dy = 0;
    d = 1;
  }
  const nx = dx / d;
  const ny = dy / d;
  const ia = pInvMass * BALL.playerResist;
  const ib = BALL.invMass;
  const total = ia + ib;
  if (total <= 0) return false;
  const overlap = min - d;
  p.x -= nx * overlap * (ia / total);
  p.y -= ny * overlap * (ia / total);
  b.x += nx * overlap * (ib / total);
  b.y += ny * overlap * (ib / total);
  const rv = (b.vx - p.vx) * nx + (b.vy - p.vy) * ny;
  if (rv < 0) {
    const speed = -rv;
    const ramp = Math.min(
      1,
      Math.max(0, (speed - BALL.bumpMinSpeed) / (BALL.bumpMaxSpeed - BALL.bumpMinSpeed)),
    );
    const e = BALL.bumpRestitution * ramp;
    const j = (-(1 + e) * rv) / total;
    p.vx -= nx * j * ia;
    p.vy -= ny * j * ia;
    b.vx += nx * j * ib;
    b.vy += ny * j * ib;
  }
  return true;
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

// Collision against a wall segment (ball only).
function collideSegment(b: Disc, r: number, seg: Segment): void {
  const dx = seg.x2 - seg.x1;
  const dy = seg.y2 - seg.y1;
  const len2 = dx * dx + dy * dy;
  let t = ((b.x - seg.x1) * dx + (b.y - seg.y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = seg.x1 + t * dx;
  const cy = seg.y1 + t * dy;
  let vx = b.x - cx;
  let vy = b.y - cy;
  let d = Math.hypot(vx, vy);
  if (d >= r) return;
  if (d < 1e-6) {
    // dead center on the line: push along the segment normal
    const len = Math.sqrt(len2);
    vx = -dy / len;
    vy = dx / len;
    d = 1;
  } else {
    vx /= d;
    vy /= d;
  }
  b.x = cx + vx * r;
  b.y = cy + vy * r;
  const vn = b.vx * vx + b.vy * vy;
  if (vn < 0) {
    b.vx -= (1 + seg.e) * vn * vx;
    b.vy -= (1 + seg.e) * vn * vy;
  }
}

function playerBounds(p: Disc, r: number, geom: Geometry): void {
  if (p.x > geom.maxX - r) {
    p.x = geom.maxX - r;
    if (p.vx > 0) p.vx = 0;
  }
  if (p.x < geom.minX + r) {
    p.x = geom.minX + r;
    if (p.vx < 0) p.vx = 0;
  }
  if (p.y > geom.maxY - r) {
    p.y = geom.maxY - r;
    if (p.vy > 0) p.vy = 0;
  }
  if (p.y < geom.minY + r) {
    p.y = geom.minY + r;
    if (p.vy < 0) p.vy = 0;
  }
}

// Movement integration for one player. Also used by the client to predict its
// own disc (collisions are ignored there; the server stays authoritative).
export function integratePlayer(
  p: Disc,
  input: InputState,
  charId: string,
  radius?: number,
  teams = 2,
): void {
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
  playerBounds(p, radius ?? c.radius, getGeometry(teams));
}

// Goal against `conceding`. With 2 teams the other team scores; with 3+ teams
// the last toucher scores (+1) and the conceder loses a point (-1). If the
// conceder touched it last (own goal), the previous toucher is credited so
// deliberately own-goaling can't deny the attacker.
function scoreGoal(state: SimState, conceding: number, events: SimEvent[]): void {
  let scorer = -1;
  if (state.teams === 2) {
    scorer = conceding === 0 ? 1 : 0;
  } else if (state.lastTouchTeam >= 0 && state.lastTouchTeam !== conceding) {
    scorer = state.lastTouchTeam;
  } else if (state.prevTouchTeam >= 0 && state.prevTouchTeam !== conceding) {
    scorer = state.prevTouchTeam;
  }
  if (scorer >= 0) {
    state.score[scorer]++;
    if (state.golden) state.goldenWinner = scorer;
  }
  if (state.teams > 2) state.score[conceding]--;
  state.nextKickoffTeam = conceding;
  state.phase = 1;
  state.phaseUntil = state.tick + KICKOFF_PAUSE_TICKS;
  events.push({ kind: 'goal', team: scorer });
}

function leaders(score: number[]): number[] {
  const max = Math.max(...score);
  return score.reduce<number[]>((acc, s, i) => (s === max ? [...acc, i] : acc), []);
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
  const geom = getGeometry(state.teams);

  // --- armed skills (powershot, shove): expire unused -> cooldown starts now ---
  for (const p of state.players) {
    const sk = getCharacter(p.charId).skill;
    if (!sk || (sk.id !== 'powershot' && sk.id !== 'shove')) continue;
    if (p.skillActiveUntil > 0 && t >= p.skillActiveUntil) {
      p.skillActiveUntil = 0;
      p.skillCooldownUntil = t + sk.cooldown;
    }
  }

  // --- skill activation ---
  for (const p of state.players) {
    if (!p.pendingSkill) continue;
    p.pendingSkill = false;
    const c = getCharacter(p.charId);
    if (!c.skill || t < p.skillCooldownUntil || state.phase === 2) continue;
    const isArmed = c.skill.id === 'powershot' || c.skill.id === 'shove';
    if (isArmed) {
      // cooldown is deferred until the skill is spent or expires
      if (t < p.skillActiveUntil) continue; // already armed
      p.skillActiveUntil = t + c.skill.duration;
      events.push({ kind: 'skill', id: p.id, skill: c.skill.id });
      continue;
    }
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
          // default: from your own goal toward the center
          const goal = geom.goals.find((g) => g.team === p.team);
          if (goal) {
            dx = -goal.nx;
            dy = -goal.ny;
          } else {
            dx = 1;
          }
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
    integratePlayer(p, p.input, p.charId, playerRadius(p, t), state.teams);
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
    // no magnet shenanigans against a kickoff you don't own
    if (state.kickoffTeam >= 0 && p.team !== state.kickoffTeam) continue;
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
      noteTouch(state, p.team);
    } else {
      const pull = 0.32 * (1 - d / radius) + 0.07;
      b.vx -= nx * pull;
      b.vy -= ny * pull;
    }
  }

  // --- kicks ---
  // Resolved BEFORE ball-player collisions so the perfect-return check sees
  // the ball's true approach speed; otherwise the body bounce on the contact
  // tick would cancel most of it.
  for (const p of state.players) {
    // held button OR a recent unspent press (buffer): a hair-early tap still fires
    const buffered =
      p.kickPressTick > p.kickConsumedTick && t - p.kickPressTick <= PLAYER.kickBufferTicks;
    if ((!p.input.kick && !buffered) || t < p.kickCooldownUntil) continue;
    const c = getCharacter(p.charId);
    const pr = playerRadius(p, t);
    const dx = b.x - p.x;
    const dy = b.y - p.y;
    const d = Math.hypot(dx, dy);
    const powered = c.skill?.id === 'powershot' && t < p.skillActiveUntil;
    // Power Shot gets extra reach so the boosted kick is easier to land
    const reach = pr + BALL.radius + PLAYER.kickRange + (powered ? 8 : 0);
    const ballInRange = d <= reach;

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
        p.skillActiveUntil = 0; // bodycheck is spent: cooldown starts now
        p.skillCooldownUntil = t + c.skill.cooldown;
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
    const nx = d > 1e-6 ? dx / d : 1;
    const ny = d > 1e-6 ? dy / d : 0;

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
    noteTouch(state, p.team);
    p.kickConsumedTick = Math.max(p.kickPressTick, p.kickConsumedTick);
    p.kickCooldownUntil = t + PLAYER.kickCooldownTicks;
    if (powered) {
      p.skillActiveUntil = 0; // power shot is spent: cooldown starts now
      p.skillCooldownUntil = t + c.skill!.cooldown;
    }
    // kicking a magnet-held ball releases it
    if (c.skill?.id === 'magnet' && t < p.skillActiveUntil) p.skillActiveUntil = 0;
  }

  // --- hot ball: the ball fires itself off any touch ---
  if (cfg.hotball) {
    for (const p of state.players) {
      if (t < p.kickCooldownUntil) continue;
      const pr = playerRadius(p, t);
      const dx = b.x - p.x;
      const dy = b.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d > pr + BALL.radius + 2) continue;
      const nx = d > 1e-6 ? dx / d : 1;
      const ny = d > 1e-6 ? dy / d : 0;
      const c = getCharacter(p.charId);
      b.vx = nx * c.kickStrength * 1.15 + p.vx * 0.3;
      b.vy = ny * c.kickStrength * 1.15 + p.vy * 0.3;
      p.kickCooldownUntil = t + PLAYER.kickCooldownTicks;
      noteTouch(state, p.team);
      events.push({ kind: 'kick', id: p.id });
    }
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
    const touched = collideBallPlayer(p, b, playerRadius(p, t), playerInvMass(p, t));
    if (touched) noteTouch(state, p.team);
  }
  for (const goal of geom.goals) {
    for (const post of goal.posts) {
      collideStatic(b, BALL.radius, post.x, post.y, FIELD.postRadius, 0.5);
      for (const p of state.players) {
        collideStatic(p, playerRadius(p, t), post.x, post.y, FIELD.postRadius, 0.5);
      }
    }
  }

  // --- kickoff possession: hold the other teams outside the center circle ---
  if (state.kickoffTeam >= 0) {
    if (state.lastTouchTeam >= 0 || Math.hypot(b.x, b.y) > 3) {
      state.kickoffTeam = -1; // ball is in play
    }
  }
  if (state.kickoffTeam >= 0) {
    for (const p of state.players) {
      if (p.team === state.kickoffTeam) continue;
      const d = Math.hypot(p.x, p.y);
      const min = KICKOFF_BARRIER + playerRadius(p, t);
      if (d < min) {
        const nx = d > 1e-6 ? p.x / d : 1;
        const ny = d > 1e-6 ? p.y / d : 0;
        p.x = nx * min;
        p.y = ny * min;
        const vn = p.vx * nx + p.vy * ny;
        if (vn < 0) {
          p.vx -= vn * nx;
          p.vy -= vn * ny;
        }
      }
    }
  }

  // --- walls (ball only) and player roam limits ---
  for (const seg of geom.walls) {
    collideSegment(b, BALL.radius, seg);
  }
  for (const p of state.players) {
    playerBounds(p, playerRadius(p, t), geom);
  }

  // --- goals ---
  if (state.phase === 0) {
    for (const goal of geom.goals) {
      const rx = b.x - goal.cx;
      const ry = b.y - goal.cy;
      const dN = rx * goal.nx + ry * goal.ny;
      const dT = rx * goal.ux + ry * goal.uy;
      if (dN > BALL.radius && dN < goal.depth + 30 && Math.abs(dT) < goal.mouthHalf) {
        scoreGoal(state, goal.team, events);
        break;
      }
    }
  }

  // --- clock and phase transitions ---
  if (state.phase === 0) {
    state.clock++;
    if (!state.golden && cfg.timeLimitTicks > 0 && state.clock >= cfg.timeLimitTicks) {
      const lead = leaders(state.score);
      if (lead.length === 1) {
        state.phase = 2;
        events.push({ kind: 'end', winner: lead[0] });
      } else {
        state.golden = true; // sudden death: next scored goal wins
      }
    }
  } else if (state.phase === 1 && t >= state.phaseUntil) {
    const champion =
      cfg.scoreLimit > 0 ? state.score.findIndex((s) => s >= cfg.scoreLimit) : -1;
    if (champion >= 0) {
      state.phase = 2;
      events.push({ kind: 'end', winner: champion });
    } else if (state.golden && state.goldenWinner >= 0) {
      state.phase = 2;
      events.push({ kind: 'end', winner: state.goldenWinner });
    } else {
      placeKickoff(state, state.nextKickoffTeam);
      state.phase = 0;
      events.push({ kind: 'kickoff', team: state.kickoffTeam });
    }
  }

  return events;
}

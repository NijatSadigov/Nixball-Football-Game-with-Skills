// Quick sanity checks for the shared physics. Run with: npm test

import assert from 'node:assert';
import { FIELD, KICKOFF_BARRIER, PERFECT } from '../src/shared/constants';
import { getCharacter } from '../src/shared/characters';
import {
  createMatch,
  getGeometry,
  playerRadius,
  stepMatch,
  type MatchConfig,
  type SimEvent,
} from '../src/shared/physics';

const cfg: MatchConfig = { scoreLimit: 3, timeLimitTicks: 0 };
const noJitter = () => 0.5; // (0.5 * 2 - 1) = 0, deterministic straight return

// --- 1. kickoff placement and movement ---
{
  const s = createMatch([
    { id: 1, team: 0, charId: 'classic' },
    { id: 2, team: 1, charId: 'classic' },
  ]);
  assert.ok(s.players[0].x < 0, 'red starts on the left');
  assert.ok(s.players[1].x > 0, 'blue starts on the right');
  const startX = s.players[0].x;
  s.players[0].input.right = true;
  for (let i = 0; i < 60; i++) stepMatch(s, cfg, noJitter);
  assert.ok(s.players[0].x > startX + 40, 'player accelerates to the right');
}

// --- 2. perfect return: fresh press + fast incoming ball ---
{
  const s = createMatch([{ id: 1, team: 0, charId: 'classic' }]);
  const p = s.players[0];
  p.x = 0;
  p.y = 0;
  s.ball.x = 32; // just outside body contact, inside kick range after one tick
  s.ball.y = 0;
  s.ball.vx = -6;
  s.ball.vy = 0;
  p.kickCooldownUntil = 0; // clear the kickoff kick lockout
  p.input.kick = true;
  p.kickPressTick = s.tick; // pressed right now, inside the perfect window
  const events = stepMatch(s, cfg, noJitter);
  assert.ok(
    events.some((e) => e.kind === 'perfect'),
    'expected a perfect-return event',
  );
  assert.ok(s.ball.vx > 6, `ball should rocket back, got vx=${s.ball.vx.toFixed(2)}`);
  assert.ok(Math.abs(s.ball.vy) < 0.001, 'no jitter with centered rng');
}

// --- 3. jitter stays within bounds ---
{
  const s = createMatch([{ id: 1, team: 0, charId: 'classic' }]);
  const p = s.players[0];
  p.x = 0;
  s.ball.x = 32;
  s.ball.vx = -6;
  p.kickCooldownUntil = 0; // clear the kickoff kick lockout
  p.input.kick = true;
  p.kickPressTick = s.tick;
  stepMatch(s, cfg, () => 1); // maximum jitter
  const angle = Math.abs(Math.atan2(s.ball.vy, s.ball.vx));
  assert.ok(angle <= PERFECT.jitterRad + 0.001, `jitter angle ${angle} within +/-${PERFECT.jitterRad}`);
}

// --- 4. held kick (stale press) gives a normal kick, no boost ---
{
  const s = createMatch([{ id: 1, team: 0, charId: 'classic' }]);
  const p = s.players[0];
  p.x = 0;
  s.ball.x = 32;
  s.ball.vx = -6;
  p.kickCooldownUntil = 0; // clear the kickoff kick lockout
  p.input.kick = true;
  p.kickPressTick = -1; // held since forever
  const events = stepMatch(s, cfg, noJitter);
  assert.ok(events.some((e) => e.kind === 'kick'), 'normal kick event');
  assert.ok(!events.some((e) => e.kind === 'perfect'), 'no perfect event');
  assert.ok(s.ball.vx < 2, `additive kick barely cancels a fast ball (vx=${s.ball.vx.toFixed(2)})`);
}

// --- 5. goal detection and score ---
{
  const s = createMatch([{ id: 1, team: 0, charId: 'classic' }]);
  s.players[0].x = -200; // out of the way
  s.ball.x = FIELD.halfW - 15;
  s.ball.vx = 6;
  let goal = false;
  for (let i = 0; i < 30 && !goal; i++) {
    goal = stepMatch(s, cfg, noJitter).some((e) => e.kind === 'goal' && e.team === 0);
  }
  assert.ok(goal, 'shot across the right goal line scores for red');
  assert.equal(s.score[0], 1);
  assert.equal(s.phase, 1, 'goal pause after scoring');
}

// --- 6. wall bounce ---
{
  const s = createMatch([{ id: 1, team: 0, charId: 'classic' }]);
  s.players[0].x = -200;
  s.ball.x = 0;
  s.ball.y = FIELD.halfH - 12;
  s.ball.vy = 5;
  stepMatch(s, cfg, noJitter);
  assert.ok(s.ball.vy < 0, 'ball bounces off the touchline');
}

// --- 7. score limit ends the match after the goal pause ---
{
  const s = createMatch([{ id: 1, team: 0, charId: 'classic' }]);
  const quick: MatchConfig = { scoreLimit: 1, timeLimitTicks: 0 };
  s.players[0].x = -200;
  s.ball.x = FIELD.halfW - 15;
  s.ball.vx = 6;
  let ended = false;
  for (let i = 0; i < 400 && !ended; i++) {
    ended = stepMatch(s, quick, noJitter).some((e) => e.kind === 'end' && e.winner === 0);
  }
  assert.ok(ended, 'match ends once the score limit is reached');
  assert.equal(s.phase, 2);
}

// --- 8. fortress doubles the radius while active ---
{
  const s = createMatch([{ id: 1, team: 0, charId: 'titan' }]);
  const p = s.players[0];
  const base = getCharacter('titan').radius;
  assert.equal(playerRadius(p, s.tick), base);
  p.pendingSkill = true;
  stepMatch(s, cfg, noJitter);
  assert.equal(playerRadius(p, s.tick), base * 2, 'fortress doubles the disc');
}

// --- 9. bodycheck launches a nearby opponent on the next kick ---
{
  const s = createMatch([
    { id: 1, team: 0, charId: 'brawl' },
    { id: 2, team: 1, charId: 'classic' },
  ]);
  const [p, q] = s.players;
  p.x = 0;
  p.y = 0;
  q.x = 34;
  q.y = 0;
  q.vx = 0;
  s.ball.x = -300;
  s.ball.y = -150; // out of the way
  p.pendingSkill = true;
  stepMatch(s, cfg, noJitter); // arms the shove
  p.kickCooldownUntil = 0;
  p.input.kick = true;
  p.kickPressTick = s.tick;
  const events = stepMatch(s, cfg, noJitter);
  assert.ok(events.some((e) => e.kind === 'shove'), 'shove event fires');
  assert.ok(q.vx > 3, `opponent launched away (vx=${q.vx.toFixed(2)})`);
  assert.ok(s.players[0].skillActiveUntil === 0, 'bodycheck is consumed');
  assert.ok(s.players[0].skillCooldownUntil > s.tick, 'cooldown starts after the shove');
}

// --- 10. magnet pulls the ball in and holds it ---
{
  const s = createMatch([{ id: 1, team: 0, charId: 'magno' }]);
  const p = s.players[0];
  p.x = 0;
  p.y = 0;
  s.ball.x = 80;
  s.ball.y = 0;
  s.ball.vx = 0;
  p.pendingSkill = true;
  for (let i = 0; i < 45; i++) stepMatch(s, cfg, noJitter);
  const d = Math.hypot(s.ball.x - p.x, s.ball.y - p.y);
  assert.ok(d < 32, `ball pulled in and held (d=${d.toFixed(1)})`);
}

// helper: fire the ball into a specific team's goal and return the goal event
function shootIntoGoal(
  s: ReturnType<typeof createMatch>,
  goalTeam: number,
): Extract<SimEvent, { kind: 'goal' }> | undefined {
  const goal = getGeometry(s.teams).goals.find((g) => g.team === goalTeam)!;
  s.players.forEach((p, i) => {
    // park everyone near the center, away from the shot
    p.x = -150 + i * 50;
    p.y = goal.ny !== 0 ? 0 : 120;
  });
  s.ball.x = goal.cx - goal.nx * 15;
  s.ball.y = goal.cy - goal.ny * 15;
  s.ball.vx = goal.nx * 6;
  s.ball.vy = goal.ny * 6;
  let ev: Extract<SimEvent, { kind: 'goal' }> | undefined;
  for (let i = 0; i < 30 && !ev; i++) {
    ev = stepMatch(s, cfg, noJitter).find((e) => e.kind === 'goal') as typeof ev;
  }
  return ev;
}

// --- 11. triangle (3 teams): goal credits last toucher, conceder loses one ---
{
  const s = createMatch(
    [
      { id: 1, team: 0, charId: 'classic' },
      { id: 2, team: 1, charId: 'classic' },
      { id: 3, team: 2, charId: 'classic' },
    ],
    3,
  );
  s.lastTouchTeam = 0; // red touched it last
  const goal = shootIntoGoal(s, 2); // into green's net (bottom side)
  assert.ok(goal, 'ball crosses the triangle bottom goal line');
  assert.equal(goal!.team, 0, 'credited to the last toucher (red)');
  assert.deepEqual(s.score, [1, 0, -1], 'scorer +1, conceder -1');
}

// --- 12a. triangle: panic own-goal still credits the attacker ---
{
  const s = createMatch(
    [
      { id: 1, team: 0, charId: 'classic' },
      { id: 2, team: 2, charId: 'classic' },
    ],
    3,
  );
  s.prevTouchTeam = 0; // red attacked...
  s.lastTouchTeam = 2; // ...then green smashed it into their own net
  const goal = shootIntoGoal(s, 2);
  assert.ok(goal, 'own goal still resets play');
  assert.equal(goal!.team, 0, 'previous toucher (red) gets the point');
  assert.deepEqual(s.score, [1, 0, -1]);
}

// --- 12b. triangle: own goal with no prior toucher credits nobody ---
{
  const s = createMatch(
    [
      { id: 1, team: 0, charId: 'classic' },
      { id: 2, team: 2, charId: 'classic' },
    ],
    3,
  );
  s.lastTouchTeam = 2; // green alone touched it
  const goal = shootIntoGoal(s, 2);
  assert.ok(goal, 'own goal still resets play');
  assert.equal(goal!.team, -1, 'nobody credited');
  assert.deepEqual(s.score, [0, 0, -1], 'conceder still loses a point');
}

// --- 13. hot ball fires off any touch, no kick needed ---
{
  const s = createMatch([{ id: 1, team: 0, charId: 'classic' }]);
  const p = s.players[0];
  p.x = 0;
  p.y = 0;
  p.kickCooldownUntil = 0;
  s.ball.x = 26;
  s.ball.y = 0;
  s.ball.vx = -1;
  const events = stepMatch(s, { ...cfg, hotball: true }, noJitter);
  assert.ok(events.some((e) => e.kind === 'kick'), 'auto-fire emits a kick event');
  assert.ok(s.ball.vx > 3, `ball fired away on touch (vx=${s.ball.vx.toFixed(2)})`);
}

// --- 14. square (4 teams): top goal works, scoring rules hold ---
{
  const s = createMatch(
    [
      { id: 1, team: 0, charId: 'classic' },
      { id: 2, team: 1, charId: 'classic' },
      { id: 3, team: 2, charId: 'classic' },
      { id: 4, team: 3, charId: 'classic' },
    ],
    4,
  );
  s.lastTouchTeam = 1; // blue touched it last
  const goal = shootIntoGoal(s, 2); // into green's net (top side)
  assert.ok(goal, 'ball crosses the square top goal line');
  assert.equal(goal!.team, 1, 'credited to blue');
  assert.deepEqual(s.score, [0, 1, -1, 0]);
}

// --- 15. kickoff possession: opponents held out until the first touch ---
{
  const s = createMatch(
    [
      { id: 1, team: 0, charId: 'classic' },
      { id: 2, team: 1, charId: 'classic' },
    ],
    2,
    0, // red has the kickoff
  );
  const [p, q] = s.players;
  q.x = 60; // blue tries to camp the ball
  q.y = 0;
  q.vx = 0;
  q.vy = 0;
  stepMatch(s, cfg, noJitter);
  assert.ok(
    Math.hypot(q.x, q.y) >= KICKOFF_BARRIER + 14,
    `opponent held outside the circle (d=${Math.hypot(q.x, q.y).toFixed(1)})`,
  );
  assert.equal(s.kickoffTeam, 0, 'kickoff persists until the ball is touched');
  // red takes the kickoff: possession lifts
  p.x = -26;
  p.y = 0;
  p.kickCooldownUntil = 0;
  p.input.kick = true;
  p.kickPressTick = s.tick;
  stepMatch(s, cfg, noJitter);
  assert.equal(s.kickoffTeam, -1, 'play is live after the first touch');
}

// --- 16. kick buffer: a slightly-early tap still fires on contact ---
{
  const s = createMatch([{ id: 1, team: 0, charId: 'classic' }]);
  const p = s.players[0];
  p.x = 0;
  p.y = 0;
  p.kickCooldownUntil = 0;
  s.ball.x = 44;
  s.ball.y = 0;
  s.ball.vx = -6;
  p.input.kick = false; // tapped and already released before contact
  p.kickPressTick = s.tick;
  let fired = false;
  for (let i = 0; i < 5 && !fired; i++) {
    fired = stepMatch(s, cfg, noJitter).some((e) => e.kind === 'kick' || e.kind === 'perfect');
  }
  assert.ok(fired, 'buffered press fires when the ball comes into range');
  assert.ok(s.ball.vx > 0, 'ball sent away');
}

// --- 17. armed skills: cooldown starts when spent or expired, not on arm ---
{
  const s = createMatch([{ id: 1, team: 0, charId: 'blaze' }]);
  const p = s.players[0];
  s.ball.x = 300; // out of reach so the shot is never spent
  s.ball.y = 0;
  p.pendingSkill = true;
  stepMatch(s, cfg, noJitter);
  assert.ok(p.skillActiveUntil > s.tick, 'power shot armed');
  assert.equal(p.skillCooldownUntil, 0, 'no cooldown while armed');
  for (let i = 0; i < 125; i++) stepMatch(s, cfg, noJitter); // 2 s window expires
  assert.equal(p.skillActiveUntil, 0, 'armed window expired unused');
  assert.ok(p.skillCooldownUntil > s.tick, 'cooldown started on expiry');
}

// --- 18. ball bumps players only when fast (Haxball-like feel) ---
{
  // slow ball into a still player: barely bounces, barely pushes
  const slow = createMatch([{ id: 1, team: 0, charId: 'classic' }]);
  slow.players[0].x = 0;
  slow.players[0].y = 0;
  slow.ball.x = 21; // overlapping the player (min radius 25)
  slow.ball.y = 0;
  slow.ball.vx = -1.6; // gentle approach (below bumpMinSpeed)
  stepMatch(slow, cfg, noJitter);
  const slowBounce = slow.ball.vx;
  const slowPush = Math.abs(slow.players[0].vx);

  // fast ball into a still player: bounces back, pushes a bit
  const fast = createMatch([{ id: 1, team: 0, charId: 'classic' }]);
  fast.players[0].x = 0;
  fast.players[0].y = 0;
  fast.ball.x = 21;
  fast.ball.y = 0;
  fast.ball.vx = -9;
  stepMatch(fast, cfg, noJitter);
  const fastBounce = fast.ball.vx;
  const fastPush = Math.abs(fast.players[0].vx);

  assert.ok(slowBounce <= 0.5, `slow ball doesn't ping off (vx=${slowBounce.toFixed(2)})`);
  assert.ok(fastBounce > 1.5, `fast ball bounces back (vx=${fastBounce.toFixed(2)})`);
  assert.ok(fastPush > slowPush, 'a fast ball pushes the player more than a slow one');
  assert.ok(slowPush < 0.5, `slow ball barely moves the player (push=${slowPush.toFixed(2)})`);
}

console.log('physics tests: all OK');

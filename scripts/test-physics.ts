// Quick sanity checks for the shared physics. Run with: npm test

import assert from 'node:assert';
import { FIELD, PERFECT } from '../src/shared/constants';
import { getCharacter } from '../src/shared/characters';
import { createMatch, playerRadius, stepMatch, type MatchConfig } from '../src/shared/physics';

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

// --- 11. 3-team mode: goal in the top net credits the last toucher ---
{
  const s = createMatch(
    [
      { id: 1, team: 0, charId: 'classic' },
      { id: 2, team: 1, charId: 'classic' },
      { id: 3, team: 2, charId: 'classic' },
    ],
    3,
  );
  s.players.forEach((p, i) => {
    p.x = -300 + i * 60; // clear everyone out of the shot path
    p.y = 150;
  });
  s.lastTouchTeam = 0; // red touched it last
  s.ball.x = 0;
  s.ball.y = -FIELD.halfH + 15;
  s.ball.vx = 0;
  s.ball.vy = -6;
  let goal: { kind: string; team?: number } | undefined;
  for (let i = 0; i < 30 && !goal; i++) {
    goal = stepMatch(s, cfg, noJitter).find((e) => e.kind === 'goal');
  }
  assert.ok(goal, 'ball passes through the open top mouth and scores');
  assert.equal((goal as { team: number }).team, 0, 'credited to the last toucher (red)');
  assert.deepEqual(s.score, [1, 0, 0]);
}

// --- 12. 3-team mode: own goal credits nobody ---
{
  const s = createMatch(
    [
      { id: 1, team: 0, charId: 'classic' },
      { id: 2, team: 2, charId: 'classic' },
    ],
    3,
  );
  s.players.forEach((p, i) => {
    p.x = -300 + i * 60;
    p.y = 150;
  });
  s.lastTouchTeam = 2; // green knocked it into their own net
  s.ball.x = 0;
  s.ball.y = -FIELD.halfH + 15;
  s.ball.vy = -6;
  let goal: { kind: string; team?: number } | undefined;
  for (let i = 0; i < 30 && !goal; i++) {
    goal = stepMatch(s, cfg, noJitter).find((e) => e.kind === 'goal');
  }
  assert.ok(goal, 'own goal still resets play');
  assert.equal((goal as { team: number }).team, -1, 'nobody credited');
  assert.deepEqual(s.score, [0, 0, 0]);
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

console.log('physics tests: all OK');

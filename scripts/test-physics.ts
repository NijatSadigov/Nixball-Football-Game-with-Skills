// Quick sanity checks for the shared physics. Run with: npm test

import assert from 'node:assert';
import { FIELD, PERFECT } from '../src/shared/constants';
import { createMatch, stepMatch, type MatchConfig } from '../src/shared/physics';

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

console.log('physics tests: all OK');

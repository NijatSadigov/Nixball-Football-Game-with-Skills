// End-to-end smoke test: boots the built server, connects two bot clients,
// creates a room, plays until a goal is scored and the match ends.
// Requires a build first: npm run build && npm run smoke

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import WebSocket from 'ws';

const PORT = 3105;

if (!existsSync('dist/server.cjs')) {
  console.error('dist/server.cjs missing — run `npm run build` first.');
  process.exit(1);
}

const server = spawn(process.execPath, ['dist/server.cjs'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'inherit',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const bot = { ws, name, room: null, states: 0, events: [], waiters: [] };
    // keep in sync with PROTOCOL_VERSION in src/shared/constants.ts
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', v: 2, name })));
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString());
      if (m.t === 'welcome') resolve(bot);
      else if (m.t === 'room') bot.room = m;
      else if (m.t === 'state') bot.states++;
      else if (m.t === 'ev') bot.events.push(m);
      else if (m.t === 'error') console.error(`[${name}] server error:`, m.msg);
      for (const w of [...bot.waiters]) w();
    });
    ws.on('error', reject);
  });
}

function waitFor(bot, pred, what, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const check = () => {
      if (pred(bot)) {
        resolve();
        return true;
      }
      if (Date.now() - t0 > timeout) {
        reject(new Error(`timeout waiting for: ${what}`));
        return true;
      }
      return false;
    };
    if (check()) return;
    const w = () => {
      if (check()) bot.waiters.splice(bot.waiters.indexOf(w), 1);
    };
    bot.waiters.push(w);
    const iv = setInterval(() => {
      if (check()) clearInterval(iv);
    }, 200);
  });
}

const sendJ = (bot, obj) => bot.ws.send(JSON.stringify(obj));

try {
  await sleep(800); // let the server boot

  const ana = await connect('Ana');
  sendJ(ana, { t: 'create', name: 'Smoke', isPublic: false, scoreLimit: 1, timeLimitMin: 0, maxPlayers: 4 });
  await waitFor(ana, (b) => b.room !== null, 'room creation');
  const code = ana.room.code;
  console.log(`room created: ${code}`);

  const bob = await connect('Bob');
  sendJ(bob, { t: 'join', code });
  await waitFor(bob, (b) => b.room !== null, 'bob joining');

  sendJ(ana, { t: 'team', team: 0 });
  sendJ(bob, { t: 'team', team: 1 });
  await waitFor(
    ana,
    (b) => b.room.members.some((m) => m.team === 0) && b.room.members.some((m) => m.team === 1),
    'team assignment',
  );

  sendJ(ana, { t: 'start' });
  await waitFor(ana, (b) => b.room.phase === 'match', 'match start');
  console.log('match started');

  // Ana charges right holding kick; Bob clears out of the shot path.
  sendJ(ana, { t: 'input', up: false, down: false, left: false, right: true, kick: true });
  sendJ(bob, { t: 'input', up: true, down: false, left: false, right: false, kick: false });

  await waitFor(ana, (b) => b.states > 10, 'snapshots flowing');
  console.log('snapshots flowing');

  await waitFor(ana, (b) => b.events.some((e) => e.e === 'goal'), 'a goal', 30000);
  console.log('goal scored');

  await waitFor(ana, (b) => b.events.some((e) => e.e === 'end'), 'match end', 15000);
  console.log('match ended');

  await waitFor(ana, (b) => b.room.phase === 'lobby', 'return to lobby', 15000);
  console.log('SMOKE OK — room, teams, match, goal, end, lobby all work');
  process.exitCode = 0;
} catch (err) {
  console.error('SMOKE FAILED:', err.message);
  process.exitCode = 1;
} finally {
  server.kill();
}

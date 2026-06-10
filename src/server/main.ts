import { createServer } from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { TICK_MS } from '../shared/constants';
import { RoomManager } from './rooms';
import { makeStaticHandler } from './static';

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_DIR = process.env.PUBLIC_DIR ?? path.resolve(process.cwd(), 'dist/public');

const httpServer = createServer(makeStaticHandler(PUBLIC_DIR));
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
const manager = new RoomManager();

wss.on('connection', (ws) => manager.handleConnection(ws));

// Fixed-rate simulation loop with catch-up (setInterval drift safe).
let last = Date.now();
let acc = 0;
setInterval(() => {
  const now = Date.now();
  acc += now - last;
  last = now;
  let steps = 0;
  while (acc >= TICK_MS && steps < 4) {
    manager.tick();
    acc -= TICK_MS;
    steps++;
  }
  if (steps === 4) acc = 0; // severely behind: drop time instead of spiraling
}, 8);

setInterval(() => manager.heartbeat(), 30_000);

httpServer.listen(PORT, () => {
  console.log(`NixBall server listening on http://localhost:${PORT}`);
  console.log(`Serving client from: ${PUBLIC_DIR}`);
});

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { TICK_MS } from '../shared/constants';
import { accountsEnabled, config, logConfigSummary } from './config';
import { handleApi } from './api';
import { initDb } from './db';
import { RoomManager } from './rooms';
import { makeStaticHandler } from './static';

const staticHandler = makeStaticHandler(config.publicDir);

const httpServer = createServer((req, res) => {
  // API + Stripe webhook first; everything else is the static client
  handleApi(req, res)
    .then((handled) => {
      if (!handled) staticHandler(req, res);
    })
    .catch((err) => {
      console.error('request error', err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
});

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
const manager = new RoomManager();

// pass the upgrade request so the connection can resolve its account cookie
wss.on('connection', (ws, req) => manager.handleConnection(ws, req));

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

async function main(): Promise<void> {
  if (accountsEnabled) {
    try {
      await initDb();
    } catch (err) {
      console.error('DB init failed — accounts/payments disabled for this run:', err);
    }
  }
  httpServer.listen(config.port, () => {
    console.log(`NixBall server listening on http://localhost:${config.port}`);
    console.log(`Serving client from: ${config.publicDir}`);
    logConfigSummary();
  });
}

void main();

# NixBall ⚽

A Haxball-style online multiplayer football game — with **characters and skills**.
Players create rooms, share an invite code, pick a character, and play 2D top-down
football in the browser. No accounts, no downloads.

## Features

- **Online multiplayer** — authoritative Node.js server at 60 Hz, WebSocket transport,
  snapshot interpolation + client-side prediction for a smooth feel.
- **Rooms** — create public or private rooms with score limit, time limit, and max
  players. Join via the public list or an invite code/link (`https://yourhost/#CODE`).
- **Game modes** — classic 2-team, or **3-team / 4-team** chaos with extra goals in
  the top and bottom walls (goals credit the last team that touched the ball; own
  goals credit nobody). Plus the **Hot ball** modifier: the ball fires itself off
  any touch — no kick button needed.
- **Characters with skills** (data-driven, easy to extend):

  | Character | Role        | Skill                                                              |
  | --------- | ----------- | ------------------------------------------------------------------ |
  | Classic   | All-rounder | None — pure football                                               |
  | Blaze     | Striker     | **Power Shot** — next kick is 70% harder, with an aim arrow        |
  | Bolt      | Winger      | **Blink Dash** — instant burst of speed (featherweight)            |
  | Titan     | Anchor      | **Fortress** — doubles in size and becomes immovable for 1.5 s     |
  | Brawl     | Enforcer    | **Bodycheck** — next kick also launches nearby opponents           |
  | Magno     | Keeper      | **Magnet** — gently pulls the ball in for 1 s; up close it sticks  |

- **Perfect Return** — the signature mechanic: when the ball is flying at you fast
  and you *press* the kick button just before contact (≤150 ms), the ball rockets
  back at high speed in a **slightly randomized direction**. Holding the kick button
  doesn't count — timing does.
- Golden goal overtime, in-game chat, spectators, host controls, synthesized sound
  effects (no assets).

## Controls

| Action | Keys                |
| ------ | ------------------- |
| Move   | WASD / arrow keys   |
| Kick   | X or Space          |
| Skill  | E or Q              |
| Chat   | Enter               |

## Development

```bash
npm install
npm run dev        # vite client on :5173  +  game server on :3000 (proxied)
```

Open http://localhost:5173. Open a second browser window to play against yourself.

```bash
npm run typecheck  # strict TS across client/server/shared
npm test           # physics unit tests (perfect return, goals, bounces, ...)
npm run build      # dist/public (client) + dist/server.cjs (single-file server)
npm run smoke      # boots the built server, two bots play a full match
npm start          # serve the built game on :3000
```

## How it works

```
src/
  shared/      physics.ts (60 Hz sim), characters.ts, constants.ts, types.ts (protocol)
  server/      rooms.ts (room manager + game loop), static.ts, main.ts
  client/      main.ts (screens/UI), game.ts (interp + prediction), render.ts (canvas),
               net.ts, input.ts, sound.ts
```

- The **server is authoritative**: clients only send button states. The simulation
  steps at 60 Hz and broadcasts compact snapshots at 30 Hz.
- Clients render ~100 ms behind the newest snapshot and interpolate between
  snapshots; your own disc is **predicted locally** from your inputs and gently
  blended toward the server position, so movement feels instant.
- The physics is Haxball-flavored: damped discs, impulse collisions, goal posts,
  additive kicks. All tunables live in `src/shared/constants.ts`.

### The Perfect Return rule (src/shared/physics.ts)

On kick contact, the server measures the ball's *approach speed* toward the player.
If it exceeds `PERFECT.minApproach` **and** the kick press happened within
`PERFECT.windowTicks` (a fresh press, not a hold), the ball's velocity is **set**
(not added) to `base + approach × factor` away from the player, rotated by a random
angle within ±10°. A held kick on the same ball merely adds the normal kick impulse —
which barely cancels a fast incoming shot. Reward: clean, fast, slightly
unpredictable counters.

### Adding a character

Add an entry to `src/shared/characters.ts`. If it uses an existing skill id
(`powershot`, `dash`, `fortress`) you're done — stats, UI cards, and netcode pick it
up automatically. A new skill id needs a small effect block in
`stepMatch()` in `src/shared/physics.ts`.

## Deployment

See [DEPLOY.md](DEPLOY.md) — the build is a single `dist/` folder (one server file +
static assets, no runtime `node_modules`), designed to sit behind an nginx subdomain
reverse proxy next to your portfolio.

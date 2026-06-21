import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import {
  END_PAUSE_TICKS,
  PROTOCOL_VERSION,
  ROOM,
  SNAP_EVERY,
  TEAMS,
  TICK_RATE,
} from '../shared/constants';
import { isCharacterId } from '../shared/characters';
import { getShotFx, isShotFxId } from '../shared/shotfx';
import { accountsEnabled, paymentsEnabled } from './config';
import { sessionCookieFrom } from './auth';
import { ownedFx } from './db';
import {
  addPlayerToSim,
  createMatch,
  removePlayerFromSim,
  stepMatch,
  type SimEvent,
  type SimState,
} from '../shared/physics';
import type {
  C2S,
  RoomListing,
  RoomMember,
  RoomSettings,
  S2C,
  TeamOrSpec,
  WireEvent,
  WirePlayer,
  WireState,
} from '../shared/types';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

let nextConnId = 1;

interface Member {
  id: number;
  ws: WebSocket;
  name: string; // empty until 'hello'
  team: TeamOrSpec;
  charId: string;
  shotFx: string;
  accountId: number | null; // resolved from the session cookie, if any
  owned: Set<string>; // premium fx this account owns (loaded from DB)
  room: Room | null;
  lastChatAt: number;
  alive: boolean;
}

function send(m: Member, msg: S2C): void {
  if (m.ws.readyState === m.ws.OPEN) m.ws.send(JSON.stringify(msg));
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? Math.round(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

const CONTROL_CHARS = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + ']', 'g');

function cleanText(v: unknown, maxLen: number): string {
  if (typeof v !== 'string') return '';
  return v.replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

const r2 = (n: number) => Math.round(n * 100) / 100;

class Room {
  code: string;
  name: string;
  isPublic: boolean;
  settings: RoomSettings;
  members = new Map<number, Member>();
  hostId = 0;
  admins = new Set<number>(); // extra admins granted by the host/another admin
  sim: SimState | null = null;
  private endedAtTick = 0;

  constructor(code: string, name: string, isPublic: boolean, settings: RoomSettings) {
    this.code = code;
    this.name = name;
    this.isPublic = isPublic;
    this.settings = settings;
  }

  get phase(): 'lobby' | 'match' {
    return this.sim ? 'match' : 'lobby';
  }

  isAdmin(id: number): boolean {
    return id === this.hostId || this.admins.has(id);
  }

  broadcast(msg: S2C): void {
    const raw = JSON.stringify(msg);
    for (const m of this.members.values()) {
      if (m.ws.readyState === m.ws.OPEN) m.ws.send(raw);
    }
  }

  sysChat(text: string): void {
    this.broadcast({ t: 'chat', from: '', text, sys: true });
  }

  memberList(): RoomMember[] {
    return [...this.members.values()].map((m) => ({
      id: m.id,
      name: m.name,
      team: m.team,
      charId: m.charId,
      shotFx: m.shotFx,
      admin: this.isAdmin(m.id),
    }));
  }

  sendRoomState(): void {
    const members = this.memberList();
    for (const m of this.members.values()) {
      send(m, {
        t: 'room',
        code: this.code,
        name: this.name,
        isPublic: this.isPublic,
        host: this.hostId,
        you: m.id,
        phase: this.phase,
        settings: this.settings,
        members,
      });
    }
  }

  addMember(m: Member): void {
    this.members.set(m.id, m);
    m.room = this;
    m.team = -1;
    if (this.members.size === 1) this.hostId = m.id;
    this.sendRoomState();
    this.sysChat(`${m.name} joined the room`);
  }

  removeMember(m: Member): void {
    this.members.delete(m.id);
    this.admins.delete(m.id);
    m.room = null;
    if (this.sim) removePlayerFromSim(this.sim, m.id);
    if (this.members.size === 0) return; // manager deletes the room
    if (this.hostId === m.id) {
      // hand the room to an existing admin if there is one, else the next member
      this.hostId = [...this.admins].find((id) => this.members.has(id)) ?? this.members.keys().next().value!;
      this.admins.delete(this.hostId);
      const newHost = this.members.get(this.hostId);
      this.sysChat(`${newHost?.name} is now the host`);
    }
    this.sendRoomState();
    this.sysChat(`${m.name} left the room`);
  }

  setAdmin(m: Member, targetId: number, grant: boolean): void {
    if (!this.isAdmin(m.id)) {
      send(m, { t: 'error', msg: 'Only an admin can change admins.' });
      return;
    }
    if (targetId === this.hostId) return; // the host is always an admin
    const target = this.members.get(targetId);
    if (!target) return;
    if (grant) this.admins.add(targetId);
    else this.admins.delete(targetId);
    this.sendRoomState();
    this.sysChat(`${target.name} is ${grant ? 'now an admin' : 'no longer an admin'}.`);
  }

  setTeam(m: Member, team: TeamOrSpec): void {
    if (team !== -1 && (team < 0 || team >= this.settings.teams)) return;
    if (m.team === team) return;
    m.team = team;
    if (this.sim) {
      removePlayerFromSim(this.sim, m.id);
      if (team !== -1) addPlayerToSim(this.sim, m.id, team, m.charId);
    }
    this.sendRoomState();
  }

  setChar(m: Member, charId: string): void {
    if (!isCharacterId(charId)) return;
    // no swapping characters while actively on the pitch
    if (this.sim && m.team !== -1) {
      send(m, { t: 'error', msg: 'You can only change character between matches.' });
      return;
    }
    m.charId = charId;
    this.sendRoomState();
  }

  async setFx(m: Member, fx: string): Promise<void> {
    if (!isShotFxId(fx)) return;
    // when payments are live, premium effects require verified ownership;
    // otherwise (dev/no-payments) any effect is allowed for local preview.
    if (paymentsEnabled && getShotFx(fx).priceUsd > 0 && !m.owned.has(fx)) {
      // they may have just purchased it — reload ownership from the DB (the
      // cached set was loaded when they connected) before refusing.
      if (m.accountId) {
        try {
          m.owned = new Set(await ownedFx(m.accountId));
        } catch (err) {
          console.error('reload owned fx failed', err);
        }
      }
      if (!m.owned.has(fx)) {
        send(m, { t: 'error', msg: 'Buy this shot effect to equip it.' });
        return;
      }
    }
    m.shotFx = fx;
    this.sendRoomState();
  }

  start(m: Member): void {
    if (!this.isAdmin(m.id)) {
      send(m, { t: 'error', msg: 'Only an admin can start the match.' });
      return;
    }
    if (this.sim) return;
    const roster = [...this.members.values()]
      .filter((p) => p.team >= 0 && p.team < this.settings.teams)
      .map((p) => ({ id: p.id, team: p.team as number, charId: p.charId }));
    if (roster.length === 0) {
      send(m, { t: 'error', msg: 'At least one player must join a team.' });
      return;
    }
    // red takes the opening kickoff (classic rules); after goals the conceder restarts
    const startTeam = 0;
    this.sim = createMatch(roster, this.settings.teams, startTeam);
    this.endedAtTick = 0;
    this.sendRoomState();
    this.broadcast({ t: 'ev', e: 'kickoff', team: startTeam });
    this.sysChat(`Match started! ${TEAMS[startTeam].name} kicks off.`);
  }

  stop(m: Member): void {
    if (!this.isAdmin(m.id) || !this.sim) return;
    this.sim = null;
    this.sendRoomState();
    this.sysChat('Match ended by an admin.');
  }

  updateSettings(m: Member, msg: Extract<C2S, { t: 'settings' }>): void {
    if (!this.isAdmin(m.id)) {
      send(m, { t: 'error', msg: 'Only an admin can change settings.' });
      return;
    }
    if (this.sim) {
      send(m, { t: 'error', msg: 'Settings can only change between matches.' });
      return;
    }
    const s = this.settings;
    if (typeof msg.name === 'string') {
      const name = cleanText(msg.name, ROOM.nameMax);
      if (name) this.name = name;
    }
    if (typeof msg.isPublic === 'boolean') this.isPublic = msg.isPublic;
    s.scoreLimit = clampInt(msg.scoreLimit, 0, 20, s.scoreLimit);
    s.timeLimitMin = clampInt(msg.timeLimitMin, 0, 30, s.timeLimitMin);
    s.maxPlayers = clampInt(
      msg.maxPlayers,
      Math.max(2, this.members.size),
      ROOM.maxPlayersCap,
      s.maxPlayers,
    );
    const newTeams = clampInt(msg.teams, 2, 4, s.teams);
    if (newTeams !== s.teams) {
      s.teams = newTeams;
      // anyone on a team that no longer exists becomes a spectator
      for (const member of this.members.values()) {
        if (member.team >= newTeams) member.team = -1;
      }
    }
    if (typeof msg.hotball === 'boolean') s.hotball = msg.hotball;
    this.sendRoomState();
    this.sysChat('Room settings updated.');
  }

  private wireEvent(ev: SimEvent): WireEvent {
    switch (ev.kind) {
      case 'kick':
        return { t: 'ev', e: 'kick', id: ev.id };
      case 'perfect':
        return { t: 'ev', e: 'perfect', id: ev.id, x: r2(ev.x), y: r2(ev.y), speed: r2(ev.speed) };
      case 'skill':
        return { t: 'ev', e: 'skill', id: ev.id, skill: ev.skill };
      case 'shove':
        return { t: 'ev', e: 'shove', id: ev.id, x: r2(ev.x), y: r2(ev.y) };
      case 'goal':
        return { t: 'ev', e: 'goal', team: ev.team };
      case 'end':
        return { t: 'ev', e: 'end', winner: ev.winner };
      case 'kickoff':
        return { t: 'ev', e: 'kickoff', team: ev.team };
    }
  }

  tickSim(): void {
    const sim = this.sim;
    if (!sim) return;
    const cfg = {
      scoreLimit: this.settings.scoreLimit,
      timeLimitTicks: this.settings.timeLimitMin * 60 * TICK_RATE,
      hotball: this.settings.hotball,
    };
    const events = stepMatch(sim, cfg, Math.random);
    for (const ev of events) {
      this.broadcast(this.wireEvent(ev));
      if (ev.kind === 'goal') {
        const scoreLine = sim.score.join(' - ');
        this.sysChat(
          ev.team >= 0
            ? `GOAL! ${TEAMS[ev.team].name} scores. ${scoreLine}`
            : `Own goal! Nobody is credited. ${scoreLine}`,
        );
      } else if (ev.kind === 'end') {
        this.endedAtTick = sim.tick;
        this.sysChat(
          ev.winner === -1
            ? 'Match over: draw.'
            : `Match over: ${TEAMS[ev.winner].name} wins ${sim.score.join(' - ')}!`,
        );
      }
    }
    // after the results screen, drop back to the lobby
    if (sim.phase === 2 && this.endedAtTick > 0 && sim.tick >= this.endedAtTick + END_PAUSE_TICKS) {
      this.sim = null;
      this.sendRoomState();
    }
  }

  snapshot(): void {
    const sim = this.sim;
    if (!sim) return;
    const players: WirePlayer[] = sim.players.map((p) => {
      let flags = 0;
      if (p.input.kick) flags |= 1;
      if (sim.tick < p.skillActiveUntil) flags |= 2;
      return [
        p.id,
        r2(p.x),
        r2(p.y),
        r2(p.vx),
        r2(p.vy),
        flags,
        Math.max(0, p.skillCooldownUntil - sim.tick),
      ];
    });
    const msg: WireState = {
      t: 'state',
      k: sim.tick,
      ph: sim.phase,
      b: [r2(sim.ball.x), r2(sim.ball.y), r2(sim.ball.vx), r2(sim.ball.vy)],
      p: players,
      s: [...sim.score],
      c: sim.clock,
      g: sim.golden ? 1 : 0,
      ko: sim.kickoffTeam,
    };
    this.broadcast(msg);
  }
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  private conns = new Set<Member>();
  private tickCount = 0;

  handleConnection(ws: WebSocket, req?: IncomingMessage): void {
    const m: Member = {
      id: nextConnId++,
      ws,
      name: '',
      team: -1,
      charId: 'classic',
      shotFx: 'classic',
      accountId: null,
      owned: new Set(),
      room: null,
      lastChatAt: 0,
      alive: true,
    };
    this.conns.add(m);
    // resolve the signed-in account from the cookie sent on the WS upgrade,
    // then load which premium effects it owns (so setFx can be gated)
    if (accountsEnabled && req) {
      const accountId = sessionCookieFrom(req.headers.cookie);
      if (accountId) {
        m.accountId = accountId;
        ownedFx(accountId)
          .then((ids) => {
            m.owned = new Set(ids);
          })
          .catch((err) => console.error('load owned fx failed', err));
      }
    }
    ws.on('pong', () => (m.alive = true));
    ws.on('message', (data) => {
      let msg: C2S;
      try {
        const raw = data.toString();
        if (raw.length > 4096) return;
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      try {
        this.onMessage(m, msg);
      } catch (err) {
        console.error('error handling message', msg?.t, err);
      }
    });
    ws.on('close', () => this.dropMember(m));
    ws.on('error', () => this.dropMember(m));
  }

  private dropMember(m: Member): void {
    if (!this.conns.has(m)) return;
    this.conns.delete(m);
    this.leaveRoom(m);
  }

  private leaveRoom(m: Member): void {
    const room = m.room;
    if (!room) return;
    room.removeMember(m);
    if (room.members.size === 0) this.rooms.delete(room.code);
  }

  private publicRooms(): RoomListing[] {
    const list: RoomListing[] = [];
    for (const r of this.rooms.values()) {
      if (!r.isPublic) continue;
      list.push({
        code: r.code,
        name: r.name,
        players: r.members.size,
        max: r.settings.maxPlayers,
        phase: r.phase,
        teams: r.settings.teams,
        hotball: r.settings.hotball,
      });
      if (list.length >= 50) break;
    }
    return list;
  }

  private genCode(): string {
    for (;;) {
      let code = '';
      for (let i = 0; i < 5; i++) {
        code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
  }

  private onMessage(m: Member, msg: C2S): void {
    if (msg.t === 'hello') {
      if (msg.v !== PROTOCOL_VERSION) {
        send(m, { t: 'error', msg: 'Client is outdated. Refresh the page.' });
        m.ws.close();
        return;
      }
      m.name = cleanText(msg.name, ROOM.nickMax) || `Player${m.id}`;
      send(m, { t: 'welcome', id: m.id, rooms: this.publicRooms() });
      return;
    }
    if (!m.name) return; // must say hello first

    switch (msg.t) {
      case 'listRooms':
        send(m, { t: 'rooms', rooms: this.publicRooms() });
        break;

      case 'create': {
        if (m.room) this.leaveRoom(m);
        if (this.rooms.size >= ROOM.maxRooms) {
          send(m, { t: 'error', msg: 'Server is full (too many rooms). Try again later.' });
          return;
        }
        const name = cleanText(msg.name, ROOM.nameMax) || `${m.name}'s room`;
        const settings: RoomSettings = {
          scoreLimit: clampInt(msg.scoreLimit, 0, 20, 3),
          timeLimitMin: clampInt(msg.timeLimitMin, 0, 30, 5),
          maxPlayers: clampInt(msg.maxPlayers, 2, ROOM.maxPlayersCap, ROOM.defaultMaxPlayers),
          teams: clampInt(msg.teams, 2, 4, 2),
          hotball: msg.hotball === true,
        };
        const room = new Room(this.genCode(), name, msg.isPublic === true, settings);
        this.rooms.set(room.code, room);
        room.addMember(m);
        break;
      }

      case 'join': {
        const code = cleanText(msg.code, 8).toUpperCase();
        const room = this.rooms.get(code);
        if (!room) {
          send(m, { t: 'error', msg: `Room ${code || '?'} not found.` });
          return;
        }
        if (room.members.size >= room.settings.maxPlayers) {
          send(m, { t: 'error', msg: 'Room is full.' });
          return;
        }
        if (m.room) this.leaveRoom(m);
        room.addMember(m);
        break;
      }

      case 'leave':
        this.leaveRoom(m);
        send(m, { t: 'left' });
        break;

      case 'settings':
        m.room?.updateSettings(m, msg);
        break;

      case 'team': {
        if (!m.room) return;
        const team =
          typeof msg.team === 'number' && Number.isInteger(msg.team) && msg.team >= 0 && msg.team <= 3
            ? (msg.team as TeamOrSpec)
            : -1;
        m.room.setTeam(m, team);
        break;
      }

      case 'char':
        m.room?.setChar(m, String(msg.charId));
        break;

      case 'fx':
        void m.room?.setFx(m, String(msg.fx));
        break;

      case 'admin':
        if (m.room && typeof msg.target === 'number') {
          m.room.setAdmin(m, msg.target, msg.grant === true);
        }
        break;

      case 'start':
        m.room?.start(m);
        break;

      case 'stop':
        m.room?.stop(m);
        break;

      case 'input': {
        const sim = m.room?.sim;
        if (!sim) return;
        const p = sim.players.find((pl) => pl.id === m.id);
        if (!p) return;
        const kick = msg.kick === true;
        if (kick && !p.input.kick) p.kickPressTick = sim.tick; // rising edge
        p.input = {
          up: msg.up === true,
          down: msg.down === true,
          left: msg.left === true,
          right: msg.right === true,
          kick,
        };
        break;
      }

      case 'skill': {
        const sim = m.room?.sim;
        if (!sim) return;
        const p = sim.players.find((pl) => pl.id === m.id);
        if (p) p.pendingSkill = true;
        break;
      }

      case 'chat': {
        if (!m.room) return;
        const now = Date.now();
        if (now - m.lastChatAt < 400) return;
        m.lastChatAt = now;
        const text = cleanText(msg.text, ROOM.chatMax);
        if (text) m.room.broadcast({ t: 'chat', from: m.name, text });
        break;
      }
    }
  }

  // Called at TICK_RATE by the server loop.
  tick(): void {
    this.tickCount++;
    for (const room of this.rooms.values()) {
      room.tickSim();
      if (this.tickCount % SNAP_EVERY === 0) room.snapshot();
    }
  }

  // Terminate dead connections (run every ~30 s).
  heartbeat(): void {
    for (const m of this.conns) {
      if (!m.alive) {
        m.ws.terminate();
        this.dropMember(m);
        continue;
      }
      m.alive = false;
      m.ws.ping();
    }
  }

  get stats() {
    return { rooms: this.rooms.size, connections: this.conns.size };
  }
}

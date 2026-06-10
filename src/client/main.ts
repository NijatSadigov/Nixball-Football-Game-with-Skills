import { PROTOCOL_VERSION } from '../shared/constants';
import { CHARACTERS, getCharacter } from '../shared/characters';
import type { RoomListing, RoomStateMsg } from '../shared/types';
import { GameView } from './game';
import { InputManager } from './input';
import { Net } from './net';
import { Sfx } from './sound';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

// ---------- element refs ----------

const screens = {
  home: $('screen-home'),
  lobby: $('screen-lobby'),
  game: $('screen-game'),
};

const els = {
  nick: $<HTMLInputElement>('nick'),
  btnCreate: $<HTMLButtonElement>('btn-create'),
  joinCode: $<HTMLInputElement>('join-code'),
  btnJoin: $<HTMLButtonElement>('btn-join'),
  btnRefresh: $<HTMLButtonElement>('btn-refresh'),
  roomList: $('room-list'),
  roomListEmpty: $('room-list-empty'),
  connStatus: $('conn-status'),

  lobbyName: $('lobby-name'),
  lobbyCode: $<HTMLButtonElement>('lobby-code'),
  lobbySettings: $('lobby-settings'),
  btnLeaveLobby: $<HTMLButtonElement>('btn-leave-lobby'),
  teamRed: $('team-red'),
  teamSpec: $('team-spec'),
  teamBlue: $('team-blue'),
  charRow: $('char-row'),
  chatLog: $('chat-log'),
  chatForm: $<HTMLFormElement>('chat-form'),
  chatInput: $<HTMLInputElement>('chat-input'),
  btnStart: $<HTMLButtonElement>('btn-start'),
  startHint: $('start-hint'),

  canvas: $<HTMLCanvasElement>('game-canvas'),
  hudChatlog: $('hud-chatlog'),
  hudChatForm: $<HTMLFormElement>('hud-chat-form'),
  hudChatInput: $<HTMLInputElement>('hud-chat-input'),
  btnStop: $<HTMLButtonElement>('btn-stop'),
  btnLeaveGame: $<HTMLButtonElement>('btn-leave-game'),

  createDialog: $<HTMLDialogElement>('create-dialog'),
  createForm: $<HTMLFormElement>('create-form'),
  crName: $<HTMLInputElement>('cr-name'),
  crScore: $<HTMLInputElement>('cr-score'),
  crTime: $<HTMLInputElement>('cr-time'),
  crMax: $<HTMLInputElement>('cr-max'),
  crPublic: $<HTMLInputElement>('cr-public'),

  toast: $('toast'),
};

// ---------- app state ----------

const net = new Net();
const input = new InputManager();
const sfx = new Sfx();
const gameView = new GameView(
  els.canvas,
  {
    scoreRed: $('hud-score-red'),
    scoreBlue: $('hud-score-blue'),
    clock: $('hud-clock'),
    golden: $('hud-golden'),
    banner: $('hud-banner'),
    skill: $('hud-skill'),
    skillName: $('hud-skill-name'),
    skillCd: $('hud-skill-cd'),
    spectate: $('hud-spectate'),
  },
  sfx,
);

let currentRoom: RoomStateMsg | null = null;
let myId = 0;
let helloName = '';
let pendingJoinCode: string | null = null; // from invite link or reconnect
let rejoinTeam: -1 | 0 | 1 = -1;
let reconnectTimer = 0;
let toastTimer = 0;

// ---------- helpers ----------

function toast(msg: string): void {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => els.toast.classList.remove('show'), 2600);
}

function show(name: keyof typeof screens): void {
  for (const [key, el] of Object.entries(screens)) {
    el.classList.toggle('hidden', key !== name);
  }
}

function nickname(): string {
  return els.nick.value.trim().slice(0, 16) || 'Player';
}

function sendHello(): void {
  helloName = nickname();
  net.send({ t: 'hello', v: PROTOCOL_VERSION, name: helloName });
}

function ensureFreshName(): void {
  if (helloName !== nickname()) sendHello();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// ---------- home ----------

function renderRooms(rooms: RoomListing[]): void {
  els.roomList.innerHTML = '';
  els.roomListEmpty.classList.toggle('hidden', rooms.length > 0);
  for (const r of rooms) {
    const li = document.createElement('li');
    const full = r.players >= r.max;
    li.innerHTML =
      `<span class="r-name">${escapeHtml(r.name)}</span>` +
      `<span class="badge ${r.phase === 'match' ? 'live' : ''}">${r.phase === 'match' ? 'live' : 'lobby'}</span>` +
      `<span class="r-meta">${r.players}/${r.max}</span>`;
    const btn = document.createElement('button');
    btn.className = 'small';
    btn.textContent = full ? 'Full' : 'Join';
    btn.disabled = full;
    btn.addEventListener('click', () => {
      ensureFreshName();
      net.send({ t: 'join', code: r.code });
    });
    li.appendChild(btn);
    els.roomList.appendChild(li);
  }
}

els.nick.value = localStorage.getItem('nixball-nick') ?? '';
els.nick.addEventListener('change', () => {
  localStorage.setItem('nixball-nick', els.nick.value.trim());
});

els.btnCreate.addEventListener('click', () => {
  if (!els.nick.value.trim()) {
    els.nick.focus();
    toast('Pick a nickname first');
    return;
  }
  els.createDialog.showModal();
});

// Cancel is type="button" (closes without submitting), so any submit = create
$('cr-cancel').addEventListener('click', () => els.createDialog.close());
els.createForm.addEventListener('submit', () => {
  ensureFreshName();
  net.send({
    t: 'create',
    name: els.crName.value.trim(),
    isPublic: els.crPublic.checked,
    scoreLimit: Number(els.crScore.value),
    timeLimitMin: Number(els.crTime.value),
    maxPlayers: Number(els.crMax.value),
  });
});

function joinByCode(): void {
  const code = els.joinCode.value.trim().toUpperCase();
  if (code.length < 4) {
    toast('Enter a room code');
    return;
  }
  ensureFreshName();
  net.send({ t: 'join', code });
}

els.btnJoin.addEventListener('click', joinByCode);
els.joinCode.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinByCode();
});
els.btnRefresh.addEventListener('click', () => net.send({ t: 'listRooms' }));

setInterval(() => {
  if (!screens.home.classList.contains('hidden') && net.connected && helloName) {
    net.send({ t: 'listRooms' });
  }
}, 4000);

// ---------- lobby ----------

function memberChip(member: { id: number; name: string; charId: string }, hostId: number): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'member-chip' + (member.id === myId ? ' me' : '');
  const char = getCharacter(member.charId);
  li.innerHTML =
    `<span class="dot" style="background:${char.color}"></span>` +
    `<span>${escapeHtml(member.name)}${member.id === hostId ? ' 👑' : ''}</span>`;
  return li;
}

function renderLobby(): void {
  const room = currentRoom;
  if (!room) return;
  els.lobbyName.textContent = room.name;
  els.lobbyCode.textContent = room.code;
  const parts: string[] = [];
  parts.push(room.settings.scoreLimit > 0 ? `first to ${room.settings.scoreLimit}` : 'no score limit');
  parts.push(room.settings.timeLimitMin > 0 ? `${room.settings.timeLimitMin} min` : 'no time limit');
  parts.push(room.isPublic ? 'public' : 'private');
  els.lobbySettings.textContent = parts.join(' · ');

  els.teamRed.innerHTML = '';
  els.teamSpec.innerHTML = '';
  els.teamBlue.innerHTML = '';
  for (const m of room.members) {
    const target = m.team === 0 ? els.teamRed : m.team === 1 ? els.teamBlue : els.teamSpec;
    target.appendChild(memberChip(m, room.host));
  }

  const me = room.members.find((m) => m.id === myId);
  document.querySelectorAll<HTMLButtonElement>('.join-team').forEach((btn) => {
    btn.disabled = me ? Number(btn.dataset.team) === me.team : false;
  });

  renderCharRow(me?.charId ?? 'classic');

  const isHost = room.host === myId;
  const teamPlayers = room.members.filter((m) => m.team !== -1).length;
  els.btnStart.classList.toggle('hidden', !isHost);
  if (isHost) {
    els.btnStart.disabled = teamPlayers === 0;
    els.startHint.textContent =
      teamPlayers === 0 ? 'Someone must join a team first' : `${teamPlayers} player(s) ready`;
  } else {
    els.startHint.textContent = 'Waiting for the host to start…';
  }
}

function renderCharRow(selectedId: string): void {
  els.charRow.innerHTML = '';
  for (const c of CHARACTERS) {
    const card = document.createElement('div');
    card.className = 'char-card' + (c.id === selectedId ? ' selected' : '');
    const stat = (label: string, val: number) =>
      `<div class="statbar"><span class="label">${label}</span><span class="track"><span class="fill" style="width:${val * 20}%;background:${c.color}"></span></span></div>`;
    card.innerHTML =
      `<div class="char-head"><span class="char-name" style="color:${c.color}">${c.name}</span><span class="char-role">${c.role}</span></div>` +
      `<div class="char-desc">${c.desc}</div>` +
      stat('Speed', c.stats.speed) +
      stat('Power', c.stats.power) +
      stat('Weight', c.stats.weight) +
      (c.skill
        ? `<div class="char-skill"><b>${c.skill.name}</b> — ${c.skill.desc}</div>`
        : `<div class="char-skill muted">No skill. Pure football.</div>`);
    card.addEventListener('click', () => net.send({ t: 'char', charId: c.id }));
    els.charRow.appendChild(card);
  }
}

document.querySelectorAll<HTMLButtonElement>('.join-team').forEach((btn) => {
  btn.addEventListener('click', () => {
    const team = Number(btn.dataset.team) as -1 | 0 | 1;
    net.send({ t: 'team', team });
  });
});

els.lobbyCode.addEventListener('click', async () => {
  if (!currentRoom) return;
  const url = `${location.origin}${location.pathname}#${currentRoom.code}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Invite link copied!');
  } catch {
    toast(`Invite code: ${currentRoom.code}`);
  }
});

els.btnLeaveLobby.addEventListener('click', () => net.send({ t: 'leave' }));
els.btnStart.addEventListener('click', () => net.send({ t: 'start' }));

function appendLobbyChat(from: string, text: string, sys: boolean): void {
  const li = document.createElement('li');
  if (sys) {
    li.className = 'sys';
    li.textContent = text;
  } else {
    li.innerHTML = `<span class="who">${escapeHtml(from)}:</span> ${escapeHtml(text)}`;
  }
  els.chatLog.appendChild(li);
  while (els.chatLog.children.length > 60) els.chatLog.firstChild?.remove();
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

function appendHudChat(from: string, text: string, sys: boolean): void {
  const div = document.createElement('div');
  if (sys) {
    div.className = 'sys';
    div.textContent = text;
  } else {
    div.innerHTML = `<span class="who">${escapeHtml(from)}:</span> ${escapeHtml(text)}`;
  }
  els.hudChatlog.appendChild(div);
  while (els.hudChatlog.children.length > 5) els.hudChatlog.firstChild?.remove();
  setTimeout(() => div.remove(), 8500);
}

els.chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = els.chatInput.value.trim();
  if (text) net.send({ t: 'chat', text });
  els.chatInput.value = '';
});

// ---------- game screen ----------

els.hudChatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = els.hudChatInput.value.trim();
  if (text) net.send({ t: 'chat', text });
  els.hudChatInput.value = '';
  els.hudChatForm.classList.add('hidden');
  els.hudChatInput.blur();
});

els.hudChatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    els.hudChatForm.classList.add('hidden');
    els.hudChatInput.blur();
  }
});

els.btnLeaveGame.addEventListener('click', () => net.send({ t: 'leave' }));
els.btnStop.addEventListener('click', () => net.send({ t: 'stop' }));

input.onChange = (s) => {
  gameView.localInput = s;
  net.send({ t: 'input', ...s });
};
input.onSkill = () => net.send({ t: 'skill' });
input.onChatToggle = () => {
  els.hudChatForm.classList.remove('hidden');
  els.hudChatInput.focus();
};

// ---------- net handlers ----------

net.onOpen(() => {
  els.connStatus.textContent = '';
  sendHello();
});

net.on('welcome', (msg) => {
  myId = msg.id;
  renderRooms(msg.rooms);
  els.connStatus.textContent = 'Online';
  if (pendingJoinCode) {
    const code = pendingJoinCode;
    pendingJoinCode = null;
    net.send({ t: 'join', code });
  }
});

net.on('rooms', (msg) => renderRooms(msg.rooms));

net.on('room', (msg) => {
  const wasInRoom = currentRoom !== null;
  currentRoom = msg;
  myId = msg.you;
  history.replaceState(null, '', '#' + msg.code);

  const me = msg.members.find((m) => m.id === myId);
  if (me) rejoinTeam = me.team;

  if (msg.phase === 'match') {
    show('game');
    gameView.settings = msg.settings;
    gameView.setRoster(msg.members, myId);
    gameView.start();
    input.enabled = true;
    els.btnStop.classList.toggle('hidden', msg.host !== myId);
  } else {
    gameView.stop();
    input.enabled = false;
    input.releaseAll();
    show('lobby');
    renderLobby();
    if (!wasInRoom) els.chatLog.innerHTML = '';
  }
});

net.on('state', (msg) => gameView.onState(msg));
net.on('ev', (msg) => gameView.onEvent(msg));

net.on('chat', (msg) => {
  appendLobbyChat(msg.from, msg.text, msg.sys === true);
  if (!screens.game.classList.contains('hidden')) {
    appendHudChat(msg.from, msg.text, msg.sys === true);
  }
});

net.on('left', () => {
  currentRoom = null;
  rejoinTeam = -1;
  gameView.stop();
  input.enabled = false;
  history.replaceState(null, '', location.pathname);
  show('home');
  net.send({ t: 'listRooms' });
});

net.on('error', (msg) => toast(msg.msg));

net.onClose(() => {
  els.connStatus.textContent = 'Connection lost — reconnecting…';
  input.enabled = false;
  if (currentRoom) {
    // try to rejoin the same room once we're back
    pendingJoinCode = currentRoom.code;
    const team = rejoinTeam;
    const onceRoom = () => {
      if (team !== -1) net.send({ t: 'team', team });
    };
    const handler = () => {
      onceRoom();
      rejoinHandlers.delete(handler);
    };
    rejoinHandlers.add(handler);
    currentRoom = null;
    gameView.stop();
    show('home');
    toast('Connection lost — rejoining…');
  }
  clearTimeout(reconnectTimer);
  reconnectTimer = window.setTimeout(() => net.connect(), 1800);
});

// fire rejoin team selection after the room state arrives
const rejoinHandlers = new Set<() => void>();
net.on('room', () => {
  for (const h of [...rejoinHandlers]) h();
});

// ---------- boot ----------

input.attach();

const unlockAudio = () => {
  sfx.unlock();
  window.removeEventListener('pointerdown', unlockAudio);
  window.removeEventListener('keydown', unlockAudio);
};
window.addEventListener('pointerdown', unlockAudio);
window.addEventListener('keydown', unlockAudio);

const hashCode = location.hash.replace('#', '').trim().toUpperCase();
if (hashCode.length === 5) {
  pendingJoinCode = hashCode;
  els.joinCode.value = hashCode;
}

show('home');
net.connect();

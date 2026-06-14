import { PROTOCOL_VERSION, TEAMS } from '../shared/constants';
import { CHARACTERS, getCharacter } from '../shared/characters';
import { SHOT_FX } from '../shared/shotfx';
import type { RoomListing, RoomStateMsg, TeamOrSpec } from '../shared/types';
import {
  logout,
  me,
  ownsServerSide,
  refreshMe,
  requestLogin,
  startCheckout,
} from './account';
import { GameView } from './game';
import { InputManager } from './input';
import { Net } from './net';
import { isOwned as isOwnedLocal, markOwned } from './shop';
import { Sfx } from './sound';
import { isTouchDevice, TouchControls } from './touch';

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
  teamsArea: $('teams-area'),
  charRow: $('char-row'),
  fxRow: $('fx-row'),
  accountArea: $('account-area'),
  chatLog: $('chat-log'),
  chatForm: $<HTMLFormElement>('chat-form'),
  chatInput: $<HTMLInputElement>('chat-input'),
  btnStart: $<HTMLButtonElement>('btn-start'),
  startHint: $('start-hint'),

  canvas: $<HTMLCanvasElement>('game-canvas'),
  hudChatlog: $('hud-chatlog'),
  hudChatForm: $<HTMLFormElement>('hud-chat-form'),
  hudChatInput: $<HTMLInputElement>('hud-chat-input'),
  hudSpectateBtns: $('hud-spectate-btns'),
  btnStop: $<HTMLButtonElement>('btn-stop'),
  btnLeaveGame: $<HTMLButtonElement>('btn-leave-game'),

  createDialog: $<HTMLDialogElement>('create-dialog'),
  createForm: $<HTMLFormElement>('create-form'),
  crName: $<HTMLInputElement>('cr-name'),
  crScore: $<HTMLInputElement>('cr-score'),
  crTime: $<HTMLInputElement>('cr-time'),
  crMax: $<HTMLInputElement>('cr-max'),
  crTeams: $<HTMLSelectElement>('cr-teams'),
  crHot: $<HTMLInputElement>('cr-hot'),
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
    scores: $('hud-scores'),
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
let rejoinTeam: TeamOrSpec = -1;
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
      (r.teams > 2 ? `<span class="badge">${r.teams} teams</span>` : '') +
      (r.hotball ? `<span class="badge hot">hot ball</span>` : '') +
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

// personal colour: applied only to YOUR disc on YOUR screen
const myColorInput = $<HTMLInputElement>('my-color');
const storedColor = localStorage.getItem('nixball-mycolor');
if (storedColor) {
  myColorInput.value = storedColor;
  gameView.setMyColor(storedColor);
}
myColorInput.addEventListener('input', () => {
  localStorage.setItem('nixball-mycolor', myColorInput.value);
  gameView.setMyColor(myColorInput.value);
});
$('my-color-reset').addEventListener('click', () => {
  localStorage.removeItem('nixball-mycolor');
  gameView.setMyColor(null);
  toast('Back to your team colour');
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
    teams: Number(els.crTeams.value),
    hotball: els.crHot.checked,
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

function joinTeamButton(team: TeamOrSpec, label: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'join-team';
  btn.textContent = label;
  btn.addEventListener('click', () => net.send({ t: 'team', team }));
  return btn;
}

function sendSettings(): void {
  const get = (id: string) => document.getElementById(id) as HTMLInputElement;
  net.send({
    t: 'settings',
    name: get('ls-name').value.trim(),
    isPublic: get('ls-pub').checked,
    scoreLimit: Number(get('ls-score').value),
    timeLimitMin: Number(get('ls-time').value),
    teams: Number((document.getElementById('ls-teams') as HTMLSelectElement).value),
    hotball: get('ls-hot').checked,
    maxPlayers: Number(get('ls-max').value),
  });
}

function renderSettingsLine(room: RoomStateMsg): void {
  if (room.host === myId) {
    // host edits settings right here; changes apply to the next match
    const s = room.settings;
    const teamOpts = [2, 3, 4]
      .map((n) => `<option value="${n}" ${s.teams === n ? 'selected' : ''}>${n}</option>`)
      .join('');
    els.lobbySettings.innerHTML =
      `<span class="ls-ctl">name <input id="ls-name" maxlength="24" value="${escapeHtml(room.name)}"></span>` +
      `<span class="ls-ctl">first to <input id="ls-score" type="number" min="0" max="20" value="${s.scoreLimit}"></span>` +
      `<span class="ls-ctl"><input id="ls-time" type="number" min="0" max="30" value="${s.timeLimitMin}"> min</span>` +
      `<span class="ls-ctl">teams <select id="ls-teams">${teamOpts}</select></span>` +
      `<span class="ls-ctl"><label><input id="ls-hot" type="checkbox" ${s.hotball ? 'checked' : ''}> hot ball</label></span>` +
      `<span class="ls-ctl">max <input id="ls-max" type="number" min="2" max="12" value="${s.maxPlayers}"></span>` +
      `<span class="ls-ctl"><label><input id="ls-pub" type="checkbox" ${room.isPublic ? 'checked' : ''}> public</label></span>`;
    for (const id of ['ls-name', 'ls-score', 'ls-time', 'ls-teams', 'ls-hot', 'ls-max', 'ls-pub']) {
      document.getElementById(id)!.addEventListener('change', sendSettings);
    }
  } else {
    const parts: string[] = [];
    parts.push(room.settings.scoreLimit > 0 ? `first to ${room.settings.scoreLimit}` : 'no score limit');
    parts.push(room.settings.timeLimitMin > 0 ? `${room.settings.timeLimitMin} min` : 'no time limit');
    if (room.settings.teams > 2) parts.push(`${room.settings.teams} teams`);
    if (room.settings.hotball) parts.push('hot ball');
    parts.push(room.isPublic ? 'public' : 'private');
    els.lobbySettings.textContent = parts.join(' · ');
  }
}

function renderLobby(): void {
  const room = currentRoom;
  if (!room) return;
  els.lobbyName.textContent = room.name;
  els.lobbyCode.textContent = room.code;
  renderSettingsLine(room);

  const meMember = room.members.find((m) => m.id === myId);

  // one column per team plus spectators
  els.teamsArea.innerHTML = '';
  els.teamsArea.style.gridTemplateColumns = `repeat(${room.settings.teams + 1}, 1fr)`;
  const columns: { team: TeamOrSpec; label: string; color?: string }[] = [];
  for (let i = 0; i < room.settings.teams; i++) {
    columns.push({ team: i as TeamOrSpec, label: TEAMS[i].name, color: TEAMS[i].color });
  }
  columns.push({ team: -1, label: 'Spectators' });
  for (const col of columns) {
    const div = document.createElement('div');
    div.className = 'team-col';
    const h = document.createElement('h3');
    h.textContent = col.label;
    h.style.color = col.color ?? 'var(--muted)';
    const ul = document.createElement('ul');
    for (const m of room.members) {
      if (m.team === col.team) ul.appendChild(memberChip(m, room.host));
    }
    const btn = joinTeamButton(col.team, col.team === -1 ? 'Spectate' : `Join ${col.label}`);
    btn.disabled = meMember ? meMember.team === col.team : false;
    div.append(h, ul, btn);
    els.teamsArea.appendChild(div);
  }

  renderCharRow(meMember?.charId ?? 'classic');
  renderFxRow(meMember?.shotFx ?? 'classic');
  renderAccountArea();

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

// owns = free, OR purchased (server-verified when payments live; localStorage in dev)
function ownsFx(id: string): boolean {
  return me().paymentsEnabled ? ownsServerSide(id) : isOwnedLocal(id);
}

function renderFxRow(selectedId: string): void {
  els.fxRow.innerHTML = '';
  for (const f of SHOT_FX) {
    const owned = ownsFx(f.id);
    const card = document.createElement('div');
    card.className =
      'fx-card' + (f.id === selectedId ? ' selected' : '') + (owned ? '' : ' locked');
    const tag = owned
      ? f.priceUsd === 0
        ? '<span class="fx-tag free">Free</span>'
        : '<span class="fx-tag owned">Owned</span>'
      : `<span class="fx-tag price">$${f.priceUsd}</span>`;
    card.innerHTML =
      `<span class="fx-swatch" style="background:${f.color}"></span>` +
      `<div class="fx-info"><span class="fx-name">${f.name}</span><span class="fx-desc">${f.desc}</span></div>` +
      tag;
    card.addEventListener('click', () => {
      if (owned) {
        net.send({ t: 'fx', fx: f.id });
      } else {
        void openPurchase(f.id);
      }
    });
    els.fxRow.appendChild(card);
  }
}

async function openPurchase(fxId: string): Promise<void> {
  const fx = SHOT_FX.find((f) => f.id === fxId);
  if (!fx) return;

  // Payments live: route through Stripe Checkout (requires sign-in).
  if (me().paymentsEnabled) {
    if (!me().signedIn) {
      promptSignIn(`Sign in to buy ${fx.name} ($${fx.priceUsd}).`);
      return;
    }
    toast('Opening secure checkout…');
    const url = await startCheckout(fxId);
    if (url) window.location.assign(url);
    else toast('Could not start checkout. Try again.');
    return;
  }

  // Payments not configured: local preview unlock so the visual is usable.
  const ok = window.confirm(
    `${fx.name} — $${fx.priceUsd}\n\n${fx.desc}\n\nPayments aren't enabled on this server. ` +
      `Preview this effect locally? (Unlocks only on this device.)`,
  );
  if (ok) {
    markOwned(fxId);
    net.send({ t: 'fx', fx: fxId });
    toast(`${fx.name} unlocked (preview)`);
    if (currentRoom) renderFxRow(fxId);
  }
}

function promptSignIn(reason: string): void {
  const email = window.prompt(`${reason}\n\nEnter your email — we'll send a sign-in link:`);
  if (!email) return;
  void requestLogin(email.trim()).then((ok) => {
    toast(ok ? 'Check your email for the sign-in link.' : 'Could not send the link. Try again.');
  });
}

// Sign-in status shown in the lobby header (only when accounts are enabled).
function renderAccountArea(): void {
  const area = els.accountArea;
  const s = me();
  if (!s.accountsEnabled) {
    area.classList.add('hidden');
    return;
  }
  area.classList.remove('hidden');
  area.innerHTML = '';
  if (s.signedIn) {
    const who = document.createElement('span');
    who.className = 'muted';
    who.style.fontSize = '13px';
    who.textContent = s.email ?? 'signed in';
    const out = document.createElement('button');
    out.className = 'ghost small';
    out.textContent = 'Sign out';
    out.addEventListener('click', async () => {
      await logout();
      renderAccountArea();
      if (currentRoom) renderLobby();
    });
    area.append(who, out);
  } else {
    const inBtn = document.createElement('button');
    inBtn.className = 'ghost small';
    inBtn.textContent = 'Sign in';
    inBtn.addEventListener('click', () => promptSignIn('Sign in to NixBall.'));
    area.appendChild(inBtn);
  }
}

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

// touch controls (mobile): feed the same input pipeline
const touch = isTouchDevice()
  ? new TouchControls({
      onDir: (dir) => input.setTouchDir(dir),
      onKick: (down) => input.setKick(down),
      onSkill: () => net.send({ t: 'skill' }),
    })
  : null;
if (touch) document.body.classList.add('is-touch');

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

  const meMember = msg.members.find((m) => m.id === myId);
  if (meMember) rejoinTeam = meMember.team;

  if (msg.phase === 'match') {
    show('game');
    gameView.settings = msg.settings;
    gameView.setRoster(msg.members, myId);
    gameView.start();
    input.enabled = true;
    els.btnStop.classList.toggle('hidden', msg.host !== myId);
    // touch controls only when actually playing (not spectating)
    touch?.setVisible(meMember ? meMember.team !== -1 : true);
    // spectator quick-join buttons, one per team in this mode
    els.hudSpectateBtns.innerHTML = '';
    for (let i = 0; i < msg.settings.teams; i++) {
      const b = joinTeamButton(i as TeamOrSpec, TEAMS[i].name);
      b.style.background = TEAMS[i].color;
      b.style.color = '#10141a';
      b.style.fontWeight = '700';
      els.hudSpectateBtns.appendChild(b);
    }
  } else {
    gameView.stop();
    input.enabled = false;
    input.releaseAll();
    touch?.setVisible(false);
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

// account + purchase status, and messages from the Stripe / magic-link redirects
async function bootAccount(): Promise<void> {
  await refreshMe();
  const params = new URLSearchParams(location.search);
  const purchased = params.get('purchased');
  if (purchased) {
    // the webhook may land a beat after redirect; refresh once more shortly
    setTimeout(() => void refreshMe().then(() => currentRoom && renderLobby()), 1500);
    toast('Purchase complete — effect unlocked!');
  } else if (params.get('canceled')) {
    toast('Checkout canceled.');
  } else if (params.get('signedin')) {
    toast('Signed in!');
  } else if (params.get('login') === 'expired') {
    toast('That sign-in link expired. Try again.');
  }
  if (location.search) history.replaceState(null, '', location.pathname + location.hash);
  if (currentRoom) renderLobby();
  renderAccountArea();
}

show('home');
net.connect();
void bootAccount();

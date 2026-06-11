// All physics units are pixels and pixels-per-tick at a fixed 60 Hz simulation.

export const PROTOCOL_VERSION = 3;

// Team palette. Index = team id; rooms use the first N depending on the mode.
// Teams 0/1 defend the left/right goals; team 2 the top goal; team 3 the bottom.
export const TEAMS = [
  { name: 'Red', color: '#e25d51', edge: '#511d18' },
  { name: 'Blue', color: '#5689e5', edge: '#1b3563' },
  { name: 'Green', color: '#43c46b', edge: '#17532b' },
  { name: 'Gold', color: '#e3c43d', edge: '#65561a' },
];

export const TICK_RATE = 60;
export const TICK_MS = 1000 / TICK_RATE;
export const SNAP_EVERY = 2; // broadcast a snapshot every 2 ticks (30 Hz)

export const FIELD = {
  halfW: 450,
  halfH: 230,
  goalHalf: 80, // half of the goal mouth opening
  goalDepth: 55,
  postRadius: 8,
  playerMargin: 60, // how far beyond the pitch players can roam
  wallRestitution: 0.6,
  netRestitution: 0.35,
};

export const BALL = {
  radius: 10,
  damping: 0.99,
  invMass: 1.2,
};

export const PLAYER = {
  damping: 0.96,
  restitution: 0.5,
  kickRange: 4, // extra reach beyond radii contact for kicking
  kickCooldownTicks: 10,
  kickAccelFactor: 0.65, // you accelerate slower while charging a kick
};

export const KICKOFF_PAUSE_TICKS = 150; // celebration pause after a goal (2.5 s)
export const END_PAUSE_TICKS = 330; // results shown before returning to lobby (5.5 s)

// The "perfect return" mechanic: if the ball is approaching you fast and you
// PRESS kick within the window just before contact, the ball is returned at
// high speed in a slightly randomized direction. Holding kick does not count.
export const PERFECT = {
  minApproach: 3.2, // required approach speed (px/tick) toward the player
  windowTicks: 9, // press must be at most this many ticks before contact (150 ms)
  base: 4.5, // outgoing speed floor
  factor: 1.0, // outgoing speed gained per unit of approach speed
  maxSpeed: 11,
  jitterRad: 0.175, // +/- ~10 degrees of random deviation
};

export const ROOM = {
  maxRooms: 100,
  maxPlayersCap: 12,
  defaultMaxPlayers: 8,
  nameMax: 24,
  nickMax: 16,
  chatMax: 120,
};

import type { InputState } from './physics';

export type Team = 0 | 1; // 0 = red (defends left goal), 1 = blue (defends right)
export type TeamOrSpec = Team | -1;

export interface RoomSettings {
  scoreLimit: number; // 0 = unlimited
  timeLimitMin: number; // 0 = unlimited
  maxPlayers: number;
}

export interface RoomMember {
  id: number;
  name: string;
  team: TeamOrSpec;
  charId: string;
}

export interface RoomListing {
  code: string;
  name: string;
  players: number;
  max: number;
  phase: 'lobby' | 'match';
}

// ---- client -> server ----

export type C2S =
  | { t: 'hello'; v: number; name: string }
  | { t: 'listRooms' }
  | {
      t: 'create';
      name: string;
      isPublic: boolean;
      scoreLimit: number;
      timeLimitMin: number;
      maxPlayers: number;
    }
  | { t: 'join'; code: string }
  | { t: 'leave' }
  | { t: 'team'; team: TeamOrSpec }
  | { t: 'char'; charId: string }
  | { t: 'start' }
  | { t: 'stop' }
  | ({ t: 'input' } & InputState)
  | { t: 'skill' }
  | { t: 'chat'; text: string };

// ---- server -> client ----

// [id, x, y, vx, vy, flags, skillCooldownLeft]
// flags: bit0 = kick held, bit1 = skill effect active
export type WirePlayer = [number, number, number, number, number, number, number];

export interface WireState {
  t: 'state';
  k: number; // server tick
  ph: 0 | 1 | 2; // 0 play, 1 goal pause, 2 match over
  b: [number, number, number, number]; // ball x, y, vx, vy
  p: WirePlayer[];
  s: [number, number]; // score red, blue
  c: number; // elapsed play ticks
  g: 0 | 1; // golden goal active
}

export type WireEvent =
  | { t: 'ev'; e: 'kick'; id: number }
  | { t: 'ev'; e: 'perfect'; id: number; x: number; y: number; speed: number }
  | { t: 'ev'; e: 'skill'; id: number; skill: string }
  | { t: 'ev'; e: 'shove'; id: number; x: number; y: number }
  | { t: 'ev'; e: 'goal'; team: Team }
  | { t: 'ev'; e: 'end'; winner: Team | -1 }
  | { t: 'ev'; e: 'kickoff' };

export interface RoomStateMsg {
  t: 'room';
  code: string;
  name: string;
  isPublic: boolean;
  host: number;
  you: number;
  phase: 'lobby' | 'match';
  settings: RoomSettings;
  members: RoomMember[];
}

export type S2C =
  | { t: 'welcome'; id: number; rooms: RoomListing[] }
  | { t: 'rooms'; rooms: RoomListing[] }
  | RoomStateMsg
  | WireState
  | WireEvent
  | { t: 'chat'; from: string; text: string; sys?: boolean }
  | { t: 'left' }
  | { t: 'error'; msg: string };

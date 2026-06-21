import type { InputState } from './physics';

// 0 = red (left goal), 1 = blue (right), 2 = green (top), 3 = gold (bottom)
export type Team = 0 | 1 | 2 | 3;
export type TeamOrSpec = Team | -1;

export interface RoomSettings {
  scoreLimit: number; // 0 = unlimited
  timeLimitMin: number; // 0 = unlimited
  maxPlayers: number;
  teams: number; // 2, 3 or 4
  hotball: boolean; // ball fires itself off any touch
}

export interface RoomMember {
  id: number;
  name: string;
  team: TeamOrSpec;
  charId: string;
  shotFx: string;
  admin: boolean; // host or granted admin: can start/stop, change settings, promote
}

export interface RoomListing {
  code: string;
  name: string;
  players: number;
  max: number;
  phase: 'lobby' | 'match';
  teams: number;
  hotball: boolean;
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
      teams: number;
      hotball: boolean;
    }
  | { t: 'join'; code: string }
  | { t: 'leave' }
  | {
      t: 'settings'; // host-only, lobby-only partial update
      name?: string;
      isPublic?: boolean;
      scoreLimit?: number;
      timeLimitMin?: number;
      maxPlayers?: number;
      teams?: number;
      hotball?: boolean;
    }
  | { t: 'team'; team: TeamOrSpec }
  | { t: 'char'; charId: string }
  | { t: 'fx'; fx: string }
  | { t: 'admin'; target: number; grant: boolean }
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
  s: number[]; // score per team
  c: number; // elapsed play ticks
  g: 0 | 1; // golden goal active
  ko: number; // team with kickoff possession, -1 = free play
}

export type WireEvent =
  | { t: 'ev'; e: 'kick'; id: number }
  | { t: 'ev'; e: 'perfect'; id: number; x: number; y: number; speed: number }
  | { t: 'ev'; e: 'skill'; id: number; skill: string }
  | { t: 'ev'; e: 'shove'; id: number; x: number; y: number }
  | { t: 'ev'; e: 'goal'; team: number } // -1 = own goal, nobody credited
  | { t: 'ev'; e: 'end'; winner: number } // -1 = draw / stopped
  | { t: 'ev'; e: 'kickoff'; team?: number }; // team that restarts

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

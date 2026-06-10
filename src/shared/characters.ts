// Character definitions are data-driven: add a new entry here (and, if it
// introduces a new skill id, implement the skill effect in physics.ts).

export type SkillId = 'powershot' | 'dash' | 'fortress';

export interface SkillDef {
  id: SkillId;
  name: string;
  desc: string;
  cooldown: number; // ticks
  duration: number; // ticks the effect stays active (0 = instant)
  magnitude: number; // skill-specific number (see physics.ts)
}

export interface CharacterDef {
  id: string;
  name: string;
  role: string;
  desc: string;
  color: string; // accent used on the disc and in UI
  radius: number;
  accel: number; // px/tick^2 while holding a direction
  kickStrength: number; // px/tick added to the ball on a normal kick
  invMass: number; // higher = gets pushed around more
  stats: { speed: number; power: number; weight: number }; // 1..5, for UI bars
  skill: SkillDef | null;
}

export const CHARACTERS: CharacterDef[] = [
  {
    id: 'classic',
    name: 'Classic',
    role: 'All-rounder',
    desc: 'The original. No gimmicks, no excuses.',
    color: '#e8e8e8',
    radius: 15,
    accel: 0.1,
    kickStrength: 5.0,
    invMass: 0.5,
    stats: { speed: 3, power: 3, weight: 3 },
    skill: null,
  },
  {
    id: 'blaze',
    name: 'Blaze',
    role: 'Striker',
    desc: 'Lives for the highlight reel.',
    color: '#ff9d42',
    radius: 15,
    accel: 0.097,
    kickStrength: 5.6,
    invMass: 0.5,
    stats: { speed: 3, power: 5, weight: 3 },
    skill: {
      id: 'powershot',
      name: 'Power Shot',
      desc: 'Your next kick within 2 s hits 70% harder.',
      cooldown: 480,
      duration: 120,
      magnitude: 1.7, // kick strength multiplier
    },
  },
  {
    id: 'bolt',
    name: 'Bolt',
    role: 'Winger',
    desc: 'Small, slippery, and everywhere at once.',
    color: '#ffe44d',
    radius: 14,
    accel: 0.11,
    kickStrength: 4.5,
    invMass: 0.55,
    stats: { speed: 5, power: 2, weight: 2 },
    skill: {
      id: 'dash',
      name: 'Blink Dash',
      desc: 'Instant burst of speed in your movement direction.',
      cooldown: 360,
      duration: 0,
      magnitude: 4.2, // impulse in px/tick
    },
  },
  {
    id: 'titan',
    name: 'Titan',
    role: 'Anchor',
    desc: 'The wall that walks like a player.',
    color: '#9b8cff',
    radius: 17,
    accel: 0.09,
    kickStrength: 5.2,
    invMass: 0.38,
    stats: { speed: 2, power: 4, weight: 5 },
    skill: {
      id: 'fortress',
      name: 'Fortress',
      desc: 'For 1.5 s you become nearly immovable.',
      cooldown: 600,
      duration: 90,
      magnitude: 0.06, // invMass while active
    },
  },
];

const byId = new Map(CHARACTERS.map((c) => [c.id, c]));

export function getCharacter(id: string): CharacterDef {
  return byId.get(id) ?? CHARACTERS[0];
}

export function isCharacterId(id: string): boolean {
  return byId.has(id);
}

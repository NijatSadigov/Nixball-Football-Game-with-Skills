// Cosmetic shot effects: the burst that plays at the ball whenever you kick.
// `classic` is free; the rest are premium ($1 each). Ownership is enforced
// client-side for now (see client/shop.ts); when the payment backend lands,
// the server should verify ownership before broadcasting a player's choice.

export interface ShotFxDef {
  id: string;
  name: string;
  desc: string;
  color: string; // accent shown in the picker swatch
  priceUsd: number; // 0 = free
}

export const SHOT_FX: ShotFxDef[] = [
  {
    id: 'classic',
    name: 'Classic',
    desc: 'A clean white shockring. Always free.',
    color: '#e8e8e8',
    priceUsd: 0,
  },
  {
    id: 'flame',
    name: 'Inferno',
    desc: 'Erupts into fire and rising embers.',
    color: '#ff7b2d',
    priceUsd: 1,
  },
  {
    id: 'bolt',
    name: 'Thunderstrike',
    desc: 'Jagged electric arcs crackle outward.',
    color: '#5ad1ff',
    priceUsd: 1,
  },
  {
    id: 'confetti',
    name: 'Party Time',
    desc: 'A burst of colourful confetti.',
    color: '#ff5db4',
    priceUsd: 1,
  },
  {
    id: 'shock',
    name: 'Earthshaker',
    desc: 'Triple shockwave that rattles the screen.',
    color: '#b9a4ff',
    priceUsd: 1,
  },
  {
    id: 'nova',
    name: 'Supernova',
    desc: 'A golden starburst with drifting sparkles.',
    color: '#ffe44d',
    priceUsd: 1,
  },
];

const byId = new Map(SHOT_FX.map((f) => [f.id, f]));

export function getShotFx(id: string): ShotFxDef {
  return byId.get(id) ?? SHOT_FX[0];
}

export function isShotFxId(id: string): boolean {
  return byId.has(id);
}

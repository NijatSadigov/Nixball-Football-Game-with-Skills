// Tracks which premium shot effects this player owns.
//
// TODO(payments): ownership currently lives in localStorage, which is NOT
// secure — it's a placeholder so the cosmetic system works end to end. When
// the payment backend lands, ownership should come from a verified account
// (server-signed), and `markOwned` should only run after a confirmed purchase.

import { SHOT_FX } from '../shared/shotfx';

const KEY = 'nixball-owned-fx';

function load(): Set<string> {
  const owned = new Set<string>();
  // everything free is always owned
  for (const f of SHOT_FX) if (f.priceUsd === 0) owned.add(f.id);
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) for (const id of JSON.parse(raw) as string[]) owned.add(id);
  } catch {
    /* ignore */
  }
  return owned;
}

let owned = load();

export function isOwned(id: string): boolean {
  return owned.has(id);
}

export function markOwned(id: string): void {
  owned.add(id);
  const premium = [...owned].filter((x) => SHOT_FX.find((f) => f.id === x && f.priceUsd > 0));
  try {
    localStorage.setItem(KEY, JSON.stringify(premium));
  } catch {
    /* ignore */
  }
}

export function refresh(): void {
  owned = load();
}

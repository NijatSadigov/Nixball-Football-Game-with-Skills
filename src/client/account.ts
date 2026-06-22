// Client-side account + purchase state. Talks to the server API; when the
// server reports accounts/payments disabled, the UI falls back to local
// preview unlocks (see shop.ts).

import { getShotFx } from '../shared/shotfx';

export interface MeState {
  accountsEnabled: boolean;
  paymentsEnabled: boolean;
  signedIn: boolean;
  email: string | null;
  owned: string[];
  premium: string[];
}

let state: MeState = {
  accountsEnabled: false,
  paymentsEnabled: false,
  signedIn: false,
  email: null,
  owned: [],
  premium: [],
};

export function me(): MeState {
  return state;
}

export async function refreshMe(): Promise<MeState> {
  try {
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    if (res.ok) state = { ...state, ...(await res.json()) };
  } catch {
    /* offline / disabled — keep defaults */
  }
  return state;
}

export async function requestLogin(email: string): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ email }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function logout(): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {
    /* ignore */
  }
  state = { ...state, signedIn: false, email: null, owned: [] };
}

// Begin a Stripe Checkout purchase; redirects to Stripe's hosted page.
export async function startCheckout(fxId: string): Promise<string | null> {
  try {
    const res = await fetch('/api/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ fxId }),
    });
    const data = await res.json();
    if (res.ok && data.url) return data.url as string;
    return null;
  } catch {
    return null;
  }
}

// Server-backed ownership when payments are live; free effects always owned.
export function ownsServerSide(fxId: string): boolean {
  return getShotFx(fxId).priceUsd === 0 || state.owned.includes(fxId);
}

export interface RedeemResult {
  ok: boolean;
  granted?: string[];
  error?: string;
}

export async function redeemPromo(code: string): Promise<RedeemResult> {
  try {
    const res = await fetch('/api/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ code }),
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      await refreshMe(); // pull the newly granted ownership
      return { ok: true, granted: data.granted };
    }
    return { ok: false, error: data.error ?? 'failed' };
  } catch {
    return { ok: false, error: 'network' };
  }
}

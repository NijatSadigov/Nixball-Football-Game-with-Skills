import { emptyInput, type InputState } from '../shared/physics';

const KEYMAP: Record<string, keyof InputState> = {
  KeyW: 'up',
  ArrowUp: 'up',
  KeyS: 'down',
  ArrowDown: 'down',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  Space: 'kick',
  KeyX: 'kick',
};

export class InputManager {
  state: InputState = emptyInput();
  enabled = false;
  onChange: ((s: InputState) => void) | null = null;
  onSkill: (() => void) | null = null;
  onChatToggle: (() => void) | null = null;

  attach(): void {
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => this.releaseAll());
  }

  private isTyping(): boolean {
    const el = document.activeElement;
    return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (!this.enabled || this.isTyping()) return;
    if (e.code === 'Enter') {
      if (down) this.onChatToggle?.();
      return;
    }
    const key = KEYMAP[e.code];
    if (key) {
      e.preventDefault();
      if (this.state[key] !== down) {
        this.state[key] = down;
        this.onChange?.({ ...this.state });
      }
      return;
    }
    if ((e.code === 'KeyE' || e.code === 'KeyQ') && down) {
      e.preventDefault();
      this.onSkill?.();
    }
  }

  // --- touch controls feed into the same input state ---

  setTouchDir(dir: Pick<InputState, 'up' | 'down' | 'left' | 'right'>): void {
    if (!this.enabled) return;
    let changed = false;
    for (const k of ['up', 'down', 'left', 'right'] as const) {
      if (this.state[k] !== dir[k]) {
        this.state[k] = dir[k];
        changed = true;
      }
    }
    if (changed) this.onChange?.({ ...this.state });
  }

  setKick(down: boolean): void {
    if (!this.enabled) return;
    if (this.state.kick !== down) {
      this.state.kick = down;
      this.onChange?.({ ...this.state });
    }
  }

  releaseAll(): void {
    if (Object.values(this.state).some(Boolean)) {
      this.state = emptyInput();
      this.onChange?.({ ...this.state });
    }
  }
}

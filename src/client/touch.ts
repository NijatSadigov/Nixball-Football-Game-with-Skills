// On-screen controls for touch devices: a left analog stick (mapped to the
// 8-way direction booleans) plus KICK and SKILL buttons on the right.

import type { InputState } from '../shared/physics';

export function isTouchDevice(): boolean {
  return (
    'ontouchstart' in window ||
    navigator.maxTouchPoints > 0 ||
    window.matchMedia('(pointer: coarse)').matches
  );
}

interface TouchHandlers {
  onDir: (dir: Pick<InputState, 'up' | 'down' | 'left' | 'right'>) => void;
  onKick: (down: boolean) => void;
  onSkill: () => void;
}

export class TouchControls {
  private container: HTMLElement;
  private stick: HTMLElement;
  private knob: HTMLElement;
  private kickBtn: HTMLButtonElement;
  private skillBtn: HTMLButtonElement;
  private stickId: number | null = null;
  private dir = { up: false, down: false, left: false, right: false };

  constructor(private handlers: TouchHandlers) {
    this.container = document.getElementById('touch-controls')!;
    this.stick = document.getElementById('touch-stick')!;
    this.knob = document.getElementById('touch-knob')!;
    this.kickBtn = document.getElementById('touch-kick') as HTMLButtonElement;
    this.skillBtn = document.getElementById('touch-skill') as HTMLButtonElement;
    this.attach();
  }

  setVisible(on: boolean): void {
    this.container.classList.toggle('hidden', !on);
    if (!on) this.resetStick();
  }

  private attach(): void {
    // analog stick
    this.stick.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.stickId = e.pointerId;
      this.stick.setPointerCapture(e.pointerId);
      this.moveStick(e);
    });
    this.stick.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.stickId) this.moveStick(e);
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId === this.stickId) {
        this.stickId = null;
        this.resetStick();
      }
    };
    this.stick.addEventListener('pointerup', end);
    this.stick.addEventListener('pointercancel', end);

    // kick button (press-and-hold)
    this.kickBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.handlers.onKick(true);
      this.kickBtn.classList.add('pressed');
    });
    const kickUp = (e: PointerEvent) => {
      e.preventDefault();
      this.handlers.onKick(false);
      this.kickBtn.classList.remove('pressed');
    };
    this.kickBtn.addEventListener('pointerup', kickUp);
    this.kickBtn.addEventListener('pointercancel', kickUp);
    this.kickBtn.addEventListener('pointerleave', kickUp);

    // skill button (tap)
    this.skillBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.handlers.onSkill();
      this.skillBtn.classList.add('pressed');
    });
    const skillUp = () => this.skillBtn.classList.remove('pressed');
    this.skillBtn.addEventListener('pointerup', skillUp);
    this.skillBtn.addEventListener('pointercancel', skillUp);
  }

  private moveStick(e: PointerEvent): void {
    const rect = this.stick.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = e.clientX - cx;
    let dy = e.clientY - cy;
    const max = rect.width / 2;
    const mag = Math.hypot(dx, dy);
    if (mag > max) {
      dx = (dx / mag) * max;
      dy = (dy / mag) * max;
    }
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;

    const dead = max * 0.28;
    const next = { up: false, down: false, left: false, right: false };
    if (mag > dead) {
      // 8-way: a direction is active when its axis component is significant
      const ux = dx / max;
      const uy = dy / max;
      const thr = 0.38;
      if (ux > thr) next.right = true;
      else if (ux < -thr) next.left = true;
      if (uy > thr) next.down = true;
      else if (uy < -thr) next.up = true;
    }
    this.updateDir(next);
  }

  private resetStick(): void {
    this.knob.style.transform = 'translate(0px, 0px)';
    this.updateDir({ up: false, down: false, left: false, right: false });
  }

  private updateDir(next: typeof this.dir): void {
    if (
      next.up === this.dir.up &&
      next.down === this.dir.down &&
      next.left === this.dir.left &&
      next.right === this.dir.right
    ) {
      return;
    }
    this.dir = next;
    this.handlers.onDir({ ...next });
  }
}

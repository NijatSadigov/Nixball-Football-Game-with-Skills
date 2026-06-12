// Tiny synthesized sound effects — no audio assets needed.

export class Sfx {
  private ctx: AudioContext | null = null;

  // must be called from a user gesture at least once (browser autoplay policy)
  unlock(): void {
    this.ensure();
  }

  private ensure(): AudioContext | null {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
      } catch {
        return null;
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  private tone(
    freq: number,
    dur: number,
    opts: { type?: OscillatorType; gain?: number; delay?: number; slideTo?: number } = {},
  ): void {
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + (opts.delay ?? 0);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = opts.type ?? 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (opts.slideTo) osc.frequency.exponentialRampToValueAtTime(opts.slideTo, t0 + dur);
    g.gain.setValueAtTime(opts.gain ?? 0.12, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  kick(): void {
    this.tone(160, 0.09, { type: 'triangle', gain: 0.22, slideTo: 70 });
  }

  perfect(): void {
    this.tone(880, 0.07, { type: 'square', gain: 0.07 });
    this.tone(1320, 0.12, { type: 'square', gain: 0.07, delay: 0.06 });
    this.tone(440, 0.1, { type: 'triangle', gain: 0.18, slideTo: 110 });
  }

  goal(): void {
    this.tone(523, 0.14, { gain: 0.14 });
    this.tone(659, 0.14, { gain: 0.14, delay: 0.12 });
    this.tone(784, 0.3, { gain: 0.16, delay: 0.24 });
  }

  whistle(): void {
    this.tone(2100, 0.18, { type: 'square', gain: 0.05 });
    this.tone(2100, 0.3, { type: 'square', gain: 0.05, delay: 0.26 });
  }

  skill(): void {
    this.tone(300, 0.12, { type: 'sawtooth', gain: 0.07, slideTo: 700 });
  }

  shove(): void {
    this.tone(110, 0.12, { type: 'triangle', gain: 0.24, slideTo: 55 });
  }

  ready(): void {
    this.tone(660, 0.07, { gain: 0.08 });
    this.tone(990, 0.12, { gain: 0.08, delay: 0.07 });
  }
}

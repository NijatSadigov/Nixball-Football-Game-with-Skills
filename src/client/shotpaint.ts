// Paints a cosmetic shot effect at a given progress `t` (0..1). Shared by the
// in-game renderer and the lobby skin previews. All effects are radial so they
// read well without a shot direction; `seed` keeps each burst's layout stable.

export function shotDuration(style: string | undefined): number {
  return style === 'confetti' || style === 'nova' ? 620 : style === 'shock' ? 560 : 420;
}

export function paintShot(
  ctx: CanvasRenderingContext2D,
  style: string,
  x: number,
  y: number,
  s: number,
  t: number,
  seed: number,
): void {
  const a = 1 - t;
  switch (style) {
    case 'flame': {
      const grad = ctx.createRadialGradient(x, y, 2, x, y, (16 + 38 * t) * s);
      grad.addColorStop(0, `rgba(255, 220, 120, ${0.5 * a})`);
      grad.addColorStop(0.5, `rgba(255, 110, 30, ${0.45 * a})`);
      grad.addColorStop(1, 'rgba(255, 60, 0, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, (16 + 38 * t) * s, 0, Math.PI * 2);
      ctx.fill();
      for (let i = 0; i < 9; i++) {
        const ang = seed + i * 2.0;
        const dist = (10 + 50 * t) * s;
        const px = x + Math.cos(ang) * dist * 0.6;
        const py = y + Math.sin(ang) * dist - 40 * t * t * s;
        ctx.fillStyle = `rgba(255, ${150 + ((i * 37) % 90)}, 40, ${a})`;
        ctx.beginPath();
        ctx.arc(px, py, (3.5 - 2.5 * t) * s, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case 'bolt': {
      ctx.strokeStyle = `rgba(120, 220, 255, ${a})`;
      ctx.lineWidth = 2.2;
      ctx.shadowColor = '#5ad1ff';
      ctx.shadowBlur = 8;
      const arcs = 6;
      for (let i = 0; i < arcs; i++) {
        const ang = seed + (i / arcs) * Math.PI * 2;
        const reach = (18 + 46 * t) * s;
        ctx.beginPath();
        ctx.moveTo(x, y);
        let px = x;
        let py = y;
        const segs = 4;
        for (let k = 1; k <= segs; k++) {
          const rr = (reach * k) / segs;
          const jitter = ((((i * 7 + k * 13) % 11) - 5) / 5) * 9 * s;
          px = x + Math.cos(ang) * rr + Math.cos(ang + 1.57) * jitter * (1 - t);
          py = y + Math.sin(ang) * rr + Math.sin(ang + 1.57) * jitter * (1 - t);
          ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
      break;
    }
    case 'confetti': {
      const n = 16;
      for (let i = 0; i < n; i++) {
        const ang = seed + (i / n) * Math.PI * 2 + i;
        const speed = 40 + ((i * 53) % 40);
        const dist = speed * t * s;
        const px = x + Math.cos(ang) * dist;
        const py = y + Math.sin(ang) * dist + 26 * t * t * s; // gravity
        const hues = ['#ff5db4', '#5ad1ff', '#ffe44d', '#43c46b', '#ff9d42'];
        ctx.fillStyle = hues[i % hues.length];
        ctx.globalAlpha = a;
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(ang + t * 6);
        ctx.fillRect(-3 * s, -1.5 * s, 6 * s, 3 * s);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
      break;
    }
    case 'shock': {
      for (let r = 0; r < 3; r++) {
        const rt = t - r * 0.12;
        if (rt < 0 || rt > 1) continue;
        ctx.strokeStyle = `rgba(190, 170, 255, ${(1 - rt) * 0.9})`;
        ctx.lineWidth = (4 - r) * 1.2;
        ctx.beginPath();
        ctx.arc(x, y, (10 + 70 * rt) * s, 0, Math.PI * 2);
        ctx.stroke();
      }
      break;
    }
    case 'nova': {
      ctx.strokeStyle = `rgba(255, 228, 77, ${a})`;
      ctx.lineWidth = 2.5;
      const rays = 10;
      for (let i = 0; i < rays; i++) {
        const ang = seed + (i / rays) * Math.PI * 2;
        const r0 = 8 * s;
        const r1 = (20 + 55 * t) * s;
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(ang) * r0, y + Math.sin(ang) * r0);
        ctx.lineTo(x + Math.cos(ang) * r1, y + Math.sin(ang) * r1);
        ctx.stroke();
      }
      for (let i = 0; i < 7; i++) {
        const ang = seed * 2 + i * 1.6;
        const dist = (14 + 40 * t) * s;
        const px = x + Math.cos(ang) * dist;
        const py = y + Math.sin(ang) * dist;
        ctx.fillStyle = `rgba(255, 245, 190, ${a})`;
        ctx.beginPath();
        ctx.arc(px, py, (2.5 - 1.5 * t) * s, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    default: {
      ctx.beginPath();
      ctx.arc(x, y, (12 + 26 * t) * s, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,255,255,${0.65 * a})`;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
  }
}

import { useLayoutEffect, useRef } from 'react';

// One open stroke with matching vertices: an arc and the existing 24px check.
const arc = Array.from({length:49}, (_, i) => {
  const angle = Math.PI - i / 48 * Math.PI * 1.6;
  return [12 + 9 * Math.cos(angle), 12 + 9 * Math.sin(angle)];
});
const check = arc.map((_, i) => i <= 16
  ? [4 + 5 * i / 16, 12 + 5 * i / 16]
  : [9 + 11 * (i - 16) / 32, 17 - 11 * (i - 16) / 32]);
const pathData = points => points.map(([x,y], i) => `${i ? 'L' : 'M'}${x.toFixed(3)} ${y.toFixed(3)}`).join(' ');
const rotate = (points, angle) => points.map(([x,y]) => [
  12 + (x - 12) * Math.cos(angle) - (y - 12) * Math.sin(angle),
  12 + (x - 12) * Math.sin(angle) + (y - 12) * Math.cos(angle)
]);
const mix = (from, to, t) => from.map(([x,y], i) => [x + (to[i][0] - x) * t, y + (to[i][1] - y) * t]);
const ease = t => t < .5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;

export function CompletionStroke({complete, motion}) {
  const svg = useRef(null);
  const path = useRef(null);
  const initial = useRef(complete ? check : arc);
  const pose = useRef({points:initial.current, spin:null, frame:0, epoch:0, mounted:false});

  useLayoutEffect(() => {
    const current = pose.current;
    const epoch = ++current.epoch;
    const wasSpinning = !!current.spin;
    // Capture the actual rotation before stopping it; never reset to 12 o'clock.
    const angle = wasSpinning ? (Number(current.spin.currentTime) || 0) / 750 * Math.PI * 2 : 0;
    const from = rotate(current.points, angle);
    current.spin?.cancel();
    current.spin = null;
    cancelAnimationFrame(current.frame);
    current.frame = 0;
    const paint = points => {
      current.points = points;
      path.current.setAttribute('d', pathData(points));
    };
    const startSpinner = () => {
      paint(arc);
      svg.current.dataset.progress = motion ? 'spinning' : 'static';
      if (motion) current.spin = svg.current.animate(
        [{transform:'rotate(0deg)'}, {transform:'rotate(360deg)'}],
        {duration:750, iterations:Infinity, easing:'linear'}
      );
    };
    const finish = () => {
      current.frame = 0;
      if (complete) {
        paint(check);
        svg.current.dataset.progress = 'check';
      } else startSpinner();
    };
    const previousComplete = current.complete;
    current.complete = complete;
    if (!current.mounted || !motion || previousComplete === complete) {
      current.mounted = true;
      finish();
      return;
    }

    paint(from);
    svg.current.dataset.progress = complete ? 'morphing' : 'restarting';
    const duration = complete ? 280 : 160;
    const settle = complete && wasSpinning ? 56 : 0;
    // Briefly ease the existing rotation to rest, then unfold that same arc.
    const turn = settle / 750 * Math.PI;
    const settled = rotate(from, turn);
    const target = complete ? check : arc;
    const started = performance.now();
    const frame = now => {
      if (current.epoch !== epoch) return;
      const elapsed = now - started;
      if (elapsed >= duration) {finish(); return;}
      if (elapsed < settle) {
        const t = elapsed / settle;
        paint(rotate(from, turn * (1 - (1 - t) ** 2)));
      } else {
        paint(mix(settled, target, ease((elapsed - settle) / (duration - settle))));
      }
      current.frame = requestAnimationFrame(frame);
    };
    current.frame = requestAnimationFrame(frame);
  }, [complete, motion]);

  useLayoutEffect(() => () => {
    const current = pose.current;
    current.epoch++;
    current.spin?.cancel();
    cancelAnimationFrame(current.frame);
  }, []);

  return <svg ref={svg} className="activity-progress" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path ref={path} d={pathData(initial.current)}/>
  </svg>;
}

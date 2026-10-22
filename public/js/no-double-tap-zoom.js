// iOS Safari can treat two quick taps as a double-tap zoom even with touch-action: manipulation —
// for example when the second tap of a move lands on an element that was just re-rendered. This
// page-wide guard cancels the second of two quick, stationary taps. Cancelling a touch also cancels
// its click, so when that tap was on a button, link or toggle the click is performed directly.
const DOUBLE_TAP_MS = 350;
const MAX_MOVE_PX = 10;

let lastTapEnd = 0;
let start = null;

document.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  start = e.touches.length === 1 ? { x: t.clientX, y: t.clientY, time: Date.now() } : null;
}, { passive: true });

document.addEventListener('touchend', (e) => {
  const now = Date.now();
  const t = e.changedTouches[0];
  const isTap = start && e.touches.length === 0 && now - start.time < 500
    && Math.hypot(t.clientX - start.x, t.clientY - start.y) < MAX_MOVE_PX;
  if (!isTap) {
    lastTapEnd = 0;
    return;
  }
  if (now - lastTapEnd < DOUBLE_TAP_MS && !e.target.closest('input, textarea, select, .promotion')) {
    e.preventDefault();
    const clickable = e.target.closest('button, a[href], summary, label, [role="button"]');
    if (clickable && !clickable.disabled) clickable.click();
  }
  lastTapEnd = now;
}, { passive: false });

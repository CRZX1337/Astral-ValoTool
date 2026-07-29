/* Count-up stats. One-shot per element, driven off a single rAF each. */

import { reduceMotion } from "./env.js";

const DURATION = 1100;

/* easeOutExpo: fast off the line, long settle. Reads as "landing on" a number
   rather than ramping to it. */
const ease = (t) => (t === 1 ? 1 : 1 - 2 ** (-10 * t));

export function initCounters() {
  const targets = document.querySelectorAll("[data-count]");
  if (!targets.length) return;

  const settle = (el) => {
    el.textContent = el.dataset.count;
  };

  if (reduceMotion.matches || !("IntersectionObserver" in window)) {
    for (const el of targets) settle(el);
    return;
  }

  const run = (el) => {
    const target = Number(el.dataset.count);
    if (!Number.isFinite(target)) return settle(el);

    /* Zero has nothing to count to -- "0 ms" is the point, so just show it. */
    if (target === 0) return settle(el);

    const start = performance.now();
    const tick = (now) => {
      const progress = Math.min((now - start) / DURATION, 1);
      el.textContent = String(Math.round(ease(progress) * target));
      if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        run(entry.target);
        observer.unobserve(entry.target);
      }
    },
    { threshold: 0.6 }
  );

  for (const el of targets) observer.observe(el);
}

/* Scroll reveals. Tier A of the motion system: the observer only toggles a
   class, every transition lives in motion.css.

   Elements start *visible* in CSS; the hidden state is gated on
   html.reveal-ready. A throw, a missing API or a blocked script therefore
   leaves a fully readable page rather than a blank one. And if the observer is
   armed but never actually reports back, the deadline below tears the whole
   effect down instead of stranding the page at opacity 0. */

import { reduceMotion } from "./env.js";

const DEADLINE = 1500;

export function initReveal() {
  const targets = document.querySelectorAll(".reveal");
  if (!targets.length) return;

  /* Nothing to animate: leave everything in its visible default state. */
  if (reduceMotion.matches || !("IntersectionObserver" in window)) return;

  let delivered = false;

  const observer = new IntersectionObserver(
    (entries) => {
      delivered = true;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-in");
        /* One-shot: elements don't re-hide on the way back up. */
        observer.unobserve(entry.target);
      }
    },
    { threshold: 0.15, rootMargin: "0px 0px -10% 0px" }
  );

  /* Arm the hidden state, then observe. Anything on screen is reported on the
     next rendering opportunity, which is what animates the hero in. */
  document.documentElement.classList.add("reveal-ready");
  for (const el of targets) observer.observe(el);

  /* If the observer never spoke, abandon the effect entirely rather than
     leave content hidden. setTimeout is not tied to the rendering pipeline,
     so this still fires where rAF and observer callbacks would not. */
  setTimeout(() => {
    if (delivered) return;
    observer.disconnect();
    document.documentElement.classList.remove("reveal-ready");
  }, DEADLINE);
}

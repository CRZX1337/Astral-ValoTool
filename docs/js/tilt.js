/* Pointer-driven 3D tilt and cursor-tracked specular.

   One delegated listener for the whole page, coalesced into a single rAF, so
   hovering a grid of cards costs one frame's work rather than one per card. */

import { reduceMotion, finePointer } from "./env.js";

const MAX_TILT = 7; // degrees

export function initTilt() {
  /* Touch and coarse pointers are excluded: without a hover-out event a card
     can end up stuck at an angle. */
  if (!finePointer.matches || reduceMotion.matches) return;

  const cards = document.querySelectorAll("[data-tilt], .lit");
  if (!cards.length) return;

  let pending = null;
  let frame = 0;

  const apply = () => {
    frame = 0;
    if (!pending) return;

    const { card, x, y } = pending;
    pending = null;

    const box = card.getBoundingClientRect();
    const px = (x - box.left) / box.width;
    const py = (y - box.top) / box.height;

    /* Specular position for .lit -- percentages so the gradient follows the
       cursor regardless of card size. */
    card.style.setProperty("--mx", `${(px * 100).toFixed(1)}%`);
    card.style.setProperty("--my", `${(py * 100).toFixed(1)}%`);

    if (card.matches("[data-tilt]")) {
      /* Invert Y so the card leans toward the cursor, not away from it. */
      card.style.setProperty("--ty", `${((px - 0.5) * 2 * MAX_TILT).toFixed(2)}deg`);
      card.style.setProperty("--tx", `${((0.5 - py) * 2 * MAX_TILT).toFixed(2)}deg`);
    }
  };

  document.addEventListener(
    "pointermove",
    (event) => {
      if (event.pointerType !== "mouse") return;
      const card = event.target.closest("[data-tilt], .lit");
      if (!card) return;

      card.classList.add("is-tilting");
      pending = { card, x: event.clientX, y: event.clientY };
      frame ||= requestAnimationFrame(apply);
    },
    { passive: true }
  );

  /* Reset on leave. Dropping .is-tilting restores the transition so the card
     eases back to flat instead of snapping. */
  document.addEventListener(
    "pointerout",
    (event) => {
      const card = event.target.closest("[data-tilt], .lit");
      if (!card || card.contains(event.relatedTarget)) return;

      card.classList.remove("is-tilting");
      card.style.removeProperty("--tx");
      card.style.removeProperty("--ty");
      card.style.removeProperty("--mx");
      card.style.removeProperty("--my");
    },
    { passive: true }
  );
}

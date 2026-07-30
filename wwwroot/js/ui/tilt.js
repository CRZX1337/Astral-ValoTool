/**
 * Pointer-driven tilt and cursor-tracked specular for the home cards.
 *
 * Ported from the landing site's js/tilt.js: one delegated listener for the
 * whole document coalesced into a single rAF, so hovering a grid of cards costs
 * one frame's work rather than one per card.
 */

const MAX_TILT = 6; // degrees
const SELECTOR = ".tilt";

export function mountTilt() {
  // Touch and coarse pointers are excluded: without a reliable hover-out a card
  // can end up stuck at an angle.
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  let frame = null;
  let pending = null;
  let active = null;

  function apply() {
    frame = null;

    if (!pending) {
      return;
    }

    const { card, x, y, width, height } = pending;
    pending = null;

    // Normalised to -0.5..0.5 around the card's centre.
    const px = x / width - 0.5;
    const py = y / height - 0.5;

    card.style.setProperty("--mx", `${(x / width) * 100}%`);
    card.style.setProperty("--my", `${(y / height) * 100}%`);

    if (!reduceMotion.matches) {
      card.style.transform =
        `perspective(760px) rotateX(${(-py * MAX_TILT).toFixed(2)}deg) ` +
        `rotateY(${(px * MAX_TILT).toFixed(2)}deg) translateZ(0)`;
    }
  }

  function release(card) {
    card.classList.remove("is-tilting");
    card.style.transform = "";
  }

  document.addEventListener("pointermove", (event) => {
    if (!finePointer.matches) {
      return;
    }

    const card = event.target instanceof Element ? event.target.closest(SELECTOR) : null;

    if (card !== active) {
      if (active) {
        release(active);
      }

      active = card;

      if (card) {
        card.classList.add("is-tilting");
      }
    }

    if (!card) {
      return;
    }

    const rect = card.getBoundingClientRect();
    pending = {
      card,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      width: rect.width || 1,
      height: rect.height || 1
    };

    frame ??= requestAnimationFrame(apply);
  });

  // Leaving the window entirely never produces a pointermove over another
  // card, so the last one would otherwise stay tilted.
  document.addEventListener("pointerleave", () => {
    if (active) {
      release(active);
      active = null;
    }
  });

  return function render() {
    // Purely presentational; nothing in the store drives it.
  };
}

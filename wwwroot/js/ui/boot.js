/**
 * The startup splash.
 *
 * Held until the agent list has actually loaded rather than for a fixed time,
 * so it never claims to be doing work it has already finished. A floor stops
 * a warm start from flashing the overlay for two frames.
 */

import { reduceMotion, swapText } from "./motion.js";

/** Long enough to read the wordmark; short enough not to be in the way. */
const MINIMUM_MS = 1100;

/** Matches the boot-out animation in css/motion.css. */
const OUT_MS = 520;

export function mountBoot() {
  const overlay = document.getElementById("boot");
  const status = document.getElementById("bootStatus");

  // Nothing to do if the markup is absent: mark the shell ready so the
  // assemble animations are not left waiting on an element that never existed.
  if (!overlay) {
    document.body.dataset.booted = "true";
    return function render() {};
  }

  // Arming happens here rather than in the stylesheet, so the holds in
  // css/motion.css only ever apply when this module is alive to release them.
  document.body.classList.add("boot-armed");
  overlay.hidden = false;

  const startedAt = performance.now();
  let finished = false;

  function finish() {
    if (finished) {
      return;
    }

    finished = true;
    overlay.classList.add("is-done");
    document.body.dataset.booted = "true";

    // Taken out of the DOM rather than left transparent -- a full-screen
    // overlay that still exists will happily swallow the first click.
    window.setTimeout(() => overlay.remove(), reduceMotion.matches ? 0 : OUT_MS);
  }

  return function render(state) {
    if (finished) {
      return;
    }

    if (state.bootError) {
      // Whatever went wrong is the interface's story to tell, not the splash's.
      finish();
      return;
    }

    swapText(status, state.loaded ? "Ready" : "Reading agent list…");

    if (!state.loaded) {
      return;
    }

    const remaining = Math.max(MINIMUM_MS - (performance.now() - startedAt), 0);
    window.setTimeout(finish, remaining);
  };
}

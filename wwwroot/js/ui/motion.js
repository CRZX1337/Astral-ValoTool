/**
 * Small motion helpers shared by the views.
 *
 * Everything here degrades to "just set the value": the animation is the
 * decoration, never the mechanism, so a stalled frame loop or a reduced-motion
 * preference still leaves correct content on screen.
 */

export const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/** Beyond this many items a stagger stops reading as choreography and starts reading as lag. */
const STAGGER_CAP = 12;

/**
 * Replaces text and re-triggers the swap animation, but only when the text
 * actually changed -- status lines re-render on every stream frame and would
 * otherwise flicker once a second.
 */
export function swapText(element, text) {
  if (!element || element.textContent === text) {
    return;
  }

  element.textContent = text;

  // While a view is settling, text still updates but does so quietly. A tool
  // opens, its deferred refresh lands a moment later, and half a dozen labels
  // animate at once -- which looks exactly like the view rendering a second
  // time. The flourish is worth having later, not here.
  if (reduceMotion.matches || document.body.dataset.settling) {
    return;
  }

  element.classList.remove("is-swapped");
  // Forcing layout is what lets the same animation run twice in a row.
  void element.offsetWidth;
  element.classList.add("is-swapped");
}

/** Writes the stagger index a list's CSS delay is derived from. */
export function stagger(elements, cap = STAGGER_CAP) {
  let index = 0;

  for (const element of elements) {
    element.style.setProperty("--i", String(Math.min(index, cap)));
    index += 1;
  }
}

/**
 * Counts a number up to its target. Easing is easeOutExpo -- fast off the line
 * and a long settle, which reads as landing on a number rather than ramping to
 * it.
 *
 * The final value is also written on a timer, so the number is right even if
 * the frame loop never runs.
 */
export function countUp(element, target, format = (value) => String(value), duration = 620) {
  if (!element) {
    return;
  }

  const to = Number(target) || 0;
  const from = Number(element.dataset.countValue ?? 0);

  element.dataset.countValue = String(to);

  if (reduceMotion.matches || from === to || typeof requestAnimationFrame !== "function") {
    element.textContent = format(to);
    return;
  }

  // Supersedes any run still in flight on this element.
  const run = (Number(element.dataset.countRun ?? 0) + 1) % 1000;
  element.dataset.countRun = String(run);

  const started = performance.now();
  const ease = (t) => (t === 1 ? 1 : 1 - 2 ** (-10 * t));

  const step = (now) => {
    if (element.dataset.countRun !== String(run)) {
      return;
    }

    const progress = Math.min((now - started) / duration, 1);
    element.textContent = format(Math.round(from + (to - from) * ease(progress)));

    if (progress < 1) {
      requestAnimationFrame(step);
    }
  };

  requestAnimationFrame(step);

  // Insurance: whatever happened to the frame loop, the number ends correct.
  window.setTimeout(() => {
    if (element.dataset.countRun === String(run)) {
      element.textContent = format(to);
    }
  }, duration + 60);
}

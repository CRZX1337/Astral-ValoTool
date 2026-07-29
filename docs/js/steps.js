/* How-it-works stepper.

   The sticky visual follows whichever step is nearest the middle of the
   viewport. Deliberately observer-driven rather than computed from scrollY:
   no per-frame math, no jank, and it behaves the same at any zoom level. */

const ICONS = {
  /* Keyed by step, so the sticky orb changes glyph as well as colour. */
  1: '<path d="M12 3v3M12 18v3M3 12h3M18 12h3"/><circle cx="12" cy="12" r="4"/>',
  2: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0M17 5.5l1.6 1.6L22 3.7"/>',
  3: '<path d="M4 12a8 8 0 0 1 8-8M4 17a3 3 0 0 1 3-3M4 7a13 13 0 0 1 13 13"/><circle cx="5" cy="19" r="1.4"/>',
  4: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8.5 10.5V7a3.5 3.5 0 0 1 7 0v3.5"/>',
};

export function initSteps() {
  const visual = document.getElementById("steps-visual");
  const caption = document.getElementById("steps-caption");
  const phase = document.getElementById("steps-phase");
  const icon = document.getElementById("steps-icon");
  const steps = document.querySelectorAll(".step[data-step]");
  if (!visual || !steps.length) return;

  const activate = (step) => {
    if (visual.dataset.step === step.dataset.step) return;

    for (const other of steps) other.toggleAttribute("data-active", other === step);

    visual.dataset.step = step.dataset.step;
    /* data-phase drives --phase in tokens.css, so the orb, ring and pill all
       recolour from this one attribute. */
    visual.dataset.phase = step.dataset.phase;
    if (caption) caption.textContent = step.dataset.caption;
    if (phase) phase.textContent = step.dataset.phaseLabel;
    if (icon) icon.innerHTML = ICONS[step.dataset.step] ?? ICONS[1];
  };

  activate(steps[0]);

  if (!("IntersectionObserver" in window)) return;

  /* A band across the middle of the viewport: whichever step is inside it
     wins. The last one to enter takes precedence when two overlap. */
  const observer = new IntersectionObserver(
    (entries) => {
      const hit = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (hit) activate(hit.target);
    },
    { rootMargin: "-45% 0px -45% 0px" }
  );

  for (const step of steps) observer.observe(step);
}

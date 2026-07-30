/**
 * Keeps every range input's `--fill` in step with its value.
 *
 * A native range gives you no way to style the run behind the knob: WebKit has
 * no ::-webkit-slider-progress at all. The track is painted with a hard-stop
 * gradient in css/controls.css instead, and this supplies the stop position.
 *
 * Delegated rather than bound per input, so sliders that appear later — the
 * settings dialog builds its rows on open — need no extra wiring.
 */

function paint(slider) {
  const min = Number(slider.min) || 0;
  const max = Number(slider.max);
  const span = (Number.isFinite(max) ? max : 100) - min;
  const value = Number(slider.value) || 0;

  // A zero-width range would divide by zero; treat it as full.
  const ratio = span > 0 ? (value - min) / span : 1;
  slider.style.setProperty("--fill", `${Math.min(Math.max(ratio, 0), 1) * 100}%`);
}

function paintAll() {
  for (const slider of document.querySelectorAll('input[type="range"]')) {
    paint(slider);
  }
}

export function mountControls() {
  document.addEventListener("input", (event) => {
    if (event.target instanceof HTMLInputElement && event.target.type === "range") {
      paint(event.target);
    }
  });

  paintAll();

  return function render() {
    // Values are also written straight to `.value` by the settings and
    // auto-queue views, which fires no input event -- so repaint on render.
    paintAll();
  };
}

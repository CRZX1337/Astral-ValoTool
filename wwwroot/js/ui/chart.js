/**
 * The one chart primitive the tools share.
 *
 * Renders an SVG line chart: horizontal colour bands behind the line,
 * gridlines at fixed values, a polyline through the points, and a focusable
 * dot per point that carries a `data-tip` for the app's shared tooltip
 * (js/ui/tooltip.js) -- no second tooltip implementation here.
 *
 * The component knows nothing about ranks or maps. The caller turns its data
 * into points and colours; the pieces it draws (bands, grid, line, points)
 * are the ones the map stats and dashboard sparklines build on later.
 *
 * Cost rules, same as the rest of the UI: repaint only when the series
 * actually changes, and only when the container's width changes (the
 * ResizeObserver). Every SSE frame that carries the same matches is a no-op.
 * The view paints while hidden -- the tracker deliberately renders early so
 * opening it shows finished content -- and a hidden container measures 0, so
 * a fallback canvas is used until the observer reports a real width.
 */

import { reduceMotion, stagger } from "./motion.js";

/** Height of the plot area, and the viewBox height. */
const HEIGHT = 150;

/** Side padding in viewBox units, so end points and edge labels breathe. */
const PAD = 14;

/**
 * The canvas before the container has a real width. Rendering is cheap and
 * the observer corrects it as soon as the view is on screen, so this only
 * needs to be the right order of magnitude, not the right pixels.
 */
const FALLBACK_WIDTH = 800;

/** How far a hit area reaches past its dot -- a 4px dot is not a target. */
const HIT_RADIUS = 12;

export function mountChart(root) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${FALLBACK_WIDTH} ${HEIGHT}`);
  root.append(svg);

  const bands = document.createElementNS("http://www.w3.org/2000/svg", "g");
  bands.classList.add("journey-bands");
  const grid = document.createElementNS("http://www.w3.org/2000/svg", "g");
  grid.classList.add("journey-grid");
  const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  line.classList.add("journey-line");
  // A unit dash length: the draw-in animation just runs stroke-dashoffset
  // from 1 to 0, whatever the path's real length happens to be.
  line.setAttribute("pathLength", "1");
  const points = document.createElementNS("http://www.w3.org/2000/svg", "g");
  points.classList.add("journey-points");
  const xLabels = document.createElementNS("http://www.w3.org/2000/svg", "g");
  xLabels.classList.add("journey-xlabels");
  svg.append(bands, grid, line, points, xLabels);

  let lastSeries = null;
  let lastOpts = null;
  let signature = null;

  function measure() {
    return root.clientWidth || FALLBACK_WIDTH;
  }

  function repaint() {
    if (lastSeries === null) {
      return;
    }

    paint(false);
  }

  // ResizeObserver rather than window resize: the chart lives inside a view
  // that is hidden by default, and window events cannot tell the two apart.
  // Firing when a hidden view turns visible (0 -> real width) is exactly the
  // moment the fallback canvas has to give way to the real one.
  const observer = new ResizeObserver(repaint);
  observer.observe(root);

  return function render(series, opts = {}) {
    lastSeries = series;
    lastOpts = opts;

    const next = signatureOf(series, opts);
    const animated = next !== signature;
    signature = next;

    paint(animated);
  };

  /**
   * What the chart draws, enough to tell "same picture" from "different".
   * Tips are left out: they are derived from the same fields as the y value
   * and the colours, so they cannot change on their own.
   */
  function signatureOf(series, opts) {
    const values = series.map((point) => `${point.y}|${point.color ?? ""}|${point.bandColor ?? ""}`);
    return `${values.join(",")}|${opts.yMin ?? ""}|${opts.yMax ?? ""}|${(opts.grid ?? []).join(".")}|${(opts.xLabels ?? []).join("|")}`;
  }

  function paint(animated) {
    const series = (lastSeries ?? []).filter((point) => Number.isFinite(point.y));
    const opts = lastOpts ?? {};
    const count = series.length;
    const width = measure();

    svg.setAttribute("viewBox", `0 0 ${width} ${HEIGHT}`);

    // The bands fill the whole tier height and the domain always starts at 0
    // (a tier's RR scale), so the plot area is the full canvas and the domain
    // only ever grows upward for Radiant overflow. The guards below would
    // handle any domain either way.
    const yMin = opts.yMin ?? 0;
    const yMax = opts.yMax ?? 100;
    const span = yMax - yMin || 1;
    const xAt = (i) => (count === 1 ? width / 2 : PAD + (i * (width - PAD * 2)) / (count - 1));
    const yAt = (value) => HEIGHT - ((value - yMin) / span) * HEIGHT;

    paintBands(series, count, width, xAt, animated);
    paintGrid(opts, yMin, yMax, width, yAt);
    paintLine(series, count, xAt, yAt, animated);
    paintPoints(series, count, xAt, yAt, animated);
    paintXLabels(opts, width);
  }

  function paintBands(series, count, width, xAt, animated) {
    const fragment = document.createDocumentFragment();

    for (let i = 0; i < count; i++) {
      const colour = series[i].bandColor;

      // A match without a tier colour has nothing to draw -- a transparent
      // rect would be wasted DOM. The segment just shows background instead.
      if (!colour) {
        continue;
      }

      // Consecutive points in the same tier produce adjacent rects of the
      // same colour; rebuilding them as separate rects keeps the x positions
      // exact without ever blending colours the assets did not supply.
      const from = xAt(i);
      const to = i + 1 < count ? xAt(i + 1) : width - PAD;
      const rect = element("rect", {
        class: "journey-band",
        x: String(from),
        y: "0",
        width: String(Math.max(to - from, 0)),
        height: String(HEIGHT)
      });

      // The fill opacity lives in the attribute rather than the CSS class so
      // the settle-in animation (which animates the CSS opacity property to 1
      // and keeps that value) multiplies to the intended dimness instead of
      // overriding it. The final band of the chart reaches to the right edge:
      // that is "the tier you are in now".
      rect.setAttribute("fill", colour);
      rect.setAttribute("fill-opacity", "0.13");

      if (animated && !reduceMotion.matches) {
        rect.classList.add("is-new");
      }

      fragment.append(rect);
    }

    bands.replaceChildren(fragment);
  }

  function paintGrid(opts, yMin, yMax, width, yAt) {
    const fragment = document.createDocumentFragment();

    for (const value of opts.grid ?? []) {
      if (value < yMin || value > yMax) {
        continue;
      }

      const at = yAt(value);
      const rule = element("line", {
        class: "journey-grid",
        x1: String(PAD),
        y1: String(at),
        x2: String(width - PAD),
        y2: String(at)
      });
      fragment.append(rule);

      const label = element("text", {
        class: "journey-grid-label",
        x: String(PAD + 2),
        y: String(at - 3)
      });
      label.textContent = String(value);
      fragment.append(label);
    }

    grid.replaceChildren(fragment);
  }

  function paintLine(series, count, xAt, yAt, animated) {
    // One point is a standing, not a line.
    if (count < 2) {
      line.removeAttribute("points");
      line.classList.remove("is-drawing", "is-drawn");
      return;
    }

    line.setAttribute("points", series.map((point, i) => `${xAt(i)},${yAt(point.y)}`).join(" "));

    if (animated && !reduceMotion.matches) {
      // Draw-in, in two committed styles so the transition has a from-state
      // to leave: parked with the whole dash offset out, then -- a frame
      // later, once that style is on screen -- let the .is-drawn transition
      // carry it back in. The timeout is insurance for the same case as
      // countUp's: a stalled frame loop must not leave the line invisible.
      line.classList.remove("is-drawn");
      line.classList.add("is-drawing");

      const draw = () => {
        line.classList.remove("is-drawing");
        line.classList.add("is-drawn");
      };

      requestAnimationFrame(draw);
      window.setTimeout(draw, 900);
    } else {
      line.classList.remove("is-drawing", "is-drawn");
    }
  }

  function paintPoints(series, count, xAt, yAt, animated) {
    const fragment = document.createDocumentFragment();
    const dots = [];

    for (let i = 0; i < count; i++) {
      const point = series[i];
      const cx = xAt(i);
      const cy = yAt(point.y);

      // The transparent hit circle is the interactive half: a bigger target
      // for the pointer and for the keyboard, and the `data-tip` trigger for
      // the shared tooltip. The visible dot draws on top with pointer-events
      // off so every hover lands on the same element.
      const hit = element("circle", {
        class: "journey-point-hit",
        cx: String(cx),
        cy: String(cy),
        r: String(HIT_RADIUS),
        tabindex: "0"
      });
      hit.setAttribute("data-tip", point.tip ?? "");
      hit.setAttribute("role", "img");
      hit.setAttribute("aria-label", point.aria ?? point.tip ?? "");
      fragment.append(hit);

      if (point.current && point.color) {
        const halo = element("circle", {
          class: "journey-halo",
          cx: String(cx),
          cy: String(cy),
          r: "9"
        });
        halo.setAttribute("fill", point.color);
        halo.setAttribute("fill-opacity", "0.18");
        fragment.append(halo);
      }

      const dot = element("circle", {
        class: "journey-point",
        cx: String(cx),
        cy: String(cy),
        r: point.current ? "5.5" : "4.5"
      });

      // The colour is a presentation attribute because SVG attributes cannot
      // read CSS variables; the class default (--brand) covers its absence.
      if (point.color) {
        dot.setAttribute("fill", point.color);
      }

      if (point.current) {
        dot.classList.add("is-current");
      }

      if (animated && !reduceMotion.matches) {
        dot.classList.add("is-new");
        dots.push(dot);
      }

      fragment.append(dot);
    }

    // The dots pop in left to right, capped so a long history stays a nudge
    // rather than turning into a wave -- the same convention the agent grid
    // and match list use.
    if (dots.length > 0) {
      stagger(dots);
    }

    points.replaceChildren(fragment);
  }

  function paintXLabels(opts, width) {
    const fragment = document.createDocumentFragment();

    (opts.xLabels ?? []).forEach((text, i) => {
      if (!text) {
        return;
      }

      const label = element("text", {
        class: "journey-x-label",
        x: i === 0 ? String(PAD) : String(width - PAD),
        y: String(HEIGHT - 4),
        "text-anchor": i === 0 ? "start" : "end"
      });
      label.textContent = text;
      fragment.append(label);
    });

    xLabels.replaceChildren(fragment);
  }
}

function element(tag, attributes) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);

  for (const [name, value] of Object.entries(attributes)) {
    node.setAttribute(name, value);
  }

  return node;
}

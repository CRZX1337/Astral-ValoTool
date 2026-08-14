/**
 * Map intelligence view: personal per-map statistics over the competitive
 * history the rank tracker already holds. Pure rendering -- the sums live in
 * stats/map-stats.js and this file only turns them into DOM.
 *
 * Same cost rules as the tracker: the DOM is only rebuilt when the matches
 * actually change, and the view paints even while hidden so opening it shows
 * finished content.
 */

import { refreshTrackerState } from "../store.js";
import { stagger, swapText } from "./motion.js";
import { aggregateMapStats } from "../stats/map-stats.js";

/** Form chips to the result tone they stand for. */
const FORM_RESULTS = { W: "win", L: "loss", D: "draw", "—": "unknown" };

/**
 * What the average RR bar's fill may reach past the centre. Riot's RR changes
 * rarely exceed thirty either way, so that is the scale; anything past it caps
 * at half the track and the label still tells the truth.
 */
const AVG_RR_SCALE = 30;

export function mountMaps() {
  const refreshButton = document.getElementById("mapsRefresh");
  const refreshLabel = document.getElementById("mapsRefreshLabel");
  const updated = document.getElementById("mapsUpdated");
  const alert = document.getElementById("mapsAlert");
  const grid = document.getElementById("mapGrid");
  const empty = document.getElementById("mapsEmpty");
  const compare = document.getElementById("mapCompare");
  const compareEmpty = document.getElementById("compareEmpty");

  refreshButton.addEventListener("click", () => void refreshTrackerState());

  let renderedSignature = null;

  // Deliberately paints while the view is hidden, like the tracker: the maps
  // are computed from the same matches, and opening the tool must not show a
  // moment of blank cards while the aggregation runs.
  return function render(state) {
    const tracker = state.tracker;
    const busy = state.trackerPending || Boolean(tracker?.isLoading);

    refreshButton.disabled = busy;
    refreshButton.classList.toggle("is-busy", busy);
    refreshLabel.textContent = busy ? "Loading…" : "Refresh";

    alert.hidden = !tracker?.error;
    alert.textContent = tracker?.error ?? "";

    swapText(updated, tracker?.updatedAt
      ? `Updated ${new Date(tracker.updatedAt).toLocaleTimeString()}`
      : "Not loaded yet.");

    const matches = tracker?.matches ?? [];
    const signature = matches.map((match) => `${match.matchId}:${match.rrChange}`).join("|");

    if (signature !== renderedSignature) {
      renderedSignature = signature;
      paintOverview(grid, matches);
      paintCompare(compare, matches);
    }

    empty.hidden = matches.length > 0;

    if (matches.length === 0) {
      empty.textContent = tracker?.updatedAt
        ? "Play a competitive match to see your map breakdown."
        : "Refresh to load your recent matches.";
    }

    const noCompare = matches.length <= 1;
    compare.hidden = noCompare;
    compareEmpty.hidden = !noCompare;
    compareEmpty.textContent = matches.length === 0
      ? "Play a competitive match to see your map breakdown."
      : "One map in your history — play more maps to compare.";
  };
}

function paintOverview(grid, matches) {
  const { maps } = aggregateMapStats(matches);
  const fragment = document.createDocumentFragment();

  for (const map of maps) {
    const card = document.createElement("div");
    card.className = "map-card";

    const head = document.createElement("div");
    head.className = "map-card-head";

    const name = document.createElement("div");
    name.className = "map-card-name";
    name.textContent = map.name;
    name.classList.toggle("is-unknown", map.name === "Unknown map");
    head.append(name);

    const played = document.createElement("div");
    played.className = "map-card-meta";
    played.textContent = `${map.played} match${map.played === 1 ? "" : "es"}`;
    head.append(played);

    card.append(head);

    const rate = document.createElement("div");
    rate.className = "map-card-rate";
    rate.textContent = `${Math.round(map.winrate * 100)}%`;
    rate.classList.add(map.winrate >= 0.5 ? "is-up" : "is-down");
    rate.title = `${map.wins} wins of ${map.played} matches`;
    card.append(rate);

    const rows = document.createElement("div");
    rows.className = "map-card-rows";
    rows.append(metricRow("Avg RR", formatRr(map.avgRr), signClass(map.avgRr)));
    rows.append(metricRow("Net RR", formatRr(map.netRr), signClass(map.netRr)));
    rows.append(metricRow("W / L / D", `${map.wins} / ${map.losses} / ${map.draws}`, ""));
    card.append(rows);

    const form = document.createElement("div");
    form.className = "map-form";
    form.setAttribute("aria-label", `Recent results on ${map.name}`);

    for (const result of map.form) {
      const chip = document.createElement("span");
      chip.className = "map-form-chip";
      chip.dataset.result = FORM_RESULTS[result] ?? "unknown";
      chip.textContent = result;
      form.append(chip);
    }

    card.append(form);
    fragment.append(card);
  }

  stagger(fragment.children);
  grid.replaceChildren(fragment);
}

function metricRow(label, value, tone) {
  const row = document.createElement("div");
  row.className = "map-card-row";

  const term = document.createElement("span");
  term.className = "map-card-row-label";
  term.textContent = label;

  const detail = document.createElement("span");
  detail.className = "map-card-row-value";

  // Only a real class may be added; classList.add("") throws.
  if (tone) {
    detail.classList.add(tone);
  }

  detail.textContent = value;

  row.append(term, detail);
  return row;
}

function signClass(value) {
  if (value === null) {
    return "";
  }

  return value > 0 ? "is-up" : value < 0 ? "is-down" : "";
}

function formatRr(value) {
  if (value === null) {
    return "—";
  }

  const rounded = Math.round(value * 10) / 10;
  const sign = rounded > 0 ? "+" : "";
  return `${sign}${rounded}`;
}

function paintCompare(container, matches) {
  const { maps } = aggregateMapStats(matches);

  // Strongest first: winrate, then net RR, then name for stability.
  const ranked = [...maps].sort(
    (a, b) => (b.winrate ?? 0) - (a.winrate ?? 0) || b.netRr - a.netRr || a.name.localeCompare(b.name)
  );

  const fragment = document.createDocumentFragment();

  for (const map of ranked) {
    const row = document.createElement("div");
    row.className = "compare-row";

    const name = document.createElement("div");
    name.className = "compare-name";
    name.textContent = map.name;
    row.append(name);

    const bars = document.createElement("div");
    bars.className = "compare-bars";
    bars.append(compareBar("Winrate", `${Math.round(map.winrate * 100)}%`, Math.round(map.winrate * 100), null));
    bars.append(compareBar("Avg RR", formatRr(map.avgRr), avgFill(map.avgRr), avgTone(map.avgRr)));
    row.append(bars);

    const net = document.createElement("div");
    net.className = "compare-net";
    const netTone = signClass(map.netRr);
    if (netTone) {
      net.classList.add(netTone);
    }

    net.textContent = formatRr(map.netRr);
    row.append(net);

    fragment.append(row);
  }

  stagger(fragment.children);
  container.replaceChildren(fragment);
}

/**
 * A labelled bar. `fill` is a percentage of the track; `tone` null means the
 * plain left-aligned green fill (winrate), true/false push the fill to the
 * positive/negative half around the centre (avg RR).
 */
function compareBar(label, text, fill, tone) {
  const wrap = document.createElement("div");
  wrap.className = "compare-bar";

  const track = document.createElement("div");
  track.className = "compare-bar-track";
  track.setAttribute("role", "img");
  track.setAttribute("aria-label", `${label}: ${text}`);

  const fillEl = document.createElement("div");
  fillEl.className = "compare-bar-fill";
  fillEl.style.setProperty("--w", `${fill}%`);

  if (tone === true) {
    fillEl.classList.add("is-positive");
  } else if (tone === false) {
    fillEl.classList.add("is-negative");
  }

  track.append(fillEl);
  wrap.append(track, text);
  return wrap;
}

function avgFill(value) {
  if (value === null) {
    return 0;
  }

  return Math.min(Math.abs(value) / AVG_RR_SCALE, 1) * 50;
}

function avgTone(value) {
  if (value === null) {
    return null;
  }

  return value > 0;
}
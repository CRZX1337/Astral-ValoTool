/**
 * The phone's Maps tab: personal per-map rows over the tracked matches.
 * Same aggregation as the desktop maps view -- this page only renders it.
 */

import { aggregateMapStats } from "../stats/map-stats.js";
import { stagger, swapText } from "../ui/motion.js";
import { agentsVersion, paintForm, pct } from "./home.js";
import { relativeTime } from "./shell.js";

export function mountMaps() {
  const cards = document.getElementById("mapCards");
  const empty = document.getElementById("mapsEmpty");
  const updated = document.getElementById("mapsUpdated");

  let renderedSignature = null;

  return function render(state) {
    const tracker = state.tracker;
    const matches = tracker?.matches ?? [];

    const signature = matches.map((match) => `${match.matchId}:${match.rrChange}`).join("|") + agentsVersion(state.agents);

    if (signature !== renderedSignature) {
      renderedSignature = signature;
      paintCards(aggregateMapStats(matches).maps);
    }

    empty.hidden = matches.length > 0;
    swapText(updated, tracker?.updatedAt ? `Updated ${relativeTime(tracker.updatedAt)}` : "Not loaded yet.");
  };

  function paintCards(maps) {
    cards.textContent = "";

    for (const map of maps) {
      cards.appendChild(mapCard(map));
    }

    stagger(cards.children);
  }
}

function mapCard(map) {
  const card = document.createElement("div");
  card.className = "map-card";

  const head = document.createElement("div");
  head.className = "map-card-head";

  const name = document.createElement("span");
  name.className = "map-card-name";
  name.textContent = map.name;
  name.classList.toggle("is-unknown", map.name === "Unknown map");

  const rate = document.createElement("span");
  rate.className = "map-card-rate";
  rate.textContent = pct(map.winrate);

  if (map.winrate !== null) {
    rate.classList.toggle("is-up", map.winrate >= 0.5);
    rate.classList.toggle("is-down", map.winrate < 0.5);
  }

  head.append(name, rate);

  const rows = document.createElement("div");
  rows.className = "map-card-rows";

  const played = document.createElement("span");
  played.textContent = `${map.played} played`;

  const record = document.createElement("span");
  record.textContent = `${map.wins}W ${map.losses}L ${map.draws}D`;

  const net = document.createElement("span");
  net.textContent = `${map.netRr > 0 ? "+" : ""}${map.netRr} RR`;

  rows.append(played, record, net);

  const form = document.createElement("div");
  form.className = "form-row";
  paintForm(form, map.form);

  card.append(head, rows, form);
  return card;
}
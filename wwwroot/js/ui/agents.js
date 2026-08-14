/**
 * Agent intelligence view: personal per-agent statistics over the competitive
 * history the rank tracker already holds, plus the agent x map heatmap.
 * Pure rendering -- the sums live in stats/agent-stats.js and this file only
 * turns them into DOM, resolving agent ids to names and portraits through the
 * agent assets the store already holds.
 *
 * Same cost rules as the maps view: the DOM is only rebuilt when the matches
 * actually change, and the view paints even while hidden.
 */

import { refreshTrackerState } from "../store.js";
import { stagger, swapText } from "./motion.js";
import { aggregateAgentMapStats, aggregateAgentStats, agentLookup, MIN_CELL_SAMPLE, UNKNOWN_AGENT } from "../stats/agent-stats.js";

/** Form chips to the result tone they stand for (mirrors the maps view). */
const FORM_RESULTS = { W: "win", L: "loss", D: "draw", "—": "unknown" };

export function mountAgents() {
  const refreshButton = document.getElementById("agentsRefresh");
  const refreshLabel = document.getElementById("agentsRefreshLabel");
  const updated = document.getElementById("agentsUpdated");
  const alert = document.getElementById("agentsAlert");
  const overview = document.getElementById("agentsOverview");
  const empty = document.getElementById("agentsEmpty");
  const heatmap = document.getElementById("agentMap");
  const heatEmpty = document.getElementById("agentMapEmpty");

  refreshButton.addEventListener("click", () => void refreshTrackerState());

  let renderedSignature = null;

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
    // Agent ids land asynchronously, so they are part of the paint signature:
    // an enrichment finishing must repaint the overview and heatmap in place.
    // The agents version guards the reverse order -- the catalogue arriving
    // after the first tracker paint -- so ids are never stuck unresolved.
    const signature = matches
      .map((match) => `${match.matchId}:${match.rrChange}:${match.agentId ?? ""}`)
      .join("|") + agentsVersion(state.agents);

    if (signature !== renderedSignature) {
      renderedSignature = signature;
      const byId = agentLookup(state.agents);
      paintOverview(overview, matches, byId);
      paintHeatmap(heatmap, matches, byId);
    }

    empty.hidden = matches.length > 0;

    if (matches.length === 0) {
      empty.textContent = tracker?.updatedAt
        ? "Play a competitive match to see your agent breakdown."
        : "Refresh to load your recent matches.";
    }

    const hasKnown = matches.some((match) => match.agentId);
    const noHeat = matches.length === 0 || !hasKnown;

    heatmap.hidden = noHeat;
    heatEmpty.hidden = !noHeat;

    if (matches.length > 0 && !hasKnown) {
      heatEmpty.textContent = "No agent resolved yet — it lands in a moment once the match details are in.";
    } else {
      heatEmpty.textContent = matches.length === 0
        ? "Play a competitive match to see your agent breakdown."
        : "Play matches on more maps to compare agents.";
    }
  };
}

/**
 * A compact fingerprint of the agent records, for repaint signatures: the
 * ids alone do not move when the catalogue lands after the first tracker
 * render (the mobile views use the same guard).
 */
function agentsVersion(agents) {
  return `|agents:${(agents ?? []).map((agent) => `${agent.value}@${agent.name}`).join(",")}`;
}

/**
 * Turns an agent id into display assets. `null` for ids the store does not
 * know (never-loaded assets, malformed ids): the caller shows the fallback.
 */
function resolveAgent(id, byId) {
  if (typeof id !== "string" || id === "") {
    return null;
  }

  return byId.get(id) ?? null;
}

function paintOverview(grid, matches, byId) {
  const { agents } = aggregateAgentStats(matches);
  const fragment = document.createDocumentFragment();

  for (const agent of agents) {
    const assets = agent.id === UNKNOWN_AGENT ? null : resolveAgent(agent.id, byId);
    // A raw character uuid is never a user-facing name: unknown ids read as
    // the shared sentinel instead.
    const name = assets?.name ?? UNKNOWN_AGENT;
    const card = document.createElement("div");
    card.className = "agent-stats-card";

    const head = document.createElement("div");
    head.className = "agent-stats-card-head";

    const art = document.createElement("div");
    art.className = "agent-stats-card-art";

    const portrait = document.createElement("img");
    portrait.className = "agent-stats-card-portrait";
    portrait.alt = "";
    portrait.loading = "lazy";
    portrait.decoding = "async";
    portrait.hidden = true;

    if (assets?.portrait) {
      portrait.src = assets.portrait;
      portrait.hidden = false;
    } else {
      const monogram = document.createElement("span");
      monogram.className = "agent-stats-card-monogram";
      monogram.setAttribute("aria-hidden", "true");
      monogram.textContent = assets?.name?.[0] ?? "?";
      art.append(monogram);
    }

    art.append(portrait);

    const identity = document.createElement("div");
    identity.className = "agent-stats-card-identity";

    const nameEl = document.createElement("div");
    nameEl.className = "agent-stats-card-name";
    nameEl.textContent = name;
    nameEl.classList.toggle("is-unknown", !assets);
    identity.append(nameEl);

    const played = document.createElement("div");
    played.className = "map-card-meta";
    played.textContent = `${agent.played} match${agent.played === 1 ? "" : "es"}`;
    identity.append(played);

    head.append(art, identity);

    const rate = document.createElement("div");
    rate.className = "map-card-rate";
    rate.textContent = `${Math.round(agent.winrate * 100)}%`;
    rate.classList.add(agent.winrate >= 0.5 ? "is-up" : "is-down");
    rate.title = `${agent.wins} wins of ${agent.played} matches`;
    head.append(rate);

    card.append(head);

    const rows = document.createElement("div");
    rows.className = "map-card-rows";
    rows.append(metricRow("Avg RR", formatRr(agent.avgRr), signClass(agent.avgRr)));
    rows.append(metricRow("Net RR", formatRr(agent.netRr), signClass(agent.netRr)));
    rows.append(metricRow("W / L / D", `${agent.wins} / ${agent.losses} / ${agent.draws}`, ""));
    card.append(rows);

    const form = document.createElement("div");
    form.className = "map-form";
    form.setAttribute("aria-label", `Recent results with ${name}`);

    for (const result of agent.form) {
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

function paintHeatmap(container, matches, byId) {
  const { cells, agents, maps } = aggregateAgentMapStats(matches);

  const table = document.createElement("table");
  table.className = "agent-map";
  table.setAttribute("aria-label", "Agent performance by map");

  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  headRow.append(document.createElement("th"));

  for (const map of maps) {
    const th = document.createElement("th");
    th.className = "agent-map-map";
    th.textContent = map;
    headRow.append(th);
  }

  head.append(headRow);
  table.append(head);

  const body = document.createElement("tbody");

  for (const agent of agents) {
    const assets = agent === UNKNOWN_AGENT ? null : resolveAgent(agent, byId);
    // A raw character uuid is never a user-facing name: unknown ids read as
    // the shared sentinel instead.
    const displayName = assets?.name ?? UNKNOWN_AGENT;
    const row = document.createElement("tr");
    row.className = "agent-map-row";

    const agentCell = document.createElement("th");
    agentCell.className = "agent-map-agent";
    agentCell.scope = "row";

    const mark = document.createElement("span");
    mark.className = "agent-map-mark";

    const portrait = document.createElement("img");
    portrait.className = "agent-map-portrait";
    portrait.alt = "";
    portrait.loading = "lazy";
    portrait.decoding = "async";
    portrait.hidden = true;

    if (assets?.portrait) {
      portrait.src = assets.portrait;
      portrait.hidden = false;
    } else {
      const monogram = document.createElement("span");
      monogram.className = "agent-map-monogram";
      monogram.setAttribute("aria-hidden", "true");
      monogram.textContent = assets?.name?.[0] ?? "?";
      mark.append(monogram);
    }

    mark.append(portrait);

    const nameEl = document.createElement("span");
    nameEl.className = "agent-map-agent-name";
    nameEl.textContent = displayName;
    nameEl.classList.toggle("is-unknown", !assets);

    agentCell.append(mark, nameEl);
    row.append(agentCell);

    for (const map of maps) {
      const cell = cells.find((entry) => entry.agent === agent && entry.map === map);
      const td = document.createElement("td");
      td.className = "agent-map-cell";

      if (!cell) {
        td.classList.add("is-empty");
        td.setAttribute("aria-label", `${displayName} on ${map}: no matches`);
        row.append(td);
        continue;
      }

      const small = cell.played < MIN_CELL_SAMPLE;
      td.classList.add(small ? "is-thin" : cell.winrate >= 0.5 ? "is-up" : "is-down");
      td.setAttribute("aria-label",
        `${displayName} on ${map}: ${cell.played} match${cell.played === 1 ? "" : "es"}, ` +
        `${cell.wins} win${cell.wins === 1 ? "" : "s"}, ${cell.losses} loss${cell.losses === 1 ? "" : "es"}, ` +
        `${formatRr(cell.netRr)} RR`);

      const played = document.createElement("span");
      played.className = "agent-map-cell-played";
      played.textContent = `${cell.played}`;
      played.title = `${cell.played} match${cell.played === 1 ? "" : "es"}`;
      td.append(played);

      const rate = document.createElement("span");
      rate.className = "agent-map-cell-rate";
      rate.textContent = small ? "–" : `${Math.round(cell.winrate * 100)}%`;
      td.append(rate);

      const net = document.createElement("span");
      net.className = "agent-map-cell-net";
      net.textContent = small ? "–" : formatRr(cell.netRr);
      td.append(net);

      row.append(td);
    }

    body.append(row);
  }

  table.append(body);

  // Cells, not the rows: opacity animation on <tr> elements is unreliable.
  for (const row of table.querySelectorAll(".agent-map-row")) {
    stagger(row.children);
  }

  container.replaceChildren(table);
}
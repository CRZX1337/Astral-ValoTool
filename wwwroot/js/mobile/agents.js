/**
 * The phone's Agents tab: personal per-agent rows plus one "best pairing"
 * card (agent x map). The rows are enriched with the agent assets the
 * desktop grid already loaded -- portraits and role accents -- and unknown
 * ids fall back to a neutral monogram rather than a broken image.
 */

import {
  MIN_CELL_SAMPLE,
  aggregateAgentMapStats,
  aggregateAgentStats,
  agentLookup
} from "../stats/agent-stats.js";
import { stagger, swapText } from "../ui/motion.js";
import { agentsVersion, paintForm, pct, resolveName } from "./home.js";
import { relativeTime } from "./shell.js";

export function mountAgents() {
  const cards = document.getElementById("agentCards");
  const bestCard = document.getElementById("bestCard");
  const bestLine = document.getElementById("bestLine");
  const empty = document.getElementById("agentsEmpty");
  const updated = document.getElementById("agentsUpdated");

  let renderedSignature = null;

  return function render(state) {
    const tracker = state.tracker;
    const matches = tracker?.matches ?? [];
    const byId = agentLookup(state.agents);

    const signature = matches.map((match) => `${match.matchId}:${match.rrChange}:${match.agentId ?? ""}`).join("|") + agentsVersion(state.agents);

    if (signature !== renderedSignature) {
      renderedSignature = signature;
      paintCards(aggregateAgentStats(matches).agents, byId);
      paintBest(aggregateAgentMapStats(matches).cells, byId);
    }

    empty.hidden = matches.length > 0;
    swapText(updated, tracker?.updatedAt ? `Updated ${relativeTime(tracker.updatedAt)}` : "Not loaded yet.");
  };

  function paintCards(agents, byId) {
    cards.textContent = "";

    for (const agent of agents) {
      cards.appendChild(agentCard(agent, byId));
    }

    stagger(cards.children);
  }

  function paintBest(cells, byId) {
    // Only cells with a real sample count; among those, the best winrate,
    // ties by plays. One match is a coin flip, not a pairing.
    const qualified = (cells ?? []).filter((cell) => cell.played >= MIN_CELL_SAMPLE && cell.winrate !== null);

    qualified.sort((a, b) => b.winrate - a.winrate || b.played - a.played);

    const best = qualified[0];

    if (!best) {
      bestCard.hidden = true;
      return;
    }

    bestCard.hidden = false;
    bestLine.textContent =
      `${resolveName(best.agent, byId)} on ${best.map} — ${pct(best.winrate)} ` +
      `· ${best.played} played · ${best.netRr > 0 ? "+" : ""}${best.netRr} RR`;
  }
}

function agentCard(agent, byId) {
  const card = document.createElement("div");
  card.className = "agent-card";

  const record = byId.get(agent.id ?? "");
  card.dataset.role = record?.role ?? "unknown";

  const head = document.createElement("div");
  head.className = "agent-card-head";

  const art = document.createElement("span");
  art.className = "agent-art";

  if (record?.portrait) {
    const portrait = document.createElement("img");
    portrait.src = record.portrait;
    portrait.alt = "";
    portrait.decoding = "async";
    art.appendChild(portrait);
  } else {
    const monogram = document.createElement("span");
    monogram.className = "agent-monogram";
    monogram.textContent = record ? record.name.slice(0, 2).toUpperCase() : "?";
    art.appendChild(monogram);
  }

  const identity = document.createElement("div");
  identity.className = "agent-identity";

  const name = document.createElement("div");
  name.className = "agent-name";
  name.textContent = resolveName(agent.id, byId);
  name.classList.toggle("is-unknown", name.textContent === "Unknown agent");

  const rows = document.createElement("div");
  rows.className = "agent-rows";

  const played = document.createElement("span");
  played.textContent = `${agent.played} played`;

  const recordLine = document.createElement("span");
  recordLine.textContent = `${agent.wins}W ${agent.losses}L ${agent.draws}D`;

  const net = document.createElement("span");
  net.textContent = `${agent.netRr > 0 ? "+" : ""}${agent.netRr} RR`;

  rows.append(played, recordLine, net);
  identity.append(name, rows);

  const rate = document.createElement("span");
  rate.className = "agent-card-rate";
  rate.textContent = pct(agent.winrate);

  if (agent.winrate !== null) {
    rate.classList.toggle("is-up", agent.winrate >= 0.5);
    rate.classList.toggle("is-down", agent.winrate < 0.5);
  }

  head.append(art, identity, rate);

  const form = document.createElement("div");
  form.className = "form-row";
  paintForm(form, agent.form);

  card.append(head, form);
  return card;
}
/**
 * The phone's Instalock tab: the fallback-chain builder and the arm/stop
 * controls, mirroring the desktop instalock view. It reuses the store's own
 * actions -- selectAgent, removeFromChain, moveInChain, startLock, stopLock
 * -- and its phase()/chainAgents()/errorMessage() selectors, so the mobile
 * UI and the desktop panel can never disagree about what the chain is.
 *
 * The selector is built from the canonical agent catalogue the service
 * served; there is no free-text agent input anywhere, so an arbitrary id can
 * never reach the lock route from this page.
 */

import { monogram } from "../roles.js";
import {
  chainAgents,
  chainPosition,
  errorMessage,
  isRetargeting,
  moveInChain,
  phase,
  removeFromChain,
  selectAgent,
  startLock,
  stopLock
} from "../store.js";
import { stagger, swapText } from "../ui/motion.js";
import { relativeTime } from "./shell.js";

const PHASE_TEXT = {
  booting: "Loading",
  offline: "No contact",
  arming: "Arming",
  monitoring: "Watching pre-game",
  locked: "Locked",
  error: "Stopped",
  idle: "Standby"
};

const PHASE_TONE = {
  arming: "is-warn",
  locked: "is-up",
  monitoring: "is-up",
  error: "is-down",
  offline: "is-down"
};

/** How long the stop button stays armed waiting for the second tap. */
const CONFIRM_WINDOW_MS = 3500;

const CONFIRM_STOP_LABEL = "Tap again to stop";

export function mountInstalock() {
  const updated = document.getElementById("ilUpdated");
  const phaseChip = document.getElementById("ilPhase");
  const lockedLine = document.getElementById("ilLocked");
  const statusLine = document.getElementById("ilStatus");
  const errorLine = document.getElementById("ilError");

  const chainList = document.getElementById("chainList");
  const chainEmpty = document.getElementById("chainEmpty");
  const chainHint = document.getElementById("chainHint");
  const chainCount = document.getElementById("ilChainCount");

  const search = document.getElementById("ilSearch");
  const grid = document.getElementById("ilGrid");
  const gridEmpty = document.getElementById("ilGridEmpty");
  const pickCount = document.getElementById("ilPickCount");

  const startButton = document.getElementById("ilStart");
  const startLabel = document.getElementById("ilStartLabel");
  const stopButton = document.getElementById("ilStop");

  const tiles = new Map();
  let built = false;
  let stopArmedUntil = 0;
  let renderedChain = null;

  stopButton.addEventListener("click", () => {
    const now = Date.now();

    if (now < stopArmedUntil) {
      stopArmedUntil = 0;
      stopButton.textContent = "Stop";
      stopButton.classList.remove("is-armed");
      void stopLock();
      return;
    }

    stopArmedUntil = now + CONFIRM_WINDOW_MS;
    stopButton.textContent = CONFIRM_STOP_LABEL;
    stopButton.classList.add("is-armed");
  });

  startButton.addEventListener("click", () => void startLock());

  chainList.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-chain-action]");

    if (!button) {
      return;
    }

    const name = button.dataset.agent;

    if (button.dataset.chainAction === "remove") {
      removeFromChain(name);
    } else {
      moveInChain(name, button.dataset.chainAction === "up" ? -1 : 1);
    }
  });

  search.addEventListener("input", () => applyFilter());

  grid.addEventListener("click", (event) => {
    const tile = event.target.closest("button[data-agent]");

    // The catalogue is the only source of names: the handler re-reads the
    // agent record from the tile the store's own load built.
    if (tile?.dataset.agent) {
      selectAgent(tile.dataset.agent);
    }
  });

  function applyFilter() {
    const term = search.value.trim().toLowerCase();

    for (const [name, tileEl] of tiles) {
      tileEl.hidden = !name.toLowerCase().includes(term);
    }

    const visible = [...tiles.values()].filter((tileEl) => !tileEl.hidden).length;
    gridEmpty.hidden = visible > 0;
  }

  return function render(state) {
    if (!built && state.loaded) {
      built = true;
      grid.textContent = "";

      for (const agent of state.agents) {
        grid.appendChild(tile(agent, tiles));
      }
    }

    if (built) {
      // The rank badge is what makes the order legible, same as the desktop.
      for (const [name, tileEl] of tiles) {
        const position = chainPosition(name);
        const isSelected = position > 0;
        tileEl.classList.toggle("is-selected", isSelected);
        tileEl.setAttribute("aria-pressed", String(isSelected));
        tileEl.querySelector(".il-rank").textContent = isSelected && state.chain.length > 1 ? String(position) : "";
      }

      pickCount.textContent = state.agents.length === 0
        ? ""
        : `${visibleTiles(state.agents, search.value).length}/${state.agents.length}`;
      applyFilter();
    }

    const current = phase();
    const running = Boolean(state.lock?.isRunning);
    const usable = current !== "booting" && current !== "offline";
    const chain = chainAgents();
    const landed = state.lock?.isLocked ? state.lock.selectedAgent : null;

    const signature = `${chain.map((entry) => entry.name).join(">")}|${landed ?? ""}|${agentsVersion(state.agents)}`;

    if (signature !== renderedChain) {
      renderedChain = signature;
      paintChain(chain, landed);
    }

    chainEmpty.hidden = chain.length > 0;
    chainHint.hidden = chain.length < 2;

    swapText(chainCount, chain.length === 0 ? "—" : `${chain.length} agent${chain.length === 1 ? "" : "s"}`);

    phaseChip.textContent = PHASE_TEXT[current] ?? "Standby";
    phaseChip.dataset.phase = current;

    for (const tone of Object.values(PHASE_TONE)) {
      phaseChip.classList.remove(tone);
    }

    const tone = PHASE_TONE[current];

    if (tone) {
      phaseChip.classList.add(tone);
    }

    lockedLine.hidden = !landed;
    lockedLine.textContent = landed ? `Locked: ${landed}` : "";

    swapText(statusLine, statusText(state, current));
    swapText(updated, state.lock?.updatedAt ? relativeTime(state.lock.updatedAt) : "—");

    const alert = current === "offline"
      ? "Lost contact with the local service. Retrying."
      : errorMessage();

    errorLine.hidden = !alert;
    errorLine.textContent = alert ?? "";

    const retargeting = isRetargeting();
    startButton.disabled = !usable || state.chain.length === 0 || Boolean(state.pending) || (running && !retargeting);
    startLabel.textContent = startText(state, running, retargeting);

    stopButton.disabled = !usable || !running || Boolean(state.pending);
    stopButton.classList.toggle("is-busy", state.pending === "stop");

    if (Date.now() >= stopArmedUntil && stopButton.textContent === CONFIRM_STOP_LABEL) {
      stopButton.textContent = "Stop";
      stopButton.classList.remove("is-armed");
    }
  };
}

function tile(agent, tiles) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "il-tile";
  button.dataset.agent = agent.name;
  button.dataset.role = agent.role;
  button.setAttribute("aria-pressed", "false");

  const art = document.createElement("span");
  art.className = "il-art";

  const portrait = document.createElement("img");
  portrait.alt = "";
  portrait.decoding = "async";
  portrait.hidden = true;

  if (agent.portrait) {
    portrait.addEventListener("load", () => {
      portrait.hidden = false;
      monogramEl.hidden = true;
    }, { once: true });
    portrait.src = agent.portrait;
  }

  const monogramEl = document.createElement("span");
  monogramEl.className = "il-monogram";
  monogramEl.setAttribute("aria-hidden", "true");
  monogramEl.textContent = monogram(agent.name);

  art.append(portrait, monogramEl);

  const name = document.createElement("span");
  name.className = "il-name";
  name.textContent = agent.name;

  const rank = document.createElement("span");
  rank.className = "il-rank";
  rank.setAttribute("aria-hidden", "true");

  button.append(art, name, rank);
  tiles.set(agent.name, button);
  return button;
}

function visibleTiles(agents, term) {
  const query = term.trim().toLowerCase();

  if (query.length === 0) {
    return agents;
  }

  return agents.filter((agent) => agent.name.toLowerCase().includes(query));
}

function paintChain(chain, lockedAgent) {
  chainList.replaceChildren();

  chain.forEach((agent, index) => {
    const row = document.createElement("li");
    row.className = "chain-row";
    row.dataset.state = agent.name === lockedAgent ? "locked" : "";

    const rank = document.createElement("span");
    rank.className = "chain-rank";
    rank.textContent = String(index + 1);

    const art = document.createElement("span");
    art.className = "chain-art";

    const portrait = document.createElement("img");
    portrait.alt = "";
    portrait.decoding = "async";
    portrait.hidden = true;

    if (agent.portrait) {
      portrait.addEventListener("load", () => {
        portrait.hidden = false;
        monogramEl.hidden = true;
      }, { once: true });
      portrait.src = agent.portrait;
    }

    const monogramEl = document.createElement("span");
    monogramEl.className = "chain-monogram";
    monogramEl.setAttribute("aria-hidden", "true");
    monogramEl.textContent = monogram(agent.name);

    art.append(portrait, monogramEl);

    const name = document.createElement("span");
    name.className = "chain-name";
    name.textContent = agent.name;

    row.append(rank, art, name);

    if (index > 0) {
      row.append(chainButton("up", agent.name, "↑", `Move ${agent.name} up`));
    }

    if (index < chain.length - 1) {
      row.append(chainButton("down", agent.name, "↓", `Move ${agent.name} down`));
    }

    row.append(chainButton("remove", agent.name, "✕", `Remove ${agent.name}`));
    chainList.append(row);
  });

  stagger(chainList.children);
}

function chainButton(action, name, glyph, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "chain-action";
  button.dataset.chainAction = action;
  button.dataset.agent = name;
  button.textContent = glyph;
  button.setAttribute("aria-label", label);
  return button;
}

function statusText(state, current) {
  if (current === "booting") {
    return "Loading agents…";
  }

  if (current === "offline") {
    return "Waiting for the local service…";
  }

  if (state.pending === "start") {
    return "Attaching to VALORANT…";
  }

  if (state.lock?.status) {
    return state.lock.status;
  }

  return state.chain.length > 0 ? "Ready when you are." : "Pick an agent to begin.";
}

function startText(state, running, retargeting) {
  if (state.pending === "start") {
    return "Starting…";
  }

  if (retargeting) {
    return "Switch target";
  }

  if (running) {
    return "Monitoring…";
  }

  return state.chain.length > 1 ? `Start locking (${state.chain.length})` : "Start locking";
}

function agentsVersion(agents) {
  return `|agents:${(agents ?? []).map((agent) => `${agent.value}@${agent.name}`).join(",")}`;
}
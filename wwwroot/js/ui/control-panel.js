/**
 * Right hand control panel: who is targeted, what the service is doing, and
 * the two buttons that drive it.
 */

import { monogram, rgba } from "../roles.js";
import {
  chainAgents,
  errorMessage,
  isRetargeting,
  moveInChain,
  phase,
  removeFromChain,
  selectedAgent,
  startLock,
  stopLock
} from "../store.js";
import { swapText } from "./motion.js";

const LOOP_LABELS = {
  booting: "Loading",
  offline: "No contact",
  idle: "Standby",
  arming: "Attaching",
  monitoring: "Watching pre-game",
  locked: "Cooldown + monitor",
  error: "Stopped"
};

export function mountControlPanel() {
  const heroArt = document.getElementById("heroArt");
  const heroBackdrop = document.getElementById("heroBackdrop");
  const heroPortrait = document.getElementById("heroPortrait");
  const heroMonogram = document.getElementById("heroMonogram");
  const heroWatermark = document.getElementById("heroWatermark");
  const heroBadge = document.getElementById("heroBadge");
  const panelName = document.getElementById("panelName");
  const panelRole = document.getElementById("panelRole");
  const statusLine = document.getElementById("statusLine");
  const metaLoop = document.getElementById("metaLoop");
  const metaUpdated = document.getElementById("metaUpdated");
  const panelAlert = document.getElementById("panelAlert");
  const startButton = document.getElementById("startButton");
  const startLabel = document.getElementById("startLabel");
  const stopButton = document.getElementById("stopButton");
  const panelChain = document.getElementById("panelChain");
  const chainList = document.getElementById("chainList");

  // undefined, not null: "no agent" is a real value that must still paint once.
  let renderedAgent;
  let renderedChain;

  startButton.addEventListener("click", () => void startLock());
  stopButton.addEventListener("click", () => void stopLock());

  // Delegated: the rows are rebuilt whenever the chain changes, so per-row
  // listeners would have to be rebound every time.
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

  return function render(state) {
    const current = phase();
    const agent = selectedAgent();
    const running = Boolean(state.lock?.isRunning);
    const usable = current !== "booting" && current !== "offline";

    const agentName = agent?.name ?? null;

    if (agentName !== renderedAgent) {
      renderedAgent = agentName;
      paintAgent(agent, { heroArt, heroBackdrop, heroPortrait, heroMonogram, heroWatermark, panelName, panelRole });
    }

    // Only worth showing once there is a fallback to show; a chain of one is
    // just the target agent again.
    const chain = chainAgents();

    // Which entry actually got locked is `selectedAgent` once `isLocked` is set:
    // the worker narrows the chain down to the one it landed on.
    const landed = state.lock?.isLocked ? state.lock.selectedAgent : null;
    const signature = `${chain.map((entry) => entry.name).join(">")}|${landed ?? ""}`;

    if (signature !== renderedChain) {
      renderedChain = signature;
      panelChain.hidden = chain.length < 2;
      paintChain(chainList, chain, landed);
    }

    heroBadge.hidden = current !== "locked";
    heroArt.dataset.phase = current;

    swapText(statusLine, statusText(state, current));
    swapText(metaLoop, LOOP_LABELS[current] ?? "Standby");
    metaUpdated.textContent = formatTime(state.lock?.updatedAt);

    const alert = current === "offline"
      ? "Lost contact with the local service. Retrying."
      : errorMessage();

    panelAlert.hidden = !alert;
    panelAlert.textContent = alert ?? "";

    const retargeting = isRetargeting();
    startButton.disabled = !usable || state.chain.length === 0 || Boolean(state.pending) || (running && !retargeting);
    startButton.classList.toggle("is-busy", state.pending === "start");
    startLabel.textContent = startText(state, running, retargeting);

    stopButton.disabled = !usable || !running || Boolean(state.pending);
    stopButton.classList.toggle("is-busy", state.pending === "stop");
  };
}

function paintChain(list, chain, lockedAgent) {
  list.replaceChildren();

  chain.forEach((agent, index) => {
    const row = document.createElement("li");
    row.className = "chain-row";
    row.dataset.state = agent.name === lockedAgent ? "locked" : "";

    // An agent that is in the chain but missing from the grid has no gradient
    // to tint with, which is why this is conditional rather than assumed.
    const tint = agent.gradient?.[0];

    if (tint) {
      row.style.setProperty("--chain-tint", rgba(tint, 0.5));
    }

    const rank = document.createElement("span");
    rank.className = "chain-rank";
    rank.textContent = String(index + 1);

    const name = document.createElement("span");
    name.className = "chain-name";
    name.textContent = agent.name;

    row.append(rank, name);

    // Nothing to move at the ends, so those buttons are simply absent rather
    // than present and disabled.
    if (index > 0) {
      row.append(chainButton("up", agent.name, "↑", `Move ${agent.name} up`));
    }

    if (index < chain.length - 1) {
      row.append(chainButton("down", agent.name, "↓", `Move ${agent.name} down`));
    }

    row.append(chainButton("remove", agent.name, "✕", `Remove ${agent.name}`));
    list.append(row);
  });
}

function chainButton(action, agent, glyph, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "chain-action";
  button.dataset.chainAction = action;
  button.dataset.agent = agent;
  button.textContent = glyph;
  button.title = label;
  button.setAttribute("aria-label", label);
  return button;
}

function paintAgent(agent, elements) {
  const { heroArt, heroBackdrop, heroPortrait, heroMonogram, heroWatermark, panelName, panelRole } = elements;

  heroArt.dataset.role = agent?.role ?? "unknown";
  panelName.textContent = agent?.name ?? "No agent selected";

  // With nothing picked the hero shows the app mark instead of a bare "?".
  heroWatermark.hidden = Boolean(agent);
  heroMonogram.hidden = !agent;
  heroMonogram.textContent = agent ? monogram(agent.name) : "";

  panelRole.hidden = !agent;
  panelRole.textContent = agent?.roleLabel ?? "";
  panelRole.dataset.role = agent?.role ?? "unknown";

  // Same rule as the grid: monogram first, portrait only once it decoded.
  heroArt.dataset.art = "none";
  heroPortrait.classList.toggle("is-mirrored", Boolean(agent?.rightFacing));
  setImage(heroBackdrop, agent?.background ?? null);
  setImage(heroPortrait, agent?.portrait ?? null, () => {
    heroArt.dataset.art = "portrait";
  });
}

function setImage(image, source, onLoad) {
  image.onload = null;

  if (!source) {
    image.removeAttribute("src");
    image.hidden = true;
    return;
  }

  image.hidden = false;
  image.onload = onLoad ?? null;
  image.src = source;
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

function formatTime(value) {
  if (!value) {
    return "—";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString();
}

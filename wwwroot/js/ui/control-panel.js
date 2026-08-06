/**
 * Right hand control panel: who is targeted, what the service is doing, and
 * the two buttons that drive it.
 */

import { monogram } from "../roles.js";
import { errorMessage, isRetargeting, phase, selectedAgent, startLock, stopLock } from "../store.js";
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

  // undefined, not null: "no agent" is a real value that must still paint once.
  let renderedAgent;

  startButton.addEventListener("click", () => void startLock());
  stopButton.addEventListener("click", () => void stopLock());

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
    startButton.disabled = !usable || !state.selected || Boolean(state.pending) || (running && !retargeting);
    startButton.classList.toggle("is-busy", state.pending === "start");
    startLabel.textContent = startText(state, running, retargeting);

    stopButton.disabled = !usable || !running || Boolean(state.pending);
    stopButton.classList.toggle("is-busy", state.pending === "stop");
  };
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

  return state.selected ? "Ready when you are." : "Pick an agent to begin.";
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

  return "Start locking";
}

function formatTime(value) {
  if (!value) {
    return "—";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString();
}

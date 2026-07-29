/**
 * Top bar plus the document level chrome: `data-phase` and `data-role` on
 * <body> drive every accent in styles.css, and the ambient glow behind the
 * glass is tinted with the selected agent's own gradient.
 */

import { rgba } from "../roles.js";
import { phase, selectedAgent } from "../store.js";

const PHASE_LABELS = {
  booting: "Loading",
  offline: "Disconnected",
  idle: "Idle",
  arming: "Arming",
  monitoring: "Monitoring",
  locked: "Locked",
  error: "Error"
};

export function mountHeader() {
  const body = document.body;
  const root = document.documentElement;
  const phaseLabel = document.getElementById("phaseLabel");
  const noticePill = document.getElementById("noticePill");

  let lastAmbientAgent = null;

  return function render(state) {
    const current = phase();

    body.dataset.phase = current;
    phaseLabel.textContent = PHASE_LABELS[current] ?? current;

    const agent = selectedAgent();
    body.dataset.role = agent?.role ?? "unknown";

    if (agent?.name !== lastAmbientAgent) {
      lastAmbientAgent = agent?.name ?? null;
      paintAmbience(root, agent);
    }

    const offlineAssets = state.loaded && !state.assetsAvailable;
    noticePill.hidden = !offlineAssets;
  };
}

/**
 * The gradients come from valorant-api as 4 stops. First and last carry the
 * most character, and heavy alpha keeps them a glow rather than a wash.
 */
function paintAmbience(root, agent) {
  const stops = agent?.gradient ?? [];

  if (stops.length === 0) {
    root.style.removeProperty("--ambient-a");
    root.style.removeProperty("--ambient-b");
    return;
  }

  root.style.setProperty("--ambient-a", rgba(stops[0], 0.3));
  root.style.setProperty("--ambient-b", rgba(stops[stops.length - 1], 0.22));
}

/**
 * The phone shell: the connection pill, the live status line, and the
 * document-level navigation delegation that turns any [data-go] tap into a
 * route change. The shell is permanent -- it mounts once at boot and never
 * unmounts, while feature pages come and go underneath it.
 *
 * Navigation is hash-based (see router.js): [data-go="session"] becomes
 * location.hash = "#/session", the router mounts Session and unmounts
 * whatever was active before. Everything else on the page -- bottom nav
 * buttons and Home's quick links alike -- goes through the same path.
 */

import { errorMessage, phase } from "../store.js";
import { navigate } from "./router.js";

const CONN_LABELS = {
  stream: "Connected",
  retrying: "Reconnecting",
  polling: "Polling",
  offline: "Offline"
};

const PHASE_TEXT = {
  booting: "Starting…",
  offline: "No connection",
  arming: "Instalock arming",
  error: "Instalock error",
  locked: "Instalock locked",
  monitoring: "Monitoring agent select",
  idle: "Idle"
};

export function mountMobileShell() {
  // One delegated listener for every [data-go] tap, wherever it lives:
  // bottom nav (permanent), quick links (Home), card links (Latest match).
  document.addEventListener("click", (event) => {
    const go = event.target.closest("[data-go]");

    if (go?.dataset.go) {
      navigate(go.dataset.go);
    }
  });

  const pill = document.getElementById("connPill");
  const connLabel = document.getElementById("connLabel");
  const statusLine = document.getElementById("statusLine");

  return function render(state) {
    const conn = state.connected ? state.transport : "offline";
    pill.dataset.conn = conn;
    connLabel.textContent = CONN_LABELS[conn] ?? "Connecting…";

    const current = phase();

    statusLine.textContent = current === "error"
      ? `Instalock: ${errorMessage() ?? "error"}`
      : `${PHASE_TEXT[current] ?? "Idle"} · ${connLabel.textContent}`;
  };
}

/**
 * Compact "how long ago" for the updated lines: seconds, minutes, hours, then
 * a plain date. Shared by every page so they all phrase it identically.
 */
export function relativeTime(value) {
  if (!value) {
    return "";
  }

  const at = new Date(value).getTime();

  if (!Number.isFinite(at)) {
    return "";
  }

  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));

  if (seconds < 60) {
    return "just now";
  }

  const minutes = Math.round(seconds / 60);

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.round(minutes / 60);

  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.round(hours / 24);

  return days === 1 ? "yesterday" : `${days}d ago`;
}
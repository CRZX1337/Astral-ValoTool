/**
 * The phone shell: which tab is on screen, the connection pill, and the live
 * status line on Home. Tabs are plain hidden toggles -- the companion is a
 * read-only mirror, so there is nothing to build or tear down.
 */

import { errorMessage, phase } from "../store.js";

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
  const sections = new Map();
  const buttons = new Map();

  for (const section of document.querySelectorAll(".tab[data-tab]")) {
    sections.set(section.dataset.tab, section);
  }

  for (const button of document.querySelectorAll(".tab-btn")) {
    buttons.set(button.dataset.tab, button);
    button.addEventListener("click", () => setTab(button.dataset.tab));
  }

  function setTab(name) {
    document.body.dataset.tab = name;

    for (const [tab, section] of sections) {
      section.hidden = tab !== name;
    }

    for (const [tab, button] of buttons) {
      if (tab === name) {
        button.setAttribute("aria-current", "page");
      } else {
        button.removeAttribute("aria-current");
      }
    }

    window.scrollTo(0, 0);
  }

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
 * a plain date. Shared by every tab so they all phrase it identically.
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
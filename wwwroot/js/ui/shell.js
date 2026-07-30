/**
 * The shell: which view is on screen, the back button, and the live status
 * line on each home card.
 *
 * Views are swapped by toggling `hidden` rather than being built and torn down,
 * so each tool keeps its scroll position and its DOM across visits.
 */

import { goHome, phase, setView } from "../store.js";

const TITLES = {
  home: "Astral",
  instalock: "Instalock",
  tracker: "Rank tracker",
  autoqueue: "Auto-queue"
};

export function mountShell() {
  const body = document.body;
  const backButton = document.getElementById("backButton");
  const brandLabel = document.getElementById("brandLabel");
  const settingsButton = document.getElementById("settingsButton");
  const views = new Map();

  for (const section of document.querySelectorAll("[data-view]")) {
    if (section.id?.startsWith("view-")) {
      views.set(section.dataset.view, section);
    }
  }

  for (const card of document.querySelectorAll("[data-goto]")) {
    card.addEventListener("click", () => setView(card.dataset.goto));
  }

  backButton.addEventListener("click", goHome);

  // Escape backs out of a tool. The agent grid's own Escape (clearing the
  // search box) runs first and stops there, so this never fights it.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) {
      return;
    }

    const modalOpen = document.getElementById("settingsModal")?.hidden === false;

    if (!modalOpen) {
      goHome();
    }
  });

  const statuses = {
    instalock: document.getElementById("statusInstalock"),
    tracker: document.getElementById("statusTracker"),
    autoqueue: document.getElementById("statusAutoqueue")
  };

  let rendered = null;

  return function render(state) {
    if (state.view !== rendered) {
      rendered = state.view;
      body.dataset.view = state.view;

      for (const [name, section] of views) {
        section.hidden = name !== state.view;
      }

      backButton.hidden = state.view === "home";
      brandLabel.textContent = TITLES[state.view] ?? "Astral";

      // The gear only configures the instalocker, so it has no meaning
      // anywhere else.
      settingsButton.hidden = state.view !== "instalock";

      // Re-run the entry animation on the view being shown.
      const active = views.get(state.view);

      if (active) {
        active.style.animation = "none";
        void active.offsetWidth;
        active.style.animation = "";
      }
    }

    paintStatus(statuses.instalock, instalockStatus(state));
    paintStatus(statuses.tracker, trackerStatus(state));
    paintStatus(statuses.autoqueue, autoqueueStatus(state));
  };
}

function paintStatus(element, { text, live }) {
  if (!element) {
    return;
  }

  element.dataset.live = live ? "on" : "off";
  element.lastElementChild.textContent = text;
}

function instalockStatus(state) {
  const current = phase();

  if (current === "locked") {
    return { text: `Locked ${state.lock?.selectedAgent ?? ""}`.trim(), live: true };
  }

  if (state.lock?.isRunning) {
    return { text: `Monitoring · ${state.lock.selectedAgent ?? "—"}`, live: true };
  }

  return { text: state.lock?.error ? "Stopped" : "Idle", live: false };
}

function trackerStatus(state) {
  const tracker = state.tracker;

  if (!tracker?.updatedAt) {
    return { text: "Not loaded", live: false };
  }

  const rank = tracker.rank?.tierName ?? "Unranked";
  const net = tracker.session?.netRr ?? 0;
  const sign = net > 0 ? "+" : "";

  return { text: `${rank} · ${sign}${net} RR today`, live: net !== 0 };
}

function autoqueueStatus(state) {
  const queue = state.autoqueue;

  if (!queue?.isRunning) {
    return { text: "Idle", live: false };
  }

  return { text: queue.currentQueueId ? `Running · ${queue.currentQueueId}` : "Running", live: true };
}

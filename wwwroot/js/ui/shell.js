/**
 * The shell: which view is on screen, the back button, and the live status
 * line on each home card.
 *
 * Views are swapped by toggling `hidden` rather than being built and torn down,
 * so each tool keeps its scroll position and its DOM across visits.
 */

import { goHome, phase, setView } from "../store.js";
import { reduceMotion } from "./motion.js";

const TITLES = {
  home: "Astral",
  instalock: "Instalock",
  tracker: "Rank tracker",
  autoqueue: "Auto-queue"
};

/**
 * The shared element the home card morphs into. One name, handed between two
 * elements -- see transitionTo().
 */
const MORPH = "tool-morph";

/** Long enough to cover the staggered entry in css/motion.css. */
const ENTER_MS = 900;

/**
 * How long after a view change text swaps stay quiet. Covers the 480ms morph
 * plus the deferred data load that store.js fires once the view has settled.
 */
const SETTLE_MS = 800;

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

  /** The strip a card morphs into: the tool's header bar, or the view itself. */
  function morphTarget(view) {
    const section = views.get(view);
    return section ? section.querySelector(".tool-head, .toolbar") ?? section : null;
  }

  function cardFor(view) {
    return document.querySelector(`[data-goto="${view}"]`);
  }

  function applyView(next) {
    body.dataset.view = next;

    for (const [name, section] of views) {
      section.hidden = name !== next;
    }

    backButton.hidden = next === "home";
    brandLabel.textContent = TITLES[next] ?? "Astral";

    // The gear only configures the instalocker, so it has no meaning
    // anywhere else.
    settingsButton.hidden = next !== "instalock";
  }

  /** Staggers the view's own sections in, once any transition has finished. */
  function enter(next) {
    const active = views.get(next);

    if (!active) {
      return;
    }

    active.classList.remove("is-entering");
    void active.offsetWidth;
    active.classList.add("is-entering");
    window.setTimeout(() => active.classList.remove("is-entering"), ENTER_MS);
  }

  /**
   * Marks the window as settling: text swaps stay quiet until it clears, so a
   * deferred refresh landing just after a view opens does not animate a dozen
   * labels at once.
   */
  function settle() {
    body.dataset.settling = "1";
    window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => delete body.dataset.settling, SETTLE_MS);
  }

  function transitionTo(next, from) {
    const startTransition = document.startViewTransition?.bind(document);

    // First paint is the boot sequence's job, not a transition.
    if (from === null || !startTransition || reduceMotion.matches) {
      applyView(next);
      enter(next);
      return;
    }

    settle();

    // A view-transition-name has to be unique across the document at snapshot
    // time, so it lives on the card for the outgoing frame and moves to the
    // destination header for the incoming one. Naming both at once silently
    // kills the morph.
    const opening = next !== "home";
    const outgoing = opening ? cardFor(next) : morphTarget(from);
    const incoming = opening ? morphTarget(next) : cardFor(from);

    if (outgoing) {
      outgoing.style.viewTransitionName = MORPH;
    }

    const transition = startTransition(() => {
      if (outgoing) {
        outgoing.style.viewTransitionName = "";
      }

      if (incoming) {
        incoming.style.viewTransitionName = MORPH;
      }

      applyView(next);
    });

    // Deliberately no enter() here. The transition *is* the entry animation;
    // staggering the sections in again once it finished played the whole view
    // twice and read as the tool loading, settling, then reloading.
    const cleanup = () => {
      if (outgoing) {
        outgoing.style.viewTransitionName = "";
      }

      if (incoming) {
        incoming.style.viewTransitionName = "";
      }
    };

    // Both arms: `finished` rejects when a transition is skipped, which happens
    // whenever two land close together.
    transition.finished.then(cleanup, cleanup);
  }

  let rendered = null;
  let settleTimer = null;

  return function render(state) {
    if (state.view !== rendered) {
      const from = rendered;
      rendered = state.view;
      transitionTo(state.view, from);
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

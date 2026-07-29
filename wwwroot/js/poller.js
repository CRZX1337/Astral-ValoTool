/**
 * State feed. Prefers the server-sent event stream so changes arrive as they
 * happen; falls back to the adaptive polling loop when EventSource is missing
 * or the stream keeps failing.
 */

import { fetchState } from "./api.js";
import { applyLockState, phase, setConnected } from "./store.js";

const INTERVALS = {
  booting: 600,
  arming: 500,
  monitoring: 1000,
  locked: 1000,
  error: 2500,
  idle: 2500,
  offline: 2000
};

const HIDDEN_INTERVAL = 5000;
const MAX_INTERVAL = 6000;
const FAILURES_BEFORE_OFFLINE = 3;

/** EventSource retries by itself; this is when we stop believing in it. */
const FAILURES_BEFORE_POLLING = 5;

let timer = null;
let inFlight = false;
let failures = 0;
let stream = null;
let polling = false;

export function startStateFeed() {
  // One plain read so the interface has state before the transport settles.
  void hydrate();

  if (typeof window.EventSource === "function") {
    openStream();
    return;
  }

  startPolling();
}

async function hydrate() {
  try {
    applyLockState(await fetchState());
    setConnected(true);
  } catch {
    // Whichever transport starts next will report the outage.
  }
}

function openStream() {
  stream = new EventSource("/api/state/stream");

  stream.addEventListener("open", () => {
    failures = 0;
    setConnected(true);
  });

  stream.addEventListener("message", (event) => {
    let next;

    try {
      next = JSON.parse(event.data);
    } catch {
      return;
    }

    failures = 0;
    applyLockState(next);
  });

  stream.addEventListener("error", () => {
    failures += 1;

    if (failures >= FAILURES_BEFORE_OFFLINE) {
      setConnected(false);
    }

    if (failures >= FAILURES_BEFORE_POLLING) {
      stream.close();
      stream = null;
      startPolling();
    }
  });
}

function startPolling() {
  if (polling) {
    return;
  }

  polling = true;
  failures = 0;

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      void tick();
    }
  });

  void tick();
}

async function tick() {
  window.clearTimeout(timer);

  if (inFlight || document.hidden) {
    schedule();
    return;
  }

  inFlight = true;

  try {
    applyLockState(await fetchState());
    failures = 0;
    setConnected(true);
  } catch {
    failures += 1;

    if (failures >= FAILURES_BEFORE_OFFLINE) {
      setConnected(false);
    }
  } finally {
    inFlight = false;
    schedule();
  }
}

function schedule() {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void tick(), delay());
}

function delay() {
  if (document.hidden) {
    return HIDDEN_INTERVAL;
  }

  const base = INTERVALS[phase()] ?? INTERVALS.idle;
  return failures === 0 ? base : Math.min(base * (failures + 1), MAX_INTERVAL);
}

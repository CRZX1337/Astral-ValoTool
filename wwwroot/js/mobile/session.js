/**
 * The phone's Session tab: full session analytics over the tracker's history,
 * and the reset-session action. The numbers all come from the shared
 * sessionAnalytics reducer -- the same one the desktop session view uses --
 * so there is exactly one way the session is counted. The reset goes through
 * the existing store action, which means the existing LAN-authenticated
 * endpoint; nothing new is invented here.
 */

import { getState, resetSession } from "../store.js";
import { sessionAnalytics } from "../stats/session-stats.js";
import { swapText } from "../ui/motion.js";
import { paintForm, pct } from "./home.js";
import { relativeTime } from "./shell.js";

/** How long the reset button stays armed waiting for the second tap. */
const CONFIRM_WINDOW_MS = 4000;

const CONFIRM_LABEL = "Tap again to reset";

export function mountSession() {
  const heroCard = document.getElementById("sessionHeroCard");
  const statsCard = document.getElementById("sessionStatsCard");
  const resetCard = document.getElementById("sessionResetCard");
  const empty = document.getElementById("sessEmpty");
  const updated = document.getElementById("sessionUpdated");

  const sessNet = document.getElementById("sessNet");
  const sessPlayed = document.getElementById("sessPlayed");
  const sessWins = document.getElementById("sessWins");
  const sessLosses = document.getElementById("sessLosses");
  const sessDraws = document.getElementById("sessDraws");
  const sessWinrate = document.getElementById("sessWinrate");
  const sessAvg = document.getElementById("sessAvg");
  const sessBestWorst = document.getElementById("sessBestWorst");
  const sessStreak = document.getElementById("sessStreak");
  const sessLongest = document.getElementById("sessLongest");
  const sessSpan = document.getElementById("sessSpan");
  const sessMomentum = document.getElementById("sessMomentum");
  const sessForm = document.getElementById("sessForm");

  const resetButton = document.getElementById("sessReset");
  const resetNote = document.getElementById("sessResetNote");

  let resetArmedUntil = 0;

  resetButton.addEventListener("click", () => {
    const now = Date.now();

    if (now < resetArmedUntil) {
      resetArmedUntil = 0;
      resetButton.textContent = "Reset session";
      resetButton.classList.remove("is-armed");
      resetNote.textContent = "";
      void doReset();
      return;
    }

    resetArmedUntil = now + CONFIRM_WINDOW_MS;
    resetButton.textContent = CONFIRM_LABEL;
    resetButton.classList.add("is-armed");
    resetNote.textContent = "This clears the session anchor — the stream will confirm.";
  });

  async function doReset() {
    resetButton.disabled = true;
    resetButton.textContent = "Resetting…";
    resetNote.textContent = "Resetting session…";

    const before = getState().tracker?.session?.startedAt ?? null;

    await resetSession();

    const tracker = getState().tracker;

    if (tracker?.error) {
      resetNote.textContent = `Could not reset: ${tracker.error}`;
    } else if (tracker && tracker.session?.startedAt !== before) {
      resetNote.textContent = "Session reset — the server started a fresh anchor.";
    } else {
      resetNote.textContent = "Reset sent. Waiting for the server to confirm…";
    }

    resetButton.disabled = false;
    resetButton.textContent = "Reset session";
    resetButton.classList.remove("is-armed");
  }

  return function render(state) {
    const tracker = state.tracker;
    const matches = tracker?.matches ?? [];
    const analytics = sessionAnalytics(matches, tracker?.session ?? null);
    const hasSession = Boolean(tracker?.session?.startedAt);

    const busy = tracker?.isLoading ?? false;

    heroCard.hidden = !hasSession;
    statsCard.hidden = !hasSession;
    resetCard.hidden = !hasSession;
    empty.hidden = hasSession;

    if (!hasSession) {
      empty.textContent = tracker?.updatedAt
        ? "No session yet — play a competitive match to start one."
        : "Refresh to load your recent matches.";
      swapText(updated, tracker?.updatedAt ? `Updated ${relativeTime(tracker.updatedAt)}` : "Not loaded yet.");
      return;
    }

    swapText(updated, busy
      ? "Refreshing…"
      : `Updated ${relativeTime(tracker.updatedAt)}`);

    const net = analytics.netRr ?? 0;

    swapText(sessNet, `${net > 0 ? "+" : ""}${net}`);
    sessNet.classList.toggle("is-up", net > 0);
    sessNet.classList.toggle("is-down", net < 0);

    swapText(sessPlayed, `${analytics.played} match${analytics.played === 1 ? "" : "es"}`);
    swapText(sessWins, String(analytics.wins));
    swapText(sessLosses, String(analytics.losses));
    swapText(sessDraws, String(analytics.draws));
    swapText(sessWinrate, pct(analytics.winrate));
    sessWinrate.classList.toggle("is-up", (analytics.winrate ?? 0) >= 0.5);
    sessWinrate.classList.toggle("is-down", (analytics.winrate ?? 1) < 0.5);

    swapText(sessAvg, analytics.avgRr === null ? "—" : signed(Math.round(analytics.avgRr * 10) / 10));
    swapText(sessBestWorst, analytics.best === null || analytics.worst === null
      ? "—"
      : `${signed(analytics.best)} / ${signed(analytics.worst)}`);
    swapText(sessStreak, analytics.currentStreak > 0
      ? `${analytics.currentStreak} ${analytics.streakResult === "win" ? "win" : "loss"}${analytics.currentStreak === 1 ? "" : "es"}`
      : "None");
    swapText(sessLongest, analytics.longestStreak > 0 ? `${analytics.longestStreak} games` : "—");

    swapText(sessSpan, analytics.spanMs === null
      ? "—"
      : spanText(analytics.spanMs));

    swapText(sessMomentum, momentumText(analytics.momentum));

    paintForm(sessForm, analytics.form);

    if (Date.now() >= resetArmedUntil && resetButton.textContent === CONFIRM_LABEL) {
      resetButton.textContent = "Reset session";
      resetButton.classList.remove("is-armed");
      resetNote.textContent = "";
    }
  };
}

function signed(value) {
  return `${value > 0 ? "+" : ""}${value}`;
}

function spanText(ms) {
  const minutes = Math.max(1, Math.round(ms / 60000));

  if (minutes < 60) {
    return `${minutes} min`;
  }

  const hours = Math.round(minutes / 60);

  return hours < 24 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}

function momentumText(momentum) {
  if (!momentum || momentum.recentAvg === null || momentum.earlierAvg === null) {
    return "—";
  }

  const delta = momentum.recentAvg - momentum.earlierAvg;

  if (Math.abs(delta) < 0.05) {
    return "Even";
  }

  return delta > 0
    ? `Climbing (+${Math.round(delta * 10) / 10})`
    : `Cooling (${Math.round(delta * 10) / 10})`;
}
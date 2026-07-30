/**
 * Rank tracker view: current standing, this session's damage, and the recent
 * competitive matches that produced it.
 */

import { refreshTrackerState, resetSession } from "../store.js";

/** Riot's RR scale within a tier. Radiant runs past it, so the bar clamps. */
const RR_PER_TIER = 100;

export function mountTracker() {
  const refreshButton = document.getElementById("trackerRefresh");
  const refreshLabel = document.getElementById("trackerRefreshLabel");
  const resetButton = document.getElementById("trackerReset");
  const updated = document.getElementById("trackerUpdated");
  const alert = document.getElementById("trackerAlert");
  const rankCard = document.getElementById("trackerRankCard");
  const rankIcon = document.getElementById("rankIcon");
  const rankFallback = document.getElementById("rankFallback");
  const rankName = document.getElementById("rankName");
  const rankRr = document.getElementById("rankRr");
  const rankFill = document.getElementById("rankFill");
  const wins = document.getElementById("sessionWins");
  const losses = document.getElementById("sessionLosses");
  const netRr = document.getElementById("sessionRr");
  const played = document.getElementById("sessionPlayed");
  const list = document.getElementById("matchList");
  const empty = document.getElementById("matchEmpty");

  refreshButton.addEventListener("click", () => void refreshTrackerState());
  resetButton.addEventListener("click", () => void resetSession());

  let renderedSignature = null;

  return function render(state) {
    if (state.view !== "tracker") {
      return;
    }

    const tracker = state.tracker;
    const busy = state.trackerPending || Boolean(tracker?.isLoading);

    refreshButton.disabled = busy;
    refreshButton.classList.toggle("is-busy", busy);
    refreshLabel.textContent = busy ? "Loading…" : "Refresh";

    alert.hidden = !tracker?.error;
    alert.textContent = tracker?.error ?? "";

    updated.textContent = tracker?.updatedAt
      ? `Updated ${new Date(tracker.updatedAt).toLocaleTimeString()}`
      : "Not loaded yet.";

    const rank = tracker?.rank ?? null;
    rankCard.hidden = !rank;

    if (rank) {
      rankName.textContent = rank.tierName;
      rankRr.textContent = `${rank.rankedRating} RR`;
      rankFill.style.width = `${Math.max(0, Math.min(rank.rankedRating, RR_PER_TIER))}%`;
      rankCard.style.setProperty("--rank-color", rank.tierColor ?? "var(--brand)");

      // The monogram-style fallback stays until the icon has actually decoded,
      // so a slow or dead CDN never leaves an empty badge.
      rankFallback.hidden = false;
      rankFallback.textContent = rank.tierName.slice(0, 2).toUpperCase();

      if (rank.tierIcon) {
        rankIcon.onload = () => {
          rankIcon.hidden = false;
          rankFallback.hidden = true;
        };
        rankIcon.src = rank.tierIcon;
      } else {
        rankIcon.hidden = true;
        rankIcon.removeAttribute("src");
      }
    }

    const session = tracker?.session ?? null;
    wins.textContent = String(session?.wins ?? 0);
    losses.textContent = String(session?.losses ?? 0);
    played.textContent = String((session?.wins ?? 0) + (session?.losses ?? 0) + (session?.draws ?? 0));

    const net = session?.netRr ?? 0;
    netRr.textContent = `${net > 0 ? "+" : ""}${net}`;
    netRr.classList.toggle("is-up", net > 0);
    netRr.classList.toggle("is-down", net < 0);

    // Matches only get rebuilt when they actually change -- this list is
    // re-rendered on every stream frame otherwise.
    const matches = tracker?.matches ?? [];
    const signature = matches.map((match) => `${match.matchId}:${match.rrChange}`).join("|");

    if (signature !== renderedSignature) {
      renderedSignature = signature;
      paintMatches(list, matches);
    }

    empty.hidden = matches.length > 0;

    if (matches.length === 0) {
      empty.textContent = tracker?.updatedAt
        ? "No competitive matches found."
        : "Refresh to load your recent matches.";
    }
  };
}

function paintMatches(list, matches) {
  const fragment = document.createDocumentFragment();

  for (const match of matches) {
    const row = document.createElement("div");
    row.className = "match-row";
    row.dataset.result = match.result;

    const flag = document.createElement("span");
    flag.className = "match-flag";

    const body = document.createElement("div");
    const map = document.createElement("div");
    map.className = "match-map";
    map.textContent = match.mapName;

    const when = document.createElement("div");
    when.className = "match-when";
    when.textContent = match.startedAt
      ? new Date(match.startedAt).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit"
        })
      : "—";

    body.append(map, when);

    const rr = document.createElement("span");
    rr.className = "match-rr";
    rr.classList.toggle("is-up", match.rrChange > 0);
    rr.classList.toggle("is-down", match.rrChange < 0);
    rr.textContent = `${match.rrChange > 0 ? "+" : ""}${match.rrChange}`;

    const tier = document.createElement("span");
    tier.className = "match-tier";
    tier.textContent = match.tierNameAfter;

    row.append(flag, body, rr, tier);
    fragment.append(row);
  }

  list.replaceChildren(fragment);
}

/**
 * Rank tracker view: current standing, this session's damage, and the recent
 * competitive matches that produced it.
 */

import { refreshTrackerState, resetSession } from "../store.js";
import { countUp, stagger, swapText } from "./motion.js";
import { mountChart } from "./chart.js";
import { buildSeries, shortDate } from "../stats/session-stats.js";

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
  const journeySummary = document.getElementById("journeySummary");
  const journeyChart = document.getElementById("journeyChart");
  const chart = mountChart(journeyChart);

  refreshButton.addEventListener("click", () => void refreshTrackerState());
  resetButton.addEventListener("click", () => void resetSession());

  let renderedSignature = null;

  // Deliberately paints even while the view is hidden. Gating this on the view
  // being active meant every first paint -- building the match rows, counting
  // the session numbers up -- happened the instant the view opened, landing
  // right on top of the transition and reading as the tool loading twice.
  // The work is a handful of text writes; doing it early is what makes opening
  // the tool show finished content.
  return function render(state) {
    const tracker = state.tracker;
    const busy = state.trackerPending || Boolean(tracker?.isLoading);

    refreshButton.disabled = busy;
    refreshButton.classList.toggle("is-busy", busy);
    refreshLabel.textContent = busy ? "Loading…" : "Refresh";

    alert.hidden = !tracker?.error;
    alert.textContent = tracker?.error ?? "";

    swapText(updated, tracker?.updatedAt
      ? `Updated ${new Date(tracker.updatedAt).toLocaleTimeString()}`
      : "Not loaded yet.");

    const rank = tracker?.rank ?? null;

    // Kept in the layout while a refresh is in flight, holding its placeholder
    // values. Hiding it until the data lands made the whole card appear from
    // nothing and shove the match list down, which is the jolt that reads as
    // the view reloading itself.
    rankCard.hidden = !rank && !busy;

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
    const net = session?.netRr ?? 0;

    countUp(wins, session?.wins ?? 0);
    countUp(losses, session?.losses ?? 0);
    countUp(played, (session?.wins ?? 0) + (session?.losses ?? 0) + (session?.draws ?? 0));
    countUp(netRr, net, (value) => `${value > 0 ? "+" : ""}${value}`);

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

    paintJourney(tracker, { summary: journeySummary, container: journeyChart, chart });
  };
}

/**
 * Rank journey: the same matches, but as a progression. The API delivers them
 * newest-first, so the story is read by walking the list backwards -- the
 * leftmost point is the oldest match and the rightmost is the standing now.
 */
function paintJourney(tracker, { summary, container, chart }) {
  const matches = tracker?.matches ?? [];
  const ordered = [...matches].reverse();
  const plotted = ordered.filter((match) => Number.isFinite(match?.rrAfter));

  // The journey's net is simply the RR its matches actually moved: every
  // plotted match carried an RrChange, and summing it is the same sum the
  // session grid shows, just over the plotted stretch rather than the anchor.
  const net = plotted.reduce(
    (sum, match) => sum + (Number.isFinite(match.rrChange) ? match.rrChange : 0),
    0);

  const points = buildSeries(ordered);

  swapText(summary, summaryFor(tracker, points, net));

  // The chart has nothing to say until there is a match to plot. The summary
  // line already explains why it is missing.
  container.hidden = points.length === 0;

  if (points.length === 0) {
    return;
  }

  const ys = points.map((point) => point.y);

  chart(points, {
    // The y axis is a tier's RR scale, so the domain starts at 0 and only
    // grows upward -- Radiant's overflow beyond 100 is drawn, not clamped
    // into lying.
    yMin: Math.min(0, ...ys),
    yMax: Math.max(RR_PER_TIER, ...ys),
    grid: [0, 50, RR_PER_TIER],
    xLabels: [shortDate(ordered[0]?.startedAt), shortDate(ordered[ordered.length - 1]?.startedAt)]
  });
}

function summaryFor(tracker, points, net) {
  if (!tracker?.updatedAt) {
    return "Refresh to load your recent matches.";
  }

  if (points.length === 0) {
    return "Play a competitive match to start your journey.";
  }

  const last = points[points.length - 1];
  return `${points.length} match${points.length === 1 ? "" : "es"} · ${net > 0 ? "+" : ""}${net} RR · now ${last.tierName}, ${last.rrAfter} RR`;
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

  stagger(fragment.children);
  list.replaceChildren(fragment);
}

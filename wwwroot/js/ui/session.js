/**
 * Session analytics view: how the current session actually went, read from
 * the tracker's own matches. Read-only -- the tracker owns refresh and reset,
 * and this view simply re-renders whenever the tracker's state changes.
 */

import { countUp, stagger, swapText } from "./motion.js";
import { mountChart } from "./chart.js";
import { aggregateMapStats } from "../stats/map-stats.js";
import { buildSeries, sessionAnalytics, shortDate } from "../stats/session-stats.js";

/** Riot's RR scale within a tier, for the chart domain (matches chart.js). */
const RR_PER_TIER = 100;

/** Chip letters to the result tokens the tracker and maps view use. */
const FORM_RESULTS = { W: "win", L: "loss", D: "draw" };

export function mountSession() {
  const updated = document.getElementById("sessionUpdated");
  const alert = document.getElementById("sessionAlert");
  const hero = document.getElementById("sessionHero");
  const net = document.getElementById("sessionNet");
  const played = document.getElementById("sessionPlayed");
  const wld = document.getElementById("sessionWld");
  const winrate = document.getElementById("sessionWinrate");
  const avg = document.getElementById("sessionAvg");
  const bestWorst = document.getElementById("sessionBestWorst");
  const rankSpan = document.getElementById("sessionRankSpan");
  const span = document.getElementById("sessionSpan");
  const empty = document.getElementById("sessionEmpty");
  const chartSection = document.getElementById("sessionChartSection");
  const chartContainer = document.getElementById("sessionChart");
  const chart = mountChart(chartContainer);
  const insightsSection = document.getElementById("sessionInsightsSection");
  const insights = document.getElementById("sessionInsights");
  const mapsSection = document.getElementById("sessionMapsSection");
  const maps = document.getElementById("sessionMaps");

  let renderedSignature = null;

  // Deliberately paints while the view is hidden, like the tracker and the
  // maps view: everything here reduces the same matches, and opening the tool
  // must not show a moment of blank sections while the reduction runs.
  return function render(state) {
    const tracker = state.tracker;

    alert.hidden = !tracker?.error;
    alert.textContent = tracker?.error ?? "";

    swapText(updated, tracker?.updatedAt
      ? `Updated ${new Date(tracker.updatedAt).toLocaleTimeString()}`
      : "Not loaded yet.");

    const analytics = sessionAnalytics(tracker?.matches ?? [], tracker?.session ?? null);
    const { subset, netRr, wins, losses, draws } = analytics;

    hero.hidden = analytics.played === 0;
    empty.hidden = analytics.played > 0;

    if (analytics.played === 0) {
      empty.textContent = tracker?.updatedAt
        ? "Play a competitive match to start your session."
        : "Refresh to load your recent matches.";
    }

    // Sections with nothing to say disappear rather than leaving dead headers.
    chartSection.hidden = subset.length === 0;
    insightsSection.hidden = analytics.played === 0;
    mapsSection.hidden = analytics.played === 0;

    // Headline numbers animate every frame; they are cheap text writes.
    countUp(net, netRr, (value) => `${value > 0 ? "+" : ""}${value}`);
    net.classList.toggle("is-up", netRr > 0);
    net.classList.toggle("is-down", netRr < 0);

    played.textContent = `${analytics.played} match${analytics.played === 1 ? "" : "es"}`;
    wld.textContent = `${wins} / ${losses} / ${draws}`;

    winrate.textContent = analytics.winrate === null ? "—" : `${Math.round(analytics.winrate * 100)}%`;
    winrate.classList.toggle("is-up", (analytics.winrate ?? 0) >= 0.5);
    winrate.classList.toggle("is-down", (analytics.winrate ?? 0) < 0.5);

    avg.textContent = formatRr(analytics.avgRr);
    bestWorst.textContent = analytics.best === null && analytics.worst === null
      ? "—"
      : `${formatRr(analytics.best)} / ${formatRr(analytics.worst)}`;
    rankSpan.textContent = rankSpanText(tracker);
    span.textContent = formatSpan(analytics.spanMs, analytics.firstStartedAt);

    // The chart, insights and maps rebuild only when the session's matches
    // actually change.
    const signature = subset.map((match) => `${match.matchId}:${match.rrChange}`).join("|");

    if (signature !== renderedSignature) {
      renderedSignature = signature;
      paintChart(chart, chartContainer, subset);
      paintInsights(insights, analytics);
      paintMaps(maps, subset);
    }
  };
}

/**
 * The session's own progression: the same tier-scale chart as the rank
 * journey, but over the matches since the session anchor rather than the
 * whole history window.
 */
function paintChart(chart, container, subset) {
  const points = buildSeries(subset);

  container.hidden = points.length === 0;

  if (points.length === 0) {
    return;
  }

  const ys = points.map((point) => point.y);

  chart(points, {
    yMin: Math.min(0, ...ys),
    yMax: Math.max(RR_PER_TIER, ...ys),
    grid: [0, 50, RR_PER_TIER],
    xLabels: [shortDate(subset[0]?.startedAt), shortDate(subset[subset.length - 1]?.startedAt)]
  });
}

/** Form chips plus the derived lines; every line is a plain statement. */
function paintInsights(container, analytics) {
  const fragment = document.createDocumentFragment();

  // Recent form, newest last -- the same reading direction as the maps view.
  const form = document.createElement("div");
  form.className = "session-form";
  form.setAttribute("aria-label", "Recent results, newest last");

  for (const result of analytics.form) {
    const chip = document.createElement("span");
    chip.className = "map-form-chip";
    chip.dataset.result = FORM_RESULTS[result] ?? "unknown";
    chip.textContent = result;
    form.append(chip);
  }

  fragment.append(form);

  const lines = document.createElement("div");
  lines.className = "session-lines";

  const streak = document.createElement("div");
  streak.className = "session-line";

  if (analytics.currentStreak > 0) {
    streak.classList.add(analytics.streakResult === "win" ? "is-up" : "is-down");
    streak.textContent = `${analytics.currentStreak} ${analytics.streakResult} streak`;
  } else {
    streak.textContent = "No current streak";
  }

  lines.append(streak);

  if (analytics.longestStreak > 1) {
    const longest = document.createElement("div");
    longest.className = "session-line is-dim";
    longest.textContent = `Longest: ${analytics.longestStreak} in a row`;
    lines.append(longest);
  }

  if (analytics.momentum) {
    const momentum = document.createElement("div");
    momentum.className = "session-line is-dim";
    momentum.textContent = `Momentum · last ${analytics.momentum.recentCount} matches avg ${formatRr(analytics.momentum.recentAvg)} RR · earlier ${analytics.momentum.earlierCount} avg ${formatRr(analytics.momentum.earlierAvg)} RR`;
    lines.append(momentum);
  }

  fragment.append(lines);
  stagger(fragment.children);
  container.replaceChildren(fragment);
}

/**
 * Compact per-map rows over the session's own matches. The aggregation is the
 * map view's -- this is the same function over a narrower history.
 */
function paintMaps(container, matches) {
  const { maps } = aggregateMapStats(matches);
  const fragment = document.createDocumentFragment();

  for (const map of maps) {
    const row = document.createElement("div");
    row.className = "session-map-row";

    const name = document.createElement("span");
    name.className = "session-map-name";
    name.textContent = map.name;
    name.classList.toggle("is-unknown", map.name === "Unknown map");
    row.append(name);

    const played = document.createElement("span");
    played.className = "session-map-played";
    played.textContent = `${map.played} match${map.played === 1 ? "" : "es"}`;
    row.append(played);

    const rate = document.createElement("span");
    rate.className = "session-map-rate";
    rate.textContent = `${Math.round(map.winrate * 100)}%`;
    rate.classList.add(map.winrate >= 0.5 ? "is-up" : "is-down");
    row.append(rate);

    const net = document.createElement("span");
    net.className = "session-map-net";
    net.textContent = formatRr(map.netRr);
    net.classList.toggle("is-up", map.netRr > 0);
    net.classList.toggle("is-down", map.netRr < 0);
    row.append(net);

    fragment.append(row);
  }

  stagger(fragment.children);
  container.replaceChildren(fragment);
}

function rankSpanText(tracker) {
  const starting = tracker?.session?.startingRank;
  const now = tracker?.rank;
  const start = starting ? `${starting.tierName}, ${starting.rankedRating} RR` : "—";
  const current = now ? `${now.tierName}, ${now.rankedRating} RR` : "—";

  return `${start} → ${current}`;
}

/**
 * The wall-clock span between the first and last match of the session -- the
 * session's actual length is not knowable without per-match durations, so it
 * is labelled as what it is and never called play time.
 */
function formatSpan(spanMs, firstStartedAt) {
  if (spanMs === null || spanMs === 0) {
    return "—";
  }

  const minutes = Math.max(1, Math.round(spanMs / 60000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const span = hours > 0 ? `${hours}h${rest > 0 ? ` ${rest}m` : ""} of matches` : `${rest}m of matches`;
  const from = firstStartedAt !== null
    ? ` · from ${new Date(firstStartedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
    : "";

  return span + from;
}

function formatRr(value) {
  if (value === null) {
    return "—";
  }

  const rounded = Math.round(value * 10) / 10;

  return `${rounded > 0 ? "+" : ""}${rounded}`;
}
/**
 * Session analytics: how the current session actually went, over the matches
 * the rank tracker already holds.
 *
 * Pure and stateless -- no DOM, no store -- so the session view, the future
 * dashboard and any later consumer all reduce the same history the same way.
 *
 * The session boundary mirrors the server's rule in
 * RankTrackerService.Summarize exactly: a match belongs to the session when it
 * has a timestamp and that timestamp is >= the session anchor. Matches without
 * a usable timestamp are excluded, the way the server excludes them. Duplicate
 * match IDs are NOT deduped here, because the server counts them too; Riot
 * never sends them in practice.
 *
 * The server's SessionSummary (wins, losses, draws, net RR, started-at,
 * starting rank) is authoritative for the headline numbers. This module only
 * derives what the server does not send -- the per-match subset, streaks,
 * form, best/worst, span, momentum and the chart series.
 */

/** Mirrors the semantic token colours the match rows use (.is-up, --bad). */
const RESULT_COLORS = { win: "#3ddc97", loss: "#ff5a68", draw: "#6a7183" };

/**
 * The matches that belong to the session, oldest first. An empty list when
 * there is no session anchor at all -- without one, "this session" has no
 * meaning and nothing can be attributed to it.
 */
export function sessionMatches(matches, session) {
  const anchor = session?.startedAt ? new Date(session.startedAt).getTime() : null;

  if (anchor === null || !Number.isFinite(anchor)) {
    return [];
  }

  const subset = [];

  for (const match of matches ?? []) {
    if (!match?.startedAt) {
      continue;
    }

    const at = new Date(match.startedAt).getTime();

    if (!Number.isFinite(at) || at < anchor) {
      continue;
    }

    subset.push(match);
  }

  return subset.sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
}

/**
 * The session, reduced. `played`, win/loss/draw and net RR come from the
 * server's summary; everything that needs per-match data (best/worst, span,
 * streaks, form, momentum, the subset for chart and maps) is derived here with
 * the same per-match guards the map aggregation uses -- a malformed value
 * costs that metric for the match, never the whole session.
 */
export function sessionAnalytics(matches, session) {
  const subset = sessionMatches(matches, session);

  const wins = session?.wins ?? 0;
  const losses = session?.losses ?? 0;
  const draws = session?.draws ?? 0;
  const played = wins + losses + draws;
  const netRr = session?.netRr ?? 0;

  let best = null;
  let worst = null;
  let first = null;
  let last = null;

  for (const match of subset) {
    if (Number.isFinite(match.rrChange)) {
      best = best === null ? match.rrChange : Math.max(best, match.rrChange);
      worst = worst === null ? match.rrChange : Math.min(worst, match.rrChange);
    }

    const at = new Date(match.startedAt).getTime();
    first = first === null ? at : Math.min(first, at);
    last = last === null ? at : Math.max(last, at);
  }

  const results = subset.map((match) => match.result);

  // The current streak is the run of wins or losses ending at the newest
  // match; a draw (or anything unrecognised) at the end means there is none.
  let currentStreak = 0;
  let streakResult = null;

  for (let i = results.length - 1; i >= 0; i--) {
    const result = results[i];

    if (result !== "win" && result !== "loss") {
      break;
    }

    if (streakResult === null) {
      streakResult = result;
    }

    if (result === streakResult) {
      currentStreak += 1;
    } else {
      break;
    }
  }

  // Longest run of wins or losses anywhere in the session. Draws break runs.
  let longestStreak = 0;
  let run = 0;
  let runResult = null;

  for (const result of results) {
    if (result === "win" || result === "loss") {
      if (result === runResult) {
        run += 1;
      } else {
        runResult = result;
        run = 1;
      }

      longestStreak = Math.max(longestStreak, run);
    } else {
      runResult = null;
      run = 0;
    }
  }

  // Newest last: the subset is ordered oldest-first, so the last five results
  // are the most recent five and the newest sits rightmost -- the same reading
  // direction as the rank journey chart and the map form chips.
  const form = results
    .slice(-5)
    .map((result) => (result === "win" ? "W" : result === "loss" ? "L" : result === "draw" ? "D" : "—"));

  // Momentum is only meaningful once there are enough matches for a split to
  // be anything but noise, so it stays hidden below six. The halves compare
  // per-match averages, which do not tilt when the split is uneven.
  let momentum = null;

  if (subset.length >= 6) {
    const half = Math.floor(subset.length / 2);
    const earlier = subset.slice(0, subset.length - half);
    const recent = subset.slice(subset.length - half);
    const average = (group) => {
      const changes = group.filter((match) => Number.isFinite(match.rrChange));

      return changes.length > 0
        ? changes.reduce((sum, match) => sum + match.rrChange, 0) / changes.length
        : null;
    };

    momentum = {
      recentAvg: average(recent),
      earlierAvg: average(earlier),
      recentCount: recent.length,
      earlierCount: earlier.length
    };
  }

  return {
    subset,
    played,
    wins,
    losses,
    draws,
    netRr,
    // Wins over *all* played matches -- draws sit in the denominator, the
    // same rule as the map aggregation.
    winrate: played > 0 ? wins / played : null,
    avgRr: played > 0 ? netRr / played : null,
    best,
    worst,
    firstStartedAt: first,
    lastStartedAt: last,
    spanMs: first !== null && last !== null ? last - first : null,
    currentStreak,
    streakResult: currentStreak > 0 ? streakResult : null,
    longestStreak,
    form,
    momentum
  };
}

/**
 * The rank journey chart series for a match list, oldest first. Matches whose
 * after-RR is not a number cannot be plotted and are skipped -- the chart is
 * honest about what it cannot place on the tier scale. The newest plotted
 * match is marked as the current standing.
 */
export function buildSeries(matches) {
  const plotted = (matches ?? []).filter((match) => Number.isFinite(match?.rrAfter));

  const points = plotted.map((match) => ({
    y: match.rrAfter,
    color: RESULT_COLORS[match.result] ?? RESULT_COLORS.draw,
    // The band colour comes from the tier assets via the service; a match
    // without one simply gets no band behind it.
    bandColor: match.tierColorAfter ?? null,
    tip: tipFor(match),
    tierName: match.tierNameAfter ?? "Unranked",
    rrAfter: match.rrAfter
  }));

  if (points.length > 0) {
    points[points.length - 1].current = true;
  }

  return points;
}

function tipFor(match) {
  const when = match.startedAt ? new Date(match.startedAt) : null;
  const time = when && !Number.isNaN(when.getTime())
    ? when.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "";
  const result = match.result ?? "unknown";
  const change = match.rrChange ?? 0;

  return [
    match.mapName || "Unknown map",
    `${result[0]?.toUpperCase() ?? ""}${result.slice(1)} · ${change > 0 ? "+" : ""}${change} RR`,
    `${match.rrAfter ?? "—"} RR · ${match.tierNameAfter || "—"}`,
    time
  ].filter(Boolean).join("\n");
}

export function shortDate(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
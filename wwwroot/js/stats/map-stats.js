/**
 * Map intelligence aggregation: personal statistics over the competitive
 * matches the rank tracker already holds.
 *
 * Pure and stateless -- no DOM, no store, no dates beyond what the matches
 * carry -- so the maps view, the future dashboard, and session analytics all
 * consume the same sums instead of re-slicing the history themselves. The
 * grouping key is a parameter so a later feature (agent x map, for instance)
 * can widen the dimension without rewriting the arithmetic.
 *
 * Everything here is PERSONAL data over the matches the client reported
 * (Riot's competitive-updates window, the most recent few dozen). It is
 * never presented as global Valorant statistics.
 */

/** Empty names, and the service's own sentinel for "map unknown", group here. */
const UNKNOWN_MAP = "Unknown map";

/** The tracker service derives results from the sign of the RR change. */
const RESULT_CODES = new Set(["win", "loss", "draw"]);

/** Which name a match counts under. Never null, never blank. */
export function mapKey(name) {
  const value = typeof name === "string" ? name.trim() : "";
  return value === "" || value === "the current map" ? UNKNOWN_MAP : value;
}

/**
 * Reduces the tracker's matches into one row per map.
 *
 * Every field is guarded: a malformed value costs that metric for the match,
 * never the whole aggregation. `played` counts every match; a match with an
 * unrecognised result still counts, just never as a win.
 */
export function aggregateMapStats(matches) {
  const buckets = new Map();

  for (const match of matches ?? []) {
    const key = mapKey(match?.mapName);
    let bucket = buckets.get(key);

    if (!bucket) {
      bucket = {
        key,
        played: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        changes: [],
        results: [],
        lastPlayed: null,
        best: null,
        worst: null
      };
      buckets.set(key, bucket);
    }

    bucket.played += 1;

    const result = match?.result;

    if (result === "win") {
      bucket.wins += 1;
    } else if (result === "loss") {
      bucket.losses += 1;
    } else {
      // Draws and anything unrecognised balance the count; only a win is a win.
      bucket.draws += 1;
    }

    if (Number.isFinite(match?.rrChange)) {
      bucket.changes.push(match.rrChange);
      bucket.best = bucket.best === null ? match.rrChange : Math.max(bucket.best, match.rrChange);
      bucket.worst = bucket.worst === null ? match.rrChange : Math.min(bucket.worst, match.rrChange);
    }

    if (match?.startedAt) {
      const at = new Date(match.startedAt).getTime();

      if (Number.isFinite(at) && (bucket.lastPlayed === null || at > bucket.lastPlayed)) {
        bucket.lastPlayed = at;
      }
    }

    bucket.results.push(result === "win" ? "W" : result === "loss" ? "L" : result === "draw" ? "D" : "—");
  }

  const maps = [...buckets.values()].map((bucket) => {
    const total = bucket.changes.reduce((sum, value) => sum + value, 0);

    return {
      name: bucket.key,
      played: bucket.played,
      wins: bucket.wins,
      losses: bucket.losses,
      draws: bucket.draws,
      // Wins over *all* played matches -- draws sit in the denominator.
      winrate: bucket.played > 0 ? bucket.wins / bucket.played : null,
      avgRr: bucket.changes.length > 0 ? total / bucket.changes.length : null,
      netRr: total,
      // Newest last: results arrive newest-first and the window is trimmed to
      // the last five, so reversing puts the most recent result rightmost,
      // the same direction the rank journey chart reads.
      form: bucket.results.slice(-5).reverse(),
      lastPlayed: bucket.lastPlayed,
      best: bucket.best,
      worst: bucket.worst
    };
  });

  // Most-played first; ties by name so a given history always sorts the same.
  maps.sort((a, b) => b.played - a.played || a.name.localeCompare(b.name));

  return {
    maps,
    totalPlayed: maps.reduce((sum, map) => sum + map.played, 0)
  };
}
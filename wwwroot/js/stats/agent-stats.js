/**
 * Agent intelligence aggregation: personal statistics over the competitive
 * matches the rank tracker already holds, per agent and per agent x map.
 *
 * Pure and stateless -- no DOM, no store -- so the agents view, the future
 * dashboard, and the harness all consume the same sums. Grouping keys are
 * normalised here, and every field is guarded: a malformed value costs that
 * metric for the match, never the whole aggregation.
 *
 * Everything here is PERSONAL data over the matches the client reported
 * (Riot's competitive-updates window, the most recent few dozen), enriched
 * with the agent actually played in each match. It is never presented as
 * global Valorant statistics.
 */

import { mapKey } from "./map-stats.js";

/** Blank agent ids -- a match that has not been enriched yet -- group here. */
export const UNKNOWN_AGENT = "Unknown agent";

/** A match with no map name groups under the maps view's own sentinel. */
export { mapKey };

/**
 * Fewer than this many matches make an agent x map cell read as reliable.
 * The cell still shows its match count; the comparison metrics show "–"
 * instead of pretending one match means anything.
 */
export const MIN_CELL_SAMPLE = 2;

/** Which id a match counts under. Never null, never blank. */
export function agentKey(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : UNKNOWN_AGENT;
}

/**
 * The shared agent catalogue lookup for the views: a record resolves by its
 * slug (`value`) or by Riot's character uuid (`uuid`), so a match's agentId --
 * which is a uuid -- lands on the same record the grid works with. UUID keys
 * are lowercased for case-insensitive matching; a record with no uuid simply
 * has no uuid key. Blank/unknown ids stay outside the map, where callers fall
 * back to UNKNOWN_AGENT.
 */
export function agentLookup(agents) {
  const byId = new Map();

  for (const agent of agents ?? []) {
    if (agent?.value) {
      byId.set(agent.value, agent);
    }

    if (agent?.uuid) {
      byId.set(agent.uuid.toLowerCase(), agent);
    }
  }

  return byId;
}

/**
 * Reduces the tracker's matches into one row per agent. The shape mirrors
 * aggregateMapStats so the two views read alike; only the grouping key and
 * the sentinel differ.
 */
export function aggregateAgentStats(matches) {
  const buckets = new Map();

  for (const match of matches ?? []) {
    const key = agentKey(match?.agentId);
    let bucket = buckets.get(key);

    if (!bucket) {
      bucket = {
        key,
        played: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        changes: [],
        results: []
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
    }

    bucket.results.push(result === "win" ? "W" : result === "loss" ? "L" : result === "draw" ? "D" : "—");
  }

  const agents = [...buckets.values()].map((bucket) => {
    const total = bucket.changes.reduce((sum, value) => sum + value, 0);

    return {
      id: bucket.key,
      played: bucket.played,
      wins: bucket.wins,
      losses: bucket.losses,
      draws: bucket.draws,
      // Wins over *all* played matches -- draws sit in the denominator.
      winrate: bucket.played > 0 ? bucket.wins / bucket.played : null,
      avgRr: bucket.changes.length > 0 ? total / bucket.changes.length : null,
      netRr: total,
      // Newest last: results arrive newest-first, so reversing puts the most
      // recent result rightmost, the same direction the rank journey reads.
      form: bucket.results.slice(-5).reverse()
    };
  });

  // Most-played first; ties by id so a given history always sorts the same.
  agents.sort((a, b) => b.played - a.played || String(a.id).localeCompare(String(b.id)));

  return {
    agents,
    totalPlayed: agents.reduce((sum, agent) => sum + agent.played, 0)
  };
}

/**
 * Reduces the tracker's matches into one cell per agent x map combination.
 * Cells keep the raw sums and the played count; the UI decides whether the
 * sample is big enough to show the comparison metrics (MIN_CELL_SAMPLE).
 */
export function aggregateAgentMapStats(matches) {
  const buckets = new Map();

  for (const match of matches ?? []) {
    const key = `${agentKey(match?.agentId)}\u0000${mapKey(match?.mapName)}`;
    let bucket = buckets.get(key);

    if (!bucket) {
      bucket = {
        agent: agentKey(match?.agentId),
        map: mapKey(match?.mapName),
        played: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        changes: []
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
      bucket.draws += 1;
    }

    if (Number.isFinite(match?.rrChange)) {
      bucket.changes.push(match.rrChange);
    }
  }

  const cells = [...buckets.values()].map((bucket) => {
    const total = bucket.changes.reduce((sum, value) => sum + value, 0);

    return {
      agent: bucket.agent,
      map: bucket.map,
      played: bucket.played,
      wins: bucket.wins,
      losses: bucket.losses,
      draws: bucket.draws,
      winrate: bucket.played > 0 ? bucket.wins / bucket.played : null,
      avgRr: bucket.changes.length > 0 ? total / bucket.changes.length : null,
      netRr: total
    };
  });

  // Agent order and map order both by total plays, ties by name, so the
  // heatmap reads the same way whatever order the matches arrived in.
  const agentPlays = new Map();
  const mapPlays = new Map();

  for (const cell of cells) {
    agentPlays.set(cell.agent, (agentPlays.get(cell.agent) ?? 0) + cell.played);
    mapPlays.set(cell.map, (mapPlays.get(cell.map) ?? 0) + cell.played);
  }

  const agents = [...agentPlays.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([name]) => name);

  const maps = [...mapPlays.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([name]) => name);

  return { cells, agents, maps };
}
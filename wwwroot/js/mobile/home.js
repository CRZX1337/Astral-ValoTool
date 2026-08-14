/**
 * The phone's home tab: rank, today's session, the most recent matches, and
 * the two "best of" chips. Every number comes from the tracker module state
 * that the stream (or the polling fallback) already holds -- this page makes
 * no data requests of its own.
 */

import { aggregateMapStats } from "../stats/map-stats.js";
import { aggregateAgentStats, agentLookup, UNKNOWN_AGENT } from "../stats/agent-stats.js";
import { sessionAnalytics } from "../stats/session-stats.js";
import { stagger, swapText } from "../ui/motion.js";
import { relativeTime } from "./shell.js";

/** RRs never spill past the tier boundary on the progress bar. */
const RR_PER_TIER = 100;

/** A "best of" needs at least this many matches before it means anything. */
const BEST_SAMPLE = 3;

export function mountHome() {
  const rankCard = document.getElementById("rankCard");
  const rankIcon = document.getElementById("rankIcon");
  const rankFallback = document.getElementById("rankFallback");
  const rankName = document.getElementById("rankName");
  const rankRr = document.getElementById("rankRr");
  const rankFill = document.getElementById("rankFill");

  const sNet = document.getElementById("sNet");
  const sWins = document.getElementById("sWins");
  const sLosses = document.getElementById("sLosses");
  const sRate = document.getElementById("sRate");
  const sessionWhen = document.getElementById("sessionWhen");
  const formRow = document.getElementById("formRow");
  const streakLine = document.getElementById("streakLine");

  const recentList = document.getElementById("recentList");
  const recentEmpty = document.getElementById("recentEmpty");
  const recentWhen = document.getElementById("recentWhen");
  const topChips = document.getElementById("topChips");

  let recentSignature = null;

  return function render(state) {
    const tracker = state.tracker;
    const matches = tracker?.matches ?? [];
    const byId = agentLookup(state.agents);

    paintRank(tracker?.rank ?? null);
    paintSession(tracker, sessionAnalytics(matches, tracker?.session ?? null));

    // The recent list only repaints when the match set actually changed;
    // the stream frames in once a second otherwise. The agents version is
    // part of the signature because agents can land after the first tracker
    // render at boot -- without it, names would stay as raw ids forever.
    const recent = matches.slice(0, 5);
    const signature = recent
      .map((match) => `${match.matchId}:${match.rrChange}:${match.agentId ?? ""}`)
      .join("|") + agentsVersion(state.agents);

    if (signature !== recentSignature) {
      recentSignature = signature;
      paintRecent(recent, byId);
      paintChips(matches, byId);
    }

    recentEmpty.hidden = recent.length > 0;

    if (recent.length === 0) {
      recentEmpty.textContent = tracker?.updatedAt
        ? "No competitive matches found."
        : "Refresh to load your recent matches.";
    }

    swapText(recentWhen, tracker?.updatedAt ? `Updated ${relativeTime(tracker.updatedAt)}` : "");
  };

  function paintRank(rank) {
    rankCard.hidden = !rank;

    if (!rank) {
      return;
    }

    swapText(rankName, rank.tierName || "Unranked");
    swapText(rankRr, `${rank.rankedRating ?? 0} RR`);

    const rating = Number.isFinite(rank.rankedRating) ? rank.rankedRating : 0;
    rankFill.style.width = `${Math.max(0, Math.min(rating, RR_PER_TIER))}%`;
    rankCard.style.setProperty("--rank-color", rank.tierColor || "var(--brand)");

    // The badge shows a monogram until the emblem itself proves it loaded.
    swapText(rankFallback, (rank.tierName || "Unranked").slice(0, 2).toUpperCase());

    if (rank.tierIcon) {
      rankIcon.onload = () => {
        rankIcon.hidden = false;
        rankFallback.hidden = true;
      };
      rankIcon.src = rank.tierIcon;
    } else {
      rankIcon.hidden = true;
      rankIcon.removeAttribute("src");
      rankFallback.hidden = false;
    }
  }

  function paintSession(tracker, analytics) {
    const net = analytics.netRr ?? 0;

    swapText(sNet, `${net > 0 ? "+" : ""}${net}`);
    sNet.classList.toggle("is-up", net > 0);
    sNet.classList.toggle("is-down", net < 0);

    swapText(sWins, String(analytics.wins));
    swapText(sLosses, String(analytics.losses));
    swapText(sRate, analytics.winrate === null ? "—" : `${Math.round(analytics.winrate * 100)}%`);

    swapText(sessionWhen, analytics.played === 0 ? "no matches yet" : `since ${sessionTime(tracker?.session?.startedAt)}`);

    paintForm(formRow, analytics.form);

    if (analytics.currentStreak > 0) {
      const noun = analytics.streakResult === "win" ? "win" : "loss";

      streakLine.hidden = false;
      streakLine.textContent = `${analytics.currentStreak} ${analytics.currentStreak === 1 ? noun : `${noun}es`} in a row`;
    } else {
      streakLine.hidden = true;
    }
  }

  function paintRecent(matches, byId) {
    recentList.textContent = "";

    for (const match of matches) {
      recentList.appendChild(matchRow(match, byId));
    }

    stagger(recentList.children);
  }

  function paintChips(matches, byId) {
    topChips.textContent = "";

    const bestMap = pickBest(aggregateMapStats(matches).maps, (row) => row.name);
    const bestAgent = pickBest(aggregateAgentStats(matches).agents, (row) => resolveName(row.id, byId));

    const chips = [];

    if (bestMap) {
      chips.push({
        label: "Best map",
        name: bestMap.name,
        value: `${pct(bestMap.winrate)} · ${bestMap.played} played`
      });
    }

    if (bestAgent) {
      chips.push({
        label: "Best agent",
        name: resolveName(bestAgent.id, byId),
        value: `${pct(bestAgent.winrate)} · ${bestAgent.played} played`
      });
    }

    if (chips.length === 0) {
      return;
    }

    for (const chip of chips) {
      const row = document.createElement("div");
      row.className = "top-chip";

      const label = document.createElement("span");
      label.className = "tc-lbl";
      label.textContent = chip.label;

      const name = document.createElement("span");
      name.className = "tc-name";
      name.textContent = chip.name;

      const value = document.createElement("span");
      value.className = "tc-value";
      value.textContent = chip.value;

      row.append(label, name, value);
      topChips.appendChild(row);
    }

    stagger(topChips.children);
  }
}

/** The row shape shared with the Matches tab, so both lists read alike. */
export function matchRow(match, byId) {
  const row = document.createElement("div");
  row.className = "match-row";
  row.dataset.result = match.result ?? "";

  const flag = document.createElement("span");
  flag.className = "match-flag";
  flag.setAttribute("aria-hidden", "true");

  const main = document.createElement("div");
  main.className = "match-main";

  const map = document.createElement("div");
  map.className = "match-map";
  map.textContent = match.mapName || "Unknown map";

  const sub = document.createElement("div");
  sub.className = "match-sub";

  const agent = document.createElement("span");
  agent.className = "match-agent";

  const agentRecord = byId.get(match.agentId ?? "");

  if (agentRecord?.portrait) {
    const portrait = document.createElement("img");
    portrait.src = agentRecord.portrait;
    portrait.alt = "";
    portrait.decoding = "async";
    agent.appendChild(portrait);
  }

  const agentName = document.createElement("span");
  agentName.textContent = agentRecord ? agentRecord.name : "Unknown agent";
  agent.appendChild(agentName);

  sub.append(agent, document.createTextNode("·"), document.createTextNode(relativeTime(match.startedAt)));

  main.append(map, sub);

  const rr = document.createElement("span");
  rr.className = "match-rr";

  if (Number.isFinite(match.rrChange)) {
    rr.textContent = `${match.rrChange > 0 ? "+" : ""}${match.rrChange}`;
    rr.classList.toggle("is-up", match.rrChange > 0);
    rr.classList.toggle("is-down", match.rrChange < 0);
  } else {
    rr.textContent = "—";
  }

  row.append(flag, main, rr);
  return row;
}

/** Form chips, newest on the right, mirroring the desktop reading direction. */
export function paintForm(container, form) {
  container.textContent = "";

  for (const result of form ?? []) {
    const chip = document.createElement("span");
    chip.className = "form-chip";
    chip.textContent = result;

    if (result === "W") {
      chip.dataset.result = "win";
    } else if (result === "L") {
      chip.dataset.result = "loss";
    }

    container.appendChild(chip);
  }
}

export function resolveName(id, byId) {
  // A raw character uuid is never a user-facing name: unknown ids read as
  // the shared sentinel.
  return byId.get(id ?? "")?.name ?? UNKNOWN_AGENT;
}

export function pct(winrate) {
  return winrate === null || winrate === undefined ? "—" : `${Math.round(winrate * 100)}%`;
}

/**
 * A compact fingerprint of the agent records, for repaint signatures: the
 * ids alone do not move when assets land after the first tracker render.
 */
export function agentsVersion(agents) {
  return `|agents:${(agents ?? []).map((agent) => `${agent.value}@${agent.name}`).join(",")}`;
}

function pickBest(rows, nameOf) {
  const qualified = (rows ?? []).filter((row) => row.played >= BEST_SAMPLE && row.winrate !== null);

  qualified.sort((a, b) => b.winrate - a.winrate || b.played - a.played || nameOf(a).localeCompare(nameOf(b)));

  return qualified[0] ?? null;
}

function sessionTime(value) {
  if (!value) {
    return "—";
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
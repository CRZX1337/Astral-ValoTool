/**
 * The phone's Matches tab: every tracked competitive match, newest first.
 * Rows share the shape (and the module) that the home tab's recent list uses,
 * so both always look the same.
 */

import { agentLookup } from "../stats/agent-stats.js";
import { stagger, swapText } from "../ui/motion.js";
import { agentsVersion, matchRow } from "./home.js";
import { relativeTime } from "./shell.js";

export function mountMatches() {
  const list = document.getElementById("matchList");
  const empty = document.getElementById("matchEmpty");
  const updated = document.getElementById("matchesUpdated");

  let renderedSignature = null;

  return function render(state) {
    const tracker = state.tracker;
    const matches = tracker?.matches ?? [];
    // uuid -> record, the shared resolver: match history reports Riot
    // character uuids, so a slug-only lookup would never resolve them.
    const byId = agentLookup(state.agents);

    const signature = matches.map((match) => `${match.matchId}:${match.rrChange}:${match.agentId ?? ""}`).join("|") + agentsVersion(state.agents);

    if (signature !== renderedSignature) {
      renderedSignature = signature;
      list.textContent = "";

      for (const match of matches) {
        list.appendChild(matchRow(match, byId));
      }

      stagger(list.children);
    }

    empty.hidden = matches.length > 0;

    if (matches.length === 0) {
      empty.textContent = tracker?.updatedAt
        ? "No competitive matches found."
        : "Refresh to load your recent matches.";
    }

    swapText(updated, tracker?.updatedAt ? `Updated ${relativeTime(tracker.updatedAt)}` : "Not loaded yet.");
  };
}
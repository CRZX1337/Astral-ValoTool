/**
 * Phone companion entry point: a control surface for the desktop app. Reads
 * the same event stream the desktop feeds and can arm the instalock, drive
 * the auto-queue, and reset the session -- every write goes through the
 * existing LAN-authenticated routes.
 *
 * Routing: the shell (appbar, status line, bottom nav) mounts once and stays
 * for the lifetime of the page. Exactly one feature page -- Home, Session,
 * Matches, Maps, Agents, Instalock or the More hub -- is mounted in #page at
 * any moment; the router unmounts it (unsubscribe + destroy + DOM removal)
 * before mounting the next one. See router.js for the route table.
 *
 * Boot is deliberately quiet: load the agent list and one tracker refresh up
 * front (so the phone shows today's session even when the desktop has not
 * opened a stats view this run), then everything after that rides the stream.
 */

import { startStateFeed } from "../poller.js";
import { getState, loadAgents, refreshTrackerState, subscribe } from "../store.js";
import { createRouter } from "./router.js";
import { mountAgents } from "./agents.js";
import { mountHome } from "./home.js";
import { mountInstalock } from "./instalock.js";
import { mountMaps } from "./maps.js";
import { mountMatches } from "./matches.js";
import { mountMore } from "./more.js";
import { mountSession } from "./session.js";
import { mountMobileShell } from "./shell.js";

const shell = mountMobileShell();
subscribe(shell);
shell(getState());

const pages = {
  home: mountHome,
  session: mountSession,
  matches: mountMatches,
  maps: mountMaps,
  agents: mountAgents,
  instalock: mountInstalock,
  more: mountMore
};

const router = createRouter({
  host: document.getElementById("page"),
  pages
});

// Mount the page named by the current hash (deep links and refreshes land
// straight on their route; a bare URL opens Home).
router.start();

void loadAgents();
void refreshTrackerState();
startStateFeed();
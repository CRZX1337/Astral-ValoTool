/**
 * Phone companion entry point. Read-only by design: no instalock controls, no
 * auto-queue, no lobby intel -- the phone looks at the same event stream the
 * desktop feeds and renders a mirror of it.
 *
 * Boot is deliberately quiet: load the agent list and one tracker refresh up
 * front (so the phone shows today's session even when the desktop has not
 * opened a stats view this run), then everything after that rides the stream.
 */

import { startStateFeed } from "../poller.js";
import { getState, loadAgents, refreshTrackerState, subscribe } from "../store.js";
import { mountAgents } from "./agents.js";
import { mountHome } from "./home.js";
import { mountMaps } from "./maps.js";
import { mountMatches } from "./matches.js";
import { mountMobileShell } from "./shell.js";

const views = [
  mountMobileShell(),
  mountHome(),
  mountMatches(),
  mountMaps(),
  mountAgents()
];

subscribe((state) => {
  for (const render of views) {
    render(state);
  }
});

for (const render of views) {
  render(getState());
}

void loadAgents();
void refreshTrackerState();
startStateFeed();
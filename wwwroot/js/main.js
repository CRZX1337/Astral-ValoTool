/**
 * Wiring: mount the views, subscribe them to the store, load the catalogue,
 * then let the event stream drive everything else.
 */

import { startStateFeed } from "./poller.js";
import { getState, loadAgents, loadQueue, loadQueueOptions, loadTracker, subscribe } from "./store.js";
import { mountAgentGrid } from "./ui/agent-grid.js";
import { mountAutoQueue } from "./ui/autoqueue.js";
import { mountControlPanel } from "./ui/control-panel.js";
import { mountHeader } from "./ui/header.js";
import { mountSettings } from "./ui/settings.js";
import { mountShell } from "./ui/shell.js";
import { mountTilt } from "./ui/tilt.js";
import { mountTooltips } from "./ui/tooltip.js";
import { mountTracker } from "./ui/tracker.js";

const views = [
  mountShell(),
  mountHeader(),
  mountAgentGrid(),
  mountControlPanel(),
  mountTracker(),
  mountAutoQueue(),
  mountSettings(),
  mountTooltips(),
  mountTilt()
];

subscribe((state) => {
  for (const render of views) {
    render(state);
  }
});

// First paint: skeletons and the "loading" phase, before any request lands.
for (const render of views) {
  render(getState());
}

void loadAgents();

// Cheap reads that make the home cards meaningful before a tool is opened.
// Each tool still refreshes properly when its view is entered.
void loadTracker();
void loadQueue();
void loadQueueOptions();

startStateFeed();

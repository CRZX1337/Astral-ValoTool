/**
 * Wiring: mount the views, subscribe them to the store, load the catalogue,
 * then let the poller drive everything else.
 */

import { startStateFeed } from "./poller.js";
import { getState, loadAgents, subscribe } from "./store.js";
import { mountAgentGrid } from "./ui/agent-grid.js";
import { mountControlPanel } from "./ui/control-panel.js";
import { mountHeader } from "./ui/header.js";
import { mountSettings } from "./ui/settings.js";
import { mountTooltips } from "./ui/tooltip.js";

const views = [mountHeader(), mountAgentGrid(), mountControlPanel(), mountSettings(), mountTooltips()];

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
startStateFeed();

/**
 * Wiring: mount the views, subscribe them to the store, load the catalogue,
 * then let the event stream drive everything else.
 */

import { startStateFeed } from "./poller.js";
import { getState, loadAgents, loadQueue, loadQueueOptions, loadTracker, subscribe } from "./store.js";
import { mountAgentGrid } from "./ui/agent-grid.js";
import { mountAutoQueue } from "./ui/autoqueue.js";
import { mountBoot } from "./ui/boot.js";
import { mountControlPanel } from "./ui/control-panel.js";
import { mountControls } from "./ui/controls.js";
import { mountHeader } from "./ui/header.js";
import { mountSettings } from "./ui/settings.js";
import { mountShell } from "./ui/shell.js";
import { mountTilt } from "./ui/tilt.js";
import { mountTooltips } from "./ui/tooltip.js";
import { mountTracker } from "./ui/tracker.js";

// Belt and braces for the context menu: DesktopAppForm turns it off in
// WebView2 itself, which is the real fix, but that setting is only applied
// once the runtime is up. This also covers the case of the UI being opened in
// an ordinary browser via the loopback port.
document.addEventListener("contextmenu", (event) => event.preventDefault());

const views = [
  mountBoot(),
  mountShell(),
  mountHeader(),
  mountAgentGrid(),
  mountControlPanel(),
  mountTracker(),
  mountAutoQueue(),
  mountSettings(),
  mountTooltips(),
  mountTilt(),
  mountControls()
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

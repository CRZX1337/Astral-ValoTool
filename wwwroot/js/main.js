/**
 * Wiring: mount the views, subscribe them to the store, load the catalogue,
 * then let the event stream drive everything else.
 */

import { startStateFeed } from "./poller.js";
import {
  getState,
  loadAgents,
  loadQueue,
  loadQueueOptions,
  loadTracker,
  loadUpdate,
  subscribe
} from "./store.js";
import { mountAgentGrid } from "./ui/agent-grid.js";
import { mountAgents } from "./ui/agents.js";
import { mountAutoQueue } from "./ui/autoqueue.js";
import { mountBoot } from "./ui/boot.js";
import { mountControlPanel } from "./ui/control-panel.js";
import { mountControls } from "./ui/controls.js";
import { mountHeader } from "./ui/header.js";
import { mountIntel } from "./ui/intel.js";
import { mountLan } from "./ui/lan.js";
import { mountMaps } from "./ui/maps.js";
import { mountPerf } from "./ui/perf.js";
import { mountSession } from "./ui/session.js";
import { mountSettings } from "./ui/settings.js";
import { mountShell } from "./ui/shell.js";
import { mountTilt } from "./ui/tilt.js";
import { mountTooltips } from "./ui/tooltip.js";
import { mountTracker } from "./ui/tracker.js";
import { mountUpdate } from "./ui/update.js";
import { mountWindowControls } from "./ui/window-controls.js";

// Belt and braces for the context menu: DesktopAppForm turns it off in
// WebView2 itself, which is the real fix, but that setting is only applied
// once the runtime is up. This also covers the case of the UI being opened in
// an ordinary browser via the loopback port.
document.addEventListener("contextmenu", (event) => event.preventDefault());

const views = [
  // First on purpose: the frame probe should measure the boot sequence, which is
  // the busiest the window ever gets, and the idle flag should be right from the
  // very first frame rather than after the splash.
  mountPerf(),
  mountWindowControls(),
  mountBoot(),
  mountShell(),
  mountHeader(),
  mountAgentGrid(),
  mountControlPanel(),
  mountTracker(),
  mountMaps(),
  mountAgents(),
  mountSession(),
  mountAutoQueue(),
  mountIntel(),
  mountLan(),
  mountSettings(),
  mountUpdate(),
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

// Whatever the last check found, so a pending update is on screen before the
// startup check (six seconds in, UpdateService.StartupDelay) has run again.
void loadUpdate();

startStateFeed();

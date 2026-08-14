/**
 * The phone's More page: a hub that opens two compact sub-pages.
 *
 * AutoQueue -- the existing start/stop actions over the existing endpoints;
 * the page renders whatever state the stream already holds and refreshes on
 * open, the same lazy rule the desktop autoqueue view follows.
 *
 * Lobby intel -- read-only. The watch is driven the way the desktop drives
 * it (on while its page is open, off when it leaves), so the roster flows
 * through the existing /api/events frames; no refresh button is needed.
 *
 * Sub-pages are nested routes (#/more/autoqueue, #/more/intel) inside the
 * More hub. The router dispatches astral:subpage enter/leave events; this
 * module shows whichever sub-page is named and reacts to the lifecycle
 * events. When the whole More page unmounts, destroy() ends the lobby watch
 * and drops the document-level listener so nothing leaks into another page.
 */

import {
  getState,
  refreshQueueState,
  toggleAutoQueue,
  watchLobby
} from "../store.js";
import { swapText } from "../ui/motion.js";
import { navigate } from "./router.js";
import { relativeTime } from "./shell.js";

const PICK_LABELS = { None: "—", Hovering: "Hovering", Locked: "Locked" };

export function mountMore(initialSub = null) {
  const hub = document.getElementById("moreHub");
  const subPages = {
    autoqueue: document.getElementById("sub-autoqueue"),
    intel: document.getElementById("sub-intel")
  };

  const aqEntrySub = document.getElementById("aqEntrySub");
  const intelEntrySub = document.getElementById("intelEntrySub");

  const aqUpdated = document.getElementById("aqUpdated");
  const aqError = document.getElementById("aqError");
  const aqPhase = document.getElementById("aqPhase");
  const aqRequeues = document.getElementById("aqRequeues");
  const aqStatus = document.getElementById("aqStatus");
  const aqParty = document.getElementById("aqParty");
  const aqQueue = document.getElementById("aqQueue");
  const aqRequeueCount = document.getElementById("aqRequeueCount");
  const aqLimit = document.getElementById("aqLimit");
  const aqStart = document.getElementById("aqStart");
  const aqStartLabel = document.getElementById("aqStartLabel");
  const aqStop = document.getElementById("aqStop");

  const intelMap = document.getElementById("intelMap");
  const intelError = document.getElementById("intelError");
  const intelPhase = document.getElementById("intelPhase");
  const intelTimer = document.getElementById("intelTimer");
  const intelStatus = document.getElementById("intelStatus");
  const intelLocked = document.getElementById("intelLocked");
  const lobbyList = document.getElementById("lobbyList");
  const lobbyEmpty = document.getElementById("lobbyEmpty");

  function showSub(name) {
    hub.hidden = name !== null;
    subPages.autoqueue.hidden = name !== "autoqueue";
    subPages.intel.hidden = name !== "intel";
    document.body.dataset.sub = name ?? "hub";
  }

  aqStart.addEventListener("click", () => void toggleAutoQueue(true));
  aqStop.addEventListener("click", () => void toggleAutoQueue(false));

  document.getElementById("aqEntry").addEventListener("click", () => navigate("more", "autoqueue"));
  document.getElementById("intelEntry").addEventListener("click", () => navigate("more", "intel"));
  document.getElementById("aqBack").addEventListener("click", () => navigate("more"));
  document.getElementById("intelBack").addEventListener("click", () => navigate("more"));

  // The same lazy rule the desktop autoqueue view follows: fetch once on
  // open, then trust the stream. Leaving the intel sub-page ends its watch,
  // exactly as leaving the desktop intel view does.
  const onSubpage = (event) => {
    const name = event.detail?.name ?? null;
    showSub(name);

    if (name === "autoqueue" && !getState().queuePending) {
      void refreshQueueState();
    }

    if (name === "intel" && !getState().intel?.isWatching && !getState().intelPending) {
      void watchLobby(true);
    }

    if (name === null && getState().intel?.isWatching && !getState().intelPending) {
      void watchLobby(false);
    }
  };

  document.addEventListener("astral:subpage", onSubpage);
  showSub(initialSub);

  function render(state) {
    paintAutoQueue(state);
    paintIntel(state);
  }

  return {
    render,

    destroy() {
      document.removeEventListener("astral:subpage", onSubpage);

      // Leaving the page while the lobby watch is on must end it, the same
      // rule as leaving the intel sub-page or the desktop intel view.
      if (getState().intel?.isWatching && !getState().intelPending) {
        void watchLobby(false);
      }
    }
  };

  function paintAutoQueue(state) {
    const queue = state.autoqueue;
    const running = Boolean(queue?.isRunning);
    const busy = state.queuePending;

    aqEntrySub.textContent = running ? queue.status : "Idle.";

    aqError.hidden = !queue?.error;
    aqError.textContent = queue?.error ?? "";

    swapText(aqStatus, queue?.status ?? "Not loaded yet.");
    swapText(aqUpdated, queue?.updatedAt ? relativeTime(queue.updatedAt) : "—");

    aqPhase.textContent = running ? "Running" : "Idle";
    aqPhase.dataset.phase = running ? "running" : "idle";
    aqPhase.classList.toggle("is-up", running);
    aqPhase.classList.toggle("is-down", queue?.limitReached);

    swapText(aqRequeues, queue?.limitReached ? "Limit reached" : "");

    swapText(aqParty, queue?.partyState ? `Party: ${queue.partyState}` : "—");
    swapText(aqQueue, queue?.currentQueueId ?? "Not in queue");
    swapText(aqRequeueCount, String(queue?.consecutiveRequeues ?? 0));

    aqLimit.hidden = !queue?.limitReached;
    aqLimit.textContent = queue?.limitReached ? "Reached — stopped" : "No";

    aqStart.disabled = running || busy;
    aqStart.classList.toggle("is-busy", busy && !running);
    aqStartLabel.textContent = running ? "Running" : "Start";

    aqStop.disabled = !running || busy;
    aqStop.classList.toggle("is-busy", busy && running);
  }

  function paintIntel(state) {
    const intel = state.intel;

    intelEntrySub.textContent = intel?.isWatching
      ? intel.status
      : "Not watching.";

    intelError.hidden = !intel?.error;
    intelError.textContent = intel?.error ?? "";

    swapText(intelStatus, intel?.status ?? "Not watching.");
    swapText(intelMap, intel?.mapName ?? "—");
    swapText(intelLocked, intel?.isActive ? `${intel.lockedCount} locked` : "");

    intelTimer.hidden = !intel?.isActive || intel?.secondsRemaining == null;
    intelTimer.textContent = intel?.secondsRemaining == null
      ? ""
      : `${Math.ceil(intel.secondsRemaining)}s`;

    intelPhase.textContent = intel?.isActive ? "Agent select" : intel?.isWatching ? "Watching" : "Not watching";
    intelPhase.dataset.phase = intel?.isActive ? "running" : intel?.isWatching ? "watching" : "idle";
    intelPhase.classList.toggle("is-up", intel?.isActive || intel?.isWatching);

    paintPlayers(intel?.players ?? []);
    lobbyEmpty.hidden = (intel?.players?.length ?? 0) > 0;
  }

  function paintPlayers(players) {
    const signature = players.map((player) =>
      `${player.slot}:${player.name ?? ""}:${player.agentName ?? ""}:${player.pickState}`).join("|");

    if (signature === lobbyList.dataset.signature) {
      return;
    }

    lobbyList.dataset.signature = signature;
    lobbyList.replaceChildren();

    for (const player of players) {
      lobbyList.appendChild(playerRow(player));
    }
  }
}

function playerRow(player) {
  const row = document.createElement("div");
  row.className = "lobby-row";
  row.dataset.pick = player.pickState?.toLowerCase() ?? "none";

  const slot = document.createElement("span");
  slot.className = "lobby-slot";
  slot.textContent = String(player.slot + 1);

  const art = document.createElement("span");
  art.className = "lobby-art";

  const portrait = document.createElement("img");
  portrait.alt = "";
  portrait.decoding = "async";
  portrait.hidden = true;

  if (player.agentPortrait) {
    portrait.addEventListener("load", () => {
      portrait.hidden = false;
      monogramEl.hidden = true;
    }, { once: true });
    portrait.src = player.agentPortrait;
  }

  const monogramEl = document.createElement("span");
  monogramEl.className = "lobby-monogram";
  monogramEl.setAttribute("aria-hidden", "true");
  monogramEl.textContent = player.agentName ? player.agentName[0] : "?";

  art.append(portrait, monogramEl);

  const main = document.createElement("span");
  main.className = "lobby-main";

  const name = document.createElement("span");
  name.className = "lobby-name";
  name.textContent = player.isIncognito
    ? "Incognito player"
    : (player.name ?? "Unknown player");
  main.append(name);

  if (player.agentName) {
    const agent = document.createElement("span");
    agent.className = "lobby-agent";
    agent.textContent = player.agentName;
    main.append(agent);
  }

  const meta = document.createElement("span");
  meta.className = "lobby-meta";
  meta.textContent = [player.tierName, player.isCaptain ? "Captain" : "", player.isSelf ? "You" : ""]
    .filter(Boolean)
    .join(" · ");
  main.append(meta);

  const pick = document.createElement("span");
  pick.className = "lobby-pick";
  pick.textContent = PICK_LABELS[player.pickState] ?? "—";

  row.append(slot, art, main, pick);
  return row;
}
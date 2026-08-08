/**
 * Single source of truth. Views never talk to each other or to the API --
 * they call actions here and re-render from the snapshot they get back.
 *
 * Flow: api -> store -> emit -> views.
 */

import {
  ApiError,
  applyUpdate,
  cancelUpdateDownload,
  checkForUpdate,
  downloadUpdate,
  fetchAgents,
  fetchAutoQueue,
  fetchAutoQueueOptions,
  fetchOptions,
  fetchTracker,
  fetchUpdate,
  patchAutoQueueOptions,
  patchOptions,
  refreshAutoQueue,
  refreshTracker,
  requestLock,
  requestStop,
  resetTrackerSession,
  setIntelWatching,
  setQueueing,
  skipUpdate,
  startAutoQueue,
  stopAutoQueue
} from "./api.js";
import { sortRoles } from "./roles.js";

/** Views the shell can show. `home` is the launcher; the rest are tools. */
export const VIEWS = ["home", "instalock", "tracker", "autoqueue", "intel"];

/**
 * How long to let a view transition settle before a tool fetches anything.
 *
 * Loading immediately means the request lands mid-transition and the content
 * changes underneath the snapshot the user is watching, so the tool appears to
 * populate itself twice. Comfortably covers the 480ms morph in css/motion.css.
 */
const VIEW_SETTLE_MS = 520;

/** How long the save button keeps saying "Saved" before returning to idle. */
const SAVED_NOTICE_MS = 2200;

/**
 * InstalockerService.StartOrUpdate flips `isRunning` to true and parks this
 * exact status before the worker has attached to the game, so it marks the
 * window in which "monitoring" would be a lie.
 */
const ARMING_STATUS = "Waiting for pre-game.";

const listeners = new Set();

const state = {
  // Which tool is on screen. The app opens on the launcher.
  view: "home",

  agents: [],
  assetsAvailable: true,
  loaded: false,
  bootError: null,

  search: "",
  roleFilter: "all",
  selected: null,

  /** Agents to try, in order. `selected` mirrors the head of it. */
  chain: [],

  lock: null,
  hydrated: false,
  connected: true,
  pending: null,
  actionError: null,

  // Settings modal. `options` is the last server truth, `optionsDraft` the
  // editable copy the panel binds to; the save button compares the two.
  settingsOpen: false,
  options: null,
  optionsDraft: null,
  optionsStatus: "idle", // idle | loading | saving | saved | error
  optionsError: null,

  // --- rank tracker ---
  tracker: null,
  trackerPending: false,

  // --- auto-queue ---
  autoqueue: null,
  queueOptions: null,
  queuePending: false,
  queueSaveNote: "",

  // --- pre-game intel ---
  // The watch is only on while the view is open, so this is not persisted.
  intel: null,
  intelPending: false,

  // --- updater ---
  // `updateDismissed` is this run only: the banner comes back on relaunch
  // unless the version was actually skipped, which is server-side.
  update: null,
  updatePending: false,
  updateDismissed: false
};

let savedNoticeTimer = null;

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getState() {
  return state;
}

// --- selectors ---------------------------------------------------------

/**
 * booting -> offline -> arming -> error -> locked -> monitoring -> idle.
 * Order matters: the first match wins.
 */
export function phase() {
  if (!state.loaded) {
    return "booting";
  }

  if (!state.connected) {
    return "offline";
  }

  if (state.pending === "start") {
    return "arming";
  }

  if (state.actionError || state.lock?.error) {
    return "error";
  }

  if (state.lock?.isRunning) {
    if (state.lock.isLocked) {
      return "locked";
    }

    return state.lock.status === ARMING_STATUS ? "arming" : "monitoring";
  }

  return "idle";
}

export function selectedAgent() {
  return state.agents.find((agent) => agent.name === state.selected) ?? null;
}

export function visibleAgents() {
  const term = state.search.trim().toLowerCase();

  return state.agents.filter((agent) => {
    if (state.roleFilter !== "all" && agent.role !== state.roleFilter) {
      return false;
    }

    return term.length === 0 || agent.name.toLowerCase().includes(term);
  });
}

export function availableRoles() {
  return sortRoles(new Set(state.agents.map((agent) => agent.role)));
}

export function errorMessage() {
  return state.actionError ?? state.lock?.error ?? null;
}

/** Where an agent sits in the chain, 1-based, or 0 when it is not in it. */
export function chainPosition(name) {
  return state.chain.indexOf(name) + 1;
}

/** The chain as agent records, in order, skipping anything the grid lacks. */
export function chainAgents() {
  return state.chain
    .map((name) => state.agents.find((agent) => agent.name === name) ?? { name, gradient: [] });
}

/** True once the running worker is armed with a chain other than the current one. */
export function isRetargeting() {
  const armed = state.lock?.selectedAgents ?? (state.lock?.selectedAgent ? [state.lock.selectedAgent] : []);

  return Boolean(
    state.lock?.isRunning &&
    state.chain.length > 0 &&
    (armed.length !== state.chain.length || armed.some((name, at) => name !== state.chain[at]))
  );
}

export function optionsDirty() {
  if (!state.options || !state.optionsDraft) {
    return false;
  }

  return serializePatch(state.optionsDraft) !== serializePatch(toDraft(state.options));
}

/**
 * Maps still selectable in a given rule row: everything except the maps other
 * rows already claim, so two rules can never target the same map.
 */
export function mapsForRow(index) {
  const maps = state.options?.maps ?? [];
  const taken = new Set(
    state.optionsDraft?.overrides
      .filter((rule, position) => position !== index && rule.map)
      .map((rule) => rule.map) ?? []
  );

  return maps.filter((map) => !taken.has(map));
}

// --- routing -----------------------------------------------------------

/**
 * Switches view and lazily loads whatever that tool needs. Loading here rather
 * than in each view keeps the views pure renderers.
 */
export function setView(view) {
  if (!VIEWS.includes(view) || state.view === view) {
    return;
  }

  const previous = state.view;

  state.view = view;
  state.actionError = null;
  emit();

  // Leaving the lobby view ends the watch straight away rather than after the
  // settle delay: it holds a connection lease, and nothing is rendering it any
  // more. Not deferred, because the answer cannot change on the way out.
  if (previous === "intel") {
    void watchLobby(false);
  }

  // Deferred so the fetch cannot land while the view is still animating in.
  // Re-checked on the way out: by then the user may have gone somewhere else.
  window.setTimeout(() => {
    if (state.view !== view) {
      return;
    }

    if (view === "tracker" && !state.tracker?.updatedAt && !state.trackerPending) {
      void refreshTrackerState();
    }

    if (view === "intel") {
      void watchLobby(true);
    }

    if (view === "autoqueue") {
      if (!state.queueOptions) {
        void loadQueueOptions();
      }

      if (!state.queuePending) {
        void refreshQueueState();
      }
    }
  }, VIEW_SETTLE_MS);
}

export function goHome() {
  setView("home");
}

/**
 * A frame off /api/events. Every tool publishes its whole state, so this is a
 * straight assignment rather than a merge.
 */
export function applyModuleState(module, moduleState) {
  switch (module) {
    case "instalock":
      applyLockState(moduleState);
      return;
    case "tracker":
      state.tracker = moduleState;
      break;
    case "autoqueue":
      state.autoqueue = moduleState;
      break;
    case "intel":
      state.intel = moduleState;
      break;
    case "update":
      state.update = moduleState;
      break;
    default:
      return;
  }

  state.connected = true;
  emit();
}

// --- updater -----------------------------------------------------------

/** True when there is something worth putting a banner on screen for. */
export function updateBannerVisible() {
  const update = state.update;

  if (!update || state.updateDismissed) {
    return false;
  }

  return update.isUpdateAvailable ||
    update.stage === "Downloading" ||
    update.stage === "Ready" ||
    update.stage === "Restarting";
}

/** Hides the banner for this run only. Skipping a version is a separate action. */
export function dismissUpdate() {
  state.updateDismissed = true;
  emit();
}

export async function loadUpdate() {
  try {
    state.update = await fetchUpdate();
  } catch {
    // Not having checked yet is a valid starting state.
  } finally {
    emit();
  }
}

export async function runUpdateCheck() {
  if (state.updatePending) {
    return;
  }

  state.updatePending = true;
  state.updateDismissed = false;
  emit();

  try {
    state.update = await checkForUpdate();
  } catch (error) {
    state.update = {
      ...(state.update ?? {}),
      error: error instanceof ApiError ? error.message : "Could not check for updates."
    };
  } finally {
    state.updatePending = false;
    emit();
  }
}

/**
 * Starts the download. The response is the state at the moment it began, not
 * at the end -- progress arrives over the event stream from here on.
 */
export async function startUpdateDownload() {
  if (state.updatePending) {
    return;
  }

  state.updatePending = true;
  emit();

  try {
    state.update = await downloadUpdate();
  } catch (error) {
    state.update = {
      ...(state.update ?? {}),
      error: error instanceof ApiError ? error.message : "Could not start the download."
    };
  } finally {
    state.updatePending = false;
    emit();
  }
}

export async function cancelUpdate() {
  try {
    state.update = await cancelUpdateDownload();
  } catch {
    // The stream corrects us if it landed anyway.
  } finally {
    emit();
  }
}

/**
 * Swaps the binary and restarts. On success the app is already on its way out,
 * so there is deliberately nothing to render afterwards.
 */
export async function installUpdate() {
  if (state.updatePending) {
    return;
  }

  state.updatePending = true;
  emit();

  try {
    state.update = await applyUpdate();
  } catch (error) {
    state.update = {
      ...(state.update ?? {}),
      error: error instanceof ApiError ? error.message : "Could not apply the update."
    };
  } finally {
    state.updatePending = false;
    emit();
  }
}

/** Silences one version for good, rather than just for this run. */
export async function skipUpdateVersion() {
  const version = state.update?.latestVersion ?? null;

  state.updateDismissed = true;
  emit();

  try {
    state.update = await skipUpdate(version);
  } catch {
    // Dismissed locally regardless; the banner is already gone.
  } finally {
    emit();
  }
}

// --- pre-game intel ----------------------------------------------------

/**
 * Turns the lobby watch on or off. The server pushes the roster over
 * /api/events from then on, so this is the only request the view makes.
 */
export async function watchLobby(watching) {
  if (state.intelPending) {
    return;
  }

  state.intelPending = true;
  emit();

  try {
    state.intel = await setIntelWatching(watching);
  } catch (error) {
    state.intel = {
      ...(state.intel ?? {}),
      isWatching: false,
      error: error instanceof ApiError ? error.message : "Could not read the lobby."
    };
  } finally {
    state.intelPending = false;
    emit();
  }
}

// --- tracker -----------------------------------------------------------

export async function refreshTrackerState() {
  if (state.trackerPending) {
    return;
  }

  state.trackerPending = true;
  emit();

  try {
    state.tracker = await refreshTracker();
  } catch (error) {
    state.tracker = {
      ...(state.tracker ?? {}),
      error: error instanceof ApiError ? error.message : "Could not load your rank."
    };
  } finally {
    state.trackerPending = false;
    emit();
  }
}

export async function resetSession() {
  try {
    state.tracker = await resetTrackerSession();
  } catch {
    // The stream will correct us if this landed anyway.
  } finally {
    emit();
  }
}

export async function loadTracker() {
  try {
    state.tracker = await fetchTracker();
  } catch {
    // Nothing loaded yet is a valid starting state.
  } finally {
    emit();
  }
}

// --- auto-queue --------------------------------------------------------

export async function loadQueueOptions() {
  try {
    state.queueOptions = await fetchAutoQueueOptions();
  } catch (error) {
    state.queueSaveNote = error instanceof ApiError ? error.message : "Could not load auto-queue settings.";
  } finally {
    emit();
  }
}

export async function refreshQueueState() {
  if (state.queuePending) {
    return;
  }

  state.queuePending = true;
  emit();

  try {
    state.autoqueue = await refreshAutoQueue();
  } catch {
    // Errors surface through the module state itself.
  } finally {
    state.queuePending = false;
    emit();
  }
}

export async function loadQueue() {
  try {
    state.autoqueue = await fetchAutoQueue();
  } catch {
    // Idle is a fine starting state.
  } finally {
    emit();
  }
}

export async function toggleAutoQueue(start) {
  state.queuePending = true;
  emit();

  try {
    state.autoqueue = start ? await startAutoQueue() : await stopAutoQueue();
  } catch (error) {
    state.queueSaveNote = error instanceof ApiError ? error.message : "Could not change auto-queue.";
  } finally {
    state.queuePending = false;
    emit();
  }
}

export async function queueNow(queueing) {
  state.queuePending = true;
  emit();

  try {
    state.autoqueue = await setQueueing(queueing);
  } catch (error) {
    state.queueSaveNote = error instanceof ApiError ? error.message : "Could not change the queue.";
  } finally {
    state.queuePending = false;
    emit();
  }
}

/** Auto-queue settings save on change -- there is no draft to reconcile. */
export async function saveQueueOptions(patch) {
  if (!state.queueOptions) {
    return;
  }

  state.queueOptions = { ...state.queueOptions, ...patch };
  state.queueSaveNote = "Saving…";
  emit();

  try {
    state.queueOptions = await patchAutoQueueOptions(patch);
    state.queueSaveNote = "Saved";
  } catch (error) {
    state.queueSaveNote = error instanceof ApiError ? error.message : "Could not save.";
    void loadQueueOptions();
  } finally {
    emit();
  }
}

// --- actions -----------------------------------------------------------

export async function loadAgents() {
  try {
    const { agents, assetsAvailable } = await fetchAgents();
    state.agents = agents;
    state.assetsAvailable = assetsAvailable;
    state.bootError = null;
  } catch (error) {
    state.agents = [];
    state.bootError = error instanceof ApiError ? error.message : "Could not load the agent list.";
  } finally {
    state.loaded = true;
    emit();
  }
}

export function setSearch(value) {
  state.search = value;
  emit();
}

export function setRoleFilter(role) {
  state.roleFilter = role;
  emit();
}

/**
 * Adds an agent to the fallback chain, or takes it back out if it is already
 * there. Clicking builds the order: first click is the first choice.
 */
export function selectAgent(name) {
  const at = state.chain.indexOf(name);

  if (at === -1) {
    state.chain.push(name);
  } else {
    state.chain.splice(at, 1);
  }

  syncSelected();
  state.actionError = null;
  emit();
}

/** Drops one agent out of the chain, regardless of how it got in. */
export function removeFromChain(name) {
  const at = state.chain.indexOf(name);

  if (at === -1) {
    return;
  }

  state.chain.splice(at, 1);
  syncSelected();
  state.actionError = null;
  emit();
}

/** Moves an agent one place up or down the order of preference. */
export function moveInChain(name, delta) {
  const at = state.chain.indexOf(name);
  const to = at + delta;

  if (at === -1 || to < 0 || to >= state.chain.length) {
    return;
  }

  state.chain.splice(to, 0, ...state.chain.splice(at, 1));
  syncSelected();
  emit();
}

/**
 * `selected` is the head of the chain. It stays a field of its own because the
 * header, the card highlight and the retarget check all read it, and none of
 * them care that there is now an order behind it.
 */
function syncSelected() {
  state.selected = state.chain[0] ?? null;
}

export function applyLockState(lock) {
  state.lock = lock;
  state.connected = true;

  // Adopt the server's chain exactly once, on the first poll. Doing it on every
  // poll would yank a fresh selection back within a second.
  if (!state.hydrated) {
    state.hydrated = true;

    // `selectedAgents` is the whole chain; `selectedAgent` is the one entry old
    // builds sent. Reading both means a running worker is still adopted when
    // the response comes from a server that predates the chain.
    const chain = lock.selectedAgents?.length
      ? [...lock.selectedAgents]
      : lock.selectedAgent ? [lock.selectedAgent] : [];

    if (chain.length > 0) {
      state.chain = chain;
      syncSelected();
    }
  }

  emit();
}

export function setConnected(connected) {
  if (state.connected === connected) {
    return;
  }

  state.connected = connected;
  emit();
}

export async function startLock() {
  if (state.chain.length === 0 || state.pending) {
    return;
  }

  state.pending = "start";
  state.actionError = null;
  emit();

  try {
    applyLockState(await requestLock(state.chain));
  } catch (error) {
    state.actionError = error instanceof ApiError ? error.message : "Could not start locking.";
    state.connected = !(error instanceof ApiError && error.status === 0);
  } finally {
    state.pending = null;
    emit();
  }
}

export async function stopLock() {
  if (state.pending) {
    return;
  }

  state.pending = "stop";
  state.actionError = null;
  emit();

  try {
    applyLockState(await requestStop());
  } catch (error) {
    state.actionError = error instanceof ApiError ? error.message : "Could not stop locking.";
    state.connected = !(error instanceof ApiError && error.status === 0);
  } finally {
    state.pending = null;
    emit();
  }
}

// --- settings ----------------------------------------------------------

export function openSettings() {
  state.settingsOpen = true;
  emit();

  if (!state.options && state.optionsStatus !== "loading") {
    void loadOptions();
  }
}

export function closeSettings() {
  state.settingsOpen = false;
  // Drop unsaved edits so reopening always shows what the service actually has.
  state.optionsDraft = state.options ? toDraft(state.options) : null;
  state.optionsError = null;
  state.optionsStatus = state.options ? "idle" : state.optionsStatus;
  emit();
}

export async function loadOptions() {
  state.optionsStatus = "loading";
  state.optionsError = null;
  emit();

  try {
    const options = await fetchOptions();
    state.options = options;
    state.optionsDraft = toDraft(options);
    state.optionsStatus = "idle";
  } catch (error) {
    state.optionsError = error instanceof ApiError ? error.message : "Could not load settings.";
    state.optionsStatus = "error";
  } finally {
    emit();
  }
}

export function updateDraft(patch) {
  if (!state.optionsDraft) {
    return;
  }

  state.optionsDraft = { ...state.optionsDraft, ...patch };
  clearSavedNotice();
  emit();
}

export function addOverride() {
  if (!state.optionsDraft) {
    return;
  }

  const remaining = mapsForRow(-1);
  state.optionsDraft.overrides.push({ map: remaining[0] ?? "", agent: "" });
  clearSavedNotice();
  emit();
}

export function updateOverride(index, patch) {
  const rule = state.optionsDraft?.overrides[index];

  if (!rule) {
    return;
  }

  Object.assign(rule, patch);
  clearSavedNotice();
  emit();
}

export function removeOverride(index) {
  state.optionsDraft?.overrides.splice(index, 1);
  clearSavedNotice();
  emit();
}

export async function saveOptions() {
  if (!state.optionsDraft || state.optionsStatus === "saving") {
    return;
  }

  clearSavedNotice();
  state.optionsStatus = "saving";
  state.optionsError = null;
  emit();

  try {
    const options = await patchOptions(draftToPatch(state.optionsDraft));
    state.options = options;
    state.optionsDraft = toDraft(options);
    state.optionsStatus = "saved";

    savedNoticeTimer = window.setTimeout(() => {
      savedNoticeTimer = null;
      state.optionsStatus = "idle";
      emit();
    }, SAVED_NOTICE_MS);
  } catch (error) {
    state.optionsError = error instanceof ApiError ? error.message : "Could not save settings.";
    state.optionsStatus = "error";
  } finally {
    emit();
  }
}

/** Server shape -> editable shape. Rules become a list so a half-filled new row can exist. */
function toDraft(options) {
  return {
    hoverDelayMs: options.hoverDelayMs,
    lockDelayMs: options.lockDelayMs,
    postLockDelayMs: options.postLockDelayMs,
    overrides: Object.entries(options.mapAgentOverrides ?? {}).map(([map, agent]) => ({ map, agent }))
  };
}

/** Editable shape -> PATCH body. Incomplete rows are simply not sent. */
function draftToPatch(draft) {
  const mapAgentOverrides = {};

  for (const rule of draft.overrides) {
    if (rule.map && rule.agent) {
      mapAgentOverrides[rule.map] = rule.agent;
    }
  }

  return {
    hoverDelayMs: draft.hoverDelayMs,
    lockDelayMs: draft.lockDelayMs,
    postLockDelayMs: draft.postLockDelayMs,
    mapAgentOverrides
  };
}

function serializePatch(draft) {
  const patch = draftToPatch(draft);
  const sorted = Object.keys(patch.mapAgentOverrides).sort();

  return JSON.stringify([
    patch.hoverDelayMs,
    patch.lockDelayMs,
    patch.postLockDelayMs,
    sorted.map((map) => [map, patch.mapAgentOverrides[map]])
  ]);
}

function clearSavedNotice() {
  if (savedNoticeTimer !== null) {
    window.clearTimeout(savedNoticeTimer);
    savedNoticeTimer = null;
  }

  if (state.optionsStatus === "saved") {
    state.optionsStatus = "idle";
  }
}

function emit() {
  for (const listener of listeners) {
    listener(state);
  }
}

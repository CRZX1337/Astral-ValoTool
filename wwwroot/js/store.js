/**
 * Single source of truth. Views never talk to each other or to the API --
 * they call actions here and re-render from the snapshot they get back.
 *
 * Flow: api -> store -> emit -> views.
 */

import {
  ApiError,
  fetchAgents,
  fetchAutoQueue,
  fetchAutoQueueOptions,
  fetchOptions,
  fetchTracker,
  patchAutoQueueOptions,
  patchOptions,
  refreshAutoQueue,
  refreshTracker,
  requestLock,
  requestStop,
  resetTrackerSession,
  setQueueing,
  startAutoQueue,
  stopAutoQueue
} from "./api.js";
import { sortRoles } from "./roles.js";

/** Views the shell can show. `home` is the launcher; the rest are tools. */
export const VIEWS = ["home", "instalock", "tracker", "autoqueue"];

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
  queueSaveNote: ""
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

/** True once the running worker is aimed at somebody other than the selection. */
export function isRetargeting() {
  return Boolean(
    state.lock?.isRunning &&
    state.selected &&
    state.selected !== state.lock.selectedAgent
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

  state.view = view;
  state.actionError = null;
  emit();

  if (view === "tracker" && !state.tracker?.updatedAt && !state.trackerPending) {
    void refreshTrackerState();
  }

  if (view === "autoqueue") {
    if (!state.queueOptions) {
      void loadQueueOptions();
    }

    if (!state.queuePending) {
      void refreshQueueState();
    }
  }
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
    default:
      return;
  }

  state.connected = true;
  emit();
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

export function selectAgent(name) {
  state.selected = name;
  state.actionError = null;
  emit();
}

export function applyLockState(lock) {
  state.lock = lock;
  state.connected = true;

  // Adopt the server's target exactly once, on the first poll. Doing it on
  // every poll would yank a fresh selection back within a second.
  if (!state.hydrated) {
    state.hydrated = true;

    if (lock.selectedAgent) {
      state.selected = lock.selectedAgent;
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
  if (!state.selected || state.pending) {
    return;
  }

  state.pending = "start";
  state.actionError = null;
  emit();

  try {
    applyLockState(await requestLock(state.selected));
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

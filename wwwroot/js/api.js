/**
 * Thin wrappers around the backend routes. Every failure surfaces as an
 * ApiError so the UI never has to tell a network drop apart from a 400 body.
 */

import { parseGradient, roleLabel, roleSlug } from "./roles.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

/**
 * The LAN pairing token, when this page is the mobile companion. The desktop
 * window navigates without ?k=, so this stays empty there and no request is
 * altered -- the loopback exemption makes the token unnecessary locally. The
 * mobile page carries ?k=TOKEN in its own URL and every request it makes
 * inherits the token from there.
 */
const PAIRING_TOKEN = new URLSearchParams(window.location.search).get("k") ?? "";

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function fetchState() {
  return request("/api/state");
}

/** `agents` is the fallback chain, most-wanted first. */
export function requestLock(agents) {
  return request("/api/lock", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ agents })
  });
}

export function requestStop() {
  return request("/api/stop", { method: "POST" });
}

// --- rank tracker -------------------------------------------------------

export function fetchTracker() {
  return request("/api/tracker");
}

export function refreshTracker() {
  return request("/api/tracker/refresh", { method: "POST" });
}

export function resetTrackerSession() {
  return request("/api/tracker/session/reset", { method: "POST" });
}

// --- pre-game lobby intel -----------------------------------------------

export function fetchIntel() {
  return request("/api/intel");
}

/** Turns the lobby watch on or off. Driven by the intel view being open. */
export function setIntelWatching(watching) {
  return request("/api/intel/watch", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ watching })
  });
}

// --- updater ------------------------------------------------------------

export function fetchUpdate() {
  return request("/api/update");
}

export function checkForUpdate() {
  return request("/api/update/check", { method: "POST" });
}

/**
 * Returns as soon as the download starts, not when it finishes. Progress
 * arrives over the event stream like every other module's state.
 */
export function downloadUpdate() {
  return request("/api/update/download", { method: "POST" });
}

export function cancelUpdateDownload() {
  return request("/api/update/cancel", { method: "POST" });
}

/** Replaces the binary and restarts, so a success response is the last one. */
export function applyUpdate() {
  return request("/api/update/apply", { method: "POST" });
}

/** Silences one version. The release after it is offered as normal. */
export function skipUpdate(version) {
  return request("/api/update/skip", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ version })
  });
}

// --- auto-queue ---------------------------------------------------------

export function fetchAutoQueue() {
  return request("/api/autoqueue");
}

export function startAutoQueue() {
  return request("/api/autoqueue/start", { method: "POST" });
}

export function stopAutoQueue() {
  return request("/api/autoqueue/stop", { method: "POST" });
}

export function refreshAutoQueue() {
  return request("/api/autoqueue/refresh", { method: "POST" });
}

/** Enters or leaves the queue immediately, independent of the automation. */
export function setQueueing(queueing) {
  return request("/api/autoqueue/queueing", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ queueing })
  });
}

export function fetchAutoQueueOptions() {
  return request("/api/autoqueue/options");
}

export function patchAutoQueueOptions(patch) {
  return request("/api/autoqueue/options", {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify(patch)
  });
}

/** Settings plus the map list they can refer to, in one round trip. */
export function fetchOptions() {
  return request("/api/options");
}

/** Partial update: omitted fields keep their current value. */
export function patchOptions(patch) {
  return request("/api/options", {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify(patch)
  });
}

/**
 * `/api/agent-assets` reaches out to valorant-api.com and throws a 500 when
 * that call fails (ValorantApiAssetService.cs). `/api/agents` is purely local,
 * so it is the offline fallback -- names only, no portraits.
 */
export async function fetchAgents() {
  try {
    const assets = await request("/api/agent-assets");
    return { agents: assets.map(toAgent), assetsAvailable: true };
  } catch {
    const options = await request("/api/agents");
    return { agents: options.map(toAgent), assetsAvailable: false };
  }
}

function toAgent(raw) {
  return {
    name: raw.name,
    value: raw.value,
    // Riot's character id, what match history reports as agentId. Lowercased
    // so lookups never fight over casing; null for catalogues without one.
    uuid: raw.uuid?.toLowerCase() ?? null,
    role: roleSlug(raw.role),
    roleLabel: roleLabel(raw.role),
    portrait: raw.portrait ?? null,
    background: raw.background ?? null,
    gradient: parseGradient(raw.gradient),
    rightFacing: Boolean(raw.isRightFacing)
  };
}

/**
 * Appends the pairing token to a URL when this page is the mobile companion,
 * and leaves the URL alone otherwise. The event stream shares this path: an
 * EventSource carries no headers of its own, so its token has to ride in the
 * query string like every other request's.
 */
export function withToken(url) {
  return PAIRING_TOKEN === "" ? url : `${url}${url.includes("?") ? "&" : "?"}k=${PAIRING_TOKEN}`;
}

async function request(url, init) {
  let response;

  try {
    response = await fetch(withToken(url), init);
  } catch {
    throw new ApiError("Cannot reach the local service.", 0);
  }

  const payload = await readJson(response);

  if (!response.ok) {
    throw new ApiError(payload?.error ?? `Request failed (${response.status}).`, response.status);
  }

  return payload;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

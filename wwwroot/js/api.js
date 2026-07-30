/**
 * Thin wrappers around the backend routes. Every failure surfaces as an
 * ApiError so the UI never has to tell a network drop apart from a 400 body.
 */

import { parseGradient, roleLabel, roleSlug } from "./roles.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

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

export function requestLock(agent) {
  return request("/api/lock", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ agent })
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
    role: roleSlug(raw.role),
    roleLabel: roleLabel(raw.role),
    portrait: raw.portrait ?? null,
    background: raw.background ?? null,
    gradient: parseGradient(raw.gradient),
    rightFacing: Boolean(raw.isRightFacing)
  };
}

async function request(url, init) {
  let response;

  try {
    response = await fetch(url, init);
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

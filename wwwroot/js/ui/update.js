/**
 * The update banner.
 *
 * Lives in the shell rather than in a view of its own: an update is worth
 * knowing about whichever tool is open, and it is not a tool. Nothing here
 * decides anything -- the store owns whether a banner is warranted.
 */

import {
  cancelUpdate,
  dismissUpdate,
  installUpdate,
  skipUpdateVersion,
  startUpdateDownload,
  updateBannerVisible
} from "../store.js";

export function mountUpdate() {
  const banner = document.getElementById("updateBanner");

  if (!banner) {
    return () => {};
  }

  const title = document.getElementById("updateTitle");
  const note = document.getElementById("updateNote");
  const bar = document.getElementById("updateBar");
  const fill = document.getElementById("updateFill");
  const notes = document.getElementById("updateNotes");
  const link = document.getElementById("updateLink");
  const primary = document.getElementById("updatePrimary");
  const secondary = document.getElementById("updateSecondary");
  const close = document.getElementById("updateClose");

  primary.addEventListener("click", () => {
    const stage = current?.stage;

    if (stage === "Ready") {
      void installUpdate();
      return;
    }

    if (stage === "Downloading") {
      void cancelUpdate();
      return;
    }

    void startUpdateDownload();
  });

  // "Skip" is a promise not to nag about this version again, so it is only
  // offered before anything has been downloaded on its behalf.
  secondary.addEventListener("click", () => void skipUpdateVersion());
  close.addEventListener("click", dismissUpdate);

  let current = null;
  let shown = null;

  return function render(state) {
    const visible = updateBannerVisible();

    if (visible !== shown) {
      shown = visible;
      banner.hidden = !visible;
    }

    current = state.update;

    if (!visible || !current) {
      return;
    }

    const stage = current.stage;
    const version = current.latestVersion ?? "";

    banner.dataset.stage = stage;
    title.textContent = current.releaseName?.trim() || `Astral ${version} is available`;
    note.textContent = describe(current, state.updatePending);

    const downloading = stage === "Downloading";
    const fraction = progressOf(current);

    bar.hidden = !downloading;
    bar.setAttribute("aria-valuenow", fraction === null ? "0" : String(Math.round(fraction * 100)));
    fill.style.width = fraction === null ? "45%" : `${(fraction * 100).toFixed(1)}%`;
    // An unknown total gets an indeterminate sweep rather than a bar that
    // pretends to know how far along it is.
    fill.dataset.indeterminate = fraction === null ? "1" : "0";

    notes.textContent = current.releaseNotes ?? "";
    notes.hidden = !current.releaseNotes || downloading;

    link.href = current.releaseUrl ?? "#";
    link.hidden = !current.releaseUrl;

    primary.textContent = primaryLabel(stage);
    primary.disabled = state.updatePending || stage === "Restarting";
    secondary.hidden = stage !== "Available";
    close.disabled = stage === "Restarting";
  };
}

function primaryLabel(stage) {
  switch (stage) {
    case "Ready":
      return "Restart & install";
    case "Downloading":
      return "Cancel";
    case "Restarting":
      return "Restarting…";
    default:
      return "Download";
  }
}

function describe(update, pending) {
  if (update.error) {
    return update.error;
  }

  if (update.stage === "Downloading") {
    return update.downloadSize
      ? `${formatBytes(update.downloadedBytes)} of ${formatBytes(update.downloadSize)}`
      : `${formatBytes(update.downloadedBytes)} downloaded`;
  }

  if (pending) {
    return "Working…";
  }

  const size = update.downloadSize ? ` · ${formatBytes(update.downloadSize)}` : "";

  return update.stage === "Available"
    ? `You're on ${update.currentVersion}${size}`
    : update.status;
}

/**
 * The server sends `progress` already computed, but a frame from an older
 * build may not, so it is recomputed here when the field is missing.
 */
function progressOf(update) {
  if (typeof update.progress === "number") {
    return update.progress;
  }

  if (!update.downloadSize) {
    return null;
  }

  return Math.min(1, Math.max(0, update.downloadedBytes / update.downloadSize));
}

function formatBytes(bytes) {
  if (!bytes || bytes < 1024) {
    return `${bytes ?? 0} B`;
  }

  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

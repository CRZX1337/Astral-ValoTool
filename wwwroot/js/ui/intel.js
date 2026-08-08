/**
 * Lobby intel view: who is on your team in agent select, what rank they are,
 * and how far through picking they have got.
 *
 * The watch itself is started and stopped by store.setView, so this file only
 * paints -- there is nothing here to click.
 */

import { roleSlug } from "../roles.js";
import { stagger, swapText } from "./motion.js";

/** Wire values of LobbyPickState, lowercased for use as a data attribute. */
const PICK_LABELS = {
  none: "Picking…",
  hovering: "Hovering",
  locked: "Locked"
};

export function mountIntel() {
  const map = document.getElementById("intelMap");
  const status = document.getElementById("intelStatus");
  const timer = document.getElementById("intelTimer");
  const locked = document.getElementById("intelLocked");
  const alert = document.getElementById("intelAlert");
  const list = document.getElementById("lobbyList");
  const empty = document.getElementById("lobbyEmpty");

  let renderedSignature = null;

  // Paints even while hidden, for the same reason the tracker does: the view
  // should already be finished when the morph lands on it.
  return function render(state) {
    const intel = state.intel;
    const players = intel?.players ?? [];

    swapText(map, intel?.isActive && intel.mapName ? intel.mapName : "Lobby intel");
    swapText(status, intel?.status ?? "Not watching.");

    alert.hidden = !intel?.error;
    alert.textContent = intel?.error ?? "";

    // Riot's countdown, rounded to whole seconds. It only ticks when a poll
    // lands, so it steps rather than counts -- close enough to read the room.
    const seconds = intel?.secondsRemaining;
    timer.hidden = !intel?.isActive || typeof seconds !== "number";
    timer.textContent = typeof seconds === "number" ? `${Math.max(0, Math.round(seconds))}s` : "";

    locked.hidden = !intel?.isActive || players.length === 0;
    locked.textContent = `${intel?.lockedCount ?? 0}/${players.length} locked`;

    // Rebuilt only when something a row shows has actually changed. Without
    // this the whole roster is thrown away and rebuilt on every poll, which
    // restarts the entry stagger twice a second.
    const signature = players
      .map((player) => [player.slot, player.name, player.agentName, player.pickState, player.tier].join(":"))
      .join("|");

    if (signature !== renderedSignature) {
      renderedSignature = signature;
      paintRoster(list, players);
    }

    empty.hidden = players.length > 0;

    if (players.length === 0) {
      empty.textContent = intel?.isWatching
        ? "Open agent select and your team will appear here."
        : "Not watching the lobby.";
    }
  };
}

function paintRoster(list, players) {
  const fragment = document.createDocumentFragment();

  for (const player of players) {
    fragment.append(buildRow(player));
  }

  stagger(fragment.children);
  list.replaceChildren(fragment);
}

function buildRow(player) {
  const pick = (player.pickState ?? "None").toLowerCase();

  const row = document.createElement("div");
  row.className = "lobby-row";
  row.dataset.pick = pick;
  row.dataset.role = roleSlug(player.agentRole);

  if (player.isSelf) {
    row.dataset.self = "1";
  }

  row.append(buildPortrait(player), buildIdentity(player), buildRank(player));

  return row;
}

/** The agent portrait, or the slot number until they have hovered something. */
function buildPortrait(player) {
  const wrap = document.createElement("span");
  wrap.className = "lobby-portrait";

  if (player.agentPortrait) {
    const image = document.createElement("img");
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    image.src = player.agentPortrait;
    wrap.append(image);
  } else {
    const fallback = document.createElement("span");
    fallback.className = "lobby-slot";
    fallback.textContent = String(player.slot + 1);
    wrap.append(fallback);
  }

  return wrap;
}

function buildIdentity(player) {
  const body = document.createElement("div");
  body.className = "lobby-identity";

  const name = document.createElement("div");
  name.className = "lobby-name";
  name.textContent = displayName(player);

  if (player.isIncognito) {
    name.dataset.incognito = "1";
  }

  if (player.isCaptain) {
    const captain = document.createElement("span");
    captain.className = "lobby-tag";
    captain.textContent = "Party lead";
    captain.title = "Owns the party, so they control the queue.";
    name.append(" ", captain);
  }

  const pick = document.createElement("div");
  pick.className = "lobby-pick";
  pick.textContent = player.agentName
    ? `${player.agentName} · ${PICK_LABELS[(player.pickState ?? "None").toLowerCase()] ?? ""}`.trim()
    : PICK_LABELS[(player.pickState ?? "None").toLowerCase()] ?? "Picking…";

  body.append(name, pick);

  return body;
}

function buildRank(player) {
  const rank = document.createElement("span");
  rank.className = "lobby-rank";
  rank.style.setProperty("--rank-color", player.tierColor ?? "var(--brand)");
  rank.title = player.tierName ?? "Unranked";

  if (player.tierIcon) {
    const icon = document.createElement("img");
    icon.alt = "";
    icon.loading = "lazy";
    icon.decoding = "async";
    icon.src = player.tierIcon;
    rank.append(icon);
  }

  const label = document.createElement("span");
  label.className = "lobby-tier";
  label.textContent = player.tierName ?? "Unranked";
  rank.append(label);

  return rank;
}

/** Names are only known for people who are not playing incognito. */
function displayName(player) {
  if (player.isSelf) {
    return player.name ?? "You";
  }

  if (player.isIncognito) {
    return "Incognito";
  }

  return player.name ?? `Player ${player.slot + 1}`;
}

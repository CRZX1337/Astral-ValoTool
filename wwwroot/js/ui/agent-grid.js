/**
 * The agent browser: search, role filters, portrait grid, keyboard nav.
 *
 * Cards are built exactly once and then only re-flagged. Rebuilding them on
 * every poll would re-trigger 28 portrait downloads once a second.
 */

import { monogram, rgba, UNKNOWN_ROLE_LABEL } from "../roles.js";
import { availableRoles, selectAgent, setRoleFilter, setSearch, visibleAgents } from "../store.js";
import { stagger } from "./motion.js";

const SKELETON_COUNT = 12;

export function mountAgentGrid() {
  const gridEl = document.getElementById("agentGrid");
  const emptyEl = document.getElementById("gridEmpty");
  const emptyTextEl = document.getElementById("gridEmptyText");
  const countEl = document.getElementById("resultCount");
  const searchEl = document.getElementById("agentSearch");
  const filtersEl = document.getElementById("roleFilters");
  const template = document.getElementById("agentCardTemplate");

  const cards = new Map();
  const chips = new Map();
  let built = false;

  searchEl.addEventListener("input", () => setSearch(searchEl.value));
  searchEl.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && searchEl.value !== "") {
      event.preventDefault();
      searchEl.value = "";
      setSearch("");
    }
  });

  document.addEventListener("keydown", (event) => {
    // Scoped to this view: the shell has other tools now, and stealing focus
    // into a search box that is not on screen would be baffling.
    if (event.key === "/" && document.body.dataset.view === "instalock" && !isTypingTarget(event.target)) {
      event.preventDefault();
      searchEl.focus();
      searchEl.select();
    }
  });

  gridEl.addEventListener("keydown", (event) => onGridKeyDown(event, gridEl));

  renderSkeletons(gridEl);

  return function render(state) {
    if (!built && state.loaded) {
      built = true;
      gridEl.replaceChildren();

      if (state.agents.length > 0) {
        buildCards(state.agents, template, gridEl, cards);
        buildFilters(filtersEl, chips);
      }
    }

    if (!built) {
      return;
    }

    const visible = new Set(visibleAgents().map((agent) => agent.name));
    const lock = state.lock;

    for (const [name, card] of cards) {
      card.hidden = !visible.has(name);

      const isSelected = name === state.selected;
      card.classList.toggle("is-selected", isSelected);
      card.setAttribute("aria-selected", String(isSelected));

      const isTarget = Boolean(lock?.isRunning) && lock.selectedAgent === name;
      card.dataset.flag = isTarget ? (lock.isLocked ? "locked" : "target") : "";
    }

    for (const [role, chip] of chips) {
      const active = state.roleFilter === role;
      chip.classList.toggle("is-active", active);
      chip.setAttribute("aria-pressed", String(active));
    }

    countEl.textContent = state.agents.length === 0
      ? ""
      : `${visible.size}/${state.agents.length}`;

    const message = emptyMessage(state, visible.size);
    emptyEl.hidden = message === null;

    if (message !== null) {
      emptyTextEl.textContent = message;
    }
  };
}

function emptyMessage(state, visibleCount) {
  if (state.bootError) {
    return state.bootError;
  }

  if (state.agents.length === 0) {
    return "No agents were returned by the service.";
  }

  return visibleCount === 0 ? "No agent matches this search." : null;
}

function buildCards(agents, template, gridEl, cards) {
  const fragment = document.createDocumentFragment();

  for (const agent of agents) {
    const card = template.content.firstElementChild.cloneNode(true);
    const art = card.querySelector(".card-art");
    const portrait = card.querySelector(".card-portrait");

    card.dataset.role = agent.role;
    card.dataset.name = agent.name;
    card.querySelector(".card-name").textContent = agent.name;
    card.querySelector(".card-role").textContent = agent.roleLabel;
    card.querySelector(".card-monogram").textContent = monogram(agent.name);

    if (agent.gradient.length > 0) {
      card.style.setProperty("--card-tint", rgba(agent.gradient[0], 0.55));
    }

    // The monogram is the baseline; the portrait only takes over once it has
    // actually decoded. A missing, broken *or* stalled image therefore always
    // leaves a readable tile instead of an empty box.
    if (agent.portrait) {
      portrait.classList.toggle("is-mirrored", agent.rightFacing);
      portrait.addEventListener("load", () => {
        art.dataset.art = "portrait";
      }, { once: true });
      portrait.src = agent.portrait;
    }

    card.addEventListener("click", () => selectAgent(agent.name));
    card.classList.add("is-new");
    cards.set(agent.name, card);
    fragment.append(card);
  }

  // Indexes the entry stagger, then drops the flag so filtering later does not
  // replay the wave every time a card is shown again.
  stagger(cards.values());
  gridEl.append(fragment);
  window.setTimeout(() => {
    for (const card of cards.values()) {
      card.classList.remove("is-new");
    }
  }, 1200);
}

function buildFilters(filtersEl, chips) {
  const fragment = document.createDocumentFragment();
  const entries = [["all", "All"], ...availableRoles().map((role) => [role, labelForRole(role)])];

  for (const [role, label] of entries) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.dataset.role = role;
    chip.textContent = label;
    chip.setAttribute("aria-pressed", "false");
    chip.addEventListener("click", () => setRoleFilter(role));

    chips.set(role, chip);
    fragment.append(chip);
  }

  filtersEl.replaceChildren(fragment);
}

function labelForRole(role) {
  if (role === "unknown") {
    return UNKNOWN_ROLE_LABEL;
  }

  return role.charAt(0).toUpperCase() + role.slice(1);
}

function renderSkeletons(gridEl) {
  const fragment = document.createDocumentFragment();

  for (let index = 0; index < SKELETON_COUNT; index += 1) {
    const skeleton = document.createElement("div");
    skeleton.className = "agent-card is-skeleton";
    skeleton.setAttribute("aria-hidden", "true");
    fragment.append(skeleton);
  }

  gridEl.replaceChildren(fragment);
}

function onGridKeyDown(event, gridEl) {
  const step = arrowStep(event.key, gridEl);

  if (step === 0) {
    return;
  }

  const visible = [...gridEl.querySelectorAll(".agent-card:not([hidden])")];
  const index = visible.indexOf(document.activeElement);

  if (index === -1) {
    return;
  }

  const next = visible[Math.min(Math.max(index + step, 0), visible.length - 1)];
  event.preventDefault();
  next.focus();
  next.scrollIntoView({ block: "nearest" });
}

function arrowStep(key, gridEl) {
  const columns = countColumns(gridEl);

  switch (key) {
    case "ArrowRight": return 1;
    case "ArrowLeft": return -1;
    case "ArrowDown": return columns;
    case "ArrowUp": return -columns;
    default: return 0;
  }
}

function countColumns(gridEl) {
  const template = window.getComputedStyle(gridEl).gridTemplateColumns;
  return Math.max(template.split(" ").filter(Boolean).length, 1);
}

function isTypingTarget(target) {
  return target instanceof HTMLElement &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
}

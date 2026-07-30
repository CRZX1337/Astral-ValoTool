/* Interactive agent grid — a replica of Astral's desktop UI.

   Portraits come from valorant-api.com, the same source the real app uses at
   runtime. The lock sequence is simulated (there is no game client in a
   browser tab) but every phase, loop label and status string below is one the
   app actually reports, so what you see here is what you get. */

import { loadConfig, initSettings } from "./settings.js";

const API = "https://valorant-api.com/v1/agents?isPlayableCharacter=true";

/* Maps the simulated pre-game can open on. Drawn from the same table the
   settings dialog offers, minus the two non-competitive ones. */
const ROTATION = [
  "Ascent", "Bind", "Haven", "Split", "Lotus", "Sunset",
  "Icebox", "Breeze", "Fracture", "Pearl", "Abyss", "Corrode",
];
const CACHE_KEY = "astral:agents";
const TIMEOUT = 4000;

/* Offline fallback: the exact 29 entries of RadiantConnect's agent enum
   (v10.6.1), with roles as valorant-api reports them. Used when the API is
   unreachable, so the section is never empty. Rendered as monogram tiles. */
const FALLBACK = [
  ["Astra", "Controller"], ["Breach", "Initiator"], ["Brimstone", "Controller"],
  ["Chamber", "Sentinel"], ["Clove", "Controller"], ["Cypher", "Sentinel"],
  ["Deadlock", "Sentinel"], ["Fade", "Initiator"], ["Gekko", "Initiator"],
  ["Harbor", "Controller"], ["Iso", "Duelist"], ["Jett", "Duelist"],
  ["KAY/O", "Initiator"], ["Killjoy", "Sentinel"], ["Miks", "Controller"],
  ["Neon", "Duelist"], ["Omen", "Controller"], ["Phoenix", "Duelist"],
  ["Raze", "Duelist"], ["Reyna", "Duelist"], ["Sage", "Sentinel"],
  ["Skye", "Initiator"], ["Sova", "Initiator"], ["Tejo", "Initiator"],
  ["Veto", "Sentinel"], ["Viper", "Controller"], ["Vyse", "Sentinel"],
  ["Waylay", "Duelist"], ["Yoru", "Duelist"],
].map(([name, role]) => ({ name, role }));

const ROLES = ["All", "Duelist", "Initiator", "Controller", "Sentinel"];

/* Same rule as the app's grid: split on non-alphanumerics so "KAY/O" reads
   as "KO", and a plain name falls back to its first letter. */
function monogram(name) {
  const parts = name.split(/[^a-z0-9]+/i).filter(Boolean);
  return (parts.length > 1 ? parts.slice(0, 2).map((p) => p[0]).join("") : name[0]).toUpperCase();
}

const clock = () =>
  new Date().toLocaleTimeString("en-GB", { hour12: false });

/* One retry that bypasses the HTTP cache. A stale or partially-written cache
   entry for this URL otherwise fails every load for the life of the browser
   profile, permanently downgrading the grid to monograms. `reload` refetches
   and repairs the entry rather than skipping the cache like `no-store`. */
async function request(url, signal) {
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(String(response.status));
    return response;
  } catch (error) {
    if (signal.aborted) throw error;
    const retry = await fetch(url, { signal, cache: "reload" });
    if (!retry.ok) throw new Error(String(retry.status));
    return retry;
  }
}

async function loadAgents() {
  const cached = sessionStorage.getItem(CACHE_KEY);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed) && parsed.length) return { agents: parsed, live: true };
    } catch {
      sessionStorage.removeItem(CACHE_KEY);
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    const response = await request(API, controller.signal);

    const agents = (await response.json()).data
      .map((agent) => ({
        name: agent.displayName,
        role: agent.role?.displayName ?? "Unlisted",
        /* The app prefers the tall portrait for its panel and crops the same
           image into the small card. */
        portrait: agent.fullPortraitV2 ?? agent.fullPortrait ?? agent.bustPortrait ?? null,
        icon: agent.displayIcon ?? null,
        tint: agent.backgroundGradientColors?.[0]
          ? `#${agent.backgroundGradientColors[0].slice(0, 6)}`
          : null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));

    if (!agents.length) throw new Error("empty");

    sessionStorage.setItem(CACHE_KEY, JSON.stringify(agents));
    return { agents, live: true };
  } catch {
    return { agents: FALLBACK, live: false };
  } finally {
    clearTimeout(timer);
  }
}

export async function initDemo() {
  const root = document.getElementById("demo-app");
  const grid = document.getElementById("demo-grid");
  const filters = document.getElementById("demo-filters");
  const search = document.getElementById("demo-search");
  const count = document.getElementById("demo-count");
  const empty = document.getElementById("demo-empty");
  const notice = document.getElementById("demo-notice");
  const template = document.getElementById("agent-card-template");
  if (!root || !grid || !template) return;

  const panel = {
    phase: document.getElementById("demo-phase"),
    art: document.getElementById("demo-art"),
    portrait: document.getElementById("demo-portrait"),
    watermark: document.getElementById("demo-watermark"),
    monogram: document.getElementById("demo-monogram"),
    badge: document.getElementById("demo-badge"),
    name: document.getElementById("demo-name"),
    role: document.getElementById("demo-role"),
    status: document.getElementById("demo-status"),
    loop: document.getElementById("demo-loop"),
    updated: document.getElementById("demo-updated"),
    start: document.getElementById("demo-start"),
    startLabel: document.getElementById("demo-start-label"),
    stop: document.getElementById("demo-stop"),
  };

  /* Skeletons while the request is in flight, matching the app's 12. */
  grid.innerHTML = '<div class="agent-skeleton"></div>'.repeat(12);

  let agents = [];
  let live = false;
  let role = "All";
  let query = "";
  let selected = null;
  let run = 0; // increments to invalidate a running sequence

  /* Persisted timing and map overrides, standing in for the app's
     %APPDATA%\Astral\settings.json. */
  const config = loadConfig();

  /* --- Filters --------------------------------------------------------- */

  filters.innerHTML = "";
  for (const name of ROLES) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "rep-chip";
    chip.textContent = name;
    chip.setAttribute("aria-pressed", String(name === role));
    chip.addEventListener("click", () => {
      role = name;
      for (const other of filters.children) {
        other.setAttribute("aria-pressed", String(other === chip));
      }
      render();
    });
    filters.append(chip);
  }

  search?.addEventListener("input", () => {
    query = search.value.trim().toLowerCase();
    render();
  });

  search?.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !search.value) return;
    search.value = "";
    query = "";
    render();
  });

  /* --- Grid ------------------------------------------------------------ */

  function visible() {
    return agents.filter(
      (agent) =>
        (role === "All" || agent.role === role) &&
        (!query || agent.name.toLowerCase().includes(query))
    );
  }

  function render() {
    const list = visible();
    grid.replaceChildren();

    for (const agent of list) {
      const card = template.content.firstElementChild.cloneNode(true);
      const img = card.querySelector("img");
      const isTarget = agent.name === selected?.name;

      card.dataset.role = agent.role.toLowerCase();
      card.dataset.name = agent.name;
      card.setAttribute("aria-selected", String(isTarget));
      if (isTarget && run) card.dataset.flag = root.dataset.phase === "locked" ? "locked" : "target";

      card.querySelector(".agent-name").textContent = agent.name;
      card.querySelector(".agent-role").textContent = agent.role;
      card.querySelector(".agent-monogram").textContent = monogram(agent.name);

      /* --card-tint drives the card's radial wash, exactly as in the app. */
      if (agent.tint) card.style.setProperty("--card-tint", agent.tint);

      const art = agent.portrait ?? agent.icon;
      if (art) {
        img.src = art;
        img.addEventListener("load", () => img.classList.add("is-loaded"), { once: true });
        /* A dead image URL just leaves the monogram showing. */
        img.addEventListener("error", () => img.remove(), { once: true });
      } else {
        img.remove();
      }

      card.addEventListener("click", () => select(agent));
      grid.append(card);
    }

    if (count) count.textContent = list.length ? `${list.length}/${agents.length}` : "";
    if (empty) {
      empty.hidden = list.length > 0;
      empty.textContent = query
        ? `Nothing matches "${search.value.trim()}".`
        : "No agents in this role.";
    }
  }

  /* Roving arrow-key navigation across the rendered grid. */
  grid.addEventListener("keydown", (event) => {
    const cards = [...grid.querySelectorAll(".agent-card")];
    if (!cards.length) return;

    const current = cards.indexOf(document.activeElement);
    /* Column count read from the computed layout, so it stays correct at
       every width without hardcoding a breakpoint. */
    const columns = Math.max(
      1,
      getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length
    );

    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns }[event.key];

    if (step === undefined) {
      if (event.key === "Enter" || event.key === " ") {
        const card = cards[current];
        if (card) {
          event.preventDefault();
          card.click();
        }
      }
      return;
    }

    event.preventDefault();
    const next = cards[Math.min(Math.max((current === -1 ? 0 : current) + step, 0), cards.length - 1)];
    next?.focus();
  });

  /* --- Panel ----------------------------------------------------------- */

  function setPhase(phase, phaseLabel, loop, status) {
    root.dataset.phase = phase;
    panel.phase.textContent = phaseLabel;
    panel.loop.textContent = loop;
    panel.status.textContent = status;
    panel.updated.textContent = clock();
    panel.badge.hidden = phase !== "locked";

    /* The app flags the targeted card in the grid too. */
    for (const card of grid.querySelectorAll(".agent-card")) {
      const isTarget = card.dataset.name === selected?.name;
      if (isTarget && run) card.dataset.flag = phase === "locked" ? "locked" : "target";
      else delete card.dataset.flag;
    }
  }

  function select(agent) {
    selected = agent;
    /* data-role on the shell recolours the panel, chips and card accents,
       which is how a lock lights up in the agent's own colour. */
    root.dataset.role = agent.role.toLowerCase();

    for (const card of grid.querySelectorAll(".agent-card")) {
      card.setAttribute("aria-selected", String(card.dataset.name === agent.name));
    }

    panel.name.textContent = agent.name;
    panel.role.textContent = agent.role;
    panel.role.hidden = false;

    const art = agent.portrait ?? agent.icon;
    if (art) {
      panel.portrait.src = art;
      panel.portrait.hidden = false;
      panel.art.dataset.art = "portrait";
    } else {
      panel.portrait.hidden = true;
      panel.monogram.textContent = monogram(agent.name);
      panel.art.dataset.art = "monogram";
    }

    panel.start.disabled = false;

    if (run) {
      panel.startLabel.textContent = "Monitoring…";
      setPhase("monitoring", "Monitoring", "Watching pre-game", `Re-aimed at ${agent.name}.`);
    } else {
      panel.startLabel.textContent = "Start locking";
      setPhase("idle", "Idle", "Standby", `${agent.name} ready. Start the loop to arm it.`);
    }
  }

  /* --- Lock sequence --------------------------------------------------- */

  const wait = (ms, token) =>
    new Promise((resolve) => setTimeout(() => resolve(token === run), ms));

  /* Walk the rotation, but put any map that has an override next in line so a
     saved rule visibly fires instead of waiting on chance. */
  let cycle = 0;
  function nextMap() {
    const configured = Object.keys(config.mapAgentOverrides);
    if (!configured.length) return ROTATION[cycle++ % ROTATION.length];

    const others = ROTATION.filter((map) => !configured.includes(map));
    /* Every map in the rotation is overridden, so there is nothing to alternate
       with -- walk the rules alone rather than interleaving `undefined`. */
    if (!others.length) return configured[cycle++ % configured.length];

    const pool = configured.flatMap((map, i) => [map, others[i % others.length]]);
    return pool[cycle++ % pool.length];
  }

  async function start() {
    if (!selected) return;
    const token = ++run;

    panel.start.disabled = true;
    panel.stop.disabled = false;
    panel.startLabel.textContent = "Monitoring…";

    setPhase("arming", "Arming", "Attaching", "Attaching to the local client…");
    if (!(await wait(900, token))) return;

    /* Same shape as the real loop: watch, resolve the map, hover, lock, hold.
       Every delay below is whatever is currently saved in Settings. */
    while (token === run) {
      setPhase("monitoring", "Monitoring", "Watching pre-game", "Waiting for pre-game.");
      if (!(await wait(2600, token))) return;

      const map = nextMap();
      /* A per-map override wins over the agent picked in the grid, exactly as
         InstalockerService.ResolveAgentForMap does. */
      const agent = config.mapAgentOverrides[map] ?? selected.name;

      if (config.hoverDelayMs) {
        setPhase("monitoring", "Monitoring", "Watching pre-game", `Pre-game on ${map}. Waiting ${config.hoverDelayMs} ms…`);
        if (!(await wait(Math.min(config.hoverDelayMs, 4000), token))) return;
      }

      setPhase("monitoring", "Monitoring", "Watching pre-game", `Selecting ${agent} on ${map}.`);
      if (!(await wait(Math.max(Math.min(config.lockDelayMs, 4000), 420), token))) return;

      setPhase("locked", "Locked", "Cooldown + monitor", `Locked ${agent}. Monitoring for the next match.`);
      if (!(await wait(Math.max(Math.min(config.postLockDelayMs, 5000), 600), token))) return;
    }
  }

  function stop() {
    run = 0;
    panel.stop.disabled = true;
    panel.start.disabled = !selected;
    panel.startLabel.textContent = "Start locking";
    setPhase(
      "idle",
      "Idle",
      "Stopped",
      selected ? `Stopped. ${selected.name} still selected.` : "Stopped."
    );
  }

  /* While running, Start is inert — the app re-aims by picking another card. */
  panel.start?.addEventListener("click", () => {
    if (!run) start();
  });
  panel.stop?.addEventListener("click", stop);

  /* --- Boot ------------------------------------------------------------ */

  ({ agents, live } = await loadAgents());
  render();

  if (!live && notice) notice.hidden = false;

  /* Wired only once the roster is known, so the override rows can offer real
     agent names rather than an empty list. */
  initSettings({
    config,
    agentNames: agents.map((agent) => agent.name),
    onSave: () => {
      const rules = Object.keys(config.mapAgentOverrides).length;
      if (run) return; // a running loop picks the new values up next cycle
      setPhase(
        root.dataset.phase,
        panel.phase.textContent,
        panel.loop.textContent,
        rules
          ? `Settings saved. ${rules} map override${rules > 1 ? "s" : ""} active.`
          : "Settings saved."
      );
    },
  });

  setPhase("idle", "Idle", "Standby", "Pick an agent to arm the loop.");
}

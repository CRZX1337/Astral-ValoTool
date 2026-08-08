/* Interactive multitool — a replica of Astral's desktop UI.

   Portraits and rank badges come from valorant-api.com, the same source the
   real app uses at runtime. The game side is simulated (there is no Valorant
   client in a browser tab), but every view, phase, loop label and status string
   below is one the app actually renders, so what you see here is what you get.

   Sections: 1. data  2. shell/routing  3. instalock  4. tracker  5. auto-queue */

import { loadConfig, initSettings } from "./settings.js";

const AGENTS_API = "https://valorant-api.com/v1/agents?isPlayableCharacter=true";
const TIERS_API = "https://valorant-api.com/v1/competitivetiers";
const CACHE_KEY = "astral:agents";
const TIER_CACHE_KEY = "astral:tiers";
const TIMEOUT = 4000;

/* Maps the simulated pre-game can open on. Drawn from the same table the
   settings dialog offers, minus the two non-competitive ones. */
const ROTATION = [
  "Ascent", "Bind", "Haven", "Split", "Lotus", "Sunset",
  "Icebox", "Breeze", "Fracture", "Pearl", "Abyss", "Corrode",
];

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

/* The seven QueueId values RadiantConnect exposes, with the names the app's
   picker shows. */
const QUEUES = [
  ["unrated", "Unrated"], ["competitive", "Competitive"], ["swiftplay", "Swiftplay"],
  ["spikerush", "Spike Rush"], ["deathmatch", "Deathmatch"], ["ggteam", "Escalation"],
  ["hurm", "Team Deathmatch"],
].map(([id, name]) => ({ id, name }));

/* A plausible competitive session, standing in for what
   FetchCompetitveUpdatesAsync returns. Newest first, as the app sorts them. */
const DEMO_RANK = { tierName: "Ascendant 2", rr: 64 };
const DEMO_MATCHES = [
  { map: "Lotus", rr: +23, tier: "Ascendant 2", ago: 18 },
  { map: "Ascent", rr: +19, tier: "Ascendant 1", ago: 61 },
  { map: "Icebox", rr: -16, tier: "Ascendant 1", ago: 104 },
  { map: "Sunset", rr: +21, tier: "Ascendant 1", ago: 152 },
  { map: "Breeze", rr: -14, tier: "Ascendant 1", ago: 203 },
];

/* Same rule as the app's grid: split on non-alphanumerics so "KAY/O" reads
   as "KO", and a plain name falls back to its first letter. */
function monogram(name) {
  const parts = name.split(/[^a-z0-9]+/i).filter(Boolean);
  return (parts.length > 1 ? parts.slice(0, 2).map((p) => p[0]).join("") : name[0]).toUpperCase();
}

const clock = () => new Date().toLocaleTimeString("en-GB", { hour12: false });

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

async function cachedJson(url, key) {
  const cached = sessionStorage.getItem(key);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch {
      sessionStorage.removeItem(key);
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const data = await (await request(url, controller.signal)).json();
    sessionStorage.setItem(key, JSON.stringify(data));
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function loadAgents() {
  try {
    const payload = await cachedJson(AGENTS_API, CACHE_KEY);
    const agents = payload.data
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
    return { agents, live: true };
  } catch {
    return { agents: FALLBACK, live: false };
  }
}

/* Rank art, resolved the same way the app does it: the newest tier table from
   valorant-api, keyed by the tier's display name. */
async function loadTier(tierName) {
  try {
    const payload = await cachedJson(TIERS_API, TIER_CACHE_KEY);
    const table = payload.data?.[payload.data.length - 1];
    const tier = table?.tiers?.find(
      (t) => (t.tierName ?? "").trim().toLowerCase() === tierName.toLowerCase()
    );
    if (!tier) return null;
    return {
      icon: tier.largeIcon ?? tier.smallIcon ?? null,
      color: tier.color ? `#${tier.color.slice(0, 6)}` : null,
    };
  } catch {
    return null;
  }
}

export async function initDemo() {
  const root = document.getElementById("demo-app");
  const grid = document.getElementById("demo-grid");
  const template = document.getElementById("agent-card-template");
  if (!root || !grid || !template) return;

  /* ================= 2. Shell and routing ================= */

  const TITLES = {
    home: "Astral",
    instalock: "Instalock",
    tracker: "Rank tracker",
    autoqueue: "Auto-queue",
    intel: "Lobby intel",
  };

  const views = new Map(
    [...root.querySelectorAll(".rep-view")].map((el) => [el.dataset.view, el])
  );
  const back = document.getElementById("demo-back");
  const brand = document.getElementById("demo-brand");
  const gear = document.getElementById("demo-settings-open");
  const cardStatus = {
    instalock: document.getElementById("demo-status-instalock"),
    tracker: document.getElementById("demo-status-tracker"),
    autoqueue: document.getElementById("demo-status-autoqueue"),
    intel: document.getElementById("demo-status-intel"),
  };

  let view = "home";

  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

  /* Same shared element as the app's shell.js, prefixed so the site's own
     transitions can never collide with the replica's. */
  const MORPH = "rep-morph";

  const morphTarget = (name) => {
    const section = views.get(name);
    return section ? section.querySelector(".rep-tool-head, .rep-toolbar") ?? section : null;
  };
  const cardFor = (name) => root.querySelector(`[data-goto="${name}"]`);

  function applyView(next) {
    view = next;
    root.dataset.view = next;

    for (const [name, el] of views) el.hidden = name !== next;

    back.hidden = next === "home";
    brand.textContent = TITLES[next] ?? "Astral";
    /* The gear only configures the instalocker, exactly as in the app. */
    gear.hidden = next !== "instalock";

    /* Same rule as the app: the watch only runs while the view is on screen. */
    setIntelWatching(next === "intel");
  }

  function enter(next) {
    const active = views.get(next);
    if (!active) return;
    active.classList.remove("is-entering");
    void active.offsetWidth;
    active.classList.add("is-entering");
    setTimeout(() => active.classList.remove("is-entering"), 900);
  }

  function setView(next) {
    if (!views.has(next) || next === view) return;

    const from = view;
    const start = document.startViewTransition?.bind(document);

    if (!start || reduceMotion.matches) {
      applyView(next);
      enter(next);
    } else {
      /* One view-transition-name, handed from the card to the destination
         header. Naming both at once silently kills the morph. */
      const opening = next !== "home";
      const outgoing = opening ? cardFor(next) : morphTarget(from);
      const incoming = opening ? morphTarget(next) : cardFor(from);

      if (outgoing) outgoing.style.viewTransitionName = MORPH;

      const transition = start(() => {
        if (outgoing) outgoing.style.viewTransitionName = "";
        if (incoming) incoming.style.viewTransitionName = MORPH;
        applyView(next);
      });

      /* Deliberately no enter() here: the transition is the entry animation,
         and staggering the sections in again afterwards played the view twice. */
      const cleanup = () => {
        if (outgoing) outgoing.style.viewTransitionName = "";
        if (incoming) incoming.style.viewTransitionName = "";
      };

      /* Both arms: `finished` rejects when a transition is skipped. */
      transition.finished.then(cleanup, cleanup);
    }

    /* Opening the tracker loads it, the way the app refreshes on view entry --
       but only once the view has settled, so the content cannot change
       underneath the snapshot the user is still watching. */
    if (next === "tracker" && !trackerLoaded && !trackerBusy) {
      setTimeout(() => {
        if (view === "tracker" && !trackerLoaded && !trackerBusy) refreshTracker();
      }, 520);
    }
  }

  for (const card of root.querySelectorAll("[data-goto]")) {
    card.addEventListener("click", () => setView(card.dataset.goto));
  }
  back.addEventListener("click", () => setView("home"));

  function paintCard(key, text, live) {
    const el = cardStatus[key];
    if (!el) return;
    el.dataset.live = live ? "on" : "off";
    el.lastElementChild.textContent = text;
  }

  /* ================= 3. Instalock ================= */

  const panel = {
    phase: document.getElementById("demo-phase"),
    art: document.getElementById("demo-art"),
    portrait: document.getElementById("demo-portrait"),
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

  const filters = document.getElementById("demo-filters");
  const search = document.getElementById("demo-search");
  const count = document.getElementById("demo-count");
  const empty = document.getElementById("demo-empty");
  const notice = document.getElementById("demo-notice");

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

    if (phase === "locked") paintCard("instalock", `Locked ${selected?.name ?? ""}`.trim(), true);
    else if (run) paintCard("instalock", `Monitoring · ${selected?.name ?? "—"}`, true);
    else paintCard("instalock", "Idle", false);
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

  /* ================= 4. Rank tracker ================= */

  const tracker = {
    updated: document.getElementById("demo-tracker-updated"),
    refresh: document.getElementById("demo-tracker-refresh"),
    refreshLabel: document.getElementById("demo-tracker-refresh-label"),
    reset: document.getElementById("demo-tracker-reset"),
    card: document.getElementById("demo-rank-card"),
    icon: document.getElementById("demo-rank-icon"),
    fallback: document.getElementById("demo-rank-fallback"),
    name: document.getElementById("demo-rank-name"),
    rr: document.getElementById("demo-rank-rr"),
    fill: document.getElementById("demo-rank-fill"),
    wins: document.getElementById("demo-session-wins"),
    losses: document.getElementById("demo-session-losses"),
    net: document.getElementById("demo-session-rr"),
    played: document.getElementById("demo-session-played"),
    list: document.getElementById("demo-match-list"),
    empty: document.getElementById("demo-match-empty"),
  };

  let trackerLoaded = false;
  let trackerBusy = false;
  /* How many of the recent matches count as "this session". Reset drops it to
     zero, the way re-anchoring the session does in the app. */
  let sessionSize = 3;

  function paintSession() {
    const inSession = DEMO_MATCHES.slice(0, sessionSize);
    const wins = inSession.filter((m) => m.rr > 0).length;
    const losses = inSession.filter((m) => m.rr < 0).length;
    const net = inSession.reduce((sum, m) => sum + m.rr, 0);

    tracker.wins.textContent = String(wins);
    tracker.losses.textContent = String(losses);
    tracker.played.textContent = String(inSession.length);
    tracker.net.textContent = `${net > 0 ? "+" : ""}${net}`;
    tracker.net.classList.toggle("rep-up", net > 0);
    tracker.net.classList.toggle("rep-down", net < 0);

    paintCard("tracker", `${DEMO_RANK.tierName} · ${net > 0 ? "+" : ""}${net} RR today`, net !== 0);
  }

  function paintMatches() {
    const fragment = document.createDocumentFragment();

    for (const match of DEMO_MATCHES) {
      const row = document.createElement("div");
      row.className = "rep-match-row";
      row.dataset.result = match.rr > 0 ? "win" : match.rr < 0 ? "loss" : "draw";

      const flag = document.createElement("span");
      flag.className = "rep-match-flag";

      const body = document.createElement("div");
      const map = document.createElement("div");
      map.className = "rep-match-map";
      map.textContent = match.map;
      const when = document.createElement("div");
      when.className = "rep-match-when";
      when.textContent = `${match.ago} min ago`;
      body.append(map, when);

      const rr = document.createElement("span");
      rr.className = `rep-match-rr ${match.rr > 0 ? "rep-up" : "rep-down"}`;
      rr.textContent = `${match.rr > 0 ? "+" : ""}${match.rr}`;

      const tier = document.createElement("span");
      tier.className = "rep-match-tier";
      tier.textContent = match.tier;

      row.append(flag, body, rr, tier);
      fragment.append(row);
    }

    tracker.list.replaceChildren(fragment);
    tracker.empty.hidden = true;
  }

  async function refreshTracker() {
    if (trackerBusy) return;
    trackerBusy = true;
    tracker.refresh.disabled = true;
    tracker.refreshLabel.textContent = "Loading…";

    /* A beat of latency, so it reads the way it does against the real
       POST /api/tracker/refresh rather than snapping. */
    await new Promise((resolve) => setTimeout(resolve, 620));

    tracker.card.hidden = false;
    tracker.name.textContent = DEMO_RANK.tierName;
    tracker.rr.textContent = `${DEMO_RANK.rr} RR`;
    tracker.fill.style.width = `${Math.min(DEMO_RANK.rr, 100)}%`;
    tracker.fallback.textContent = DEMO_RANK.tierName.slice(0, 2).toUpperCase();

    const art = await loadTier(DEMO_RANK.tierName);
    if (art?.color) tracker.card.style.setProperty("--rank-color", art.color);
    if (art?.icon) {
      tracker.icon.addEventListener("load", () => {
        tracker.icon.hidden = false;
        tracker.fallback.hidden = true;
      }, { once: true });
      tracker.icon.src = art.icon;
    }

    paintMatches();
    paintSession();
    tracker.updated.textContent = `Updated ${clock()}`;

    trackerLoaded = true;
    trackerBusy = false;
    tracker.refresh.disabled = false;
    tracker.refreshLabel.textContent = "Refresh";
  }

  tracker.refresh.addEventListener("click", () => refreshTracker());
  tracker.reset.addEventListener("click", () => {
    sessionSize = 0;
    paintSession();
    tracker.updated.textContent = `Session reset ${clock()}`;
  });

  /* ================= 5. Auto-queue ================= */

  const queue = {
    status: document.getElementById("demo-queue-status"),
    start: document.getElementById("demo-queue-start"),
    startLabel: document.getElementById("demo-queue-start-label"),
    stop: document.getElementById("demo-queue-stop"),
    picker: document.getElementById("demo-queue-picker"),
    party: document.getElementById("demo-party-state"),
    partyQueue: document.getElementById("demo-party-queue"),
    requeue: document.getElementById("demo-opt-requeue"),
  };

  let queueId = "competitive";
  let queueRun = 0;
  let requeues = 0;

  const chips = new Map();
  for (const item of QUEUES) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "rep-queue-chip";
    chip.textContent = item.name;
    chip.addEventListener("click", () => {
      queueId = item.id;
      paintQueueChips();
    });
    chips.set(item.id, chip);
    queue.picker.append(chip);
  }

  function paintQueueChips() {
    for (const [id, chip] of chips) {
      const active = id === queueId;
      chip.classList.toggle("is-active", active);
      chip.setAttribute("aria-pressed", String(active));
    }
    queue.partyQueue.textContent = `· queue: ${queueId}`;
  }

  const delayPair = bindPair("demo-opt-delay", "demo-opt-delay-value", 0, 60000);
  const maxPair = bindPair("demo-opt-max", "demo-opt-max-value", 1, 20);

  function bindPair(rangeId, numberId, min, max) {
    const range = document.getElementById(rangeId);
    const field = document.getElementById(numberId);
    const clamp = (v) => Math.min(Math.max(Number(v) || min, min), max);

    range.addEventListener("input", () => (field.value = range.value));
    field.addEventListener("change", () => {
      field.value = String(clamp(field.value));
      range.value = field.value;
    });

    return { value: () => clamp(range.value) };
  }

  function setQueueStatus(text, running) {
    queue.status.textContent = text;
    paintCard("autoqueue", running ? `Running · ${queueId}` : "Idle", running);
  }

  /* Its own token check: `wait` above is bound to the instalock run counter,
     and reusing it here would let a stopped queue loop keep going. */
  const queueWait = (ms, token) =>
    new Promise((resolve) => setTimeout(() => resolve(token === queueRun), ms));

  async function runQueue() {
    const token = ++queueRun;
    requeues = 0;
    queue.start.disabled = true;
    queue.stop.disabled = false;
    queue.startLabel.textContent = "Running";

    setQueueStatus("Watching for the end of a match.", true);
    queue.party.textContent = "Party: MATCHMAKING";

    while (token === queueRun) {
      if (!(await queueWait(2400, token))) return;

      /* The real loop only requeues while the client is back in the menus. */
      queue.party.textContent = "Party: DEFAULT";
      const limit = maxPair.value();

      if (requeues >= limit) {
        setQueueStatus(`Stopped requeueing after ${limit} in a row. Start again when you're ready.`, true);
        return;
      }

      if (!queue.requeue.checked) {
        setQueueStatus("Match over. Auto-requeue is off, so nothing to do.", true);
        if (!(await queueWait(2200, token))) return;
        continue;
      }

      const delay = delayPair.value();
      setQueueStatus(`Match over. Requeueing in ${delay} ms…`, true);
      if (!(await queueWait(Math.min(delay, 2500), token))) return;

      requeues += 1;
      queue.party.textContent = "Party: MATCHMAKING";
      setQueueStatus(`Requeued automatically (${requeues} of ${limit}).`, true);
      if (!(await queueWait(1800, token))) return;

    }
  }

  function stopQueue() {
    queueRun = 0;
    queue.start.disabled = false;
    queue.stop.disabled = true;
    queue.startLabel.textContent = "Start";
    queue.party.textContent = "Party: DEFAULT";
    setQueueStatus("Stopped by user.", false);
  }

  queue.start.addEventListener("click", () => {
    if (!queueRun) runQueue();
  });
  queue.stop.addEventListener("click", stopQueue);
  paintQueueChips();

  /* ================= Lobby intel ================= */

  /* A canned agent select. The app reads this from the client; here it is a
     scripted roster that fills in, so the view shows what it looks like mid-pick
     rather than sitting on a finished lobby. */
  const LOBBY = [
    { slot: 0, self: true, captain: true, name: "You#EUW", agent: "Neon", role: "duelist", at: 0, tier: "Diamond 1" },
    { slot: 1, name: "Kestrel#1337", agent: "Sova", role: "initiator", at: 0, tier: "Platinum 3" },
    { slot: 2, incognito: true, agent: "Omen", role: "controller", at: 2, tier: "Platinum 1" },
    { slot: 3, name: "mint#000", agent: null, role: null, at: 4, tier: "Immortal 1" },
    { slot: 4, name: "raze enjoyer#na1", agent: "Raze", role: "duelist", at: 3, tier: "Gold 1" },
  ];

  const intel = {
    list: document.getElementById("demo-lobby-list"),
    map: document.getElementById("demo-intel-map"),
    status: document.getElementById("demo-intel-status"),
    timer: document.getElementById("demo-intel-timer"),
    locked: document.getElementById("demo-intel-locked"),
  };

  let intelTick = 0;
  let intelTimer = null;

  /* `at` is the tick a player locks on. Before it they are hovering, which is
     what makes the roster visibly settle as the countdown runs. */
  function paintLobby() {
    if (!intel.list) return;

    const seconds = Math.max(0, 45 - intelTick * 3);
    let locked = 0;

    intel.list.replaceChildren(
      ...LOBBY.map((player, index) => {
        const settled = player.agent !== null && intelTick >= player.at;
        if (settled) locked += 1;

        const row = document.createElement("div");
        row.className = "rep-lobby-row";
        row.dataset.pick = player.agent === null ? "none" : settled ? "locked" : "hovering";
        row.dataset.role = player.role ?? "unknown";
        row.style.setProperty("--i", String(index));
        if (player.self) row.dataset.self = "1";

        const portrait = document.createElement("span");
        portrait.className = "rep-lobby-portrait";
        portrait.textContent = String(player.slot + 1);

        const body = document.createElement("div");
        body.className = "rep-lobby-identity";

        const name = document.createElement("div");
        name.className = "rep-lobby-name";
        name.textContent = player.incognito ? "Incognito" : player.name;
        if (player.incognito) name.dataset.incognito = "1";

        if (player.captain) {
          const tag = document.createElement("span");
          tag.className = "rep-lobby-tag";
          tag.textContent = "Party lead";
          name.append(" ", tag);
        }

        const pick = document.createElement("div");
        pick.className = "rep-lobby-pick";
        pick.textContent = player.agent
          ? `${player.agent} · ${settled ? "Locked" : "Hovering"}`
          : "Picking…";

        body.append(name, pick);

        const rank = document.createElement("span");
        rank.className = "rep-lobby-tier";
        rank.textContent = player.tier;

        row.append(portrait, body, rank);
        return row;
      })
    );

    intel.timer.textContent = `${seconds}s`;
    intel.locked.textContent = `${locked}/${LOBBY.length} locked`;
    intel.status.textContent = `Agent select on Ascent. ${locked} of ${LOBBY.length} locked.`;
    paintCard("intel", `Ascent · ${locked}/${LOBBY.length}`, true);
  }

  /* Only runs while the view is open: the real watch holds a connection lease,
     and an interval ticking behind a hidden section is the same waste here. */
  function setIntelWatching(watching) {
    clearInterval(intelTimer);
    intelTimer = null;

    if (!watching) {
      paintCard("intel", "Not watching", false);
      return;
    }

    intelTick = 0;
    paintLobby();
    intelTimer = setInterval(() => {
      intelTick = intelTick >= 6 ? 0 : intelTick + 1;
      paintLobby();
    }, 1600);
  }

  /* ================= Boot ================= */

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
  applyView("home");
  bootReplica();

  /* ================= Boot on scroll ================= */

  /* The app boots when it launches; the replica has no such moment, so it
     boots the first time it comes into view. Same guard as js/reveal.js: the
     effect is only armed once we know we can drive it, and a deadline tears it
     down if the observer never reports rather than leaving the demo covered. */
  function bootReplica() {
    const overlay = document.getElementById("demo-boot");
    const status = document.getElementById("demo-boot-status");

    if (!overlay) {
      root.dataset.booted = "true";
      return;
    }

    if (reduceMotion.matches || !("IntersectionObserver" in window)) {
      overlay.remove();
      root.dataset.booted = "true";
      return;
    }

    overlay.hidden = false;
    root.dataset.booting = "true";

    let finished = false;

    function finish() {
      if (finished) return;
      finished = true;
      overlay.classList.add("is-done");
      delete root.dataset.booting;
      root.dataset.booted = "true";
      /* Removed rather than left transparent: a full-cover overlay that still
         exists will happily swallow the first click on a tool card. */
      setTimeout(() => overlay.remove(), 520);
    }

    function play() {
      status.textContent = "Reading agent list…";
      setTimeout(() => { status.textContent = "Ready"; }, 520);
      setTimeout(finish, 1100);
    }

    let delivered = false;

    const observer = new IntersectionObserver(
      (entries) => {
        delivered = true;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer.disconnect();
          play();
        }
      },
      { threshold: 0.25 }
    );

    observer.observe(root);

    setTimeout(() => {
      if (delivered) return;
      observer.disconnect();
      finish();
    }, 1500);
  }
}

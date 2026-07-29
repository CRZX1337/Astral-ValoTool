/* Interactive agent grid.

   A replica of Astral's picker. Portraits come from valorant-api.com, the same
   source the real app uses at runtime. The lock sequence is simulated -- there
   is no game client in a browser tab -- but the phases, labels and colours are
   the ones the app actually reports. */

const API = "https://valorant-api.com/v1/agents?isPlayableCharacter=true";
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
    const response = await fetch(API, { signal: controller.signal });
    if (!response.ok) throw new Error(String(response.status));

    const agents = (await response.json()).data
      .map((agent) => ({
        name: agent.displayName,
        role: agent.role?.displayName ?? "Unlisted",
        /* bustPortrait crops well into a square tile; displayIcon is the
           smaller safety net. */
        portrait: agent.bustPortrait ?? agent.displayIcon ?? null,
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
  const root = document.getElementById("demo");
  const grid = document.getElementById("demo-grid");
  const filters = document.getElementById("demo-filters");
  const search = document.getElementById("demo-search");
  const count = document.getElementById("demo-count");
  const empty = document.getElementById("demo-empty");
  const phaseLabel = document.getElementById("demo-phase");
  const statusLine = document.getElementById("demo-status");
  const startBtn = document.getElementById("demo-start");
  const startLabel = document.getElementById("demo-start-label");
  const stopBtn = document.getElementById("demo-stop");
  const template = document.getElementById("agent-card-template");
  if (!root || !grid || !template) return;

  /* Skeletons while the request is in flight, matching the app's 12. */
  grid.innerHTML = '<div class="agent-skeleton"></div>'.repeat(12);

  let agents = [];
  let live = false;
  let role = "All";
  let query = "";
  let selected = null;
  let run = 0; // increments to invalidate a running sequence

  /* --- Filters --------------------------------------------------------- */

  filters.innerHTML = "";
  for (const name of ROLES) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = name;
    chip.dataset.role = name.toLowerCase();
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

  /* --- Rendering ------------------------------------------------------- */

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
      const art = card.querySelector(".agent-art");
      const img = card.querySelector("img");
      const mono = card.querySelector(".agent-monogram");

      card.dataset.role = agent.role.toLowerCase();
      card.dataset.name = agent.name;
      card.setAttribute("aria-selected", String(agent.name === selected?.name));
      card.querySelector(".agent-name").textContent = agent.name;
      card.querySelector(".agent-role").textContent = agent.role;
      mono.textContent = monogram(agent.name);

      /* Per-agent tint from the API's own gradient, layered over the role
         accent so the tile still reads as that role. */
      if (agent.tint) {
        art.style.background =
          `radial-gradient(circle at 50% 16%, ${agent.tint}66, transparent 72%), rgba(0,0,0,.28)`;
      }

      if (agent.portrait) {
        img.src = agent.portrait;
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
        ? `No agent matches "${search.value.trim()}".`
        : "No agents in this role.";
    }
  }

  /* Roving arrow-key navigation across the rendered grid. */
  grid.addEventListener("keydown", (event) => {
    const cards = [...grid.querySelectorAll(".agent-card")];
    if (!cards.length) return;

    const current = cards.indexOf(document.activeElement);
    /* Column count from the actual computed layout, so it stays correct at
       every breakpoint without hardcoding. */
    const columns = Math.max(
      1,
      getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length
    );

    const step = {
      ArrowRight: 1, ArrowLeft: -1,
      ArrowDown: columns, ArrowUp: -columns,
    }[event.key];

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

  /* --- Lock sequence --------------------------------------------------- */

  function setPhase(phase, label, status) {
    root.dataset.phase = phase;
    if (phaseLabel) phaseLabel.textContent = label;
    if (statusLine) statusLine.innerHTML = status;
  }

  function select(agent) {
    selected = agent;
    /* data-role on the container recolours the whole panel, which is how the
       app makes a lock light up in the agent's own colour. */
    root.dataset.role = agent.role.toLowerCase();

    for (const card of grid.querySelectorAll(".agent-card")) {
      card.setAttribute("aria-selected", String(card.dataset.name === agent.name));
    }

    startBtn.disabled = false;
    if (startLabel) startLabel.textContent = run ? "Switch target" : "Start locking";
    if (!run) {
      setPhase("idle", "Idle", `<b>${agent.name}</b> ready. Start the loop to arm it.`);
    } else {
      setPhase("monitoring", "Monitoring", `Re-aimed at <b>${agent.name}</b>. Watching pre-game.`);
    }
  }

  const wait = (ms, token) =>
    new Promise((resolve) => setTimeout(() => resolve(token === run), ms));

  async function start() {
    if (!selected) return;
    const token = ++run;

    startBtn.disabled = true;
    stopBtn.disabled = false;
    if (startLabel) startLabel.textContent = "Monitoring…";

    setPhase("arming", "Arming", "Attaching to the local client…");
    if (!(await wait(900, token))) return;

    /* Loops the way the real one does: watch, lock, hold, watch again. */
    while (token === run) {
      setPhase("monitoring", "Monitoring", `Watching pre-game for <b>${selected.name}</b>.`);
      if (!(await wait(2600, token))) return;

      setPhase("locked", "Locked", `Pre-game detected — <b>${selected.name}</b> locked.`);
      if (!(await wait(2800, token))) return;

      setPhase("monitoring", "Monitoring", "Cooldown + monitor.");
      if (!(await wait(1400, token))) return;
    }
  }

  function stop() {
    run = 0;
    stopBtn.disabled = true;
    startBtn.disabled = !selected;
    if (startLabel) startLabel.textContent = "Start locking";
    setPhase("idle", "Idle", selected ? `Stopped. <b>${selected.name}</b> still selected.` : "Stopped.");
  }

  startBtn?.addEventListener("click", () => {
    /* While running, Start acts as "switch target" and the loop keeps going. */
    if (run) return;
    start();
  });
  stopBtn?.addEventListener("click", stop);

  /* --- Boot ------------------------------------------------------------ */

  ({ agents, live } = await loadAgents());
  render();

  if (!live) {
    const note = root.querySelector(".demo-note");
    if (note) {
      const pill = document.createElement("span");
      pill.className = "pill";
      pill.textContent = "Portraits unavailable";
      note.prepend(pill);
    }
  }

  setPhase("idle", "Idle", "Pick an agent to arm the loop.");
}

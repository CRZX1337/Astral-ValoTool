/* Settings dialog for the demo replica.

   Mirrors the app's dialog: timing sliders, map overrides, post-lock hold.
   It is fully wired -- what you save here actually drives the simulated lock
   loop, including which agent gets picked on which map. Values persist to
   localStorage, standing in for %APPDATA%\Astral\settings.json. */

const STORE_KEY = "astral:settings";

/* The 19 entries of RadiantConnect's InternalMapNames table (v10.6.1), which
   is what the app's GET /api/options returns as the selectable map list. */
export const MAPS = [
  "Abyss", "Ascent", "Basic Training", "Bind", "Breeze", "Corrode", "District",
  "Drift", "Fracture", "Glitch", "Haven", "Icebox", "Kasbah", "Lotus", "Pearl",
  "Piazza", "Split", "Sunset", "The Range",
];

export const DEFAULTS = {
  /* Straight from the shipped appsettings.json -- note there are no map
     overrides by default, whatever the README's illustrative snippet shows. */
  hoverDelayMs: 0,
  lockDelayMs: 0,
  postLockDelayMs: 5000,
  mapAgentOverrides: {},
};

export function loadConfig() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (!raw || typeof raw !== "object") return { ...DEFAULTS };
    return {
      ...DEFAULTS,
      ...raw,
      mapAgentOverrides:
        raw.mapAgentOverrides && typeof raw.mapAgentOverrides === "object"
          ? raw.mapAgentOverrides
          : {},
    };
  } catch {
    /* Corrupt entry falls back to defaults, as the app's OptionsStore does. */
    return { ...DEFAULTS };
  }
}

const clampMs = (value) =>
  Math.min(10000, Math.max(0, Math.round((Number(value) || 0) / 50) * 50));

export function initSettings({ config, agentNames, onSave }) {
  const modal = document.getElementById("demo-settings");
  const opener = document.getElementById("demo-settings-open");
  const template = document.getElementById("rule-row-template");
  if (!modal || !opener || !template) return;

  const list = document.getElementById("set-rules");
  const empty = document.getElementById("set-rules-empty");
  const addBtn = document.getElementById("set-add");
  const saveBtn = document.getElementById("set-save");
  const note = document.getElementById("set-note");

  /* Each slider is a [range, number] pair kept in sync both ways. */
  const sliders = [
    ["hoverDelayMs", "set-hover"],
    ["lockDelayMs", "set-lock"],
    ["postLockDelayMs", "set-post"],
  ].map(([key, id]) => ({
    key,
    range: document.getElementById(id),
    field: document.getElementById(`${id}-value`),
  }));

  for (const { range, field } of sliders) {
    range.addEventListener("input", () => (field.value = range.value));
    field.addEventListener("input", () => (range.value = clampMs(field.value)));
    /* Snap the typed value only on blur, so typing "1500" isn't fought. */
    field.addEventListener("change", () => {
      field.value = clampMs(field.value);
      range.value = field.value;
    });
  }

  /* --- Map override rows ----------------------------------------------- */

  const rows = () => [...list.querySelectorAll(".rep-rule-row")];

  /* A map may only be claimed once. Rather than validate on save, every other
     row's option for a taken map is disabled, so the state is unreachable. */
  function syncMapOptions() {
    const taken = new Set(rows().map((row) => row.querySelector(".rep-rule-map").value));
    for (const row of rows()) {
      const select = row.querySelector(".rep-rule-map");
      for (const option of select.options) {
        option.disabled = option.value !== select.value && taken.has(option.value);
      }
    }
    empty.hidden = rows().length > 0;
  }

  function addRow(map, agent) {
    const row = template.content.firstElementChild.cloneNode(true);
    const mapSelect = row.querySelector(".rep-rule-map");
    const agentSelect = row.querySelector(".rep-rule-agent");

    for (const name of MAPS) {
      mapSelect.append(new Option(name, name));
    }
    for (const name of agentNames) {
      agentSelect.append(new Option(name, name));
    }

    /* First map not already claimed, so a fresh row is never a duplicate. */
    const taken = new Set(rows().map((r) => r.querySelector(".rep-rule-map").value));
    mapSelect.value = map ?? MAPS.find((name) => !taken.has(name)) ?? MAPS[0];

    if (agent && !agentNames.includes(agent)) {
      /* Saved agent that the current roster no longer has -- the app keeps it
         selectable and marks it, rather than silently dropping the rule. */
      agentSelect.append(new Option(`${agent} (unavailable)`, agent));
    }
    agentSelect.value = agent ?? agentNames[0] ?? "";

    mapSelect.addEventListener("change", syncMapOptions);
    row.querySelector(".rep-rule-remove").addEventListener("click", () => {
      row.remove();
      syncMapOptions();
    });

    list.append(row);
    syncMapOptions();
  }

  addBtn.addEventListener("click", () => {
    if (rows().length >= MAPS.length) return;
    addRow();
    list.lastElementChild?.querySelector("select")?.focus();
  });

  /* --- Open / close ---------------------------------------------------- */

  let lastFocus = null;

  function fill() {
    for (const { key, range, field } of sliders) {
      range.value = config[key];
      field.value = config[key];
    }
    list.replaceChildren();
    for (const [map, agent] of Object.entries(config.mapAgentOverrides)) {
      addRow(map, agent);
    }
    syncMapOptions();
    note.textContent = "";
  }

  function open() {
    lastFocus = document.activeElement;
    fill();
    modal.hidden = false;
    modal.querySelector("#set-hover")?.focus();
  }

  function close() {
    modal.hidden = true;
    /* Focus belongs back on the control that opened the dialog. Falling back
       to the gear covers the cases where whatever had focus is gone or was
       never focusable in the first place. */
    const target =
      lastFocus && lastFocus !== document.body && lastFocus.isConnected ? lastFocus : opener;
    target.focus?.();
  }

  opener.addEventListener("click", open);
  for (const el of modal.querySelectorAll("[data-close-settings]")) {
    el.addEventListener("click", close);
  }

  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "Tab") return;

    /* Focus trap. Querying on each Tab rather than caching, because rows are
       added and removed while the dialog is open. */
    const focusable = modal.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href]'
    );
    if (!focusable.length) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  /* --- Save ------------------------------------------------------------ */

  saveBtn.addEventListener("click", async () => {
    const next = { mapAgentOverrides: {} };
    for (const { key, field } of sliders) next[key] = clampMs(field.value);
    for (const row of rows()) {
      next.mapAgentOverrides[row.querySelector(".rep-rule-map").value] =
        row.querySelector(".rep-rule-agent").value;
    }

    saveBtn.disabled = true;
    note.textContent = "Saving…";

    /* A beat of latency, so the state reads the way it does against the real
       PATCH /api/options rather than snapping. */
    await new Promise((resolve) => setTimeout(resolve, 320));

    Object.assign(config, next);
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(next));
    } catch {
      /* Private mode or a full quota: the settings still apply this session. */
    }

    onSave?.(config);
    note.textContent = "Saved";
    saveBtn.disabled = false;
    setTimeout(() => close(), 420);
  });

  /* Also let the tooltips work, since the app has them here. */
  let tip = null;
  const hideTip = () => {
    tip?.remove();
    tip = null;
  };

  for (const trigger of modal.querySelectorAll("[data-tip]")) {
    const show = () => {
      hideTip();
      tip = document.createElement("div");
      tip.className = "rep-tooltip";
      tip.textContent = trigger.dataset.tip;
      document.body.append(tip);

      const anchor = trigger.getBoundingClientRect();
      const box = tip.getBoundingClientRect();
      /* Clamp into the viewport so it never hangs off a narrow screen. */
      tip.style.left = `${Math.min(Math.max(8, anchor.left), innerWidth - box.width - 8)}px`;
      tip.style.top = `${Math.max(8, anchor.top - box.height - 8)}px`;
    };

    trigger.addEventListener("pointerenter", show);
    trigger.addEventListener("focus", show);
    trigger.addEventListener("pointerleave", hideTip);
    trigger.addEventListener("blur", hideTip);
    trigger.addEventListener("click", (event) => event.preventDefault());
  }

  modal.addEventListener("scroll", hideTip, true);
}

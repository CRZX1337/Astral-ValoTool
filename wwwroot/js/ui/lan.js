/**
 * The "Open on phone" panel: the LAN companion's control surface.
 *
 * Deliberately self-contained -- it talks to its own three endpoints and has
 * no store involvement, because nothing the desktop views render depends on
 * it. The home card's status line is the one thing it touches beyond the
 * modal, and that only while the panel is open.
 */

import { withToken } from "../api.js";

export function mountLan() {
  const card = document.getElementById("lanCard");
  const modal = document.getElementById("lanModal");
  const loading = document.getElementById("lanLoading");
  const enableGroup = document.getElementById("lanEnableGroup");
  const enabled = document.getElementById("lanEnabled");
  const stateLine = document.getElementById("lanState");
  const pairGroup = document.getElementById("lanPairGroup");
  const qr = document.getElementById("lanQr");
  const url = document.getElementById("lanUrl");
  const firewallGroup = document.getElementById("lanFirewallGroup");
  const firewallNote = document.getElementById("lanFirewallNote");
  const firewallButton = document.getElementById("lanFirewall");
  const empty = document.getElementById("lanEmpty");
  const status = document.getElementById("statusLan");

  let inFlight = false;

  card.addEventListener("click", () => {
    modal.hidden = false;
    void refresh();
  });

  for (const closer of document.querySelectorAll("[data-close-lan]")) {
    closer.addEventListener("click", () => {
      modal.hidden = true;
    });
  }

  // The shell's own Escape handler checks this modal before deciding to go
  // home, so the two never fight.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.hidden) {
      modal.hidden = true;
    }
  });

  enabled.addEventListener("change", () => {
    void post("/api/lan/enable", { enabled: enabled.checked });
  });

  firewallButton.addEventListener("click", () => {
    void post("/api/lan/firewall", { add: true });
  });

  async function refresh() {
    if (inFlight) {
      return;
    }

    inFlight = true;

    try {
      const lan = await api("/api/lan/status");
      render(lan);
    } finally {
      inFlight = false;
    }
  }

  async function post(path, body) {
    if (inFlight) {
      return;
    }

    inFlight = true;

    try {
      const lan = await api(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      render(lan);
    } finally {
      inFlight = false;
    }
  }

  function render(lan) {
    if (!lan || lan.error) {
      loading.hidden = false;
      loading.textContent = lan?.error ?? "Could not read the phone panel.";
      enableGroup.hidden = true;
      stateLine.hidden = true;
      pairGroup.hidden = true;
      firewallGroup.hidden = true;
      empty.hidden = true;
      return;
    }

    loading.hidden = true;
    enableGroup.hidden = false;
    enabled.checked = Boolean(lan.enabled);

    stateLine.hidden = false;
    stateLine.textContent = lan.enabled
      ? "Phones on this network can open the page below. The link works until Astral closes."
      : "Off. Phones and other devices get a 403 until you switch this on.";

    const pairVisible = lan.enabled && lan.urls.length > 0;
    pairGroup.hidden = !pairVisible;

    if (pairVisible) {
      url.value = lan.urls[0];
      paintQr(qr, lan.urls[0]);
    }

    empty.hidden = !lan.enabled || lan.urls.length > 0;

    // The firewall story only matters while the door is open.
    firewallGroup.hidden = !lan.enabled;

    if (lan.enabled) {
      if (lan.firewallRuleExists) {
        firewallNote.textContent =
          "Windows Firewall already allows Astral on private networks. Public networks stay blocked.";
        firewallButton.hidden = true;
      } else if (!lan.firewallPrivateProfileOn) {
        firewallNote.textContent =
          "Windows Firewall is off on private networks here — nothing is blocking the phone, and no rule is needed.";
        firewallButton.hidden = true;
      } else {
        firewallNote.textContent =
          "Windows Firewall may block the phone on first connect. A rule for private networks removes the guesswork.";
        firewallButton.hidden = false;
      }
    }

    status.dataset.live = lan.enabled ? "on" : "off";
    status.lastElementChild.textContent = lan.enabled
      ? `Open · ${lan.urls.length} address${lan.urls.length === 1 ? "" : "es"}`
      : "Closed";
  }

  // The LAN panel keeps its own state and never subscribes to the store, but
  // the boot loop in main.js treats every mount the same way and calls its
  // return value as a render function -- so hand back a no-op.
  return () => {};
}

function paintQr(container, text) {
  // The vendored renderer (js/vendor/qrcode.js) is a UMD global.
  if (typeof window.qrcode !== "function") {
    container.textContent = "QR unavailable";
    return;
  }

  const qr = window.qrcode(0, "M");
  qr.addData(text);
  qr.make();

  // The generated SVG's path is black by default, which is exactly what a
  // scanner wants to see on the panel's light card -- no re-styling needed.
  container.innerHTML = qr.createSvgTag(4, 6);
}

async function api(path, init) {
  let response;

  try {
    response = await fetch(withToken(path), init);
  } catch {
    return { error: "Cannot reach the local service." };
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    return { error: payload?.error ?? `Request failed (${response.status}).` };
  }

  return payload;
}
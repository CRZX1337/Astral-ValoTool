/* Entry point. Boots each module independently so one failure can't take the
   page down with it -- the site is fully readable with no JS at all. */

import { reduceMotion } from "./env.js";
import { initReveal } from "./reveal.js";
import { initTilt } from "./tilt.js";
import { initCounters } from "./counters.js";
import { initSteps } from "./steps.js";
import { initDemo } from "./demo.js";
import { initLightbox } from "./lightbox.js";
import { initRelease } from "./release.js";
import { initHero3d } from "./hero3d/index.js";

/* Sticky header: a zero-height sentinel at the top of the document. When it
   leaves the viewport we're scrolled, which is cheaper and smoother than
   listening to scroll and reading scrollY. */
function initHeader() {
  const header = document.getElementById("site-header");
  if (!header) return;

  const sentinel = document.createElement("div");
  sentinel.setAttribute("aria-hidden", "true");
  sentinel.style.cssText = "position:absolute;top:0;height:1px;width:1px";
  document.body.prepend(sentinel);

  new IntersectionObserver(
    ([entry]) => header.toggleAttribute("data-scrolled", !entry.isIntersecting),
    { threshold: 0 }
  ).observe(sentinel);

  /* Close the mobile drawer after a jump, otherwise it covers the target. */
  const menu = header.querySelector(".nav-menu");
  menu?.addEventListener("click", (event) => {
    if (event.target.closest("a")) menu.open = false;
  });
}

/* Tab groups. Driven entirely by aria wiring in the markup, so adding a tab
   needs no JS change: role=tablist > [role=tab][aria-controls]. */
function initTabs() {
  for (const list of document.querySelectorAll('[role="tablist"]')) {
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    if (tabs.length < 2) return;

    const select = (tab) => {
      for (const other of tabs) {
        const on = other === tab;
        other.setAttribute("aria-selected", String(on));
        other.setAttribute("aria-pressed", String(on));
        other.tabIndex = on ? 0 : -1;
        document.getElementById(other.getAttribute("aria-controls"))?.toggleAttribute("hidden", !on);
      }
    };

    list.addEventListener("click", (event) => {
      const tab = event.target.closest('[role="tab"]');
      if (tab) select(tab);
    });

    /* Arrow keys are expected on a tablist. */
    list.addEventListener("keydown", (event) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      const index = tabs.indexOf(document.activeElement);
      const next = tabs[(index + step + tabs.length) % tabs.length];
      next.focus();
      select(next);
    });
  }
}

/* Copy buttons on the code blocks. clipboard is absent over file:// and on
   some older browsers, so the button removes itself rather than failing. */
function initCopy() {
  const buttons = document.querySelectorAll("[data-copy]");
  if (!navigator.clipboard) {
    for (const button of buttons) button.remove();
    return;
  }

  for (const button of buttons) {
    button.addEventListener("click", async () => {
      /* Take the visible panel's code, so tabbed blocks copy the right one. */
      const body = button.closest(".code-body");
      const code = body?.querySelector('div:not([hidden]) code, pre code');
      if (!code) return;

      try {
        await navigator.clipboard.writeText(code.textContent.trim());
        button.textContent = "Copied";
      } catch {
        button.textContent = "Press Ctrl+C";
      }
      setTimeout(() => (button.textContent = "Copy"), 1600);
    });
  }
}

/* `/` focuses the demo search, mirroring the app's own hotkey. */
function initHotkey() {
  const input = document.getElementById("demo-search");
  if (!input) return;

  addEventListener("keydown", (event) => {
    if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable) return;
    event.preventDefault();
    input.focus();
    input.scrollIntoView({ block: "center", behavior: reduceMotion.matches ? "auto" : "smooth" });
  });
}

document.documentElement.classList.remove("no-js");

for (const boot of [
  initHeader,
  initTabs,
  initCopy,
  initHotkey,
  initReveal,
  initTilt,
  initCounters,
  initSteps,
  initDemo,
  initLightbox,
  initRelease,
  initHero3d,
]) {
  try {
    boot();
  } catch (error) {
    console.warn(`[astral] ${boot.name} failed`, error);
  }
}

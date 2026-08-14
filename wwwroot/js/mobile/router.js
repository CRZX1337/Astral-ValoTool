/**
 * Hash router for the phone companion: one route, one mounted page.
 *
 *   #/home  #/session  #/matches  #/maps  #/agents  #/instalock  #/more
 *   #/more/autoqueue  #/more/intel   <- nested routes inside the More hub
 *
 * The shell (appbar, status line, bottom nav) is owned by main.js and never
 * unmounts. Only the active feature page lives in #page at any moment: the
 * router unmounts the previous page -- unsubscribe, destroy, DOM removal --
 * before mounting the next one, so hidden pages cannot keep rendering. The
 * store/SSE layer stays alive across page changes; page-specific renders
 * subscribe only while their page is the active one.
 *
 * Pages are supplied as a map of mount functions. A mount returns either a
 * render(state) function or { render, destroy }: destroy runs on unmount for
 * anything that needs explicit cleanup (document-level listeners, watches).
 */

import { getState, subscribe } from "../store.js";

export const PAGES = ["home", "session", "matches", "maps", "agents", "instalock", "more"];

/** Nested routes are only legal inside the More hub. */
const SUB_PAGES = { more: ["autoqueue", "intel"] };

const MARKERS = {
  home: "rankCard",
  session: "sessionHeroCard",
  matches: "matchList",
  maps: "mapCards",
  agents: "agentCards",
  instalock: "ilGrid",
  more: "moreHub"
};

export function routeFromHash() {
  const raw = location.hash.replace(/^#\/?/, "").trim();
  const [page, sub] = raw.split("/");

  if (PAGES.includes(page)) {
    return { page, sub: SUB_PAGES[page]?.includes(sub) ? sub : null };
  }

  return { page: "home", sub: null };
}

/**
 * Navigates by changing the hash. Returns false when the target equals the
 * current hash (the route is already applied); true when a hashchange will
 * follow. Browser history, Back/Forward and deep links all fall out of the
 * hash changing -- there is no separate nav state to keep in sync.
 */
export function navigate(page, sub = null) {
  const target = sub ? `#/${page}/${sub}` : `#/${page}`;

  if (location.hash === target) {
    return false;
  }

  location.hash = target;
  return true;
}

export function createRouter({ host, pages }) {
  let active = null;

  function syncNav(page) {
    for (const button of document.querySelectorAll(".tab-btn")) {
      if (button.dataset.go === page) {
        button.setAttribute("aria-current", "page");
      } else {
        button.removeAttribute("aria-current");
      }
    }
  }

  function dispatchSubpage(name) {
    document.dispatchEvent(new CustomEvent("astral:subpage", { detail: { name } }));
  }

  function setBodyState(route) {
    document.body.dataset.page = route.page;
    document.body.dataset.sub = route.page === "more" ? (route.sub ?? "hub") : "hub";
  }

  function applyRoute(route) {
    // Same page, different nested route: only the More hub routes internally.
    // Leave the old sub-page before entering the next one so its lifecycle
    // events (watch off / refresh) fire exactly like a leave does.
    if (active && route.page === active.type) {
      if (route.page === "more" && route.sub !== active.sub) {
        active.sub = route.sub;
        dispatchSubpage(null);
        dispatchSubpage(route.sub);
      }

      syncNav(route.page);
      setBodyState(route);
      return;
    }

    teardown();

    const template = document.getElementById(`page-${route.page}`);

    if (!template) {
      applyRoute({ page: "home", sub: null });
      return;
    }

    host.replaceChildren(template.content.cloneNode(true));

    const instance = pages[route.page](route.sub ?? null);
    const render = typeof instance === "function" ? instance : instance.render;
    const destroy = typeof instance === "function" ? null : instance.destroy ?? null;

    const unsubscribe = subscribe(render);
    render(getState());

    active = { type: route.page, sub: route.sub, unsubscribe, destroy };

    setBodyState(route);
    syncNav(route.page);

    // Entering More opens its hub or the deep-linked sub-page; the sub-page
    // lifecycle events drive the watch/refresh rules inside more.js.
    if (route.page === "more") {
      dispatchSubpage(route.sub);
    }

    window.scrollTo(0, 0);
  }

  function teardown() {
    if (!active) {
      return;
    }

    active.unsubscribe();
    active.destroy?.();
    active = null;
    host.replaceChildren();
  }

  window.addEventListener("hashchange", () => applyRoute(routeFromHash()));

  return {
    /** Boot: apply whatever route the current hash names. */
    start() {
      applyRoute(routeFromHash());
    },

    /** Force the boot path again (used by the harness to simulate a reload). */
    restart() {
      teardown();
      applyRoute(routeFromHash());
    },

    apply(route) {
      applyRoute(route ?? routeFromHash());
    },

    current() {
      return active ? { page: active.type, sub: active.sub } : null;
    },

    /** Marker element that proves a page is mounted, per page. */
    marker(page) {
      return MARKERS[page];
    }
  };
}
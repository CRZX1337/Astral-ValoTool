/**
 * One shared tooltip for every `[data-tip]` element in the document.
 *
 * Delegated, so rows added later (map override rules) work without wiring, and
 * positioned `fixed` against the trigger's viewport rect -- the settings modal
 * scrolls its body, and a bubble living inside that box would be clipped.
 */

const GAP = 8;

export function mountTooltips() {
  const bubble = document.createElement("div");
  bubble.className = "tooltip";
  bubble.id = "appTooltip";
  bubble.setAttribute("role", "tooltip");
  bubble.hidden = true;
  document.body.append(bubble);

  let anchor = null;

  function show(trigger) {
    const text = trigger.dataset.tip;

    if (!text) {
      return;
    }

    anchor = trigger;
    bubble.textContent = text;
    bubble.hidden = false;
    trigger.setAttribute("aria-describedby", bubble.id);
    place(bubble, trigger);
  }

  function hide() {
    anchor?.removeAttribute("aria-describedby");
    anchor = null;
    bubble.hidden = true;
  }

  document.addEventListener("pointerover", (event) => {
    const trigger = closestTip(event.target);

    if (trigger && trigger !== anchor) {
      show(trigger);
    }
  });

  document.addEventListener("pointerout", (event) => {
    if (closestTip(event.target) === anchor && anchor !== null) {
      hide();
    }
  });

  document.addEventListener("focusin", (event) => {
    const trigger = closestTip(event.target);
    trigger ? show(trigger) : hide();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hide();
    }
  });

  // A fixed position goes stale as soon as anything scrolls, and the modal body
  // is scrollable. Follow the trigger instead of dismissing: hiding on every
  // stray scroll event makes the tooltip feel broken.
  function reposition() {
    if (!anchor) {
      return;
    }

    if (!anchor.isConnected) {
      hide();
      return;
    }

    place(bubble, anchor);
  }

  document.addEventListener("scroll", reposition, true);
  window.addEventListener("resize", reposition);

  return function render() {
    // Nothing to re-render; the tooltip lives outside the store's state.
  };
}

function closestTip(target) {
  return target instanceof Element ? target.closest("[data-tip]") : null;
}

/** Above the trigger when there is room, below it otherwise, clamped on screen. */
function place(bubble, trigger) {
  const rect = trigger.getBoundingClientRect();
  const box = bubble.getBoundingClientRect();

  let top = rect.top - box.height - GAP;

  if (top < GAP) {
    top = rect.bottom + GAP;
  }

  const left = Math.min(
    Math.max(rect.left + rect.width / 2 - box.width / 2, GAP),
    window.innerWidth - box.width - GAP);

  bubble.style.top = `${Math.round(top)}px`;
  bubble.style.left = `${Math.round(left)}px`;
}

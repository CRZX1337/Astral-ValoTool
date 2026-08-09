/**
 * The three caption buttons in the topbar, and the top resize edge.
 *
 * Deliberately small. Dragging the window, double-click to maximise and the
 * system menu are not handled here at all -- those come from `app-region: drag`
 * on .topbar, which WebView2 turns into a real title bar once
 * IsNonClientRegionSupportEnabled is set (see DesktopAppForm.HardenBrowser).
 * Only the three explicit presses need a message, because there is no CSS for
 * "minimise".
 *
 * The left, right and bottom edges are not here either: those are real
 * non-client sizing strips that DWM owns and hit-tests outside the window.
 * The top edge is the one exception -- the caption's pixels were given to the
 * page, so there is no strip left along the top and this module synthesises one.
 *
 * Outside the desktop host -- the loopback port in a browser, or devstub.py --
 * `chrome.webview` does not exist and the controls stay hidden. Three buttons
 * that silently do nothing are worse than no buttons.
 */

/** Kept in step with the strings DesktopAppForm.OnWebMessage switches on. */
const ACTION_PREFIX = "window:";

export function mountWindowControls() {
  const controls = document.getElementById("windowControls");
  const grip = document.getElementById("resizeTop");
  const host = window.chrome?.webview;

  if (!controls || !host) {
    return function render() {};
  }

  controls.hidden = false;

  if (grip) {
    grip.hidden = false;

    // pointerdown, not click: the host answers by starting the shell's own
    // resize loop, which has to take over while the button is still down.
    // preventDefault stops the page from also beginning a text selection --
    // the loop runs modally and the page never sees the matching pointerup.
    grip.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      host.postMessage(ACTION_PREFIX + "resize:top");
    });
  }

  // Delegated: three buttons, and the glyph <svg> inside each one is what the
  // press actually lands on.
  controls.addEventListener("click", (event) => {
    const button = event.target instanceof Element
      ? event.target.closest("[data-window-action]")
      : null;

    if (button) {
      host.postMessage(ACTION_PREFIX + button.dataset.windowAction);
    }
  });

  // The maximise glyph is driven from the host rather than from the click
  // above: Aero Snap, a double-click on the drag region and the system menu all
  // change the state without this module hearing about it.
  host.addEventListener("message", (event) => {
    const message = typeof event.data === "string" ? event.data : "";

    if (message === "window:state:maximized") {
      controls.dataset.state = "maximized";
      document.body.dataset.window = "maximized";
      return;
    }

    if (message === "window:state:normal") {
      delete controls.dataset.state;
      delete document.body.dataset.window;
    }
  });

  return function render() {
    // Purely presentational; nothing in the store drives it.
  };
}

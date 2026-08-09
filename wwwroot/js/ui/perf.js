/**
 * Two signals the stylesheets read off <body>, following the same convention as
 * data-booted and data-settling elsewhere in this folder.
 *
 *   data-idle  -- the window is not the one the user is looking at. css/motion.css
 *                 parks the endless decorations on it. This is the case that
 *                 matters: the app sits next to a running game and keeps asking
 *                 the GPU to re-blur backdrops for an ambient gradient nobody can
 *                 see. Fed from the document's own focus events and, in the
 *                 desktop host, from the form's activation state -- which is the
 *                 more reliable of the two once a game is in front.
 *
 *   data-perf  -- "low" once a frame probe finds the compositor is not keeping
 *                 up. css/glass.css turns the glass into opaque panels. This is
 *                 the machine styles.css already worried about at .hero-badge:
 *                 a WebView2 without GPU acceleration, drawing every captured
 *                 backdrop on the CPU.
 */

/** rAF samples per probe run -- about a second at 60Hz, long enough to outlast
 *  a single slow image decode without waiting around. */
const PROBE_FRAMES = 60;

/** Median frame interval above this is roughly sub-45fps. Median rather than
 *  mean on purpose: the probe overlaps the boot sequence, where the agent fetch
 *  and eight portrait decodes land as outliers that a mean would swallow whole.
 *
 *  Caveat worth knowing: rAF cannot beat the display's refresh rate, so a 30Hz
 *  output reads as slow here. That is a false positive we accept -- it costs the
 *  translucency and nothing else. */
const SLOW_FRAME_MS = 22;

/** How often an interrupted run is allowed to start over before it gives up and
 *  says nothing. Someone alt-tabbing through startup should not be told their
 *  machine is slow. */
const MAX_RESTARTS = 4;

export function mountPerf() {
  const body = document.body;

  let samples = [];
  let lastFrame = 0;
  let restarts = 0;
  let frame = null;

  // Reduced motion means the decorations this would switch off are already off,
  // so there is nothing left for the probe to buy. Starting "settled" is how it
  // opts out: every entry point below checks this first.
  let settled = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /**
   * An unfocused or hidden window has its rAF throttled to a crawl, which would
   * read as a struggling GPU. Whatever was collected is thrown away rather than
   * averaged in, and the run starts over once the window is back.
   */
  function abortProbe() {
    if (frame === null) {
      return;
    }

    cancelAnimationFrame(frame);
    frame = null;
    samples = [];
    lastFrame = 0;
    restarts += 1;
  }

  function startProbe() {
    if (settled || frame !== null || restarts > MAX_RESTARTS) {
      return;
    }

    // Starting while throttled would only produce a run that has to be thrown
    // away, and each of those costs a restart.
    if (document.hidden || !document.hasFocus()) {
      return;
    }

    frame = requestAnimationFrame(step);
  }

  function step(now) {
    frame = null;

    // The first callback has no predecessor to measure against.
    if (lastFrame !== 0) {
      samples.push(now - lastFrame);
    }

    lastFrame = now;

    if (samples.length < PROBE_FRAMES) {
      frame = requestAnimationFrame(step);
      return;
    }

    const sorted = samples.sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];

    settled = true;
    samples = [];

    // One-way. A single bad minute should not flip the whole look back and
    // forth while the user watches.
    if (median > SLOW_FRAME_MS) {
      body.dataset.perf = "low";
    }
  }

  /**
   * Both halves of "not being looked at" collapse into the one flag: minimised
   * or on another virtual desktop raises `hidden`, while a fullscreen game in
   * front of the window only takes the focus.
   *
   * `hostIdle` is the desktop host's own verdict and outranks the document's,
   * for the reason spelled out at the listener below. It stays null in a plain
   * browser, where there is no host to ask and the events are all there is.
   */
  let hostIdle = null;

  function syncIdle() {
    // Hidden is never overruled: a minimised window is idle whatever the form
    // thinks, and the host reports activation, not visibility.
    const idle = document.hidden || (hostIdle ?? !document.hasFocus());

    if (idle) {
      body.dataset.idle = "true";
      abortProbe();
      return;
    }

    delete body.dataset.idle;
    startProbe();
  }

  window.addEventListener("focus", syncIdle);
  window.addEventListener("blur", syncIdle);
  document.addEventListener("visibilitychange", syncIdle);

  // The desktop host's own account of whether it is the active window, from
  // DesktopAppForm.PostFocusState. The events above are the document's view, and
  // it can be wrong in the one case this whole flag exists for: a fullscreen
  // game taking the foreground deactivates the form, but the WebView2 can keep
  // reporting focus, so the decorations would go on painting behind the game.
  // The form always hears about the deactivation, so it is trusted over
  // document.hasFocus() from the first message onwards.
  window.chrome?.webview?.addEventListener("message", (event) => {
    const message = typeof event.data === "string" ? event.data : "";

    if (message === "window:focus:idle" || message === "window:focus:active") {
      hostIdle = message === "window:focus:idle";
      syncIdle();
    }
  });

  // Sets the initial flag and, if the window already has focus, starts the probe.
  syncIdle();

  return function render() {
    // Purely presentational; nothing in the store drives it.
  };
}

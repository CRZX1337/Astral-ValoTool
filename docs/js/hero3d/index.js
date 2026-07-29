/* WebGL2 hero.

   Everything here is optional. If the context is missing, the shader fails to
   compile, or the context is lost mid-session, the canvas is removed and the
   CSS aurora underneath carries the hero on its own. */

import { reduceMotion, smallScreen } from "../env.js";
import { VERT, frag } from "./shaders.js";

const MAX_DPR = 1.75;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`shader compile failed: ${log}`);
  }
  return shader;
}

function build(gl, quality) {
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, frag(quality));
  const program = gl.createProgram();

  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`program link failed: ${log}`);
  }
  return program;
}

export function initHero3d() {
  const canvas = document.getElementById("hero-canvas");
  const visual = document.getElementById("hero-visual");
  const hero = canvas?.closest(".hero");
  if (!canvas || !hero) return;

  /* Tear the canvas out and hand the hero to the CSS aurora, which is painted
     underneath at all times so this always looks deliberate. The logo mark is
     created here rather than in the markup so its 512px asset is only fetched
     when it will actually be seen. */
  const bail = (reason) => {
    canvas.remove();
    if (visual && !visual.hasAttribute("data-fallback")) {
      const logo = document.createElement("img");
      logo.className = "hero-logo-fallback";
      logo.src = "assets/img/logo.png";
      logo.alt = "";
      logo.width = 512;
      logo.height = 512;
      logo.decoding = "async";
      visual.prepend(logo);
      visual.setAttribute("data-fallback", "");
    }
    if (reason) console.info(`[astral] hero shader off: ${reason}`);
  };

  if (reduceMotion.matches) return bail("reduced motion");

  const gl = canvas.getContext("webgl2", {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "low-power",
    /* Without this, some drivers clear between frames unpredictably. */
    preserveDrawingBuffer: false,
  });

  if (!gl) return bail("no webgl2");

  let program;
  try {
    /* Fewer march steps on phones and low-core machines. The shader is a
       template string, so the tier is compiled in rather than branched on. */
    const low = smallScreen.matches || (navigator.hardwareConcurrency ?? 8) <= 4;
    program = build(gl, low ? { steps: 48, inner: 16 } : { steps: 64, inner: 24 });
  } catch (error) {
    return bail(error.message);
  }

  gl.useProgram(program);

  const uRes = gl.getUniformLocation(program, "uRes");
  const uTime = gl.getUniformLocation(program, "uTime");
  const uPointer = gl.getUniformLocation(program, "uPointer");
  const uScroll = gl.getUniformLocation(program, "uScroll");

  const low = smallScreen.matches || (navigator.hardwareConcurrency ?? 8) <= 4;
  const scale = low ? 0.65 : 1;
  const minFrame = low ? 1000 / 30 : 0; // 30 fps cap on the low tier

  /* --- Sizing ---------------------------------------------------------- */

  let width = 0;
  let height = 0;

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, MAX_DPR) * scale;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (w === width && h === height) return;

    width = canvas.width = w;
    height = canvas.height = h;
    gl.viewport(0, 0, w, h);
  }

  let resizeTimer = 0;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 120);
  }).observe(canvas);

  /* --- Input ----------------------------------------------------------- */

  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  let scroll = 0;

  addEventListener(
    "pointermove",
    (event) => {
      /* Normalized to [-1, 1] about the viewport centre. */
      pointer.tx = (event.clientX / innerWidth) * 2 - 1;
      pointer.ty = (event.clientY / innerHeight) * 2 - 1;
    },
    { passive: true }
  );

  const readScroll = () => {
    const box = hero.getBoundingClientRect();
    scroll = Math.min(Math.max(-box.top / Math.max(box.height, 1), 0), 1);
  };
  readScroll();
  addEventListener("scroll", readScroll, { passive: true });

  /* --- Loop ------------------------------------------------------------ */

  let frame = 0;
  let onScreen = true;
  let last = 0;
  const started = performance.now();

  function render(now) {
    frame = requestAnimationFrame(render);

    if (minFrame && now - last < minFrame) return;
    last = now;

    /* Exponential smoothing: the star leans toward the cursor instead of
       snapping to it. */
    pointer.x += (pointer.tx - pointer.x) * 0.045;
    pointer.y += (pointer.ty - pointer.y) * 0.045;

    resize();

    gl.uniform2f(uRes, width, height);
    gl.uniform1f(uTime, (now - started) / 1000);
    gl.uniform2f(uPointer, pointer.x, pointer.y);
    gl.uniform1f(uScroll, scroll);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function play() {
    if (frame || !onScreen || document.hidden) return;
    last = 0;
    frame = requestAnimationFrame(render);
  }

  function pause() {
    cancelAnimationFrame(frame);
    frame = 0;
  }

  /* Never burn a GPU on a hero nobody is looking at. */
  new IntersectionObserver(
    ([entry]) => {
      onScreen = entry.isIntersecting;
      onScreen ? play() : pause();
    },
    { threshold: 0 }
  ).observe(canvas);

  document.addEventListener("visibilitychange", () => {
    document.hidden ? pause() : play();
  });

  /* Driver resets and GPU-process crashes both surface here. */
  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    pause();
    bail("context lost");
  });

  /* Honour a mid-session switch to reduced motion. */
  reduceMotion.addEventListener?.("change", (event) => {
    if (!event.matches) return;
    pause();
    bail("reduced motion");
  });

  resize();
  play();
}

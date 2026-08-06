/**
 * Auto-queue view: the queue picker, the automation toggle, and the
 * guard-rail settings.
 *
 * Settings save on change rather than behind a Save button -- there is no draft
 * to reconcile here, unlike the instalocker's map overrides.
 */

import { queueNow, saveQueueOptions, toggleAutoQueue } from "../store.js";
import { stagger, swapText } from "./motion.js";

export function mountAutoQueue() {
  const startButton = document.getElementById("queueStart");
  const startLabel = document.getElementById("queueStartLabel");
  const stopButton = document.getElementById("queueStop");
  const status = document.getElementById("queueStatus");
  const alert = document.getElementById("queueAlert");
  const picker = document.getElementById("queuePicker");
  const partyState = document.getElementById("partyState");
  const partyQueue = document.getElementById("partyQueue");
  const enterButton = document.getElementById("queueEnter");
  const leaveButton = document.getElementById("queueLeave");
  const autoRequeue = document.getElementById("optAutoRequeue");
  const saveNote = document.getElementById("queueSaveNote");

  const delay = bindNumber("optRequeueDelay", "optRequeueDelayValue", 0, 60000,
    (value) => void saveQueueOptions({ requeueDelayMs: value }));
  const limit = bindNumber("optMaxRequeues", "optMaxRequeuesValue", 1, 20,
    (value) => void saveQueueOptions({ maxConsecutiveRequeues: value }));

  startButton.addEventListener("click", () => void toggleAutoQueue(true));
  stopButton.addEventListener("click", () => void toggleAutoQueue(false));
  enterButton.addEventListener("click", () => void queueNow(true));
  leaveButton.addEventListener("click", () => void queueNow(false));

  autoRequeue.addEventListener("change", () => void saveQueueOptions({ autoRequeue: autoRequeue.checked }));

  const chips = new Map();
  let builtPicker = false;

  // Paints while hidden on purpose -- see the note in tracker.js. The queue
  // chips in particular were being built the moment the view opened, so their
  // stagger played straight after the morph.
  return function render(state) {
    const queue = state.autoqueue;
    const options = state.queueOptions;
    const running = Boolean(queue?.isRunning);

    swapText(status, queue?.status ?? "Idle.");
    alert.hidden = !queue?.error;
    alert.textContent = queue?.error ?? "";

    startButton.disabled = running || state.queuePending;
    startButton.classList.toggle("is-busy", state.queuePending && !running);
    startLabel.textContent = running ? "Running" : "Start";
    stopButton.disabled = !running || state.queuePending;

    enterButton.disabled = state.queuePending;
    leaveButton.disabled = state.queuePending;

    partyState.textContent = `Party: ${queue?.partyState ?? "unknown"}`;
    partyQueue.textContent = queue?.currentQueueId ? `· queue: ${queue.currentQueueId}` : "";

    if (options) {
      if (!builtPicker) {
        builtPicker = true;
        buildPicker(picker, options.queues ?? [], chips);
      }

      for (const [id, chip] of chips) {
        const active = id.toLowerCase() === (options.queueId ?? "").toLowerCase();
        chip.classList.toggle("is-active", active);
        chip.setAttribute("aria-pressed", String(active));

        // Queues the party cannot enter are shown but disabled, which is more
        // informative than hiding them.
        const eligible = queue?.eligibleQueues ?? [];
        chip.disabled = eligible.length > 0 && !eligible.some((name) => name.toLowerCase() === id.toLowerCase());
      }

      if (document.activeElement !== autoRequeue) {
        autoRequeue.checked = Boolean(options.autoRequeue);
      }

      delay.sync(options.requeueDelayMs);
      limit.sync(options.maxConsecutiveRequeues);
    }

    saveNote.textContent = state.queueSaveNote ?? "";
  };
}

function buildPicker(picker, queues, chips) {
  const fragment = document.createDocumentFragment();

  for (const queue of queues) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "queue-chip";
    chip.textContent = queue.name;
    chip.setAttribute("aria-pressed", "false");
    chip.addEventListener("click", () => void saveQueueOptions({ queueId: queue.id }));
    chip.classList.add("is-new");

    chips.set(queue.id, chip);
    fragment.append(chip);
  }

  stagger(fragment.children);
  picker.replaceChildren(fragment);

  // Drop the flag once the wave is over, so a later re-render does not replay it.
  window.setTimeout(() => {
    for (const chip of chips.values()) {
      chip.classList.remove("is-new");
    }
  }, 900);
}

/**
 * Range and number input kept on one value. Same rule as the instalocker's
 * settings: clamp on commit, not on every keystroke, so typing a long number
 * is not fought halfway through.
 */
function bindNumber(rangeId, numberId, min, max, onCommit) {
  const slider = document.getElementById(rangeId);
  const field = document.getElementById(numberId);

  slider.addEventListener("change", () => onCommit(Number(slider.value)));
  slider.addEventListener("input", () => {
    field.value = slider.value;
  });

  field.addEventListener("change", () => {
    const clamped = Math.min(Math.max(Number(field.value) || min, min), max);
    field.value = String(clamped);
    slider.value = String(clamped);
    onCommit(clamped);
  });

  return {
    sync(value) {
      const text = String(value ?? min);

      if (document.activeElement !== slider) {
        slider.value = text;
      }

      if (document.activeElement !== field) {
        field.value = text;
      }
    }
  };
}

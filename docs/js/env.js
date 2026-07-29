/* Shared environment queries. Kept in their own module so feature modules
   don't have to import the entry point back (which would be circular). */

export const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
export const finePointer = matchMedia("(hover: hover) and (pointer: fine)");
export const smallScreen = matchMedia("(max-width: 700px)");

/* Honour a preference change without a reload where it's cheap to do so. */
export function onMotionChange(handler) {
  reduceMotion.addEventListener?.("change", handler);
}

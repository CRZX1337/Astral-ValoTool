/* Screenshot lightbox. Native <dialog>, so focus trapping, Escape and the
   backdrop are the platform's problem rather than ours. */

export function initLightbox() {
  const dialog = document.getElementById("lightbox");
  const image = document.getElementById("lightbox-img");
  if (!dialog || !image || typeof dialog.showModal !== "function") return;

  for (const trigger of document.querySelectorAll("[data-lightbox]")) {
    trigger.addEventListener("click", () => {
      const source = trigger.dataset.lightbox;
      const full = trigger.querySelector("img");

      image.src = source;
      /* Reuse the thumbnail's alt text -- it already describes the screenshot. */
      image.alt = full?.alt ?? "";
      dialog.showModal();
    });
  }

  /* Dropping the src releases a decoded 1920px PNG. Driven from both the
     close event and the paths we trigger ourselves, so it does not hinge on
     one event firing. */
  const dismiss = () => {
    dialog.close();
    image.removeAttribute("src");
  };

  dialog.querySelector("[data-close-lightbox]")?.addEventListener("click", dismiss);

  /* Click outside the image closes. The dialog fills the backdrop area, so
     test against the image box rather than relying on event.target. */
  dialog.addEventListener("click", (event) => {
    const box = image.getBoundingClientRect();
    const inside =
      event.clientX >= box.left &&
      event.clientX <= box.right &&
      event.clientY >= box.top &&
      event.clientY <= box.bottom;
    if (!inside) dismiss();
  });

  /* Covers Escape, which closes the dialog without going through dismiss(). */
  dialog.addEventListener("close", () => image.removeAttribute("src"));
}

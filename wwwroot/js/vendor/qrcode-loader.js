/* Loads the vendored qrcode-generator (qrcode.js) into a browser context.
 *
 * The library ships as a CommonJS/AMD UMD whose wrapper only assigns
 * module.exports, which a classic script tag in a browser would never run.
 * This loader evaluates the source inside a CommonJS-shaped scope instead and
 * publishes the factory result as window.qrcode.
 *
 * Classic script, synchronous same-origin read: the file is embedded in the
 * assembly next to this one, so the request is a local read and the QR is
 * guaranteed to exist before any caller draws with it.
 */
(function () {
  try {
    const request = new XMLHttpRequest();
    request.open("GET", "/js/vendor/qrcode.js", false);
    request.send();

    if (request.status !== 200) {
      return;
    }

    const module = { exports: {} };

    // The trailing "; return module.exports;" catches every export shape the
    // UMD can take, not just the CommonJS branch.
    const evaluate = new Function("module", "exports", request.responseText + "; return module.exports;");
    window.qrcode = evaluate(module, module.exports);
  } catch {
    // Leave window.qrcode undefined; callers render their fallback.
  }
})();
// Drives the ribbon in the popped-out preview window's chrome document (see
// PREVIEW_WINDOW_SHELL in editor.js). Loaded via <script src>, not inlined
// into the shell string, because extension pages run under
// script-src 'self' with no 'unsafe-inline' (same constraint as
// PREVIEW_LINK_GUARD_SCRIPT/preview-guard.js) — an inline block here would
// just get silently CSP-blocked.
const ribbon = document.getElementById("cs-preview-ribbon");
const sizeEl = document.getElementById("cs-preview-size");
const frame = document.getElementById("cs-preview-frame");

function updateSize() {
  sizeEl.textContent = frame.clientWidth + " × " + frame.clientHeight;
}
window.addEventListener("resize", updateSize);
updateSize();

// resizeTo() sets the *outer* window size, but device presets need to land
// on an exact *viewport* size (the iframe's content box) — the OS title bar
// and this ribbon both eat into whatever size is requested, so each click
// measures the current chrome/ribbon overhead and adds it back before
// calling resizeTo, landing the iframe on exactly e.g. 375x667.
ribbon.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-w]");
  if (!btn) return;
  const targetW = parseInt(btn.dataset.w, 10);
  const targetH = parseInt(btn.dataset.h, 10);
  const chromeW = window.outerWidth - frame.clientWidth;
  const chromeH = window.outerHeight - frame.clientHeight;
  window.resizeTo(targetW + chromeW, targetH + chromeH);
  setTimeout(updateSize, 50);
});

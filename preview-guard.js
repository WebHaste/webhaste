// Injected into the Live Preview iframe only (see PREVIEW_LINK_GUARD_SCRIPT
// in editor.js) — intercepts real link clicks so the sandboxed preview
// iframe doesn't attempt navigation Chrome would block anyway (other project
// pages only exist in memory, not anywhere the iframe could fetch them from).
// Elements Bootstrap's JS itself drives (data-bs-toggle="dropdown"/"collapse"/
// etc.) are left alone — those call their own preventDefault() and never
// navigate. Checking for that attribute, rather than sniffing href for a
// leading "#", matters because a real (non-toggle) link can also have
// href="#" — e.g. a freshly added dropdown item before its href is edited —
// and that must still be intercepted, not mistaken for a toggle.
document.addEventListener("click", function (e) {
  const a = e.target.closest("a[href]");
  if (!a || a.hasAttribute("data-bs-toggle")) return;
  e.preventDefault();
  window.parent.postMessage({ source: "webhaste-preview", type: "blocked-link", href: a.getAttribute("href") }, "*");
}, true);

// Scroll preservation. renderPreview() reloads this whole document (a fresh
// srcdoc) on every edit, which would otherwise always snap back to the top.
// The parent can't read this frame's scroll position itself (sandboxed with
// no allow-same-origin), so this script reports it up via postMessage, and
// the parent hands the last known position back through this <script> tag's
// own data-scroll-y attribute on the next render — an attribute rather than
// an inline script, since the extension's CSP blocks inline scripts.
//
// Reporting is held off until the restore has fully settled: a freshly
// loaded document fires scroll events at position 0 (or at a clamped
// position, while the page is still too short), and reporting any of those
// would overwrite the very position that's being restored.
(function () {
  const script = document.currentScript;
  const targetY = script ? parseInt(script.getAttribute("data-scroll-y"), 10) || 0 : 0;
  let reporting = false;
  let framePending = false;

  // behavior: "instant" matters — a site CSS framework can set
  // `scroll-behavior: smooth` on :root (Bootstrap 5 does), which turns a
  // plain scrollTo() into a slow animation. Reloading mid-animation, which
  // happens on every keystroke, then drifts the frame a few dozen pixels
  // from the top instead of restoring, and reports those intermediate
  // positions upstream.
  function restore() {
    if (targetY > 0) window.scrollTo({ left: 0, top: targetY, behavior: "instant" });
  }

  // Restore as early as possible to avoid a visible jump from the top, then
  // again once layout has settled — images, fonts and stylesheets can all
  // change the page's height after parsing, and a restore against a page
  // that's still too short would be clamped to its old, smaller maximum.
  restore();
  document.addEventListener("DOMContentLoaded", restore);
  window.addEventListener("load", function () {
    restore();
    // Scroll events from the restores above are dispatched in the next
    // rendering step, before that frame's rAF callbacks — so waiting two
    // frames guarantees they've all fired while `reporting` is still false.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        reporting = true;
      });
    });
  });

  window.addEventListener("scroll", function () {
    if (!reporting || framePending) return;
    framePending = true;
    requestAnimationFrame(function () {
      framePending = false;
      window.parent.postMessage({ source: "webhaste-preview", type: "scroll", y: window.scrollY }, "*");
    });
  });
})();

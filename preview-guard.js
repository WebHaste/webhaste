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

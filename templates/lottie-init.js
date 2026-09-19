/* ---------------------------------------------------------------------
   WebHaste Lottie/JSON animations — glue between the "Lottie Animation"
   block's placeholder markup and lottie-web (scaffolded alongside this
   file as scripts/lottie.min.js, see vendor/lottie/ in the WebHaste
   extension repo).

   Looks for every element carrying data-lottie-src in the page and plays
   the animation at that path into it, replacing the placeholder icon/label
   the editor shows in Visual view and preview. Does nothing if lottie-web
   isn't loaded, or if the page has no such elements, so pages without a
   Lottie block on the current template pay no cost. Add both to your
   template's <head> (or wherever else you load scripts/*.js from) to turn
   the placeholders on:

     <script src="/scripts/lottie.min.js"></script>
     <script src="/scripts/lottie-init.js"></script>

   Nothing about this runs inside the WebHaste editor's own preview — the
   iframe's script-src 'self' CSP blocks any scripts/*.js there, the same
   restriction that blocks a site's own scripts/main.js (see editor.js's
   rewriteScriptsForPreview()) — so the placeholder is what preview shows,
   always. The real animation only appears in a published site, or a
   "Render to Local Folder"/"Packaged" build opened in a normal browser tab.

   Packaged (file://) builds don't use `path` (a normal fetch()/XHR, which
   opening a page straight from disk blocks via CORS regardless of path
   form) — compose-core.js's findLottieSrcs()/buildLottieDataScript()
   embed each page's actual animation JSON inline instead, the same way
   search.js prefers window.CS_SEARCH_INDEX over fetching search-index.json
   when it's present. Keyed by this element's own data-lottie-src value so
   multiple different animations on one page each resolve to the right data.
   --------------------------------------------------------------------- */
(function () {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  function init() {
    if (typeof lottie === "undefined") return;
    var elements = document.querySelectorAll("[data-lottie-src]");
    elements.forEach(function (el) {
      var src = el.getAttribute("data-lottie-src");
      if (!src) return; // block inserted but never wired to a file yet
      el.innerHTML = "";
      var options = {
        container: el,
        renderer: "svg",
        loop: true,
        autoplay: true,
      };
      if (window.CS_LOTTIE_DATA && window.CS_LOTTIE_DATA[src]) {
        options.animationData = window.CS_LOTTIE_DATA[src];
      } else {
        options.path = src;
      }
      lottie.loadAnimation(options);
    });
  }
})();

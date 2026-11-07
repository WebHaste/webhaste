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

   Accessibility: the block's ♿ toolbar button in the editor (alt text) sets
   data-lottie-label="What the animation shows" on the data-lottie-src
   element (also editable in Code view), and the generated <svg> gets
   role="img" + aria-label. Without it the svg is marked aria-hidden
   (decorative).

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
      var anim = lottie.loadAnimation(options);
      // lottie-web's generated <svg> has no accessible name (accessibility
      // checkers flag it). DOMLoaded fires once the svg exists, for both
      // animationData and path loading.
      anim.addEventListener("DOMLoaded", function () {
        labelSvg(el);
      });
    });
  }

  // data-lottie-label="Description" -> role="img" + aria-label (meaningful
  // animation). No label -> treated as decorative: aria-hidden, hidden from
  // assistive tech. The label text is whatever the author puts in that
  // attribute (edit it in Code view).
  function labelSvg(el) {
    var svg = el.querySelector("svg");
    if (!svg) return;
    var label = (el.getAttribute("data-lottie-label") || "").trim();
    if (label) {
      // The editor's placeholder markup carries aria-hidden="true"; it would
      // hide the labelled svg from assistive tech on the live site too.
      el.removeAttribute("aria-hidden");
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", label);
    } else {
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("role", "presentation");
    }
  }
})();

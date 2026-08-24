/* ---------------------------------------------------------------------
   WebHaste site search — vanilla JS on top of Lunr.js (scaffolded
   alongside this file as scripts/lunr.min.js, see vendor/lunr/ in the
   WebHaste extension repo).

   Looks for #cs-search-input / #cs-search-results in the page and wires
   itself up automatically; does nothing if either is missing, so pages
   without a search box on the current template pay no cost. Add both to
   your template wherever you want a search box to appear, e.g.:

     <input type="search" id="cs-search-input" placeholder="Search this site...">
     <div id="cs-search-results"></div>

   /search-index.json is regenerated on every Publish/Render to Local
   Folder pass (see compose-core.js's buildSearchIndex()) — this script
   fetches it lazily, on first focus of the search box, and builds an
   in-memory Lunr index once from the result.
   --------------------------------------------------------------------- */
(function () {
  var MIN_QUERY_LENGTH = 2;
  var MAX_RESULTS = 10;
  var SNIPPET_LENGTH = 160;
  var DEBOUNCE_MS = 150;

  // Deferred so this works regardless of where the template places the
  // <script> tag — WebHaste sites commonly load scripts/*.js from <head>
  // (see the scripts/main.js convention), before the search box markup
  // below it exists in the DOM yet.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  function init() {
    var input = document.getElementById("cs-search-input");
    var results = document.getElementById("cs-search-results");
    if (!input || !results) return;

    var indexPromise = null;
    var pagesByUrl = null;

    function loadIndex() {
      if (indexPromise) return indexPromise;
      indexPromise = fetch("/search-index.json")
        .then(function (res) {
          if (!res.ok) throw new Error("search-index.json: " + res.status);
          return res.json();
        })
        .then(function (pages) {
          pagesByUrl = {};
          pages.forEach(function (page) {
            pagesByUrl[page.url] = page;
          });
          return lunr(function () {
            this.ref("url");
            this.field("title", { boost: 10 });
            this.field("description", { boost: 5 });
            this.field("content");
            pages.forEach(function (page) {
              this.add(page);
            }, this);
          });
        })
        .catch(function (err) {
          console.warn("WebHaste search: couldn't load /search-index.json", err);
          pagesByUrl = {};
          return null;
        });
      return indexPromise;
    }

    // Centers a short excerpt on the first query term found, rather than
    // always showing the start of the page (which is often just nav/intro
    // boilerplate unrelated to what was searched).
    function snippet(text, terms) {
      if (!text) return "";
      var lower = text.toLowerCase();
      var pos = -1;
      for (var i = 0; i < terms.length; i++) {
        pos = lower.indexOf(terms[i]);
        if (pos !== -1) break;
      }
      if (pos === -1) pos = 0;
      var start = Math.max(0, pos - SNIPPET_LENGTH / 2);
      var end = Math.min(text.length, start + SNIPPET_LENGTH);
      var out = text.slice(start, end).trim();
      if (start > 0) out = "…" + out;
      if (end < text.length) out += "…";
      return out;
    }

    function render(query, terms, hits) {
      results.innerHTML = "";
      if (!query) return;
      if (!hits.length) {
        var empty = document.createElement("p");
        empty.className = "cs-search-empty";
        empty.textContent = 'No results for "' + query + '".';
        results.appendChild(empty);
        return;
      }
      var list = document.createElement("ul");
      list.className = "cs-search-list";
      hits.slice(0, MAX_RESULTS).forEach(function (hit) {
        var page = pagesByUrl[hit.ref];
        if (!page) return;
        var item = document.createElement("li");
        item.className = "cs-search-item";
        var link = document.createElement("a");
        link.href = page.url;
        link.textContent = page.title || page.url;
        var desc = document.createElement("p");
        desc.textContent = snippet(page.description || page.content, terms);
        item.appendChild(link);
        item.appendChild(desc);
        list.appendChild(item);
      });
      results.appendChild(list);
    }

    var debounceTimer = null;
    function onInput() {
      var query = input.value.trim();
      clearTimeout(debounceTimer);
      if (query.length < MIN_QUERY_LENGTH) {
        results.innerHTML = "";
        return;
      }
      debounceTimer = setTimeout(function () {
        loadIndex().then(function (idx) {
          if (!idx) return;
          // Strip Lunr's query-syntax characters out of free-typed input.
          var terms = query
            .replace(/[*:^~+-]/g, " ")
            .toLowerCase()
            .split(/\s+/)
            .filter(Boolean);
          if (!terms.length) {
            results.innerHTML = "";
            return;
          }
          var hits;
          try {
            // Built as a structured query rather than Lunr's string syntax
            // ("term*") — Lunr's stemmer runs on the literal term text, and
            // a trailing "*" changes that text enough to break stemming
            // (e.g. "hasty*" doesn't stem to the same root as "hasty"
            // does, so it never matches the index's stemmed "hasti"
            // entries). Stemming each term ourselves first, then adding
            // the wildcard as a flag rather than a character, avoids that.
            // presence: REQUIRED makes multi-word queries an AND rather
            // than an OR — otherwise a query like "publish site" matches
            // nearly every page on a small site, since "site" alone is
            // common enough to appear almost everywhere.
            hits = idx.query(function (q) {
              terms.forEach(function (term) {
                var stemmed = lunr.stemmer(new lunr.Token(term)).toString();
                q.term(stemmed, {
                  wildcard: lunr.Query.wildcard.TRAILING,
                  usePipeline: false,
                  presence: lunr.Query.presence.REQUIRED,
                });
              });
            });
          } catch (err) {
            hits = [];
          }
          render(query, terms, hits);
        });
      }, DEBOUNCE_MS);
    }

    input.addEventListener("focus", loadIndex, { once: true });
    input.addEventListener("input", onInput);
  }
})();

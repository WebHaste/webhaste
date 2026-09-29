/* ---------------------------------------------------------------------
   WebHaste Lists — client-side renderer for the "List: Links",
   "List: Directory", and "List: Table" blocks (see this project's
   CLAUDE.md, "Lists" section).

   Looks for every element carrying data-list-src in the page, fetches the
   list's published JSON (regenerated at /lists/<slug>.json on every
   Publish/Render, from .webhaste/lists/<slug>.json), sorts + paginates it
   according to the list's own settings, and renders entries according to
   data-list-view ("links", "directory", or "table"). Does nothing for an
   element whose data-list-src is empty (a block inserted but never wired
   to a list yet via its own toolbar picker) or if the page has no such
   elements at all, so pages without a List block pay no cost.

   "table" is the odd one out structurally: for "links"/"directory", the
   [data-list-src] element is a plain wrapper <div> that gets its whole
   content replaced each redraw. For "table", that element is the <table>
   itself (so its own class="..." attribute — e.g. Bootstrap's "table" or
   Tailwind's "table-auto", written directly in the block's markup — stays
   under the site owner's control same as any other block's classes,
   rather than being something this script would need to inject). Only
   <thead>/<tbody>'s contents are rebuilt; see renderTableView() and
   renderList()'s pagination-host handling below for why that split
   matters (a <table>'s only valid direct children are
   caption/colgroup/thead/tbody/tfoot/tr — never an arbitrary <div>).

   Nothing about this runs inside the WebHaste editor's own preview — same
   script-src 'self' CSP that already blocks scripts/main.js/search.js/
   lottie-init.js there (see editor.js's rewriteScriptsForPreview()) — the
   block's placeholder is what preview always shows. The real list only
   renders on a published site, or a "Render to Local Folder"/"Packaged"
   build opened in a normal browser tab.

   Pagination is deliberately client-side only — no separate URL/page per
   list page (see this project's CLAUDE.md for why: a generated static page
   per page-number is its own SEO footgun for a small site, and sitemap.xml
   already covers whatever real pages link into a list). The current page
   is tracked as a query parameter, keyed by the list's own filename so
   multiple different lists on one page don't collide, via
   history.replaceState — so a specific page is still bookmarkable/
   shareable even though it isn't a separately crawlable file.
   --------------------------------------------------------------------- */
(function () {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  function paramKeyForSrc(src) {
    var name = src.split("/").pop().replace(/\.json$/i, "");
    return "list_" + name.replace(/[^a-z0-9_-]/gi, "") + "_page";
  }

  function pageFromQuery(key) {
    var params = new URLSearchParams(window.location.search);
    var raw = parseInt(params.get(key), 10);
    return raw > 0 ? raw : 1;
  }

  function setPageInQuery(key, page) {
    var params = new URLSearchParams(window.location.search);
    if (page > 1) params.set(key, String(page));
    else params.delete(key);
    var qs = params.toString();
    var url = window.location.pathname + (qs ? "?" + qs : "") + window.location.hash;
    window.history.replaceState(null, "", url);
  }

  // AP-style abbreviations (May/June/July are already short enough to spell
  // out; "Sept." rather than "Sep." is the one AP exception) — matches how
  // a human would hand-type a date on a real site, not a numeric format.
  var MONTH_ABBR = [
    "Jan.", "Feb.", "Mar.", "Apr.", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec.",
  ];

  // Formats a date field's stored "yyyy-mm-dd" value (what the List
  // Manager's <input type="date"> always writes) as "Sept. 28, 2026" for
  // display. Parsed with a regex rather than `new Date(value)` deliberately
  // — the Date constructor treats a bare "yyyy-mm-dd" string as UTC
  // midnight, and reading it back with local getters can roll it back a
  // day in any timezone behind UTC. A value that isn't in this exact shape
  // (hand-edited JSON, or just blank) is returned untouched rather than
  // risking a mangled/"Invalid Date" display.
  function formatDateValue(value) {
    var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return value;
    var year = match[1];
    var month = parseInt(match[2], 10);
    var day = parseInt(match[3], 10);
    if (month < 1 || month > 12) return value;
    return MONTH_ABBR[month - 1] + " " + day + ", " + year;
  }

  // String comparison is enough for both dates (stored as ISO yyyy-mm-dd,
  // which sorts correctly as plain text) and free text (alphabetical) —
  // no date-parsing dependency needed for a field type this simple. Sorting
  // always happens on the raw stored value, never the formatted display
  // string above, so this is unaffected by how a date ends up rendered.
  function sortEntries(entries, sortField, sortOrder) {
    if (!sortField) return entries.slice();
    var sorted = entries.slice().sort(function (a, b) {
      var av = a[sortField] || "";
      var bv = b[sortField] || "";
      if (av < bv) return -1;
      if (av > bv) return 1;
      return 0;
    });
    if (sortOrder === "desc") sorted.reverse();
    return sorted;
  }

  // Renders a non-link field's value as a standalone element. Link fields
  // are handled by each view function directly (the value becomes an
  // <a href>, not a standalone element), so this is never called for one.
  function fieldValueEl(field, value) {
    if (!value) return null;
    if (field.type === "image") {
      var img = document.createElement("img");
      img.src = value;
      img.alt = field.label || "";
      img.className = "cs-list-field cs-list-field--image";
      return img;
    }
    var span = document.createElement("span");
    span.className = "cs-list-field cs-list-field--" + field.type;
    span.textContent = field.type === "date" ? formatDateValue(value) : value;
    return span;
  }

  // "List: Links" — one <li><a></a></li> per entry. The entry's first
  // link-type field supplies the href; every other non-image field's
  // value becomes the anchor's visible text (joined, since a link list
  // commonly wants more than a bare title next to it, e.g. a date), and an
  // image field, if present, becomes a small leading thumbnail inside the
  // same anchor.
  function renderLinksView(container, fields, entries) {
    var list = document.createElement("ul");
    list.className = "cs-list cs-list--links";
    var linkField = fields.filter(function (f) {
      return f.type === "link";
    })[0];
    entries.forEach(function (entry) {
      var li = document.createElement("li");
      li.className = "cs-list-item";
      var a = document.createElement("a");
      a.href = (linkField && entry[linkField.key]) || "#";
      fields.forEach(function (field) {
        if (field.type === "link") return;
        var el = fieldValueEl(field, entry[field.key]);
        if (el) a.appendChild(el);
      });
      if (!a.childNodes.length) a.textContent = a.href;
      li.appendChild(a);
      list.appendChild(li);
    });
    container.appendChild(list);
  }

  // "List: Directory" — one card per entry, every field rendered in
  // schema order: image fields as a real <img>, link fields as a real
  // <a href> (labeled with the field's own label, e.g. "Website", rather
  // than the raw URL, since a directory card showing a bare link is much
  // less readable than one showing what it's a link to), everything else
  // as labeled text.
  function renderDirectoryView(container, fields, entries) {
    var grid = document.createElement("div");
    grid.className = "cs-list cs-list--directory";
    entries.forEach(function (entry) {
      var card = document.createElement("div");
      card.className = "cs-list-item";
      fields.forEach(function (field) {
        var value = entry[field.key];
        if (!value) return;
        if (field.type === "link") {
          var a = document.createElement("a");
          a.href = value;
          a.className = "cs-list-field cs-list-field--link";
          a.textContent = field.label || value;
          card.appendChild(a);
          return;
        }
        if (field.type === "image") {
          var img = fieldValueEl(field, value);
          if (img) card.appendChild(img);
          return;
        }
        var row = document.createElement("div");
        row.className = "cs-list-field cs-list-field--" + field.type;
        var label = document.createElement("span");
        label.className = "cs-list-field__label";
        label.textContent = (field.label || field.key) + ": ";
        row.appendChild(label);
        row.appendChild(document.createTextNode(field.type === "date" ? formatDateValue(value) : value));
        card.appendChild(row);
      });
      grid.appendChild(card);
    });
    container.appendChild(grid);
  }

  // "List: Table" — a real <thead>/<tbody> populated in place inside the
  // <table> element itself (tableEl === the [data-list-src] element for
  // this view — see listBlockMarkup()'s comment in editor.js for why the
  // table's own class attribute, not something this script injects, is
  // what carries the framework's default styling). Only <thead>/<tbody>'s
  // *contents* are rebuilt each redraw — the <table> tag and its class
  // attribute are left completely alone.
  function renderTableView(tableEl, fields, entries) {
    var thead = tableEl.querySelector("thead");
    var tbody = tableEl.querySelector("tbody");
    thead.innerHTML = "";
    tbody.innerHTML = "";

    var headRow = document.createElement("tr");
    fields.forEach(function (field) {
      var th = document.createElement("th");
      th.textContent = field.label || field.key;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);

    entries.forEach(function (entry) {
      var row = document.createElement("tr");
      fields.forEach(function (field) {
        var td = document.createElement("td");
        var value = entry[field.key];
        if (value) {
          if (field.type === "link") {
            var a = document.createElement("a");
            a.href = value;
            a.textContent = field.label || value;
            td.appendChild(a);
          } else {
            var el = fieldValueEl(field, value);
            if (el) td.appendChild(el);
          }
        }
        row.appendChild(td);
      });
      tbody.appendChild(row);
    });
  }

  function renderPagination(container, page, totalPages, onChange) {
    if (totalPages <= 1) return;
    var nav = document.createElement("div");
    nav.className = "cs-list-pagination";
    var prev = document.createElement("button");
    prev.type = "button";
    prev.className = "cs-list-pagination__prev";
    prev.textContent = "Previous";
    prev.disabled = page <= 1;
    prev.addEventListener("click", function () {
      onChange(page - 1);
    });
    var status = document.createElement("span");
    status.className = "cs-list-pagination__status";
    status.textContent = "Page " + page + " of " + totalPages;
    var next = document.createElement("button");
    next.type = "button";
    next.className = "cs-list-pagination__next";
    next.textContent = "Next";
    next.disabled = page >= totalPages;
    next.addEventListener("click", function () {
      onChange(page + 1);
    });
    nav.appendChild(prev);
    nav.appendChild(status);
    nav.appendChild(next);
    container.appendChild(nav);
  }

  function renderList(el, src, data) {
    var view = el.getAttribute("data-list-view") || "links";
    var fields = data.fields || [];
    var sorted = sortEntries(data.entries || [], data.sortField, data.sortOrder);
    var pagination = data.pagination || {};
    var perPage = pagination.enabled ? pagination.perPage || 10 : sorted.length;
    var totalPages = pagination.enabled ? Math.max(1, Math.ceil(sorted.length / perPage)) : 1;
    var key = paramKeyForSrc(src);
    var isTable = view === "table";

    // For "List: Table", el IS the <table> element itself — a <div> (what
    // every other view wraps its pagination controls in) can never be a
    // valid direct child of <table>, so the Previous/Next controls need a
    // real sibling element positioned right after the table instead of
    // living inside it. Created once, up front, then just cleared and
    // repopulated on each redraw — inserting it fresh every time would
    // lose its position once a later sibling existed.
    var paginationHost = null;
    if (isTable) {
      paginationHost = document.createElement("div");
      el.parentNode.insertBefore(paginationHost, el.nextSibling);
    }

    function draw(page) {
      page = Math.min(Math.max(1, page), totalPages);
      var start = (page - 1) * perPage;
      var pageEntries = pagination.enabled ? sorted.slice(start, start + perPage) : sorted;

      if (isTable) {
        renderTableView(el, fields, pageEntries);
        paginationHost.innerHTML = "";
        if (pagination.enabled) {
          renderPagination(paginationHost, page, totalPages, function (newPage) {
            setPageInQuery(key, newPage);
            draw(newPage);
          });
        }
        return;
      }

      el.innerHTML = "";
      var container = document.createElement("div");
      if (view === "directory") {
        renderDirectoryView(container, fields, pageEntries);
      } else {
        renderLinksView(container, fields, pageEntries);
      }
      el.appendChild(container);
      if (pagination.enabled) {
        renderPagination(el, page, totalPages, function (newPage) {
          setPageInQuery(key, newPage);
          draw(newPage);
        });
      }
    }

    draw(pageFromQuery(key));
  }

  function init() {
    var elements = document.querySelectorAll("[data-list-src]");
    elements.forEach(function (el) {
      var src = el.getAttribute("data-list-src");
      if (!src) return; // block inserted but never wired to a list yet
      if (window.CS_LIST_DATA && window.CS_LIST_DATA[src]) {
        renderList(el, src, window.CS_LIST_DATA[src]);
        return;
      }
      fetch(src)
        .then(function (res) {
          if (!res.ok) throw new Error(src + ": " + res.status);
          return res.json();
        })
        .then(function (data) {
          renderList(el, src, data);
        })
        .catch(function (err) {
          console.warn("WebHaste list: couldn't load " + src, err);
        });
    });
  }
})();

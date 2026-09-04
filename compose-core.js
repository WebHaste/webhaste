/* ---------------------------------------------------------------------
   compose-core.js — the published-output half of the composition logic,
   factored out so it's the single source of truth for both:
     1. editor.js in the browser (Publish / Render to Local Folder)
     2. cli/compose.js under plain Node (headless render, for agents/CI
        that can't drive the extension's UI)

   Deliberately excludes anything preview-only (data: URL asset rewriting,
   the sandboxed-iframe link guard) — that's meaningless outside the
   extension's srcdoc iframe, and Node has no equivalent to swap in for it.

   Zero dependencies, no ES module syntax (so a plain <script> tag can load
   it in the browser with no build step) — UMD-lite: attach to
   module.exports under Node, to globalThis.WebhasteCompose in a browser.
   --------------------------------------------------------------------- */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.WebhasteCompose = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  function renderNavBootstrap5(items, name) {
    const li = items
      .map((item) => {
        if (item.children) {
          const dropdownItems = item.children
            .map((c) => `<li><a class="dropdown-item" href="${c.href}">${c.label}</a></li>`)
            .join("");
          return `<li class="nav-item dropdown">
          <a class="nav-link dropdown-toggle" href="#" role="button" data-bs-toggle="dropdown">${item.label}</a>
          <ul class="dropdown-menu dropdown-menu-end">${dropdownItems}</ul>
        </li>`;
        }
        return `<li class="nav-item"><a class="nav-link" href="${item.href}">${item.label}</a></li>`;
      })
      .join("");
    return `<ul class="navbar-nav cs-menu cs-menu-${name}">${li}</ul>`;
  }

  function renderNavTailwind(items, name) {
    const li = items
      .map((item) => {
        if (item.children) {
          const dropdownItems = item.children
            .map((c) => `<a href="${c.href}" class="block px-4 py-2 hover:bg-gray-100">${c.label}</a>`)
            .join("");
          return `<div class="relative group inline-block">
          <button class="px-3 py-2">${item.label}</button>
          <div class="hidden group-hover:block absolute bg-white shadow-md min-w-[160px]">${dropdownItems}</div>
        </div>`;
        }
        return `<a href="${item.href}" class="px-3 py-2 inline-block">${item.label}</a>`;
      })
      .join("");
    return `<div class="flex items-center cs-menu cs-menu-${name}">${li}</div>`;
  }

  function renderNavPlain(items, name) {
    const li = items
      .map((item) => {
        if (item.children) {
          const sub = item.children.map((c) => `<li><a href="${c.href}">${c.label}</a></li>`).join("");
          return `<li>${item.label}<ul>${sub}</ul></li>`;
        }
        return `<li><a href="${item.href}">${item.label}</a></li>`;
      })
      .join("");
    return `<ul class="cs-menu cs-menu-${name}">${li}</ul>`;
  }

  // Footer-style menu, laid out as N side-by-side columns instead of a
  // horizontal navbar: each top-level item becomes a column heading, with
  // its children (if any) as the column's link list. A top-level item with
  // no children falls back to being its own single-link column, so a mixed
  // menu never silently drops an item.
  function columnLinks(item) {
    return item.children && item.children.length ? item.children : [item];
  }

  function renderColumnsBootstrap5(items, name) {
    // Bootstrap's grid is 12 columns wide; divide evenly among the
    // top-level items (floor, min 1) rather than requiring 12 % n === 0.
    const width = Math.max(1, Math.floor(12 / items.length));
    const cols = items
      .map((item) => {
        const li = columnLinks(item)
          .map((c) => `<li><a href="${c.href}">${c.label}</a></li>`)
          .join("");
        return `<div class="col-md-${width}"><h6>${item.label}</h6><ul>${li}</ul></div>`;
      })
      .join("");
    return `<div class="cs-menu cs-menu-${name} row">${cols}</div>`;
  }

  function renderColumnsTailwind(items, name) {
    const n = Math.max(1, Math.min(12, items.length));
    const cols = items
      .map((item) => {
        const links = columnLinks(item)
          .map((c) => `<a href="${c.href}" class="block py-1">${c.label}</a>`)
          .join("");
        return `<div><h6 class="font-semibold mb-2">${item.label}</h6><div class="flex flex-col">${links}</div></div>`;
      })
      .join("");
    return `<div class="cs-menu cs-menu-${name} grid grid-cols-1 md:grid-cols-${n} gap-8">${cols}</div>`;
  }

  function renderColumnsPlain(items, name) {
    const cols = items
      .map((item) => {
        const li = columnLinks(item)
          .map((c) => `<li><a href="${c.href}">${c.label}</a></li>`)
          .join("");
        return `<div style="flex:1"><h6>${item.label}</h6><ul>${li}</ul></div>`;
      })
      .join("");
    return `<div class="cs-menu cs-menu-${name}" style="display:flex;gap:2rem;">${cols}</div>`;
  }

  function renderMenuColumns(items, framework, name) {
    if (framework === "bootstrap5") return renderColumnsBootstrap5(items, name);
    if (framework === "tailwind") return renderColumnsTailwind(items, name);
    return renderColumnsPlain(items, name);
  }

  // layout: "navbar" (default) or "columns" — per-menu setting from
  // nav.json's top-level "layouts" map (see DEFAULT_NAV in editor.js).
  // name: the menu's key in nav.json (e.g. "header", "footer") — stamped
  // onto the output as a "cs-menu-<name>" class (namespaced with "cs-" so
  // it doesn't collide with a generic ".menu" rule in any CSS a site later
  // loads) so each menu can be targeted in site CSS regardless of layout.
  function renderMenu(items, framework, layout, name) {
    if (!items || !items.length) return "";
    if (layout === "columns") return renderMenuColumns(items, framework, name);
    if (framework === "bootstrap5") return renderNavBootstrap5(items, name);
    if (framework === "tailwind") return renderNavTailwind(items, name);
    return renderNavPlain(items, name);
  }

  // True for a page whose raw content is already a complete HTML document
  // (starts with a doctype or an <html> tag) rather than a body fragment —
  // e.g. the scaffolded 404.html, which ships as a fully standalone page on
  // purpose (its own <head>/styles, no site nav/header/footer) since
  // Cloudflare Pages/Netlify serve it directly for unmatched paths.
  // Wrapping that in the site template would nest a second <html> document
  // inside the first, so it's passed through untouched instead.
  function isFullDocument(rawContent) {
    return /^\s*(<!DOCTYPE\s+html|<html[\s>])/i.test(rawContent);
  }

  // templateText === null/"" means "No layout (raw HTML)" — rawContent
  // ships as-is, same as composePage()'s isPreview=false, no-template branch.
  function composePage({ templateText, rawContent, title, config, navData, pagesData }) {
    if (!templateText || isFullDocument(rawContent)) return rawContent;

    const framework = config.cssFramework || "bootstrap5";
    const pageMeta = (pagesData && pagesData[title]) || {};
    const pageTitle = pageMeta.title || title;
    const pageLang = pageMeta.language || config.language || "en";

    let out = templateText.replace(/{{NAV:(\w+)}}/g, (_, menuName) =>
      renderMenu(
        navData.menus && navData.menus[menuName],
        framework,
        navData.layouts && navData.layouts[menuName],
        menuName
      )
    );
    out = out
      .replace(/{{CONTENT}}/g, rawContent)
      .replace(/{{TITLE}}/g, pageTitle ? `${pageTitle} | ${config.siteName || ""}` : config.siteName || "Untitled")
      .replace(/{{META_DESCRIPTION}}/g, pageMeta.description || "")
      .replace(/{{SITE_NAME}}/g, config.siteName || "")
      .replace(/{{LANG}}/g, pageLang)
      .replace(/{{YEAR}}/g, String(new Date().getFullYear()));
    // Page Properties' "Hide from search engines" checkbox — a real noindex
    // signal (unlike sitemap/search-index exclusion below, which are just
    // omissions from our own generated files and don't stop a crawler that
    // finds the page another way).
    if (pageMeta.noindex) {
      out = out.replace(/<\/head>/i, '  <meta name="robots" content="noindex" />\n</head>');
    }
    return out;
  }

  // A page counts as a draft when pages.json marks it so — the same
  // per-page metadata store the Page Properties dialog already writes
  // title/description into. Checked here (not just in editor.js) so
  // cli/compose.js filters identically to what Publish/Render would ship.
  function isDraftPage(pageMeta) {
    return !!(pageMeta && pageMeta.status === "draft");
  }

  // Page Properties' "Exclude from sitemap" / "Exclude from search" checkboxes
  // — unlike draft, the page still publishes normally; it's just left out of
  // these two generated discovery files. Independent of each other and of
  // noindex (see composePage() above) since they answer different questions:
  // a page can be fine for Google but noisy in on-site search, or meant only
  // for direct/linked traffic but still findable if a visitor searches for it.
  function isSitemapExcluded(pageMeta) {
    return !!(pageMeta && pageMeta.excludeFromSitemap);
  }

  function isSearchExcluded(pageMeta) {
    return !!(pageMeta && pageMeta.excludeFromSearch);
  }

  // Turns a root-relative path ("/about.html", "/", "/assets/x.jpg") into one
  // relative to a page sitting `depth` folders deep (depth = number of "/" in
  // its own output path). depth 0 → "about.html" unprefixed; depth 2 (e.g.
  // "blog/2024/post.html") → "../../about.html". Used both for rewriting HTML
  // attributes (rewriteRootRelativePaths below) and for relativizing each
  // search-result URL when the index is embedded per page (see
  // buildSearchIndex()'s callers for the packaged deployment target).
  function relativizeRootPath(rootRelativePath, depth) {
    const prefix = "../".repeat(depth);
    const rest = rootRelativePath === "/" ? "index.html" : rootRelativePath.replace(/^\//, "");
    return prefix + rest;
  }

  // Rewrites every href="/..."/src="/..." in composed HTML to a path relative
  // to a page `depth` folders deep — covers nav links (from nav.json), image/
  // file srcs (assetSnippet() in editor.js), and anything an author hand-typed
  // (e.g. a favicon <link> under elements/), since by the time composePage()
  // returns they're all just attribute strings in one HTML blob. Used by the
  // "Packaged" deployment target, which composes a site that has to work when
  // opened straight from disk (file://) rather than served over HTTP, where a
  // leading "/" would resolve against the filesystem root instead of the
  // project folder. Deliberately does NOT touch "//host" (protocol-relative
  // external URLs — the negative lookahead) or paths without a leading slash
  // (already page-relative, left alone). Out of scope: inline CSS url(/...) —
  // nothing WebHaste generates produces that today.
  function rewriteRootRelativePaths(html, depth) {
    return html.replace(/\b(href|src)=(["'])\/(?!\/)([^"']*)\2/gi, (match, attr, quote, rest) => {
      return `${attr}=${quote}${relativizeRootPath("/" + rest, depth)}${quote}`;
    });
  }

  function escapeXml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&apos;",
    }[c]));
  }

  // Builds sitemap.xml from the same page list a publish/render pass ships
  // — pageEntries is [{ path, lastmod }], already gathered by the caller
  // (file mtimes come from browser File objects on one side and fs.stat on
  // the other, so that part can't live in this dependency-free module).
  // Drafts and 404.html (never a page visitors are intentionally routed to)
  // are excluded here so both callers can't drift on the rule. Returns null
  // when no domain is configured — a sitemap of host-less URLs is useless,
  // and callers should skip writing the file entirely rather than publish
  // a broken one.
  function buildSitemap({ pageEntries, pagesData, config }) {
    let domain = ((config && config.domain) || "").trim().replace(/\/+$/, "");
    if (!domain) return null;
    if (!/^https?:\/\//i.test(domain)) domain = `https://${domain}`;
    const data = pagesData || {};
    const urls = pageEntries
      .filter(
        ({ path }) => path.toLowerCase() !== "404.html" && !isDraftPage(data[path]) && !isSitemapExcluded(data[path])
      )
      .map(({ path, lastmod }) => {
        const loc = path === "index.html" ? domain : `${domain}/${path}`;
        return `  <url>\n    <loc>${escapeXml(loc)}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`;
      })
      .join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  }

  // Common named entities beyond the 5 XML ones — real page copy (curly
  // quotes, em dashes, ellipses) uses these constantly, and leaving them
  // un-decoded means literal "&mdash;"/"&rsquo;" text leaking into search
  // results. Not exhaustive (that's what numeric entities are for below),
  // just the ones plain prose actually produces.
  const NAMED_ENTITIES = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    mdash: "—",
    ndash: "–",
    hellip: "…",
    lsquo: "‘",
    rsquo: "’",
    ldquo: "“",
    rdquo: "”",
    copy: "©",
    reg: "®",
    trade: "™",
  };

  function decodeEntities(str) {
    return str.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, ent) => {
      if (ent[0] === "#") {
        const isHex = ent[1] === "x" || ent[1] === "X";
        const code = parseInt(isHex ? ent.slice(2) : ent.slice(1), isHex ? 16 : 10);
        return Number.isNaN(code) ? match : String.fromCodePoint(code);
      }
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, ent) ? NAMED_ENTITIES[ent] : match;
    });
  }

  // Strips a page's raw HTML down to plain text for the search index — regex
  // based rather than DOMParser so it behaves identically in the browser
  // extension and under plain Node (compose-core.js has zero dependencies by
  // design, see header comment). <script>/<style> contents are dropped
  // entirely rather than left as unreadable text.
  function stripHtmlToText(html) {
    return decodeEntities(
      String(html || "")
        .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<[^>]+>/g, " ")
    )
      .replace(/\s+/g, " ")
      .trim();
  }

  // Builds search-index.json from the same page list a publish/render pass
  // ships — pageEntries is [{ path, lastmod, rawContent }], rawContent being
  // each page's *pre-composition* source (not composePage()'s output), so
  // the nav/header/footer chrome a template injects is never duplicated into
  // every page's indexed text. Title/description come from pages.json, the
  // same store Page Properties already writes. Drafts, 404.html, and pages
  // marked "Exclude from search" are left out; returns null when nothing's
  // left to index so callers can skip writing the file, same as buildSitemap.
  function buildSearchIndex({ pageEntries, pagesData }) {
    const data = pagesData || {};
    const entries = pageEntries
      .filter(
        ({ path }) => path.toLowerCase() !== "404.html" && !isDraftPage(data[path]) && !isSearchExcluded(data[path])
      )
      .map(({ path, rawContent }) => {
        const meta = data[path] || {};
        return {
          url: path === "index.html" ? "/" : `/${path}`,
          title: meta.title || "",
          description: meta.description || "",
          content: stripHtmlToText(rawContent),
        };
      });
    if (!entries.length) return null;
    return JSON.stringify(entries);
  }

  return {
    renderMenu,
    composePage,
    isFullDocument,
    isDraftPage,
    isSitemapExcluded,
    isSearchExcluded,
    buildSitemap,
    buildSearchIndex,
    relativizeRootPath,
    rewriteRootRelativePaths,
  };
});

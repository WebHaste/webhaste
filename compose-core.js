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
      .replace(/{{YEAR}}/g, String(new Date().getFullYear()));
    return out;
  }

  // A page counts as a draft when pages.json marks it so — the same
  // per-page metadata store the Page Properties dialog already writes
  // title/description into. Checked here (not just in editor.js) so
  // cli/compose.js filters identically to what Publish/Render would ship.
  function isDraftPage(pageMeta) {
    return !!(pageMeta && pageMeta.status === "draft");
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
    const domain = ((config && config.domain) || "").trim().replace(/\/+$/, "");
    if (!domain) return null;
    const data = pagesData || {};
    const urls = pageEntries
      .filter(({ path }) => path.toLowerCase() !== "404.html" && !isDraftPage(data[path]))
      .map(({ path, lastmod }) => {
        const loc = path === "index.html" ? domain : `${domain}/${path}`;
        return `  <url>\n    <loc>${escapeXml(loc)}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`;
      })
      .join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  }

  return { renderMenu, composePage, isFullDocument, isDraftPage, buildSitemap };
});

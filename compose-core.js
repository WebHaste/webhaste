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
   module.exports under Node, to globalThis.ChromesiteCompose in a browser.
   --------------------------------------------------------------------- */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.ChromesiteCompose = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  // Same CDN tags as the published site gets — NOT the vendored/local copies
  // FRAMEWORK_ASSETS_PREVIEW in editor.js swaps in for the sandboxed preview
  // iframe, which has no equivalent when rendering outside the extension.
  const FRAMEWORK_ASSETS = {
    bootstrap5:
      '<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/css/bootstrap.min.css" rel="stylesheet">\n' +
      '<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/js/bootstrap.bundle.min.js"></script>',
    tailwind: '<script src="https://cdn.tailwindcss.com"></script>',
    none: "",
  };

  function renderNavBootstrap5(items) {
    const li = items
      .map((item) => {
        if (item.children) {
          const dropdownItems = item.children
            .map((c) => `<li><a class="dropdown-item" href="${c.href}">${c.label}</a></li>`)
            .join("");
          return `<li class="nav-item dropdown">
          <a class="nav-link dropdown-toggle" href="#" role="button" data-bs-toggle="dropdown">${item.label}</a>
          <ul class="dropdown-menu">${dropdownItems}</ul>
        </li>`;
        }
        return `<li class="nav-item"><a class="nav-link" href="${item.href}">${item.label}</a></li>`;
      })
      .join("");
    return `<ul class="navbar-nav">${li}</ul>`;
  }

  function renderNavTailwind(items) {
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
    return `<div class="flex items-center">${li}</div>`;
  }

  function renderNavPlain(items) {
    const li = items
      .map((item) => {
        if (item.children) {
          const sub = item.children.map((c) => `<li><a href="${c.href}">${c.label}</a></li>`).join("");
          return `<li>${item.label}<ul>${sub}</ul></li>`;
        }
        return `<li><a href="${item.href}">${item.label}</a></li>`;
      })
      .join("");
    return `<ul>${li}</ul>`;
  }

  function renderMenu(items, framework) {
    if (!items) return "";
    if (framework === "bootstrap5") return renderNavBootstrap5(items);
    if (framework === "tailwind") return renderNavTailwind(items);
    return renderNavPlain(items);
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
      renderMenu(navData.menus && navData.menus[menuName], framework)
    );
    out = out
      .replace(/{{FRAMEWORK_ASSETS}}/g, FRAMEWORK_ASSETS[framework] || "")
      .replace(/{{CONTENT}}/g, rawContent)
      .replace(/{{TITLE}}/g, pageTitle ? `${pageTitle} | ${config.siteName || ""}` : config.siteName || "Untitled")
      .replace(/{{META_DESCRIPTION}}/g, pageMeta.description || "")
      .replace(/{{SITE_NAME}}/g, config.siteName || "")
      .replace(/{{YEAR}}/g, String(new Date().getFullYear()));
    return out;
  }

  return { FRAMEWORK_ASSETS, renderMenu, composePage, isFullDocument };
});

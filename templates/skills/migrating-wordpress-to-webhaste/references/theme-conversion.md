# Theme → WebHaste template

Goal: one layout template (plus secondary ones where a section genuinely
needs a different shell) that reproduces the source site's header, footer,
and page chrome, with page content replaced by `{{CONTENT}}`.

## 1. Find the real page shell

In a static export, open two or three different page types (home, an inner
page, a blog post) and compare. What's identical across them is the
template; what differs is content. Ignore WordPress-injected noise: admin
bar, `wp-emoji` scripts, `<link rel="alternate">` feeds, `xmlrpc`/`wlwmanifest`
links, generator meta tags, and plugin scripts for features you're not
migrating.

## 2. Build `.webhaste/templates/<name>.html`

A full HTML document using WebHaste placeholders:

| Replace | With |
| --- | --- |
| `<html lang="...">` value | `{{LANG}}` |
| `<title>` | `{{TITLE}}` |
| meta description | `<meta name="description" content="{{META_DESCRIPTION}}" />` |
| site name text | `{{SITE_NAME}}` |
| the post/page body | `{{CONTENT}}` |
| header/footer menus | `{{NAV:header}}`, `{{NAV:footer}}` (any menu name works) |
| copyright year | `{{YEAR}}` |

Check `.webhaste/templates/simple-layout.html` and the project's `CLAUDE.md`
for the current placeholder list before relying on this table. Keep the
scaffolded search and `list.js` script tags if the site will use them, and
add a `#cs-search-input` / `#cs-search-results` pair where the old search
box lived.

Set `activeTemplate` in `.webhaste/site.config.json` to the new file. If
the starter `simple-layout.html` is unused, leave it; it's harmless.

## 3. CSS and JS

- WordPress themes usually ship `style.css` plus enqueued framework/plugin
  CSS. Merge what the design actually needs into `scripts/styles.css` (or
  keep a few files in `scripts/` and `<link>` each) — flat folder only.
- Delete rules that only styled WordPress admin/editor features
  (`.alignleft` etc. are worth *keeping* — migrated content uses them).
- Rewrite `url(...)` paths in copied CSS to the flattened locations. Design
  files go in **`elements/`** (`url(/elements/name.ext)`), never `assets/` —
  see "Where files go" below.
- Fonts: copy font files into `elements/` and fix `@font-face`. Drop legacy
  formats the export doesn't contain (`.eot`, `.svg`, `.ttf` entries whose
  files don't exist) rather than leaving dead `src` URLs. Google Fonts
  `<link>` tags can stay as-is.
- Copy only the JS the design needs (menu toggle, slider). Don't copy
  jQuery-dependent plugin bundles for features you're dropping. Note that
  `scripts/*.js` will not run in the editor's preview, only when published
  or rendered — so check behavior in a composed build, not the editor.
- If the source loads a CSS framework (Bootstrap, etc.), reference it with a
  real `<link>` in the template head. **Check the framework's version before
  setting `cssFramework`:** WebHaste's `bootstrap5` menu markup only matches
  Bootstrap 5, and many themes still ship Bootstrap 3/4. If the version
  doesn't match (or it isn't Bootstrap/Tailwind), use `none` and style the
  menus in CSS (menus render as `<ul>` with `cs-menu cs-menu-<name>`
  classes, plus whatever small script the dropdown/mobile toggle needs).
- Page-builder themes (Elementor, Divi, WPBakery) depend on the builder's own
  CSS and on JS initializers hooked into the builder's runtime. Copy the CSS
  the pages' classes target, and rewrap the initializers (carousels,
  counters, animations) in a small standalone init script so they run
  without the builder. You usually can't run these here — say so in the
  notes.
- Prefer the CSS + webfont form of icon libraries over their JS "kit"
  loaders; JS kits don't run in preview.

## Where files go

| File | Folder |
| --- | --- |
| CSS, JS | `scripts/` |
| Fonts, icon fonts, logo, favicon, CSS backgrounds, decorative shapes/textures used by the template or stylesheets | `elements/` |
| Photos/PDFs/media that belong to a specific page's content | `assets/` |

`assets/` is shown in WebHaste's Assets dialog as the editor's media library,
so design files left there look like content an editor might pick, and they
clutter it. When unsure, ask: if this file were removed, would the *design*
break (→ `elements/`) or would one page lose a picture (→ `assets/`)? A
decorative image embedded in a page's markup that no editor would choose
from a library can still go in `elements/`. Reference them with
`/elements/<name>` in the template, CSS and page markup alike. All three
folders are flat.

## Template text to flag

Demo themes ship placeholder contact details, social links, opening hours,
"Recent posts" lists and a theme-vendor credit in the header/footer. Replace
what you can verify from the source (the site name, copyright line using
`{{YEAR}} {{SITE_NAME}}`, menus) and leave the rest as written, listing every
leftover placeholder in `MIGRATION-NOTES.md` so the owner can fix it.

## 4. Secondary templates

Create an extra template only when a section has a visibly different shell
(a blog layout with a sidebar or byline area, a landing-page layout with no
nav). Assign it per page via `"template"` in `pages.json`. Don't create one
per page type that merely has different *content*; that's what blocks are for.

## 5. Check before moving on

Run `node .webhaste/compose.js --out .agent-preview` after drafting one
sample page, open the composed file, and compare against the source page:
header, footer, fonts, images, and menu should be recognizably the same.
Fix the shell now; every page inherits it. Delete `.agent-preview/` when
finished.

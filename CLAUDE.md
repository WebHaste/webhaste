# WebHaste extension internals

This doc is for anyone — human or agent — hacking on the WebHaste
**extension's own source** in this repo. If you're looking for how to *use*
WebHaste to build a site, see the main [README](README.md) or
chromecms.com instead. If you're an agent working inside a site *built with*
WebHaste (not this repo), that project has its own scaffolded `CLAUDE.md`
at its root — see `templates/CLAUDE.md`, the source that gets copied in.

## How the pieces fit

### 1. Local files — File System Access API
`editor.js` uses `window.showDirectoryPicker()` to get a handle to a real
folder on disk (or a synced Dropbox/Drive folder — the API doesn't care,
it just sees a directory). The handle is persisted in IndexedDB so the
user doesn't have to re-pick the folder every time they open the extension,
though Chrome will still require a one-click "reconnect" after the
permission lapses (this is a browser security requirement, not something
we can skip).

Every keystroke debounces into a direct write back to that file on disk —
so the "local drive as source of truth" model is real: there's no separate
save step, and no server round-trip.

### 2. Project config — `.webhaste/`
Site-wide settings live in a dot-prefixed directory inside the project
folder itself — the same convention as `.vscode/` or `.github/`. It's
created automatically the first time you open a folder:

```
my-site/
  index.html              ← published
  about.html               ← published
  robots.txt                ← published as-is (not composed/templated);
                              scaffolded once, never overwritten — see
                              "Draft pages, sitemap.xml, robots.txt" below
  CLAUDE.md                ← agent-facing guide to this site's conventions —
                              fragment pages, template placeholders, nav/
                              pages.json wiring, block format. Scaffolded once;
                              never overwritten if it already exists.
  assets/                   ← published; images/PDFs inserted into page content
    photo.jpg                 via the Assets dialog (Insert Image)
  scripts/                  ← published; template-level styles.css/main.js —
    styles.css                 not shown in the Assets dialog, since these
    main.js                    aren't content, they're referenced by the
                                template itself (e.g. <link href="scripts/styles.css">)
  .webhaste/              ← committed to git, never published
    site.config.json         ← siteName, domain, paragraphMode, cssFramework, activeTemplate
    nav.json                 ← named menus, supports nested "children" for dropdowns
    compose.js                ← headless Node CLI, self-contained — regenerated
    compose-core.js             every open, see "Headless rendering" below
    block-library.md          ← every block available in the Blocks dialog,
                                 regenerated every open, see "Content blocks" below
    templates/
      simple-layout.html      ← the wrapper template(s)
```

`CLAUDE.md` is scaffolded at the project **root**, not inside `.webhaste/`,
so agent tooling that auto-discovers a root-level `CLAUDE.md`/`AGENTS.md`
picks it up without being told where to look. Its content is copied in from
this repo's own `templates/CLAUDE.md` — same mechanism as the starter
`simple-layout.html`, see `ensureScaffold()` in `editor.js`.

Both `assets/` and `scripts/` are lazy — created on first use, not scaffolded
up front like `.webhaste/`. A template references its own scripts directly
(`<link rel="stylesheet" href="scripts/styles.css">`, `<script src="scripts/main.js">`)
— there's no placeholder/auto-injection for any of a template's `<head>`
content, including a CSS framework; WebHaste doesn't bundle or inject one
(see "Navigation" below for why that changed).

Because these are real files (not `chrome.storage.local`), the whole
project — content, template, menus, and settings — travels with the repo
when cloned to another machine. `chrome.storage.local` mostly just
remembers which folder you last had open; the one piece of real project
data it does hold is deployment credentials (Cloudflare/Netlify account +
token, see "Publishing" below) — deliberately *not* written into
`site.config.json`, since that file is meant to be committed to git. Those
credentials are namespaced per project via `site.config.json` →
`projectId`, a random id `ensureScaffold()` generates and writes back the
first time a project is opened (safe to commit — it's not a secret, just a
key). Without that namespacing, every project shared the same fixed
`chrome.storage.local` keys, so switching between two sites' folders in one
browser profile would silently reuse — and overwrite — whichever site's
credentials were entered most recently.

### 3. Navigation — `nav.json`

**`nav.json` supports multiple named menus with nesting**, e.g.:
```json
{
  "menus": {
    "header": [
      { "label": "Home", "href": "/index.html" },
      { "label": "Shows", "children": [
        { "label": "The Baldknobbers", "href": "/shows/baldknobbers.html" }
      ]}
    ],
    "footer": [ { "label": "Contact", "href": "/contact.html" } ]
  }
}
```
A template references a specific menu with `{{NAV:header}}`, `{{NAV:footer}}`,
etc. — same JSON, multiple placements per page.

**`cssFramework` in `site.config.json`** controls how that nav JSON gets
rendered into markup: `bootstrap5` emits `navbar-nav`/`dropdown-menu`
classes, `tailwind` emits a CSS-only hover dropdown, and `none` emits plain
unstyled `<ul>`/`<li>`. The nav data itself never changes — only the
renderer picked for composing it.

`cssFramework` only picks the nav markup's class names — it does **not**
pull in the framework's CSS/JS itself. WebHaste used to auto-inject CDN
`<link>`/`<script>` tags for the chosen framework via a `{{FRAMEWORK_ASSETS}}`
template placeholder, but Chrome Web Store review rejected that (Manifest V3
forbids remotely-hosted code anywhere in the extension package, even for
strings that only ever end up in someone else's *published* site, never
executed by the extension itself). A template's `<head>` is now expected to
reference whatever CSS framework the site author wants directly — a CDN tag
they type themselves, or a local file under `scripts/` — the same way it
already handles `scripts/styles.css`/`main.js`. Existing sites whose
templates still contain a literal `{{FRAMEWORK_ASSETS}}` placeholder need it
replaced by hand; it's no longer substituted.

`tailwind` gets one deliberate exception to "WebHaste doesn't bundle or
inject a framework": Tailwind's own zero-build CDN option is a `<script
src>` (its runtime class-scanner), and that gets blocked by this
extension's CSP inside the preview iframe (`script-src 'self'` — the same
restriction that blocks a site's own `scripts/main.js` there, see
`rewriteScriptsForPreview()`'s comment) — so a site using it would render
fine once published but show unstyled in preview, with no error to explain
why. `ensureScaffold()` sidesteps this by scaffolding **build tooling**,
not the framework itself, the moment `cssFramework` is `"tailwind"`:
`package.json` (a `tailwindcss`/`@tailwindcss/cli` devDependency plus
`build:css`/`watch:css` scripts) and `tailwind-input.css` at the project
root, plus `scripts/custom.css` for hand-written CSS that isn't run
through Tailwind at all. Source content for these three lives in this
repo's `templates/tailwind/`. The site author still has to run
`npm install` themselves (the extension can't shell out) and still has to
add the `<link href="/scripts/styles.css">` (and, if they want it,
`<link href="/scripts/custom.css">`) to their template's `<head>` by
hand — scaffolding stops at "the files exist and `npm run build:css`
works," same as every other framework choice never touching template
markup. Copied in once and never overwritten, same pattern as
`CLAUDE.md`/`simple-layout.html`; the Site Settings dialog also re-runs
`ensureScaffold()` after saving, so switching an *existing* project's
`cssFramework` to `tailwind` scaffolds these too, not just a brand-new
folder.

Editing `nav.json` right now is a raw-JSON textarea in the "Edit Menus"
dialog — a drag-and-drop nested tree editor (SortableJS-based) is planned
for later, but hand-editing in VS Code works fine in the meantime since
it's a real file.

### 4. Content blocks — `BLOCK_LIBRARY` + `.webhaste/blocks/`

Pre-baked HTML snippets inserted via the Blocks dialog, then hand-edited in
place (headline/copy/images) — Elementor-style, not a live component system.
Two sources feed the same grid:

- **Built-in (`BLOCK_LIBRARY` in `editor.js`)** — Hero, CTA, Testimonial,
  Contact, 3-Column Features, Video Embed (16:9 ratio wrapper), Form Embed
  (no ratio constraint, since form height varies). Each entry keys its markup
  by `cssFramework` (`bootstrap5` only today); a block with no entry for the
  site's active framework shows disabled rather than hidden, so it's still
  discoverable once that variant gets added.
- **Site-specific (`.webhaste/blocks/*.html`)** — one block per HTML file,
  used as-is regardless of framework since it's markup the site author
  already wrote. Opt-in and not scaffolded — the `blocks/` directory doesn't
  exist until someone adds a file to it, same as `assets/`.

Every inserted block gets a `cs-block` wrapper (`cs-block--<type>` class) and
a small move-up/move-down/delete toolbar; iframe-based blocks (the two embed
types) can't have their `src` retargeted from Visual view like text can —
that's a Code view edit.

`writeBlockLibraryDoc()` in `ensureScaffold()` regenerates
`.webhaste/block-library.md` on every folder open: every `BLOCK_LIBRARY`
entry's markup for the site's active `cssFramework`, plus a list of its
custom blocks. It exists specifically so an agent working in a site's own
repo (which has no visibility into this extension's source) can still see
and use the built-in blocks by name, not just write custom ones from
scratch. Pure generated output — never hand-edited, so it's safe to
regenerate unconditionally instead of copy-once like `CLAUDE.md`.

### 5. Images & code view

Images go in through the Assets dialog (uploads into `assets/`) and get
edited in place via an Image Properties dialog — alt text plus
framework-aware presets (width/float/margin/style; Bootstrap and Tailwind
each map presets to their own utility classes). The preview iframe can't
reach the real file bytes behind the File System Access handle, so preview
rewrites `<img>` srcs to `data:` URLs on the fly; published output keeps the
real `assets/`-relative path.

The code view runs on the vendored CodeMirror build (`vendor/codemirror/`)
for syntax highlighting and lint.

### 6. Publishing — three deployment targets

Set under Site Settings → Deployment Target (`site.config.json` →
`deploymentTarget`). The Publish button routes to whichever is active:

- **Cloudflare Pages** — Direct Upload API, as before.
- **Netlify** — uses Netlify's file-digest deploy API: SHA-1 hash every
  composed page, POST the manifest, then PUT only the files Netlify says
  it doesn't already have cached. No zip library needed in the extension.
  Needs a Site ID (Site settings → General) and a Personal Access Token
  (User settings → Applications).
- **Render to local folder** — doesn't upload anywhere. Composes every
  page and writes it into a folder inside the project directory (Site
  Settings → Local Render Folder, `site.config.json` → `deployDirectory`;
  defaults to `dist`), for handing off to any SFTP client, git repo, or
  other deploy method you already use. Good fit if the hosting isn't
  Cloudflare or Netlify at all — e.g. set it to `docs` for GitHub Pages'
  "serve from /docs" option. Note this only writes the folder; it doesn't
  run git itself (no git integration exists in the extension), so pushing
  is still on you.

`publishSite()` reads every `.html` file, runs it through the same
composition step used for preview (so what you see really is what ships),
and POSTs the result as multipart form data to Cloudflare's Direct Upload
endpoint. No git repo, no build step on Cloudflare's end — just files in,
CDN URL out.

The API token is entered once per project via a dialog and stored in
`chrome.storage.local`, under keys namespaced by that project's
`site.config.json` → `projectId` (`projectStorageKey()` in `editor.js`) —
see "Project config" above for why that namespacing exists. It's worth
having users create a **scoped** token (Cloudflare Pages edit permission
only) rather than a full account token, since extension storage isn't as
hardened as an OS keychain. Netlify's Site ID + Personal Access Token are
namespaced and stored the same way.

Both dialogs also have a "Remember these details on this device" checkbox,
checked by default (`cfRemember`/`ntlRemember` in `editor.html`) and reset
to checked every time the dialog opens, so an earlier uncheck never sticks
silently across sessions. `persistCredentials()` is the shared handler for
both dialogs' confirm buttons: checked saves as normal; unchecked *removes*
whatever was previously saved under those same namespaced keys, not just
skips writing new values. That removal is the point — on a shared machine,
someone unchecking it should actually stop the fields from autofilling next
time, including a credential a previous user already saved, not just avoid
adding a new one. There's no real user-management in WebHaste (no accounts,
no roles), so this is a hygiene control for shared devices, not an access
boundary — anyone with the folder open can still see/change any file,
including re-checking the box.

### 7. Headless rendering — `compose-core.js` + `cli/compose.js`

Composition (template/nav/framework-asset substitution) was factored out of
`editor.js` into `compose-core.js` — a dependency-free, UMD-style module
loaded two ways: as a plain `<script>` tag in `editor.html` (browser), and
via `require()` in Node. `composePage()` in `editor.js` delegates its
non-preview path (Publish, Render to Local Folder) to it directly, so a
headless render can never drift from what the extension actually ships.
Preview stays separate — it needs CSP-safe vendored CDN copies and
srcdoc-iframe-specific asset rewriting that a real render doesn't.

`cli/compose.js` is the Node-side consumer: point it at any project folder
and it composes every page + copies `assets/`/`scripts/` into a `dist/`-like
output, matching `renderToLocalFolder()`. The same file is also what
`ensureScaffold()` copies into every project as `.webhaste/compose.js`
(alongside a sibling `.webhaste/compose-core.js`) — it self-detects which
context it's running in (`require("./compose-core.js")` succeeds when
scaffolded next to a sibling copy, falls back to `require("../compose-core.js")`
for the repo's own `cli/` copy) and defaults its target folder accordingly.
The point: a site is composable with just Node, with no dependency on this
extension's source repo being checked out anywhere — see `templates/CLAUDE.md`'s
"Testing your changes" section, which is what actually points agents at it.

### 8. Draft pages, sitemap.xml, robots.txt

**Drafts** are a `status: "draft"` key in `pages.json` (the same per-page
metadata store Page Properties already writes `title`/`description` into),
toggled from a Status select in that dialog — "Active" is the default and
isn't written to the file at all, so existing `pages.json` files need no
migration. `WebhasteCompose.isDraftPage(pageMeta)` in `compose-core.js` is
the single check both `editor.js` and `cli/compose.js` use, so a draft is
excluded identically everywhere: `collectPublishPages()` (the function all
three deploy targets and the sitemap now go through — the old
`getComposedPages()` was renamed since it also collects sitemap `lastmod`
timestamps in the same walk), `cli/compose.js`, and the sitemap below. The
file itself is untouched on disk either way — a draft is a metadata flag,
not a renamed/moved file — and the sidebar shows a "DRAFT" badge
(`refreshFileList()`) so its status isn't hidden info. Live preview of the
currently-open page bypasses this filter entirely (it calls `composePage()`
directly on whatever's open), so editing a draft still previews normally.

**`sitemap.xml`** is generated fresh on every Publish/Render — never
hand-edited, unlike `robots.txt` below — by `WebhasteCompose.buildSitemap()`
from `config.domain` plus the same non-draft page list `collectPublishPages()`
produces (`404.html` is excluded too, since it's never a page visitors are
intentionally routed to). It returns `null` when `domain` is unset, and
callers skip writing the file rather than publish a sitemap of host-less
URLs. `lastmod` comes from each page file's mtime — `File.lastModified` in
the browser, `fs.statSync().mtime` in `cli/compose.js` — which is the one
piece that can't live in the dependency-free shared module, so callers
gather `{ path, lastmod }` entries themselves and pass them in.

**`robots.txt`** is the opposite of `sitemap.xml`: a real root-level file,
scaffolded once by `ensureScaffold()` from `templates/robots.txt` (default
`User-agent: *` / `Allow: /`) and never overwritten after that, same
copy-once pattern as `CLAUDE.md`. Since it's a hand-editable file rather
than generated output, publish just reads it and passes it through
untouched — same treatment as `assets/` — rather than regenerating it. It's
`.txt`, not `.html`, so `walkPages()` never discovers it as a content page
(no sidebar entry, no templating).

### 9. Site search — `search-index.json` + `scripts/search.js`

Every Publish/Render to Local Folder pass also generates `search-index.json`
at the site root via `buildSearchIndex()` in `compose-core.js` — the same
`collectPublishPages()`-gathered page list `buildSitemap()` uses, so the two
files can never drift on which pages are eligible. Each entry is `{ url,
title, description, content }`, with `content` built from a page's *raw
pre-composition* source rather than `composePage()`'s output — deliberately,
so a template's nav/header/footer markup never gets duplicated into every
single page's indexed text. `title`/`description` come from `pages.json`,
the same store Page Properties already writes. `stripHtmlToText()` does the
HTML→text conversion with a regex-based tag stripper and entity decoder
(named + numeric), not `DOMParser` — `compose-core.js` has to behave
identically under plain Node (`cli/compose.js`) and in the browser.

Three independent Page Properties checkboxes, all unchecked by default, all
orthogonal to Draft status — a page with any of them checked still publishes
normally:
- **Exclude from sitemap.xml** (`excludeFromSitemap`) — checked by
  `isSitemapExcluded()` inside `buildSitemap()`.
- **Exclude from site search** (`excludeFromSearch`) — checked by
  `isSearchExcluded()` inside `buildSearchIndex()`.
- **Hide from search engines** (`noindex`) — unlike the two above, which only
  control WebHaste's own generated files (not what a crawler that finds the
  page some other way can still do), this is a real signal:
  `composePage()` injects `<meta name="robots" content="noindex">` before
  `</head>` when set. Deliberately not a `robots.txt` `Disallow` rule instead
  — `robots.txt` is the one hand-authored, copy-once, never-regenerated file
  above, and `Disallow` blocks crawling rather than indexing, which actually
  works against a `noindex` tag Google can't see on a page it's blocked from
  fetching in the first place.

The search *UI* is a separate, opt-in layer on top of the index — WebHaste
generates the data file for every site automatically, but (consistent with
never injecting markup into a template on the author's behalf — see
`{{FRAMEWORK_ASSETS}}` above) doesn't wire up a visible search box itself.
Two files get scaffolded into every project's `scripts/` by
`ensureScaffold()`, same copy-once pattern as `robots.txt`/`CLAUDE.md`:
`scripts/search.js` (from this repo's `templates/search.js` — vanilla JS,
looks for `#cs-search-input`/`#cs-search-results` in the page and no-ops if
either is missing, fetches `search-index.json` lazily on first focus) and
`scripts/lunr.min.js` (from `vendor/lunr/`, an unmodified build of
[Lunr.js](https://lunrjs.com)). Lunr is vendored as a local file rather than
referenced via CDN for the same Manifest V3 no-remotely-hosted-code reason
`vendor/codemirror/` is — see `{{FRAMEWORK_ASSETS}}` above — except the copy
that matters here never executes inside the extension's own runtime at all,
only inside a site visitor's browser on the published page.

`search.js` builds queries with Lunr's structured query API rather than its
string syntax (`"term*"`) — Lunr's stemmer runs on the literal query text
before wildcard expansion, and a wildcard character embedded in that text
breaks stemming (`"hasty*"` doesn't stem to the same root as `"hasty"` does,
so it never matches the index's stemmed `"hasti"` entries). Multi-word
queries use `presence: REQUIRED` (AND, not OR) — for the page counts a
WebHaste site is likely to have, an OR query against common words returns
most of the site.

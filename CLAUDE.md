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
  .claude/
    skills/
      building-webhaste-site/  ← same conventions as CLAUDE.md, reorganized
        SKILL.md                 as a skill (short workflow index + topic-
        references/*.md          scoped reference files). Scaffolded once,
                                  same never-overwritten pattern as CLAUDE.md.
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
`simple-layout.html`, see `ensureScaffold()` in `editor.js`. One difference:
`simple-layout.html`'s own existence check isn't keyed to that exact
filename the way every other copy-once file's is (`CLAUDE.md`, `robots.txt`,
`404.html`, the Tailwind files) — it's "does `templates/` contain *any*
`*.html` file at all." Checking the exact name meant renaming or replacing
the starter with a differently-named template (a `template.html` an author
wrote from scratch, say) caused it to keep reappearing on every subsequent
folder open, forever, since nothing named `simple-layout.html` existed
anymore. Any existing template counts now — the point was always "a fresh
project shouldn't be templateless," never "this specific file must exist."



`.claude/skills/building-webhaste-site/` is scaffolded from
`templates/skills/building-webhaste-site/` in this repo, and for the same
reason `CLAUDE.md` lives at the project root instead of `.webhaste/` — it's
where Claude Code's own skill discovery looks. It exists alongside
`CLAUDE.md` rather than replacing it: `CLAUDE.md` stays the single
self-contained document (useful to any agent, skill-aware or not), while
the skill's `SKILL.md` is a short workflow index fanning out to
topic-scoped `references/*.md` files (pages/templates, nav/pages.json,
blocks, SEO/search, site config/testing) — the same content, reorganized
for a tool that can load just the section it needs. The two are
deliberately not kept byte-identical — a site owner editing one isn't
expected to mirror the change into the other.

**Unlike `CLAUDE.md`, skills are versioned and refreshed, not copy-once**
(`syncSkills()` in `editor.js`). `templates/skills/skills-index.json` (never
name it `manifest.json`: the Chrome Web Store rejects any package with more
than one file of that name, at any depth — `scripts/package-extension.ps1`
now checks for this) lists every shipped skill with a `version` and its file list — **bump a skill's
`version` whenever you change any of its files, or existing projects never
see the change**, and add new skills/files there too (the index file, not a
hardcoded list, drives scaffolding). Each installed skill folder holds a
`.webhaste-skill.json` marker: the installed version plus a SHA-256 of every
file as shipped. When the shipped version is newer, a file whose hash still
matches the marker is unedited and gets overwritten (a file dropped from the
index is deleted if unedited); a file that differs was hand-edited and is
left alone, with a `console.info` noting it. A skill folder with `SKILL.md`
but no marker predates versioning, so its edits can't be told from stale
content — those files are copied to `.webhaste/backups/_skills/<skill>/`
and then replaced. Hashes normalize CRLF to LF so a Windows checkout isn't
mistaken for an edit. When the version matches (the usual case) the cost is
one marker read per skill.

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
token, see "Publishing" below), plus a per-device on/off flag for the
Templates/Styles/Scripts editing tabs (see section 18) — deliberately *not* written into
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

The same CDN-`<script>`-blocked-in-preview problem comes up unprompted for
icon libraries (Bootstrap Icons, Font Awesome) — their default embed
snippet on most sites' own docs is a JS "kit"/SVG-injection loader (e.g.
Font Awesome's `kit.fontawesome.com/....js`), which hits the identical
`script-src 'self'` wall as Tailwind's CDN script. Unlike Tailwind, this
doesn't get build-tooling scaffolding — there's no per-site build step to
hook it into, and the fix is simpler: these libraries also ship a plain
CSS + webfont `<link>` alternative that isn't JS at all, so it isn't
blocked and needs no vendoring. Documented as author-facing guidance
(`templates/CLAUDE.md`, the skill's `site-config-and-testing.md`,
`README.md`) rather than anything scaffolded, since it's just "pick the
other snippet the library already offers."

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
a small move-up/move-down/delete toolbar. Any block whose markup contains an
`<iframe>` — the two built-in embed types, or a custom
`.webhaste/blocks/*.html` block — also gets a 🔗 toolbar button
(`openEmbedDialog()` in `editor.js`) for pasting in the real embed snippet
(or bare URL) from Visual view; it updates that iframe's `src` plus a safe
subset of attributes (`title`, `allow`, `allowfullscreen`, `referrerpolicy`)
in place, leaving the block's own wrapper markup (the 16:9 ratio div, a
form's `min-height`, etc.) untouched. Retargeting an iframe `src` is the only
such in-place edit — swapping which *block* is used, or hand-tuning wrapper
classes/styles, is still a Code view edit.

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

Neither deploy target is checked client-side for file size — a too-large
file only fails at publish time via whatever error Cloudflare/Netlify's API
returns (Cloudflare Pages' real ceiling is 25MB/file; WebHaste's own
Cloudflare batching already stays under its 40MB/batch limit, see
`UPLOAD_BATCH_MAX_BYTES` in `editor.js`, but that's a batch limit, not a
per-file one). Both upload entry points — the toolbar's Image fast-path and
the Assets dialog — warn via `confirm()` above `LARGE_FILE_WARN_BYTES`
(10MB) rather than blocking, since WebHaste has no authority to enforce a
host's actual limit, only to flag it early. For raster images
(png/jpg/jpeg/webp — not gif, since canvas resizing flattens animation to
one frame, and not svg, already vector) there's also an optional resize:
`resizeImageFile()` downscales via `createImageBitmap()` + canvas so the
longer edge is at most `imageResizeMaxDimension` (a `site.config.json` field,
Site Settings' "Image Resize Max Dimension" number input, default 1920 —
per-site rather than a fixed constant, since a photography/gallery-heavy
site and a mostly-text one want different caps), re-encoding at
`IMAGE_RESIZE_QUALITY`. `getImageResizeMaxDimension()` reads it fresh from
config on every resize rather than caching it, same reasoning as every
other `getSiteConfig()` call site in this file — it's a fast local-file
read, not worth staleness risk to save.

`maybeResizeImage(file, mode)` decides whether/how to offer the resize, and
is deliberately keyed off the image's actual decoded pixel dimensions, not
its byte size — an earlier version gated the toolbar fast-path's resize
offer on `file.size >= LARGE_FILE_WARN_BYTES`, which missed a
well-compressed-but-huge-dimension image entirely (a 4500x4500 PNG can
easily be well under 10MB). `mode: true` (Assets dialog, checkbox already
checked — an explicit ahead-of-time opt-in) resizes immediately with no
further prompt whenever `resizeImageFile()` reports the image was actually
oversized (its return value is `===` the input file when nothing needed to
change — cheap way to tell "no-op" from "resized" without a second decode).
`mode: "ask"` (toolbar fast-path, no checkbox to opt in ahead of time)
decodes first and only prompts via `confirm()` if the image turns out to be
oversized, regardless of how small the file already is in bytes. Both modes
then fall through to `warnIfLarge()` for the plain byte-size warning
(`LARGE_FILE_WARN_BYTES`, 10MB) — that one's still legitimately byte-size
gated, since it exists to flag anything a deploy target's API might reject,
not to decide whether resizing would help.

The Assets dialog exposes the resize option as an "assetResizeImages"
checkbox next to its upload input (its label's max-px figure filled in from
config each time the dialog opens), unchecked by default and reset to
unchecked every time the dialog opens (same "never let a one-time state
silently stick" reasoning as `cfRemember`/`ntlRemember` in "Publishing"
below, just defaulting the other direction since resizing re-encodes/loses
quality and shouldn't happen without the author opting in each time).

The code view runs on the vendored CodeMirror build (`vendor/codemirror/`)
for syntax highlighting and lint.

### 6. Publishing — four deployment targets

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
- **Packaged** — same composition as "Render to local folder", but for a
  site that has to work when opened straight from disk (`file://`) instead
  of served over HTTP — e.g. a student handing in a `dist/` folder as
  homework, where the grader shouldn't need to install or run anything.
  `renderToLocalFolder(true)` (the shared function behind both targets)
  runs each composed page through
  `WebhasteCompose.rewriteRootRelativePaths()`, which rewrites every
  `href="/…"`/`src="/…"` to a `../`-relative path based on that page's own
  folder depth — a plain leading `/` resolves against the filesystem root
  under `file://`, not the project folder, which is exactly what breaks
  today's root-relative output (nav hrefs from `nav.json`, asset/image
  paths from `assetSnippet()`, template `<head>` references) the moment
  it's opened without a server. Site search still works fully offline:
  `fetch()` of a local file is blocked by CORS under `file://` regardless
  of path form, so instead of writing `search-index.json` and letting
  `scripts/search.js` fetch it, each page gets its own
  `<script>window.CS_SEARCH_INDEX = [...]</script>` injected right after
  `<head>`, with every result's `url` pre-relativized for that specific
  page (`search.js`'s `loadIndex()` uses this global instead of fetching
  when present). Lottie/JSON animations get the identical treatment for the
  identical reason — see "Lottie/JSON animations" below for
  `window.CS_LOTTIE_DATA`. `sitemap.xml`, `robots.txt`, and `404.html` are
  all omitted for this target — none are meaningful without a real
  domain/server (a 404 page can never be triggered without one routing to
  it). `cli/compose.js --packaged` is the headless equivalent, for testing
  or CI without the extension installed.

  **Every `window.CS_*` inline-script embed (search, Lottie, Lists) must go
  through `WebhasteCompose.jsonForInlineScript()`**, never a bare
  `JSON.stringify()` — `buildSearchDataScript()`/`buildLottieDataScript()`/
  `buildListDataScript()` already do. A literal `</script>` inside any string
  value ends the inline `<script>` early, and the browser then renders the
  rest of the JSON as page text and runs none of it (every packaged page
  looked "borked", nothing worked). It really happens: search-index text
  comes from pages that *document* `<script>` tags, since
  `stripHtmlToText()` decodes `&lt;script&gt;` into a literal one. The helper
  escapes every `<` as `\u003c` (same string once parsed). Found 2026-10-03
  on chromecms.com's packaged build after its docs gained script-tag
  examples.

  **Links the author typed need two fixes under `file://`, not one**
  (`resolvePackagedLink()`, used by `rewriteRootRelativePaths()` and
  `relativizeListData()`): the leading `/` becomes a `../` path, *and* an
  extensionless URL (`/blog/my-post`) gets its `.html` back, because only a
  real server strips the extension — on disk the file is `my-post.html`.
  The extension is added only when that page exists in the build
  (`pagePaths`, passed in by both callers), so other links are left as
  typed. The Link Checker and Redirects both treat extensionless as valid,
  so authors do write it. Lists need this separately because a list's
  `link`/`image` values live in the embedded `window.CS_LIST_DATA` JSON,
  not in HTML attributes, so the attribute rewrite never sees them —
  `relativizeListData()` runs per page (depth differs per page) over every
  `link`/`image` field's values. Found 2026-10-03 when a Lists-built blog
  index's links were all broken in a packaged build; the same extensionless
  problem was also breaking ordinary page links (77 in chromecms.com's
  build). Known leftover: the rewrite is a regex over the composed HTML, so
  an `href="/x"` shown as *text* (e.g. `&lt;a href="/pricing.html"&gt;`
  inside a `<code>` example) gets rewritten too.

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
It skips both the folder it's writing to *and* `site.config.json`'s
`deployDirectory` when walking for pages: with `--out .agent-preview` (what
`templates/CLAUDE.md` tells agents to use), an existing `dist/` otherwise got
walked as source and re-composed into `.agent-preview/dist/` — matching
`editor.js`, whose own walk always skips the configured deploy folder.
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

### 10. Per-page template override

Every page uses `site.config.json` → `activeTemplate` by default, but a page
can override that individually — e.g. posts under `blog/` wrapped in a
`blog-layout.html` that adds a byline/date block the rest of the site
doesn't have — via a `"template"` key in that page's `pages.json` entry (set
from the Page Properties dialog's Template dropdown, populated by
`listTemplateFiles()` — every `*.html` file under `.webhaste/templates/`,
the same set `site.config.json` → `activeTemplate` already picks from). An
omitted key means "inherit the site default," same pattern `status`/
`language` already use in that file.

`compose-core.js`'s `composePage()` needed no changes for this — it already
took `templateText` as a plain parameter rather than reading
`config.activeTemplate` itself, so the only work was in the two callers that
resolve *which* template file to read before calling it:
`composePage()` in `editor.js` (`(pagesData[title] && pagesData[title].template)
|| config.activeTemplate`, checked before the raw-HTML/full-document early
return, since even that depends on knowing whether a template applies) and
`cli/compose.js`'s `main()` (same resolution per page, with a
`Map`-based `loadTemplateText()` cache since many pages typically share one
override). A page whose override points at a template file that's since
been deleted/renamed behaves the same as a stale `activeTemplate` always
has — it throws rather than silently falling back, matching existing
behavior rather than adding new error-handling for a failure mode that was
already possible before this feature.

### 11. Per-page header code

A `"headCode"` string key in a page's `pages.json` entry (Page Properties'
"Header code" textarea) gets inserted verbatim before `</head>` for just
that page — the escape hatch for things a sitewide tracking pixel in the
template can't cover, e.g. a Google Ads/Analytics *conversion* snippet that
only belongs on one specific page. Google Tag Manager remains the better
answer when a site needs several/changing tags (one GTM container snippet
in the template, tags managed in GTM's own UI, no further code edits per
page) — this field exists alongside that for the simpler one-off case, and
for site authors who'd rather not stand up a GTM account at all.

Handled in `compose-core.js`'s `composePage()` right after the existing
`noindex` substitution, same `<\/head>` insertion point, same "omitted key
means nothing gets inserted" pattern as every other optional `pages.json`
field — so both `editor.js`'s Publish/Render-to-Local-Folder path and
`cli/compose.js` pick it up for free with no changes of their own, same as
"per-page template override" above. Unlike `noindex` (a WebHaste-generated
tag built from a checkbox), this is trusted verbatim, so it's *not*
duplicated into the manual preview-composition branch in `editor.js`
(`composePage()`'s `isPreview` path, which already skips `noindex` for the
same reason) — neither has any visible effect inside the preview iframe,
and a `<script src>` in it would be blocked by the same preview CSP
(`script-src 'self'`) that already blocks a site's own `scripts/main.js`
there (see `rewriteScriptsForPreview()`'s comment), so there'd be nothing
real to preview even if it were wired up.

### 12. Automatic Open Graph / Twitter Card tags

`compose-core.js`'s `buildSocialMetaTags()`, called from `composePage()`
right after the `{{...}}` placeholder substitutions, injects `og:title`,
`og:type`, `twitter:card`, `twitter:title` unconditionally, plus
`og:site_name` when `config.siteName` is set, `og:description`/
`twitter:description` when the page has a `pages.json` description, and
`og:url` when `config.domain` is set — each one omitted entirely rather
than emitted with blank `content=""` when its source data is missing, same
rule every other optional `pages.json`-derived field in this file follows.
No per-page opt-in or Page Properties checkbox: unlike `noindex`/header
code above, there's no reason a site author would want this *off*, so it
just always runs.

`og:title` deliberately uses `pageMeta.title || title` alone, not the same
string `{{TITLE}}` renders (`pageTitle | siteName`) — `og:site_name` already
carries the site name separately, and a consuming platform (Slack, Twitter,
Facebook) composes the two itself, so duplicating it into `og:title` too
would show it twice in most unfurl UIs. `og:url` reuses `buildSitemap()`'s
domain-normalization and `index.html` special-case (bare domain, no
`/index.html` suffix) rather than calling into it, since sitemap building
needs a list of pages and this needs one page's own path — small enough
duplication that factoring out a shared helper wasn't worth it. Twitter's
three tags use `name=`, not `property=` — a real spec difference from Open
Graph's RDFa-based `property=`, not a copy-paste slip.

No `og:image`: there's no per-page "this is the social image" concept
today (Assets just inserts images into page content, nothing tags one as
canonical for link previews), so there's nothing to point the tag at.
Adding that would mean a new Page Properties field backed by the Assets
picker — bigger scope than this feature, left for if/when it's actually
needed. Like "per-page header code" above, both `editor.js`'s Publish/
Render-to-Local-Folder path and `cli/compose.js` get this for free with no
changes of their own, and it's *not* duplicated into `editor.js`'s preview
branch — an invisible `<meta>` tag has no observable effect inside the
preview iframe either way.

### 13. Lottie/JSON animations — placeholder-only preview

A "Lottie Animation" entry in `BLOCK_LIBRARY` (`editor.js`) inserts a
`.cs-block--lottie-animation` wrapper around a `data-lottie-src` placeholder
div — same idea as the Video/Misc Embed blocks' iframe, but for a Lottie/
Bodymovin JSON export instead of a URL. `.json` is a third asset kind
alongside images/PDFs (`isLottieAsset()`/`ASSET_LOTTIE_EXTENSIONS`, and
`application/json` added to `ASSET_MIME_TYPES`), uploaded and browsed
through the same Assets dialog.

The player itself is a real JS runtime (`lottie-web`), so it gets vendored
locally at `vendor/lottie/lottie.min.js` — same Manifest V3
no-remotely-hosted-code reasoning as `vendor/lunr/`. `ensureScaffold()`
copies it into every project's `scripts/lottie.min.js`, alongside
`scripts/lottie-init.js` (from `templates/lottie-init.js` — this repo's own
glue script, modeled directly on `templates/search.js`: finds every
`[data-lottie-src]` element on the page and calls `lottie.loadAnimation()`
into it, no-ops if `lottie` isn't loaded or nothing on the page needs it).
Both are scaffolded unconditionally, same as `search.js`/`lunr.min.js` —
nothing runs until the site's template actually adds both `<script>` tags,
same "generate the dependency for every site, don't wire up visible markup
on the author's behalf" pattern search already follows. `templates/
styles.css` also ships a baseline `.cs-lottie-placeholder` look (dashed box,
icon, label) so an unwired or not-yet-loaded block doesn't render as bare
unstyled text on a real site.

**The block never renders a real animation anywhere inside the extension —
Visual view or live Preview.** This isn't a missing feature to eventually
close; it's the same `script-src 'self'` wall that already blocks a site's
own `scripts/main.js` inside the preview iframe (see
`rewriteScriptsForPreview()`'s comment) — a vendored player script hits the
identical restriction a CDN one would, so there's no preview-side
workaround available short of relaxing that CSP itself. The placeholder
(`.cs-lottie-placeholder`, a `data-lottie-src` div plus an icon/label span)
is genuinely the only thing that can show there; the real animation only
appears once published, or in a "Render to Local Folder"/"Packaged" build
opened in a normal browser tab.

**The Packaged deployment target needed a second fix beyond the placeholder**
— `lottie-init.js`'s `path:` option makes lottie-web do a real XHR, and a
`file://` page has a `"null"` origin, so Chrome blocks *that* XHR
unconditionally (not just cross-directory ones — see "Publishing" above for
the identical reasoning behind `window.CS_SEARCH_INDEX`). `compose-core.js`'s
`findLottieSrcs()` scans a page's pre-`rewriteRootRelativePaths()` content for
every `data-lottie-src` value, and `buildLottieDataScript()` turns a
caller-supplied `{ src: parsedAnimationJson }` map into a
`window.CS_LOTTIE_DATA = {...}` `<script>` inserted right after `<head>`,
keyed by each src's *already-relativized* form (`relativizeRootPath()`) so it
matches what `el.getAttribute("data-lottie-src")` will actually read at
runtime. Reading the referenced asset file's bytes is environment-specific
(browser `ArrayBuffer` vs. Node `fs.readFileSync`), so that part stays in
each caller — `editor.js`'s `renderToLocalFolder()` and `cli/compose.js`
both do it, mirroring the `lastmod`-gathering split `buildSitemap()` already
requires. `lottie-init.js` checks `window.CS_LOTTIE_DATA[src]` first and only
falls back to `path` (a real fetch, fine for a served/Cloudflare/Netlify
site, broken under `file://`) when it's absent — a missing/invalid asset
just leaves that one src unembedded rather than failing the whole page's
render.

Because `scripts/lottie-init.js` is scaffolded copy-once (same
never-overwritten rule as `robots.txt`/`CLAUDE.md`), a project opened
*before* this `window.CS_LOTTIE_DATA` support existed has an old copy stuck
in its `scripts/` folder that will keep hitting the CORS bug above forever,
even after this file's own logic is fixed — reopening the project doesn't
help, since `ensureScaffold()` only ever writes a scaffolded file when it's
*missing*, never to update one that's outdated. The only fix for an
already-affected project is replacing that one file by hand with the
current `templates/lottie-init.js`; there's no version check or migration
mechanism for scaffolded scripts today.

Wiring a block to a specific asset happens two ways, both funneling through
the Assets dialog rather than a dedicated third dialog: clicking a `.json`
tile there with no Lottie block selected inserts a brand-new block already
wired to it (`insertBlock("lottie-animation", lottieBlockMarkup(name))`,
mirroring how clicking an image tile inserts a new `<img>`); clicking a
Lottie block's own 🎞️ toolbar button (added in `decorateBlocks()` next to
Embed's 🔗, same `block.querySelector(...)`-gated pattern) instead opens
the same dialog in a picker mode (`lottiePickerTarget`) that filters the
grid to just `.json` files and rewrites that specific block's
`data-lottie-src`/label in place on a tile click, rather than inserting a
second block — the retarget-in-place idea `openEmbedDialog()` already
established for iframes, applied to an attribute instead of an iframe
`src`. `lottiePickerTarget` is read into a local before `assetsDialog
.close()` in the grid's click handler, since `close()` dispatches its
`"close"` event (which resets that module-level flag back to `null`)
synchronously, before the rest of the handler would otherwise run.

### 14. Schema Markup (Organization / LocalBusiness JSON-LD)

Site Settings' "Schema Markup" section writes `site.config.json` →
`schemaMarkup` (`{ type, name, logo, telephone, address, sameAs }`, `address`
itself `{ streetAddress, addressLocality, addressRegion, postalCode,
addressCountry }`), and `compose-core.js`'s `buildSchemaMarkup()` turns that
into a `<script type="application/ld+json">` tag injected right after
`buildSocialMetaTags()`'s OG tags. Deliberately scoped to **just
`index.html`**, checked in `composePage()` itself (`if (title ===
"index.html")`) rather than every page — unlike OG tags, which describe
whatever page is being shared, Organization/LocalBusiness describe the
site/business as a whole, and Google's own guidance is that this markup
belongs on the homepage specifically. A site that wants schema on other
pages (Article, Product, FAQPage, Event, etc.) or more control than these
two generic types offer already has Page Properties' "Header code" field
(section 11 above) for that — this feature intentionally doesn't grow into
a general per-page/per-type schema builder.

`type`/`name` are the only two fields that gate whether anything is emitted
at all (`buildSchemaMarkup()` returns `null` without both, same "omit rather
than emit broken" rule `buildSitemap()` uses for a missing domain) — every
other field (`logo`, `telephone`, the whole `address` object, `sameAs`) is
optional and left out of the JSON-LD individually when blank, same pattern
`buildSocialMetaTags()` already follows for `og:description`/`og:url`.
`url` in the emitted JSON-LD isn't a stored field at all — it's derived from
`config.domain` on every render, reusing the exact domain-normalization
`buildSocialMetaTags()`'s `og:url` and `buildSitemap()` already do (protocol
prepended if missing), so there's one fewer thing to keep in sync when a
site's domain changes. `sameAs` (social profile URLs) is a newline-separated
textarea in the dialog rather than a dynamic add/remove list, same
simple-textarea choice `nav.json`'s raw-JSON editing makes.

Site Settings' Save handler now reads the existing config and spreads it
before overwriting the fields the dialog itself owns
(`{ ...existing, siteName: ..., ... }`) rather than building a fresh object
from only its own inputs like it used to — the old behavior silently
dropped `projectId` (see "Project config" above) on every single Site
Settings save, since `writeJSONFile()` is a full overwrite with no merging
and `projectId` isn't one of this dialog's fields. That's not just a schema-
markup-specific fix: any field not owned by this dialog now survives a
save, `schemaMarkup` included, exactly like a field owned by *this* dialog
would already need to survive a save from the Menus/Page Properties dialogs
(which write different files entirely, so didn't have this problem).

### 15. Redirects — `.webhaste/redirects.json` + `_redirects`

The Redirects dialog (toolbar button, alongside Menus/Site Settings) edits
`.webhaste/redirects.json` — a flat list of `{ from, to, type: 301|302 }`
rules, e.g. for a page that's been renamed or deleted. Unlike `nav.json`'s
tree editor, the schema here has no nesting, so the dialog is a plain
add/remove-row table (`#redirectsRows` in `editor.html`) rather than
another raw-JSON textarea or a SortableJS tree — rows are read straight out
of the DOM on Save (`createRedirectRow()`/the save handler in `editor.js`)
rather than maintained as a separate working-copy object graph, since
there's no drag-reorder or object-identity requirement driving that pattern
for `nav.json`. Save normalizes each field with a different rule, since
"from" and "to" mean different things: `normalizeRedirectFrom()` always
reduces the value to a root-relative path — a bare value gets a leading
`/` added (`contact.html` → `/contact.html`), and a full URL pasted in by
mistake (an easy slip when copying straight from a browser's address bar)
is stripped down to just its `pathname`, since "from" only ever refers to
a path on this site and a rule whose source still had a scheme+host on it
would never match a real incoming request. `normalizeRedirectTo()` adds
the same leading `/` to a bare value but leaves a full `http(s)` URL
untouched, since redirecting off-site to a different domain entirely is a
legitimate destination. Scaffolded once as `{ redirects: [] }`, same
never-overwritten pattern as `nav.json`.

`compose-core.js`'s `buildRedirectsFile()` turns that list into a real
`_redirects` file — deliberately Netlify's own format, since Cloudflare
Pages independently chose to support the exact same file/syntax. That
means **one generated file, written identically, covers both Cloudflare
Pages and Netlify** with no target-specific branching at all — the only
feature in this codebase where two deploy targets share output like that
rather than each needing its own renderer (contrast `cssFramework`'s nav
markup, which picks a different renderer per framework even though the
underlying `nav.json` never changes). Returns `null` when the list is
empty, same "omit rather than emit broken/empty" rule
`buildSitemap()`/`buildSearchIndex()` already follow, so callers skip
writing the file rather than publish an empty one.

**Every entry whose `from` ends in `.html` emits two `_redirects` lines,
not one** — the `.html` path itself, plus its extensionless form
(`/about.html` → also `/about`). This isn't optional/configurable, because
it isn't really a choice: every WebHaste page is authored as a `.html`
file, but Cloudflare Pages and Netlify both strip that extension from a
URL by default (`/about.html` serves at `/about`), so the URL a search
engine actually indexed — and the one a visitor bookmarked — is normally
the extensionless one, not the literal filename a site owner types into
the Redirects dialog. A rule that only covered the `.html` form would miss
the exact request it exists to catch. Found by testing this feature
live against chromecms.com: the `.html` redirect worked immediately after
the Direct Upload fix above, but the bare `/changedpage` URL still 404'd
until this was added. `bare !== r.from` guards against emitting a
duplicate/blank second line for a `from` that was already extensionless.

**Cloudflare's Direct Upload API needs `_redirects` sent as its own
multipart field, not as a regular file in the asset manifest** — the first
version of this feature pushed it into `publishSite()`'s `files` array
exactly like `sitemap.xml`/`robots.txt` just above it, hashed and uploaded
through the same `check-missing`/`upload`/`upsert-hashes` flow as every
other page/asset. That deploys fine and even shows `_redirects` in
Cloudflare's own dashboard file listing — but produces zero actual
redirect behavior, because plain Direct Upload deployments only treat
`_redirects` as routing config when it arrives through a dedicated
`_redirects` field on the `POST .../pages/projects/{project}/deployments`
call (confirmed against Cloudflare's API reference for that endpoint, and
consistent with `wrangler pages deploy` excluding `_redirects`/`_headers`/
`_routes.json` from its own hashed asset manifest for the same reason).
Folded into the manifest, it's just an inert text file at `/_redirects`.
`createPagesDeployment()` now takes an optional `redirectsFile` argument,
appended as `formData.append("_redirects", new Blob([redirectsFile]), ...)`
alongside the existing `manifest` field; `publishSite()` deliberately
excludes `_redirects` from `files` entirely rather than including it there
too, to avoid re-introducing the exact bug this fixes. This split is
Cloudflare-Direct-Upload-specific: **Netlify's manual deploy API has no
such distinction** — `_redirects` is genuinely just a normal file in its
digest/files object, so `publishToNetlify()` keeps treating it that way.
`renderToLocalFolder()`/`cli/compose.js` also just write it as a plain
file on disk either way, which is correct there too — a real file at the
output root is exactly what a git-integrated Cloudflare Pages build (whose
own build pipeline *does* parse `_redirects` from the output directory,
unlike raw Direct Upload) or Netlify expects, and it's simply inert and
harmless for a GitHub Pages `docs/` hand-off or any other static host that
doesn't recognize the filename at all.

**Not written for the Packaged (`file://`) target**, and deliberately not
replaced with a static stub page (e.g. an `oldpage.html` with a meta-refresh)
for that target either — sitemap.xml/robots.txt/404.html are already
skipped there for the same "no real server, nothing to redirect on" reason.
A stub page was considered specifically for the case where a "Render to
Local Folder" output later gets deployed to Cloudflare Pages or Netlify
after all (a real scenario, since that target exists precisely for
hand-off to whatever hosting the author already uses) — but the two
platforms disagree here, and it's worth being precise about which one the
concern actually applies to: Netlify's *unforced* rules let an existing
static file at a path win over a `_redirects` rule for that same path
(needs a trailing `!`/`force: true` to override), so shipping both
`_redirects` and a same-path stub file would silently defeat the real 301
the moment it landed on Netlify. Cloudflare Pages' own docs say the
opposite — "redirects are always followed, regardless of whether or not an
asset matches the incoming request" — so a stub wouldn't actually conflict
there. Since Render to Local Folder can't know which host a given copy
ends up on, and the Netlify failure mode alone is enough to make an
unconditional stub a footgun, the simplest correct choice is still to skip
it entirely rather than special-case per eventual host. A site author who
wants a meta-refresh fallback for some other static host can still add one
by hand via Page Properties' "Header code" field (section 11 above) on
that specific page.

Redirect rules are deliberately **not forced** (no trailing `!`) — if a
page is later recreated at a `from` path, the real file should win over a
stale forgotten redirect rather than the redirect silently and permanently
shadowing it. On Netlify this means an *active* redirect for a path that
still has a real page at it will lose to that page (the unforced-rule
behavior discussed above) — a lesser, self-healing failure mode than the
alternative. Cloudflare Pages has no such escape hatch either way — its
redirects always win over a matching asset regardless of forcing — so this
tradeoff is really a Netlify-specific one.

### 16. Broken link detection — Menu editor validation + Check Links dialog

Both features are built on the same three shared functions in `editor.js`
(placed just above the Menu editor dialog, their first consumer):
`looksInternalHref()` filters out anything that isn't checkable at all —
`http(s):`/`mailto:`/`tel:` links and same-page `#anchor`s are left alone
entirely, since there's nothing this extension can verify about an
off-site URL or an in-page anchor. `getKnownLinkTargets()` walks the project
fresh via the existing `walkPages()` (same call the sidebar already makes)
rather than trusting any cached list — `fileCache` only fills in as pages
are opened, not up front, so it's not a reliable source, and a plain
directory listing is cheap enough to not need caching (same reasoning
`getImageResizeMaxDimension()` uses for `site.config.json`). It also lists
(names only, via the existing `getAssetsDirHandle()`/`getScriptsDirHandle()`/
`getElementsDirHandle()` — not `getProjectAssets()` et al., which read every
file's full bytes into an `ArrayBuffer` and would be wasteful just to check
a name exists) everything under `assets/`/`scripts/`/`elements/`, flat/
one-level same as those folders already are elsewhere in this codebase —
a first version only walked pages, and flagged every link to a PDF/image
under `assets/` (a normal pattern via the Assets dialog) as broken, found
live-testing this against chromecms.com's own checklist-PDF download link.
`isInternalHrefBroken()`
strips a trailing `#fragment`/`?query`, normalizes a leading `/`, and
checks the result against that path set both as typed and with `.html`
appended — the same extensionless-URL leniency the Redirects feature's
`buildRedirectsFile()` needed, and for the identical reason: Cloudflare
Pages/Netlify both serve the extensionless form of every page by default,
so a site owner typing the clean URL shouldn't be flagged as broken just
for that.

**Menu editor validation** (the primary ask — users hand-type every nav
href, with no autocomplete/picker, so a typo or a link left stale after a
page rename is easy to introduce and easy to miss) hooks into
`renderNavItem()`'s existing `.item-href` input: `knownPagePaths` is
snapshotted once when the dialog opens (not re-walked per keystroke), and
`validateHrefInput()` runs both on initial render (so a *pre-existing*
broken link shows red immediately, not just one newly typed) and on every
`input` event. A broken match gets a `.href-broken` class (red border/tint,
matching the same red `.nav-delete-item` already uses for its destructive
button) plus a `title` tooltip — deliberately not a blocking validation,
since a menu item might legitimately be mid-edit or point somewhere not
built yet.

**Check Links** is a separate, manual toolbar button/dialog (not wired into
Publish) that scans the *entire* site in one pass: every page's raw
pre-composition content (via `DOMParser` — `editor.js` is browser-only,
unlike `compose-core.js`, so there's no cross-environment reason to fall
back to `stripHtmlToText()`'s regex approach here) for `<a href>` tags, plus
every menu's items (including dropdown children) from `nav.json` directly.
Scanning *raw* content, not composed output, is deliberate — composed
output would duplicate every nav-rendered link into every single page's
results, drowning real per-page findings in repetition; nav links are
still covered, just once each per menu, via the separate `navData` pass
rather than once per page. Results render via `createElement`/`textContent`
rather than an innerHTML template string, since a link's text or href is
user-authored page content this extension should display, never interpret
as markup. Deliberately scoped to internal links only, matching the
GitHub issue that requested this (#8) — checking external URLs would need
a live network request per link, slower and far less reliable than a
local file-existence check, for a concern (a *third-party* site changing
or breaking) this extension has no way to fix anyway.

### 17. Live preview scroll preservation

`renderPreview()` reassigns the preview iframe's `srcdoc` on every
keystroke, which loads a fresh document that would otherwise always start
at the top of the page. The iframe is sandboxed without `allow-same-origin`
(its content is user-authored HTML), so the parent can't read or set its
scroll position directly — `preview-guard.js`, already injected into every
preview for link-blocking, handles it from inside instead:

- It reports `window.scrollY` up via `postMessage` (`type: "scroll"`,
  rAF-throttled). The parent's existing `message` listener stores it in
  `previewScrollY`, keyed `main`/`popout` via `previewFrameKey()` (same
  `e.source` check the blocked-link notices already used), since the main
  pane and the popped-out preview window scroll independently.
- On the next render, the parent hands the position back through a
  `data-scroll-y` attribute on the guard `<script>` tag — an attribute,
  not an inline script, since extension pages' CSP blocks inline scripts.
  `composePage()` builds one composed string for both frames, so
  `PREVIEW_LINK_GUARD_SCRIPT` carries a placeholder that `withPreviewScroll()`
  fills in per frame (last occurrence only, so page content containing the
  same text can't be mistaken for it).
- The position resets to 0 when a *different* page is opened
  (`openFile()`), when the project closes, and when a new popped-out
  window opens — reopening the same file keeps it.

Two details that aren't obvious and each caused a real bug the first time
through: restoring uses `scrollTo({ behavior: "instant" })`, because a site
framework's `scroll-behavior: smooth` on `:root` (Bootstrap 5 sets this)
turns a plain `scrollTo()` into a slow animation, and a reload mid-animation
on the next keystroke drifted the frame ~50px from the top instead of
restoring. And reporting is held off until two animation frames *after*
`load`, not just until `load`: the restore's own scroll events (including
ones clamped while the page is still too short) are dispatched in the next
rendering step, and reporting any of them would overwrite the very position
being restored. The restore runs three times (immediately, `DOMContentLoaded`,
`load`) since images/fonts/stylesheets can change the page's height after
parsing.

Only window-level scroll is tracked — a scrollable container inside the
page (`overflow: auto`) still resets. Scrolling the preview to the block
currently being edited (rather than just keeping the last position) was
considered and left out: it would need comment markers around `{{CONTENT}}`
in preview mode plus a caret-to-block mapping, and the plain position
restore turned out to be enough.

### 18. Template / style / script editing — optional tabs

Site Settings has an "Enable template, style & script editing" checkbox, off
by default. When on, the file list gets Pages / Templates / Styles / Scripts
tabs (`#fileTabs`); everything below is code-only editing of files that
otherwise need a code editor outside WebHaste. Templates lists
`.webhaste/templates/*.html`; Styles and Scripts are `scripts/` split by
extension (that folder is flat and holds both), with `*.min.*` left out so the
scaffolded vendor libraries (`lunr.min.js`, `lottie.min.js`) don't show up.
`assets/` and `elements/` are deliberately not listed — assets already have
their own dialog, and `elements/` holds template-only resources not meant to
be hand-edited from here.

**The setting is per-device, not in `site.config.json`.** It lives in
`chrome.storage.local` under `projectStorageKey(config, "templateEditing")`,
the same per-project namespacing deployment credentials use
(`isTemplateEditingEnabled()`/`setTemplateEditingEnabled()`). `site.config.json`
is committed and shared, and the point of the setting is that one person on a
shared project can turn it on without turning it on for everyone else who
opens it — many content editors shouldn't be nudged toward template files at
all. Same caveat as "Remember these details on this device": a convenience
gate, not access control; anyone can re-enable it. With it off, the tab strip
is hidden entirely (not a lone "Pages" tab), so the default UI is unchanged.

**Same editor and save path as pages, keyed by full path.** `openCodeFile()`
reuses the one CodeMirror instance, `fileCache`, the debounced
`scheduleSave()`/`flushPendingSave()`, and `knownFileMeta`'s shared-drive
conflict check, but keys everything by project-relative path
(`scripts/styles.css`, `.webhaste/templates/x.html`) instead of a bare
filename — so a template can never collide with a page of the same name, and
conflict backups under `.webhaste/backups/` get distinct nested paths.
`codeOnlyKind` (`"template"`/`"style"`/`"script"`/`null`) is the one flag that
says which mode the editor is in; `syncFromActiveView()` and `renderPreview()`
branch on it, and `enterCodeOnlyMode()`/`leaveCodeOnlyMode()` swap the pane
class, CodeMirror mode, and the options below. `openFile()` calls
`leaveCodeOnlyMode()`, so opening a page restores whichever of Visual/Code it
was last in. The flush-before-navigating logic was pulled out of `openFile()`
into `flushOutgoingSave()` so pages and code files leave a file identically.

CodeMirror's `lint` and `autoCloseTags` are turned **off** for CSS and JS and
restored for templates and pages: the lint is a home-grown HTML tag-balance
check (`htmlTagLint()`) that would flag every `<` in a JS comparison, and
auto-close-tags would close a `<` typed in a script. The vendored build
already includes the `css`, `javascript` and `htmlmixed` modes — nothing had
to be added.

`refreshFileList({ keepCache })` gained a `keepCache` option used by tab
switches: switching tabs only changes which list the sidebar shows, and
clearing `fileCache` there could drop an edit still queued behind a deferred
conflict check for a page the user already navigated away from. Even without
it, the Pages branch re-stores the open code file's entry after clearing, since
a template can be open while the Pages tab is showing and a cleared cache
would make the next save write `undefined` over it. `refreshFileItemPublishStatus()`
skips `.file-item--code` rows — they're not pages, so they have no publish
state and would otherwise all look permanently "new".

**Live preview of templates and stylesheets** works against `previewPage` — a
`{ name, text }` snapshot of the last page that was open (falling back to
`index.html` if none was), kept separately from `fileCache` since
`refreshFileList()` clears that. `scheduleSave()` re-renders the preview on
every keystroke but only writes to disk 400ms later, and preview *reads
templates and stylesheets from disk*, so on its own it would always show the
previous save. `composePage()`/`getTemplateText()`/`rewriteScriptsForPreview()`
take an optional `override: { kind, path, text }` that substitutes the open
file's unsaved text. It's threaded through as a parameter rather than a
module-level variable so Publish — which calls the same functions — can never
pick up a half-typed edit by accident. Scripts get no preview at all (the
`script-src 'self'` CSP blocks them in the iframe, same as everywhere else),
so `renderPreview()` returns early for them.

When the open template isn't the one the previewed page actually uses (a
per-page `template` override in `pages.json` ignores a change to the site
default, or the fallback `index.html` uses a different one), an edit would
silently appear to do nothing. `setPreviewNotice()` dims the preview frame to
35% opacity and shows an amber reason in the preview label bar; the same
message also goes to the status bar. It does *not* switch the preview to a
page that does use that template — that would jump to a page the user didn't
open — and the same notice is shown for an open script, since the preview
can't reflect one either. Cleared whenever a page, stylesheet or matching
template is opened.

Not included: creating or deleting templates/styles/scripts from these tabs,
a tab for `.webhaste/blocks/`, and any special handling of Tailwind sites —
there `scripts/styles.css` is generated build output (source is
`tailwind-input.css` at the project root), so hand-edits to it are overwritten
by the next `npm run build:css`.

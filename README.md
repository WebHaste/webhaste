# chromesite
ChromeSite CMS Extension for Chrome
# Local Site Builder & Publisher — skeleton

*"Money, it's a gas" — but Cloudflare Pages' free tier means this particular idea won't cost you any.*

This is a working skeleton, not a finished product. It proves out the three
hard parts — local-first storage, config-as-files, and one-click publish —
and has since grown a real editing surface on top: CodeMirror-based syntax
highlighting, image upload/editing, and a block-insertion system. See "Known
limitations" below for what's still stubbed out.

User-facing help docs and developer docs live at **chromecms.com** (built,
naturally, using this extension), not in this README. Keep this file scoped
to "how the pieces fit together for someone hacking on the extension itself."

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
so the "local drive as source of truth" model you described is real: there's
no separate save step, and no server round-trip.

### 2. Project config — `.chromesite/`
Site-wide settings live in a dot-prefixed directory inside the project
folder itself — the same convention as `.vscode/` or `.github/`. It's
created automatically the first time you open a folder:

```
my-site/
  index.html              ← published
  about.html               ← published
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
  .chromesite/              ← committed to git, never published
    site.config.json         ← siteName, domain, paragraphMode, cssFramework, activeTemplate
    nav.json                 ← named menus, supports nested "children" for dropdowns
    compose.js                ← headless Node CLI, self-contained — regenerated
    compose-core.js             every open, see "Headless rendering" below
    block-library.md          ← every block available in the Blocks dialog,
                                 regenerated every open, see "Content blocks" below
    templates/
      simple-layout.html      ← the wrapper template(s)
```

`CLAUDE.md` is scaffolded at the project **root**, not inside `.chromesite/`,
so agent tooling that auto-discovers a root-level `CLAUDE.md`/`AGENTS.md`
picks it up without being told where to look. Its content is copied in from
this repo's own `templates/CLAUDE.md` — same mechanism as the starter
`simple-layout.html`, see `ensureScaffold()` in `editor.js`.

Both `assets/` and `scripts/` are lazy — created on first use, not scaffolded
up front like `.chromesite/`. A template references its own scripts directly
(`<link rel="stylesheet" href="scripts/styles.css">`, `<script src="scripts/main.js">`)
since there's no placeholder/auto-injection for them, unlike `{{FRAMEWORK_ASSETS}}`.

Because these are real files (not `chrome.storage.local`), the whole
project — content, template, menus, and settings — travels with the repo
when cloned to another machine. `chrome.storage.local` now only remembers
which folder you last had open; it holds no project data.

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
classes plus the Bootstrap CDN tags via `{{FRAMEWORK_ASSETS}}`, `tailwind`
emits a CSS-only hover dropdown with the Tailwind CDN script, and `none`
emits plain unstyled `<ul>`/`<li>`. The nav data itself never changes —
only the renderer picked for composing it.

Editing `nav.json` right now is a raw-JSON textarea in the "Edit Menus"
dialog — a drag-and-drop nested tree editor (SortableJS-based) is planned
for later, but hand-editing in VS Code works fine in the meantime since
it's a real file.

### 4. Content blocks — `BLOCK_LIBRARY` + `.chromesite/blocks/`

Pre-baked HTML snippets inserted via the Blocks dialog, then hand-edited in
place (headline/copy/images) — Elementor-style, not a live component system.
Two sources feed the same grid:

- **Built-in (`BLOCK_LIBRARY` in `editor.js`)** — Hero, CTA, Testimonial,
  Contact, 3-Column Features, Video Embed (16:9 ratio wrapper), Form Embed
  (no ratio constraint, since form height varies). Each entry keys its markup
  by `cssFramework` (`bootstrap5` only today); a block with no entry for the
  site's active framework shows disabled rather than hidden, so it's still
  discoverable once that variant gets added.
- **Site-specific (`.chromesite/blocks/*.html`)** — one block per HTML file,
  used as-is regardless of framework since it's markup the site author
  already wrote. Opt-in and not scaffolded — the `blocks/` directory doesn't
  exist until someone adds a file to it, same as `assets/`.

Every inserted block gets a `cs-block` wrapper (`cs-block--<type>` class) and
a small move-up/move-down/delete toolbar; iframe-based blocks (the two embed
types) can't have their `src` retargeted from Visual view like text can —
that's a Code view edit.

`writeBlockLibraryDoc()` in `ensureScaffold()` regenerates
`.chromesite/block-library.md` on every folder open: every `BLOCK_LIBRARY`
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

The code view now runs on the vendored CodeMirror build (`vendor/codemirror/`)
for syntax highlighting and lint — the plain-`<textarea>` version mentioned
in earlier drafts of this README has been replaced.

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

The API token is entered once via a dialog and stored in
`chrome.storage.local`. It's worth having users create a **scoped** token
(Cloudflare Pages edit permission only) rather than a full account token,
since extension storage isn't as hardened as an OS keychain.

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
`ensureScaffold()` copies into every project as `.chromesite/compose.js`
(alongside a sibling `.chromesite/compose-core.js`) — it self-detects which
context it's running in (`require("./compose-core.js")` succeeds when
scaffolded next to a sibling copy, falls back to `require("../compose-core.js")`
for the repo's own `cli/` copy) and defaults its target folder accordingly.
The point: a site is composable with just Node, with no dependency on this
extension's source repo being checked out anywhere — see `CLAUDE.md`'s
"Testing your changes" section, which is what actually points agents at it.

## Known limitations in this skeleton (intentional, for a v0)

- Only `.html` files are listed/edited in the main file list — `assets/` and
  `scripts/` are managed through their own upload flows (Assets dialog;
  hand-editing in VS Code for `scripts/`) rather than the editor's tab list.
- All three publish paths (Cloudflare, Netlify, local render) now ship
  `assets/` and `scripts/` alongside the composed `.html` pages, in addition
  to the framework CDN tags (Bootstrap/Tailwind) wired in automatically via
  `{{FRAMEWORK_ASSETS}}`.
- Menu editing is a raw JSON textarea (`.chromesite/nav.json`) — nested
  dropdowns work, but there's no drag-and-drop tree UI yet. Hand-editing in
  VS Code works fine as a stopgap since it's a real file in the repo.
- No conflict handling if the same folder is open in two tabs.
- `BLOCK_LIBRARY` only has `bootstrap5` markup today — Tailwind/plain
  variants aren't filled in, so those blocks show disabled under other
  frameworks (and missing entirely from `block-library.md` for those sites).
- No popout/detached preview persistence — the popout preview window
  (see `editor.js`) re-renders from the same in-memory composition each
  time rather than being a fully independent view.

## Try it locally

1. `chrome://extensions` → enable Developer Mode → "Load unpacked" → select
   this folder.
2. Click the toolbar icon to open the editor tab.
3. "Open Project Folder" → pick a folder with (or where you'll create)
   `.html` files. A `.chromesite/` config directory is created automatically
   on first open, with a default `site.config.json`, `nav.json`, and starter
   template.
4. Try "Site Settings" (name, domain, paragraph mode, CSS framework) and
   "Edit Menus" (nested `nav.json`) to see composition happen live in the
   preview pane.
5. Fill in Cloudflare account ID / project name / API token under Publish
   to test a real deploy (needs a Pages project already created in the
   Cloudflare dashboard).

*"Breathe, breathe in the air"* — the editing surface (CodeMirror, image
handling, blocks) is in place now; what's left is mostly the items under
"Known limitations" above, plus building out chromecms.com itself.

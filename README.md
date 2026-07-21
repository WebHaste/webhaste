# chromesite
ChromeSite CMS Extension for Chrome
# Local Site Builder & Publisher — skeleton

*"Money, it's a gas" — but Cloudflare Pages' free tier means this particular idea won't cost you any.*

This is a working skeleton, not a finished product. It proves out the three
hard parts and leaves the "make it a real editor" work (syntax highlighting,
multi-file types, drag-and-drop image handling, etc.) for later.

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
  .chromesite/              ← committed to git, never published
    site.config.json         ← siteName, domain, paragraphMode, cssFramework, activeTemplate
    nav.json                 ← named menus, supports nested "children" for dropdowns
    templates/
      simple-layout.html      ← the wrapper template(s)
```

Because these are real files (not `chrome.storage.local`), the whole
project — content, template, menus, and settings — travels with the repo
when cloned to another machine. `chrome.storage.local` now only remembers
which folder you last had open; it holds no project data.

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

### 4. Publishing — three deployment targets

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

## Known limitations in this skeleton (intentional, for a v0)

- Only `.html` files are listed/edited — no CSS/JS/image file support yet,
  though the File System Access calls extend to any file type trivially.
- The Cloudflare publish step only ships `.html` files — no images or
  standalone CSS/JS assets yet, even though the framework CDN tags
  (Bootstrap/Tailwind) are wired in automatically via `{{FRAMEWORK_ASSETS}}`.
- Menu editing is a raw JSON textarea (`.chromesite/nav.json`) — nested
  dropdowns work, but there's no drag-and-drop tree UI yet. Hand-editing in
  VS Code works fine as a stopgap since it's a real file in the repo.
- No conflict handling if the same folder is open in two tabs.
- The code view is a plain textarea, not a real code editor. Swapping in
  CodeMirror or Monaco is a drop-in replacement for `#codeArea`.

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

*"Breathe, breathe in the air"* — and maybe grab a coffee before wiring up
the CodeMirror swap, since that's the part that'll actually make this
pleasant to use day-to-day.

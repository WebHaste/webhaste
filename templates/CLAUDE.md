# Working on this site

This is a WebHaste project: content edited here is meant to be opened and
published through the WebHaste Chrome extension, not built with a
bundler/framework of its own. A few things about the format aren't obvious
from the files alone — read this before creating or editing pages.

## Page files are content fragments, not full HTML documents

Every `*.html` file at the project root (e.g. `index.html`, `docs.html`) is
just the **body content** for that page — a fragment, not a full
`<html><head>...` document. Don't add `<!DOCTYPE>`, `<html>`, `<head>`, or
`<body>` tags to a page file; the active layout template supplies all of
that at publish/preview time by substituting `{{CONTENT}}` with the page
file's contents.

The current layout template is `.webhaste/templates/<activeTemplate>`
(see `.webhaste/site.config.json` → `activeTemplate` for which file).
It also defines `{{TITLE}}`, `{{META_DESCRIPTION}}`, `{{NAV:<menu>}}`,
`{{FRAMEWORK_ASSETS}}`, `{{SITE_NAME}}`, and `{{YEAR}}` placeholders — check
that file if you need to know what wraps every page (header/nav/footer).

## Read `.webhaste/site.config.json` before writing markup

Don't assume Bootstrap, `<p>` paragraphs, etc. — they're configurable per
site and change over time. Check this file first:

- `cssFramework` — `bootstrap5`, `tailwind`, or `none`. Write class names
  that match whichever is active; classes for the wrong framework are dead
  weight (or actively wrong) in the published output.
- `paragraphMode` — `p` or `div`. Matches how the visual editor's Enter key
  behaves; hand-written content should follow the same convention so it's
  consistent with what a human editing the same page would produce.
- `activeTemplate` — which template file wraps pages (see above).
- `deploymentTarget` / `deployDirectory` — where "Publish" sends the site.
  Not usually relevant to content edits, but useful context if asked about
  publishing.
- `domain` — the live site's URL (e.g. `https://example.com`). Drives
  `sitemap.xml` generation (see below); no sitemap is produced while it's
  unset.

## Making a new page reachable

Creating `some-page.html` at the root is not enough by itself — nothing
links to it. Two more files, both in `.webhaste/`:

- **`nav.json`** — add an entry to the relevant menu (commonly `header` or
  `footer`) so it's linked from the site chrome. Supports nested `children`
  for dropdowns, e.g.:
  ```json
  { "label": "New Page", "href": "/some-page.html" }
  ```
  A top-level `"layouts"` map controls how a whole menu renders: each key is
  a menu name, value is `"navbar"` (default, horizontal) or `"columns"`
  (each top-level item becomes a heading with its `children` listed below
  it — typical for a multi-column footer). E.g. `"layouts": { "footer":
  "columns" }`. Every rendered menu also gets `cs-menu cs-menu-<name>`
  classes (e.g. `cs-menu-header`, `cs-menu-footer`) regardless of layout,
  so you can target a specific menu in site CSS.
- **`pages.json`** (optional) — per-page `<title>`/meta description
  override, keyed by filename:
  ```json
  "some-page.html": { "title": "New Page", "description": "..." }
  ```
  A page without an entry here falls back to a default title built from the
  file name and site name — fine for minor pages, worth setting explicitly
  for anything meant to be found via search or shared as a link. Unlike
  `site.config.json`/`nav.json`, this file is *not* scaffolded up front —
  it's created the first time something needs a title/description override.
  Don't assume it exists; check before reading or editing it.

  A page entry can also carry `"status": "draft"` (set from the Page
  Properties dialog's Status field; the key is omitted entirely for the
  default "Active" state). A draft page stays on disk and still previews
  normally in the editor, but is skipped by Publish, Render to Local
  Folder, and `sitemap.xml` — treat it as work in progress, not a live URL,
  when deciding whether to link to it from `nav.json` or other pages.

## sitemap.xml and robots.txt

`sitemap.xml` is generated automatically at publish/render time from
`site.config.json`'s `domain` and every non-draft page — don't create or
hand-edit one in the project root, it plays no part in composing it. For
"Render to Local Folder" it lands inside the deploy folder (`dist/` by
default — see that folder's own "don't hand-edit" note below); for
Cloudflare/Netlify Publish it's uploaded straight to the live site and
never touches a file here at all. If `domain` is unset, no sitemap is
produced.

`robots.txt`, by contrast, is a real project file at the root, scaffolded
once with a permissive default (`User-agent: *` / `Allow: /`) and never
regenerated — safe to hand-edit (e.g. adding `Disallow:` rules) same as any
other file here.

## Content blocks

Reusable HTML snippets — hero sections, CTAs, embeds, etc. — follow this
wrapper convention when inserted by the editor:

```html
<div id="cs-block-xxxxxxxx" class="cs-block cs-block--<type>">
  ...
</div>
```

The `id` just needs to be unique on the page; it doesn't need to match any
particular format. If you're writing a section that isn't one-off page
content — something likely to get reused across pages — consider dropping
it in `.webhaste/blocks/<name>.html` as its own file instead of inlining
it. Anything there shows up as an insertable block tile in the editor's
Blocks dialog, labeled from the filename, and can be reused without
duplicating markup by hand. Write just the inner markup in that file —
*not* the `cs-block` wrapper shown above. The wrapper (with a freshly
generated id) is added by the editor at the moment a block is inserted
onto a page, not stored in the block's own source file.

**See `.webhaste/block-library.md`** for the full list of blocks actually
available in this site's Blocks dialog — both the extension's built-in ones
(Hero, CTA, Testimonial, etc., with their real markup for this site's
`cssFramework`) and this site's own custom ones. It's generated, not
hand-written — see "Do not hand-edit" below.

## No package manager or build step

There's no `package.json`, no `node_modules`, and nothing to `npm install`
— WebHaste never scaffolds any of that into a project. `.webhaste/compose.js`
is a self-contained, dependency-free Node script; running it is the only
"tooling" this repo has. Don't add a `package.json` or install dependencies
for a task unless the user explicitly asks for build tooling beyond what
WebHaste itself provides.

## Testing your changes (requires Node)

Page files are fragments (see above), so you can't just open one in a
browser to see the real result — it needs the template/nav/CSS-framework
substitution applied first. `.webhaste/compose.js` does exactly that,
headlessly, matching what the extension's "Render to Local Folder" /
Publish would produce:

```
node .webhaste/compose.js --out .agent-preview
```

This writes fully-composed pages (plus `assets/`/`scripts/`) into
`.agent-preview/` inside the project — use a scratch `--out` folder like
this rather than the real `dist/` (or whatever `deployDirectory` is set to)
so you don't clobber the site owner's actual build output. Delete the
scratch folder once you're done checking it; it's not meant to be committed.
Run `node .webhaste/compose.js --help` for the full option list.

If Node isn't available in this environment, fall back to reasoning from
the template's placeholders and this file's conventions — there's no other
way to render a page outside the extension itself.

## Do not hand-edit

- `dist/` (or whatever `deployDirectory` points at) — build output from
  "Render to Local Folder," overwritten on every render. WebHaste doesn't
  scaffold a `.gitignore`, so some projects end up committing `dist/` to
  version control anyway — if so, expect its diffs to show up in `git
  status` after every render; that's expected noise from the build, not
  something to investigate or hand-fix.
- `.webhaste/compose.js`, `.webhaste/compose-core.js`, and
  `.webhaste/block-library.md` — regenerated every time the project
  folder is opened in the editor, so hand edits won't stick. (Unlike this
  file and `.webhaste/templates/`, which are copied in once and then left
  alone — edit those freely.)
- `.webhaste/` config files (`site.config.json`, `nav.json`, `pages.json`)
  are fine to hand-edit — that's the supported way to bulk-edit them — but
  keep the JSON valid. The editor doesn't validate on load, and a broken
  file falls back to defaults silently rather than erroring.

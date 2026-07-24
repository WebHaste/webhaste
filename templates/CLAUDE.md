# Working on this site

This is a ChromeSite project: content edited here is meant to be opened and
published through the ChromeSite Chrome extension, not built with a
bundler/framework of its own. A few things about the format aren't obvious
from the files alone — read this before creating or editing pages.

## Page files are content fragments, not full HTML documents

Every `*.html` file at the project root (e.g. `index.html`, `docs.html`) is
just the **body content** for that page — a fragment, not a full
`<html><head>...` document. Don't add `<!DOCTYPE>`, `<html>`, `<head>`, or
`<body>` tags to a page file; the active layout template supplies all of
that at publish/preview time by substituting `{{CONTENT}}` with the page
file's contents.

The current layout template is `.chromesite/templates/<activeTemplate>`
(see `.chromesite/site.config.json` → `activeTemplate` for which file).
It also defines `{{TITLE}}`, `{{META_DESCRIPTION}}`, `{{NAV:<menu>}}`,
`{{FRAMEWORK_ASSETS}}`, `{{SITE_NAME}}`, and `{{YEAR}}` placeholders — check
that file if you need to know what wraps every page (header/nav/footer).

## Read `.chromesite/site.config.json` before writing markup

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

## Making a new page reachable

Creating `some-page.html` at the root is not enough by itself — nothing
links to it. Two more files, both in `.chromesite/`:

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
  for anything meant to be found via search or shared as a link.

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
it in `.chromesite/blocks/<name>.html` as its own file instead of inlining
it. Anything there shows up as an insertable block tile in the editor's
Blocks dialog, labeled from the filename, and can be reused without
duplicating markup by hand.

**See `.chromesite/block-library.md`** for the full list of blocks actually
available in this site's Blocks dialog — both the extension's built-in ones
(Hero, CTA, Testimonial, etc., with their real markup for this site's
`cssFramework`) and this site's own custom ones. It's generated, not
hand-written — see "Do not hand-edit" below.

## Testing your changes (requires Node)

Page files are fragments (see above), so you can't just open one in a
browser to see the real result — it needs the template/nav/CSS-framework
substitution applied first. `.chromesite/compose.js` does exactly that,
headlessly, matching what the extension's "Render to Local Folder" /
Publish would produce:

```
node .chromesite/compose.js --out .agent-preview
```

This writes fully-composed pages (plus `assets/`/`scripts/`) into
`.agent-preview/` inside the project — use a scratch `--out` folder like
this rather than the real `dist/` (or whatever `deployDirectory` is set to)
so you don't clobber the site owner's actual build output. Delete the
scratch folder once you're done checking it; it's not meant to be committed.
Run `node .chromesite/compose.js --help` for the full option list.

If Node isn't available in this environment, fall back to reasoning from
the template's placeholders and this file's conventions — there's no other
way to render a page outside the extension itself.

## Do not hand-edit

- `dist/` (or whatever `deployDirectory` points at) — build output from
  "Render to Local Folder," overwritten on every render.
- `.chromesite/compose.js`, `.chromesite/compose-core.js`, and
  `.chromesite/block-library.md` — regenerated every time the project
  folder is opened in the editor, so hand edits won't stick. (Unlike this
  file and `.chromesite/templates/`, which are copied in once and then left
  alone — edit those freely.)
- `.chromesite/` config files (`site.config.json`, `nav.json`, `pages.json`)
  are fine to hand-edit — that's the supported way to bulk-edit them — but
  keep the JSON valid. The editor doesn't validate on load, and a broken
  file falls back to defaults silently rather than erroring.

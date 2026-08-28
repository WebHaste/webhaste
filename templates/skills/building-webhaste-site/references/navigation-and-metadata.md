# Navigation and Page Metadata

Creating `some-page.html` at the root is not enough by itself — nothing
links to it. Two more files, both in `.webhaste/`:

## `nav.json`

Add an entry to the relevant menu (commonly `header` or `footer`) so it's
linked from the site chrome. Supports nested `children` for dropdowns,
e.g.:

```json
{ "label": "New Page", "href": "/some-page.html" }
```

A top-level `"layouts"` map controls how a whole menu renders: each key is
a menu name, value is `"navbar"` (default, horizontal) or `"columns"`
(each top-level item becomes a heading with its `children` listed below
it — typical for a multi-column footer). E.g. `"layouts": { "footer":
"columns" }`. Every rendered menu also gets `cs-menu cs-menu-<name>`
classes (e.g. `cs-menu-header`, `cs-menu-footer`) regardless of layout, so
you can target a specific menu in site CSS.

`cssFramework` (see `site.config.json`) controls how this same JSON gets
rendered into markup: `bootstrap5` emits `navbar-nav`/`dropdown-menu`
classes, `tailwind` emits a CSS-only hover dropdown, and `none` emits plain
unstyled `<ul>`/`<li>`. The nav data itself never changes — only the
renderer picked for composing it.

## `pages.json` (optional)

Per-page `<title>`/meta description override, keyed by filename:

```json
"some-page.html": { "title": "New Page", "description": "..." }
```

A page without an entry here falls back to a default title built from the
file name and site name — fine for minor pages, worth setting explicitly
for anything meant to be found via search or shared as a link. Unlike
`site.config.json`/`nav.json`, this file is *not* scaffolded up front —
it's created the first time something needs a title/description override.
Don't assume it exists; check before reading or editing it.

A page entry can also carry:

- **`"status": "draft"`** (set from the Page Properties dialog's Status
  field; the key is omitted entirely for the default "Active" state). A
  draft page stays on disk and still previews normally in the editor, but
  is skipped by Publish, Render to Local Folder, and `sitemap.xml` — treat
  it as work in progress, not a live URL, when deciding whether to link to
  it from `nav.json` or other pages.
- **`"language"`** — a BCP 47 tag overriding `site.config.json`'s
  site-wide `language` for just that page (e.g. a single Spanish-language
  page on an otherwise English site). Omitted key means "inherit the site
  default," same pattern as `status`. See
  references/pages-and-templates.md for how this resolves into
  `{{LANG}}`.
- **`"template"`** — a filename under `.webhaste/templates/` overriding
  `site.config.json`'s `activeTemplate` for just that page. See
  references/pages-and-templates.md.

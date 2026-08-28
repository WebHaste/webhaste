# SEO, Sitemap, Robots, and Site Search

## sitemap.xml and robots.txt

`sitemap.xml` is generated automatically at publish/render time from
`site.config.json`'s `domain` and every non-draft page — don't create or
hand-edit one in the project root, it plays no part in composing it. For
"Render to Local Folder" it lands inside the deploy folder (`dist/` by
default); for Cloudflare/Netlify Publish it's uploaded straight to the
live site and never touches a file here at all. If `domain` is unset, no
sitemap is produced.

`robots.txt`, by contrast, is a real project file at the root, scaffolded
once with a permissive default (`User-agent: *` / `Allow: /`) and never
regenerated — safe to hand-edit (e.g. adding `Disallow:` rules) same as
any other file here.

## Site search

`search-index.json` is generated automatically alongside `sitemap.xml` at
publish/render time — same rules, don't hand-edit or create one at the
project root. Each entry is built from a page's *raw* content (not the
composed output, so template nav/header/footer text is never duplicated
into every page's indexed text), plus its `pages.json` title/description.

Two files are already scaffolded into `scripts/` for you — `search.js`
(the search UI logic) and `lunr.min.js` (the search library it depends
on) — but neither does anything until your template actually references
them and includes a search box. Add to the layout template's `<head>`:

```html
<script src="/scripts/lunr.min.js"></script>
<script src="/scripts/search.js"></script>
```

and a search box wherever you want one to appear:

```html
<input type="search" id="cs-search-input" placeholder="Search...">
<div id="cs-search-results"></div>
```

`search.js` looks for those two element IDs specifically and wires itself
up automatically — nothing else to configure, and a template that never
adds them just doesn't load the index. Results render as
`<ul class="cs-search-list"><li class="cs-search-item">` entries (or a
`<p class="cs-search-empty">` when there are none) — unstyled by default,
so add CSS for those classes the same way you would for any other `cs-*`
class from a block or menu.

## Per-page SEO/search checkboxes

Page Properties has three checkboxes independent of Draft status — a page
with any of them checked still publishes normally, it's just left out of
the file(s) named:

- **Exclude from sitemap.xml** — leaves it out of `sitemap.xml`.
- **Exclude from site search** — leaves it out of `search-index.json`.
- **Hide from search engines (noindex)** — adds a real
  `<meta name="robots" content="noindex">` tag to the page. Unlike the
  two checkboxes above, which only control WebHaste's own generated
  files, this is a genuine signal to crawlers — deliberately not a
  `robots.txt` `Disallow` rule instead, since `Disallow` blocks crawling
  rather than indexing, which works against a `noindex` tag a crawler
  can't see on a page it's blocked from fetching in the first place.

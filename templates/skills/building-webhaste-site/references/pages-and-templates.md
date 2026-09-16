# Pages and Templates

## Page files are content fragments, not full HTML documents

Every `*.html` file at the project root (e.g. `index.html`, `docs.html`) is
just the **body content** for that page — a fragment, not a full
`<html><head>...` document. Don't add `<!DOCTYPE>`, `<html>`, `<head>`, or
`<body>` tags to a page file; the active layout template supplies all of
that at publish/preview time by substituting `{{CONTENT}}` with the page
file's contents.

The current layout template is `.webhaste/templates/<activeTemplate>`
(see `.webhaste/site.config.json` → `activeTemplate` for which file). It
also defines `{{TITLE}}`, `{{META_DESCRIPTION}}`, `{{NAV:<menu>}}`,
`{{SITE_NAME}}`, `{{LANG}}`, and `{{YEAR}}` placeholders — check that file
if you need to know what wraps every page (header/nav/footer). Any CSS
framework `<link>`/`<script>` tags are NOT a placeholder — they're literal
markup in the template's `<head>`, same as `scripts/styles.css`/`main.js`;
WebHaste doesn't inject or manage them.

## Per-page template override

Every page uses `site.config.json` → `activeTemplate` by default, but a
page can override that individually — e.g. posts under `blog/` wrapped in
a `blog-layout.html` that adds a byline/date block the rest of the site
doesn't have — via a `"template"` key in that page's `pages.json` entry
(set from the Page Properties dialog's Template dropdown; the options
there are every `*.html` file under `.webhaste/templates/`). An omitted
key means "inherit the site default," same pattern `status`/`language`
use — see references/navigation-and-metadata.md.

A page whose override points at a template file that's since been
deleted/renamed throws rather than silently falling back — same as a
stale `activeTemplate` always has.

## Per-page header code

A `"headCode"` key in a page's `pages.json` entry (set from the Page
Properties dialog's "Header code" field) is raw HTML/JS inserted verbatim
before `</head>` for just that page — for things a sitewide snippet in the
template can't cover, e.g. a Google Ads/Analytics *conversion* tag that
only applies to one page. If a site needs several tags, or they change
often, prefer a Google Tag Manager container snippet in the template
instead (tags then managed in GTM's own UI, no further per-page edits) —
this field is for the simpler one-off case.

Don't use this field for `og:*`/`twitter:*` social meta tags — those are
generated automatically from title/description already, see
references/seo-and-search.md. Hand-adding your own here would duplicate
them.

## `assets/` and `scripts/` are flat — no subfolders

Both directories are read one level deep only; WebHaste does not walk
subdirectories when composing pages. `assets/photo.jpg` works —
`assets/uploads/2024/01/photo.jpg` does not, and fails silently: it won't
render in the editor's live preview (broken image/missing stylesheet, no
error), and it's excluded from Publish and Render to Local
Folder/Packaged, so the live site 404s on it.

This matters most when importing/converting an existing site (e.g. a
WordPress export, which nests uploads as `wp-content/uploads/YYYY/MM/...`
by convention): flatten every file straight into `assets/` (or `scripts/`)
and rewrite every reference to match — don't preserve the source site's
folder structure. Watch for filename collisions once flattened, and for
any stylesheet that references sibling assets by relative path (e.g. an
icon font's `@font-face` pointing at `../fonts/name.woff2`) — rewrite those
too. Page files themselves don't have this restriction — `blog/post.html`
is fine.

## Multi-language content

`{{LANG}}` in the layout template resolves per page as: this page's
`pages.json` → `language` override, else `site.config.json` → `language`,
else `"en"`. There's no separate translated-copy mechanism — a localized
page is just a normal `.html` fragment (e.g. `about-es.html`) written in
that language, linked from `nav.json` like any other page, with its
`pages.json` entry's `language` set to match. `hreflang` alternate-language
`<link>` tags aren't generated automatically; add them by hand in the
template's `<head>` (or per-page, if editing raw HTML) if the site needs
them.

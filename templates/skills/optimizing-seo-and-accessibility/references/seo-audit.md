# SEO audit

Scan every non-draft page. Drafts aren't published, so skip them except to
mention in the report that they exist.

## Titles

`{{TITLE}}` renders as `<page title> | <siteName>` (check the template, but
that's the default shape), so the `pages.json` `title` should be just the
page's own name.

- Present for every page (a missing entry falls back to a title built from
  the filename, which is rarely good).
- Unique across the site.
- Roughly 50 characters or fewer for the page title alone, so the full
  title doesn't truncate in results. Don't repeat the site name in it.
- Describes the page, not the file ("Dairy Farming Services", not
  "dairy-firm").
- Home page: the business name plus what it does is better than "Home".

## Meta descriptions

`pages.json` `description`:

- Present for every page that can be found or shared (all of them, except
  maybe utility pages).
- Unique, about 120–160 characters, plain sentences, no keyword stuffing,
  no "Welcome to…" filler.
- Accurate to the page's visible content. Write from the page, never from
  assumptions.
- Open Graph/Twitter descriptions are derived from the same field, so one
  good description covers all three.

## Headings

- Exactly one `<h1>` per page, matching the page's real topic. Remember a
  template can supply an `<h1>` (a site-wide logo/heading) or a page-title
  banner block can; check the **composed** page, not just the fragment.
- Levels don't skip downward (h2 → h4) and aren't chosen for size alone.
- No empty headings or headings used only as styled text.

## Content and links

- Descriptive link text (not "click here", "read more" repeated many times
  without distinguishing context).
- Internal links resolve to real pages (the extension's Check Links tool
  can't run here — check by script against the page list). Prefer
  root-relative paths (`/about.html`).
- No leftover links to old/staging domains or deleted pages.
- Pages reachable from `nav.json` or a content link; list orphans.
- Redirects for removed or renamed URLs belong in the Redirects dialog
  (`.webhaste/redirects.json`); suggest them in the report when a page was
  renamed, don't hand-write `_redirects`.

## Images

- Content images have meaningful `alt` (see accessibility audit).
- Images are web-sized. WebHaste can resize on upload, but already-present
  files can be huge. **Check this by script** (it's one of the cheap scans,
  don't skip it): list every file in `assets/` and `elements/` over about
  1 MB, and read pixel dimensions of PNG/JPEG files (header bytes; no
  library needed) to flag any wider than `imageResizeMaxDimension` in
  `site.config.json` (default 1920). Report them with sizes; don't resize or
  recompress files yourself.
- Descriptive filenames help but renaming means rewriting references; only
  do it when asked.
- There is no `og:image` support yet, so don't try to add one by hand.

## Structured data

- `index.html` gets Organization/LocalBusiness JSON-LD only if
  `site.config.json` → `schemaMarkup` has a `type` and a `name`. If the site
  represents a real business and that's missing, recommend filling it in
  (type, name, logo, telephone, address, `sameAs`). It's a plain JSON object
  in the config, so you can set values the owner has *given you*; don't
  guess missing ones.
- Other schema types go in a page's `headCode` in `pages.json` as a
  `<script type="application/ld+json">`. Only add what the visible page
  supports:
  - `Article`/`BlogPosting` for blog posts (headline, datePublished,
    author — only if those facts are on the page).
  - `FAQPage` only when the page really has question/answer content.
  - `Event`, `Product`, `Service`: same rule — real data only.
  - Valid JSON, no trailing commas; avoid duplicating Organization data
    already emitted on the homepage.

## Indexing controls

- **`domain` set in `site.config.json`?** Check this first and report it as
  a top finding if missing. Without it **no `sitemap.xml` is produced at
  all** and `og:url` is omitted, so "the site has no sitemap" is fixed by
  setting `domain`, never by writing a `sitemap.xml` file (a root-level copy
  is ignored and never published). If the owner hasn't given you the real
  domain, ask rather than guess.
- `robots.txt` exists and doesn't accidentally `Disallow: /`.
- Thank-you, internal, or duplicate pages: suggest "Hide from search
  engines" (`noindex`) or "Exclude from sitemap.xml" in the report. These
  are Page Properties checkboxes (`noindex`, `excludeFromSitemap` in
  `pages.json`); apply only if the owner agrees.
- If the site came from a migration, the old WordPress `noindex` may have
  been dropped or kept — check intent.

## Duplicate or near-duplicate content: canonical tags

WebHaste doesn't generate `<link rel="canonical">`. When two or more pages
carry the same or very similar content (a page reachable in two versions,
variant landing pages, a "services-one"/"services-two" pair of demo layouts,
print/alternate versions), pick the one page that should rank and add a
canonical tag to the **other** pages through the per-page **`headCode`** field
(Page Properties' "Header code"; `"headCode"` in that page's `pages.json`
entry), pointing at the preferred page:

```json
"services-two.html": {
  "title": "Services",
  "description": "...",
  "headCode": "<link rel=\"canonical\" href=\"https://example.com/services-one.html\">"
}
```

- Use an **absolute** URL with `https://` and the site's real `domain`, in the
  same form the sitemap and `og:url` use: `domain/page.html`, and the bare
  domain for `index.html`. Don't mix `/about` and `/about.html` forms.
- Canonical is a hint for *which URL to index*; use `noindex` instead when a
  page shouldn't be indexed at all, and don't combine the two on one page.
- Don't point a canonical at a draft, `noindex`, or redirected page.
- A page may canonicalize to itself; that's optional and not needed.
- Which page is "preferred" is the owner's call: when it isn't obvious from
  the content, list the duplicates in the report with a recommendation
  instead of applying tags. `headCode` is trusted verbatim, so keep any
  existing value in it and append the `<link>` rather than replacing it.

## Language

- `site.config.json` → `language` matches the site's language.
- Pages in another language have a `language` override in `pages.json`.

## Performance-adjacent basics

Only the ones visible in markup: large unoptimized images, many render-blocking
scripts in the template `<head>` that could use `defer`, missing
`width`/`height` on images causing layout shift (report; don't mass-edit).

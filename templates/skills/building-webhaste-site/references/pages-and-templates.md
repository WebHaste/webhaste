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

---
name: migrating-wordpress-to-webhaste
description: Migrate an existing WordPress site (from a static export or crawl) into a WebHaste project — converting the theme into a WebHaste layout template and the pages/posts into content fragments, with nav, metadata, assets, and custom blocks. Use when asked to convert, migrate, import, or port a WordPress site or theme into WebHaste.
---

# Migrating a WordPress Site to WebHaste

This skill covers *migration workflow*. For the WebHaste conventions it
relies on (fragment pages, placeholders, `nav.json`, `pages.json`, blocks),
use the `building-webhaste-site` skill and the project's `CLAUDE.md` — don't
re-derive them here.

## Inputs — confirm before starting

- **Source**: path to a static export/crawl of the WordPress site (and,
  ideally, the live URL for reference). Never work from a live site by
  guessing; if there's no local copy, ask for one. This workflow has been
  tested against exports made with the
  [Simply Static](https://wordpress.org/plugins/simply-static/) WordPress
  plugin; other exporters or crawlers should work, but expect their folder
  layout and URL rewriting to differ, so inspect the export before
  assuming the conventions below. A full conversion is a long task (the
  tested site took roughly 30 minutes), so work through the phases steadily
  rather than stopping to ask about decisions the rules here already cover.
- **Target**: the WebHaste project folder (it should already contain
  `.webhaste/`, `CLAUDE.md`, and `.claude/skills/`). Write only there; treat
  the source as read-only.
- **Exclusions**: by default skip the store/WooCommerce pages, XML feeds
  (RSS, sitemaps), WordPress's own search, login/admin/`wp-json` URLs, and
  tag/category/author archive pages. The user can override any of these.

If the target's `cssFramework` is unset or unsuitable (the source uses its
own CSS), `none` is usually right — see Phase 1.

## Workflow

Do the phases in order; later phases depend on earlier ones.

1. **Inventory** — list every source page, its section, and notable
   features. Read
   [references/content-migration.md](references/content-migration.md)
   ("Inventory"). Decide the target file names and folder layout now.
2. **Theme → template** — read
   [references/theme-conversion.md](references/theme-conversion.md). Produce
   `.webhaste/templates/*.html`, `scripts/styles.css`, and any assets the
   template needs. Compose and eyeball one page before moving on.
3. **Content → fragments** — read
   [references/content-migration.md](references/content-migration.md). One
   fragment per source page, flattened assets, descriptions in
   `pages.json`, designed sections as custom blocks.
4. **Navigation** — rebuild `nav.json` menus from the *new* file structure,
   not by copying the WordPress menu verbatim (hrefs differ).
5. **Verify and report** — compose the site, check every internal link and
   asset reference, and write `MIGRATION-NOTES.md` (see below).

## Hard rules

- Page files are **body fragments** — never copy a WordPress `<html>`,
  `<head>`, header, nav, or footer into one. Those belong in the template.
- `assets/`, `scripts/` and `elements/` are **flat**. WordPress's
  `wp-content/uploads/YYYY/MM/` nesting must be flattened and every
  reference rewritten (watch for filename collisions and for `url(...)`
  paths inside copied stylesheets).
- **Sort files by purpose, not by where they came from.** `assets/` is the
  editor's media library, shown in the Assets dialog, so it holds only
  content images/PDFs that belong to pages. Everything the *design* depends
  on goes in `elements/`: web fonts (including icon fonts such as Font
  Awesome and Flaticon), the logo(s), favicon, CSS background images,
  decorative shapes and textures, quote-mark graphics. CSS and JS go in
  `scripts/`. Reference elements as `/elements/<name>`. Don't copy the
  theme's whole uploads/images folder into `assets/`.
- Copy only files that something actually references. Don't carry over the
  export's unused images or WordPress's `-300x200` resize variants.
- Use **WebHaste's own search** (the scaffolded `scripts/search.js` +
  `lunr.min.js` and the `#cs-search-input` / `#cs-search-results`
  elements). Do not migrate WordPress search forms.
- Don't add a `package.json`, bundler, or npm dependencies.
- Don't hand-write `sitemap.xml`, `search-index.json`, or Open Graph tags;
  WebHaste generates them.
- Don't invent facts. Where content is unclear or missing, say so in the
  notes rather than filling it in. The one exception is a missing meta
  description: write one (under about 160 characters) from that page's
  actual content.

## Things that won't work on a static site

Contact forms (Contact Form 7, Gravity Forms, WPForms), comments, member
areas, booking/calendar plugins, and embedded store widgets can't run in a
static export. For each: leave a visible placeholder in the page (a short
`<p>`/box saying the feature is pending, or the site's existing form-embed
block if the user supplies an embed URL) and add a line to
`MIGRATION-NOTES.md`. Never silently drop them.

## Deliverable: `MIGRATION-NOTES.md`

Write it at the project root. Include: pages migrated (source → target),
pages skipped and why, features replaced by placeholders (with the page
each is on), descriptions you wrote yourself, custom blocks created, assets
renamed due to collisions, demo/placeholder text still in the template (a
theme's sample email, address, phone, social links, copyright credit),
pages with no `<h1>`, JavaScript behavior you couldn't test, and anything
you weren't sure about. The user
reviews this instead of re-reading the whole conversation.

---
name: building-webhaste-site
description: Build and edit a site made with the WebHaste CMS — creating pages, wiring navigation and page metadata, adding content blocks, working with templates, and configuring site-wide settings. Use when creating or editing pages, blocks, templates, nav.json, pages.json, or site.config.json in a WebHaste project.
---

# Building a WebHaste Site

WebHaste is a browser-based CMS: this content is meant to be opened and
published through the WebHaste Chrome extension, not built with a
bundler/framework of its own. Sites are plain static files — no package
manager, no build step, except when `cssFramework` is `tailwind` (see
references/site-config-and-testing.md).

This skill covers the *conventions* of a WebHaste project. `CLAUDE.md` at
the project root covers the same ground in full prose; this skill exists as
a faster, topic-scoped path to the same information — reach for whichever
fits the task, and prefer `CLAUDE.md` if the two ever appear to disagree
(it's the one a site owner is more likely to have hand-edited).

## Common Gotchas

1. **Page files are body fragments, not full HTML documents.** No
   `<!DOCTYPE>`, `<html>`, `<head>`, or `<body>` — the active layout
   template supplies those at publish/preview time. Writing a full document
   into a page file produces a broken, double-wrapped page.
2. **A new page isn't reachable just by creating it.** `some-page.html` at
   the root has nothing linking to it until you add an entry to
   `.webhaste/nav.json`.
3. **Check `.webhaste/site.config.json` before writing markup.**
   `cssFramework` (`bootstrap5` / `tailwind` / `none`) and `paragraphMode`
   (`p` / `div`) are configurable per site and drift over time — don't
   assume Bootstrap classes or `<p>` paragraphs are correct for this site.
4. **Some files are regenerated and will silently discard hand edits:**
   `.webhaste/compose.js`, `.webhaste/compose-core.js`,
   `.webhaste/block-library.md`, `sitemap.xml`, and `search-index.json`.
   Edit `.webhaste/templates/`, `nav.json`, `pages.json`,
   `site.config.json`, `.webhaste/blocks/*.html`, or page files themselves
   instead — see references/site-config-and-testing.md for the full list.
5. **You can't preview a page by opening it in a browser.** It's a
   fragment, not a document — there's no `<head>`/nav/footer without the
   template substitution applied. Use `.webhaste/compose.js` (needs Node);
   see references/site-config-and-testing.md.

## File Structure

```
my-site/
  index.html, about.html, ...   ← page fragments (published)
  robots.txt                     ← hand-editable, scaffolded once
  CLAUDE.md                       ← full prose version of this skill
  assets/                         ← images/PDFs inserted via Insert Image
  scripts/                        ← template-level styles.css/main.js
  .webhaste/
    site.config.json              ← siteName, domain, cssFramework, ...
    nav.json                      ← named menus, nested children
    pages.json                    ← per-page title/description/status/...
    blocks/*.html                 ← site-specific content blocks
    templates/*.html               ← layout template(s)
    compose.js, compose-core.js    ← regenerated Node CLI for headless render
    block-library.md               ← regenerated list of insertable blocks
```

## Workflow

1. **Know the site's conventions first** — read
   [references/site-config-and-testing.md](references/site-config-and-testing.md)
   for `site.config.json` fields (`cssFramework`, `paragraphMode`,
   `activeTemplate`, `domain`, `language`) before writing any markup.
2. **Create or edit a page** — read
   [references/pages-and-templates.md](references/pages-and-templates.md)
   for the fragment/template contract, placeholders, per-page template
   overrides, and multi-language pages.
3. **Wire it up** — read
   [references/navigation-and-metadata.md](references/navigation-and-metadata.md)
   for `nav.json` menu entries and `pages.json` per-page metadata (title,
   description, draft status, language, template override).
4. **Add reusable content** — read
   [references/blocks.md](references/blocks.md) for the content-block
   wrapper convention and `.webhaste/blocks/`.
5. **Handle SEO and search** — read
   [references/seo-and-search.md](references/seo-and-search.md) for
   `sitemap.xml`, `robots.txt`, `search-index.json`, and the three
   per-page Page Properties checkboxes.
6. **Verify the result** — read
   [references/site-config-and-testing.md](references/site-config-and-testing.md)'s
   "Testing your changes" section and run
   `node .webhaste/compose.js --out .agent-preview`.

## Reference Documents

| File | Contents |
| --- | --- |
| [references/pages-and-templates.md](references/pages-and-templates.md) | Fragment/template contract, placeholders, per-page template override, multi-language |
| [references/navigation-and-metadata.md](references/navigation-and-metadata.md) | `nav.json` menus/layouts, `pages.json` fields (title, description, draft, language, template) |
| [references/blocks.md](references/blocks.md) | Content block wrapper convention, `.webhaste/blocks/`, `block-library.md` |
| [references/seo-and-search.md](references/seo-and-search.md) | `sitemap.xml`, `robots.txt`, site search wiring, the three Page Properties checkboxes |
| [references/site-config-and-testing.md](references/site-config-and-testing.md) | `site.config.json` fields, no build step, headless testing with `compose.js`, do-not-hand-edit list |

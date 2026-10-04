# Content migration

## Inventory

Before writing anything, list the source pages and decide, for each, the
target path. Record this table; it becomes the basis of `MIGRATION-NOTES.md`.

- Include: real content pages and blog posts/section pages.
- Exclude by default: store/WooCommerce (cart, checkout, my-account,
  products), feeds, tag/category/author/date archives, pagination pages
  (`/page/2/`), attachment pages, search results, login/admin, `wp-json`.
- A static export often has each page as `slug/index.html`; the page's
  identity is the slug, not `index.html`.

**File names:** use 20 characters or fewer including `.html` where possible,
lowercase, hyphenated, derived from the slug (`our-services-and-pricing` →
`services.html` or `pricing.html`; say which you chose in the notes if you
shortened meaningfully). The home page is `index.html`.

**Sections:** pages grouped in the source under a path (`/blog/…`,
`/services/…`) go in a matching folder (`blog/my-post.html`). Page files may
nest; `assets/` and `scripts/` may not.

## Page fragments

For each page, extract only the main content region (the post/entry body,
not the theme header/sidebar/footer/comments) and write it as a fragment.

- No `<html>/<head>/<body>`. Start with the content itself.
- Keep the page's `<h1>` in the fragment unless the template already
  renders the title (check the template; don't duplicate it).
- Strip WordPress cruft: `wp-block-*`/`elementor-*`/`et_pb_*` wrapper
  classes that only existed for the theme's CSS (keep classes the migrated
  stylesheet actually targets), inline `style` clutter, empty `<p>`s,
  `<!-- wp:... -->` comments, shortcodes that exported as literal
  `[shortcode]` text (replace with a placeholder and note it).
- Match `paragraphMode` from `site.config.json`.
- Rewrite internal links to the *new* paths (`/about.html`, or
  `/blog/post.html`), not the old WordPress permalinks. Leave external
  links alone. Absolute links to the old domain's own pages are internal.
- Images: first decide whether each is page content or design (see
  theme-conversion.md "Where files go"). Logos, backgrounds, icons and
  decorative shapes go to `elements/`; only content images/PDFs go to
  `assets/`. For content images, copy each referenced file into flat
  `assets/`, rewrite `src` (and
  `srcset` — simplest is to drop `srcset` and use the full-size file) to
  `/assets/<name>`. Prefer the original over WordPress's `-300x200`
  resized variants. Keep or write meaningful `alt` text; if missing, write
  it from context. Resolve name collisions by renaming (e.g. add the year
  or a short prefix) and record them.

## `pages.json`

Create or extend `.webhaste/pages.json` with one entry per page:
`{ "title": "...", "description": "..." }`.

- `title`: the page's real title (without the site name; WebHaste appends it).
- `description`: reuse the source's meta description if it has one (Yoast /
  Rank Math fields are in the page `<head>`). If none, write one from the
  page's content: one or two plain sentences, under about 160 characters,
  no keyword stuffing. Track which you wrote.
- Mark pages that shouldn't go live yet with `"status": "draft"`.
- For a page that must keep a different layout, add `"template"`.

## Designed sections → custom blocks

When a page contains a designed section that is likely reused or clearly a
unit (hero banner, featured services row, team grid, call-to-action
strip, testimonial slider), don't inline it into every page:

1. Write the inner markup to `.webhaste/blocks/<descriptive-name>.html`.
   Inner markup only; **no** `cs-block` wrapper, WebHaste adds it on insert.
   The file name becomes the block's label.
2. Place it in the page fragment inside the standard wrapper:
   `<div id="cs-block-xxxxxxxx" class="cs-block cs-block--<type>"> …inner… </div>`
   with a unique id per instance.
3. Check `.webhaste/block-library.md` first — if a built-in block already
   fits (Hero, CTA, Testimonial, Video Embed, etc.), use it rather than
   duplicating it.

Per-page unique sections (an About page's one-off layout) can stay inline.
Repeating *data* (events, staff, downloads) is a candidate for WebHaste
Lists instead; mention it in the notes rather than building one unasked.

## Embeds and features

- YouTube/Vimeo/Maps iframes: keep as iframes (the Video/Form Embed blocks
  wrap them if you want editor support).
- Forms, comments, sliders that depend on a plugin, booking widgets, store
  widgets: placeholder plus note (see SKILL.md).
- Galleries: convert to plain image markup, flattened assets.

## Navigation

Rebuild `.webhaste/nav.json` after all pages exist. Start from the source
site's header/footer menus for structure and labels, but set every `href`
to the new file path and drop entries for excluded pages. Use `children`
for dropdowns. Footer menus can use `"layouts": { "footer": "columns" }`
if the source footer was columns. Every kept page should be reachable from
some menu or a link in content; list any that aren't in the notes.

## Final verification

1. `node .webhaste/compose.js --out .agent-preview` runs without errors.
2. Every page fragment you wrote: no `<html>`/`<head>`, no leftover old-domain
   internal links, no `wp-content` or `/uploads/` paths.
3. Every `src`/`href`/`url()` pointing at `/assets/…`, `/scripts/…` or
   `/elements/…` refers to a file that exists in that flat folder, including
   `url()` references inside every copied stylesheet (script this check;
   don't eyeball it). Also confirm nothing in `assets/` is a font, logo,
   favicon, or CSS-only background, and that no file in any of the three
   folders is unreferenced.
4. Every page has exactly one `<h1>`; list any that have none or several in
   the notes (don't invent headings, but a page-title banner's title should
   be the `<h1>`).
5. Every internal page link resolves to a real page file (the in-editor
   Check Links tool can't be run from here, so check by script).
6. `nav.json` hrefs all resolve.
7. Delete `.agent-preview/`, then write `MIGRATION-NOTES.md`.

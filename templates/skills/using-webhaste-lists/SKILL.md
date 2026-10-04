---
name: using-webhaste-lists
description: Create, edit, and place WebHaste Lists — admin-managed collections (staff directories, blog indexes, link lists, locations, downloads, tabular data) stored in .webhaste/lists/*.json and rendered into pages by the List: Links, List: Directory, and List: Table blocks, including optional DataTables search/sort on tables. Use when asked to build or change a list, directory, table of repeating data, or searchable/sortable table in a WebHaste project.
---

# Using WebHaste Lists

A **List** is one JSON file, `.webhaste/lists/<slug>.json`: a schema (fields),
display settings (sort, pagination) and the entries themselves. A page shows
it through a **placeholder** in the page markup that a scaffolded script,
`scripts/list.js`, fills in *in the visitor's browser*. For general WebHaste
conventions see `building-webhaste-site`; this skill only covers Lists.

Read [references/list-format.md](references/list-format.md) before writing a
list file or block markup, or any script that must act on a rendered list
(it documents the `cs-list-rendered` event). Read
[references/datatables.md](references/datatables.md) only when the owner wants
a searchable/sortable table.

## When a List is the right tool

Use one for repeating records the owner will keep adding to or editing as
*data*: staff, locations, events, downloads, resources, a blog/news index,
price or product tables.

Don't use one for:
- One-off content (an About page's layout) — plain page markup.
- A reusable *design* section (hero, CTA) — a custom block in
  `.webhaste/blocks/`.
- Content that must be found by search engines or WebHaste's site search.
  **List entries are rendered by JavaScript after the page loads.** The page's
  own HTML contains only a placeholder, so `search-index.json` (built from raw
  page content) doesn't include them, and crawlers may not index them
  reliably. A blog index or team bio page that needs to rank is better as
  plain HTML. Say this when the choice isn't obvious.

## Things that go wrong

1. **The template must load `/scripts/list.js`.** It is scaffolded into
   `scripts/` but never wired into a template for you. Without the
   `<script src="/scripts/list.js"></script>` tag, the *live published site*
   shows only the placeholder (icon and list name), not just the editor. The
   starter templates include it; a site converted from elsewhere often
   doesn't. Check the active template (and any per-page override) first.
2. **An old copied `scripts/list.js` degrades silently.** It's copy-once, so a
   project scaffolded before "List: Table" existed treats
   `data-list-view="table"` like the Links view instead of erroring. If a
   table renders as a bulleted list, compare `scripts/list.js` with the
   current WebHaste version (supported views: `links`, `directory`, `table`).
   The same applies to the `cs-list-rendered` event: a copy without it
   (`grep -c cs-list-rendered scripts/list.js` is `0`) never fires it, so use
   the DataTables fallback recipe or refresh the file (diff first).
3. **`data-list-src` is the published path** `/lists/<slug>.json`, not
   `.webhaste/lists/…` (`.webhaste/` is never published). WebHaste copies each
   *referenced* list to `/lists/` at publish/render time.
4. **Only lists referenced by some page's `data-list-src` are published.** An
   unreferenced list's data stays private — useful, but it also means a list
   you wrote isn't visible anywhere until a page references it. Don't put
   private data in a list that's placed on a public page.
5. **The editor and live Preview show only the placeholder.** `scripts/*.js`
   can't run in the preview iframe. Real rendering happens on the published
   site, or a Render to Local Folder / Packaged build opened in a browser tab.
   Don't "fix" the placeholder.
6. **Entries are keyed by field `key`, not label.** Renaming a field's `key`
   in the JSON orphans its values in every entry. Keep keys stable; change
   `label` freely.

## Workflow

1. **Design the fields** — only `text`, `date`, `link`, `image` exist (see
   list-format.md). Pick the sort field and direction; decide on pagination.
2. **Write the list file** — `.webhaste/lists/<slug>.json`, valid JSON.
   Slug: lowercase letters, digits, hyphens. Prefer descriptive field keys
   (`first-name`, not `new-field-3`).
3. **Place it** — in the page fragment, inside the standard block wrapper,
   using the exact markup in list-format.md. Choose the view that fits:
   `links` (a simple `<ul>`), `directory` (cards, every field labeled),
   `table` (a real `<table>`).
4. **Check the template** loads `list.js` (gotcha 1).
5. **Verify** — `node .webhaste/compose.js --out .agent-preview`, then
   confirm `.agent-preview/lists/<slug>.json` exists and the composed page
   contains both the `data-list-src` placeholder and the `list.js` script
   tag. Delete `.agent-preview/`. You can't see the rendered list from here;
   say so and tell the owner to check a Render to Local Folder or published
   copy.

## Editing an existing list

Edit entries/fields directly in the JSON when asked. Keep every entry's keys
matching `fields[].key`, dates as `yyyy-mm-dd`, and image/link values valid
paths/URLs. If the owner has the List Manager dialog open in the extension,
they should close and reopen it to see file changes (and shouldn't Save an
old view over yours). The dialog also offers CSV import (appends, matches
columns by field label) and export, which is often easier for large data
sets than writing entries by hand — mention it when someone has a spreadsheet.

## Migrated or imported sites

Repeating content on a migrated site (team members, projects, services,
blog index) is a candidate for a List, but converting it changes how it's
rendered (client-side) and indexed (see above). Offer it in notes rather
than converting unasked.

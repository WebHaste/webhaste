# Content Blocks

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
it in `.webhaste/blocks/<name>.html` as its own file instead of inlining
it. Anything there shows up as an insertable block tile in the editor's
Blocks dialog, labeled from the filename, and can be reused without
duplicating markup by hand. Write just the inner markup in that file —
*not* the `cs-block` wrapper shown above. The wrapper (with a freshly
generated id) is added by the editor at the moment a block is inserted
onto a page, not stored in the block's own source file.

**See `.webhaste/block-library.md`** for the full list of blocks actually
available in this site's Blocks dialog — both the extension's built-in
ones (Hero, CTA, Testimonial, etc., with their real markup for this site's
`cssFramework`) and this site's own custom ones. It's generated, not
hand-written — regenerated every time the project folder is opened in the
editor, so hand edits to it won't stick. Add blocks by dropping a new file
into `.webhaste/blocks/`, not by editing `block-library.md` directly.

## Lottie/JSON animations

The built-in "Lottie Animation" block wires an uploaded `.json` (Lottie/
Bodymovin export) into a page via `data-lottie-src="/assets/name.json"` —
uploaded through the Assets dialog like an image. `scripts/lottie.min.js`
(player library) and `scripts/lottie-init.js` (this site's glue, finds
every `[data-lottie-src]` element and plays it) are already scaffolded;
the template needs both `<script>` tags added by hand, same as
`lunr.min.js`/`search.js` in "SEO & Search" — nothing auto-injected.

This block **only ever shows a static placeholder in the WebHaste
editor** — Visual view and live Preview alike — never the real animation.
`scripts/*.js` can't execute inside the preview iframe (same restriction
that blocks a site's own `scripts/main.js` there), so this is expected,
not broken. Check the real animation on the published site, or a "Render
to Local Folder"/"Packaged" build opened in a normal browser tab.

It also works fully offline under **Packaged** (no server, opened straight
from disk) — same as site search: each page's referenced animation JSON
gets embedded inline automatically instead of fetched, since `file://`
pages can't fetch anything. Nothing to configure for this.

## Lists

The built-in "List: Links", "List: Directory", and "List: Table" blocks
render an admin-managed list — set up from Site Admin → 🗂️ Lists (fields,
sort order, optional pagination, entries) — into a page, via a
`data-list-src="/lists/<slug>.json"` placeholder wired to one specific
list through the block's own 🗂️ toolbar button.

"List: Table"'s placeholder is a real `<table>` (list.js only repopulates
its `<thead>`/`<tbody>`), pre-filled with that framework's default table
class — `table` (Bootstrap 5) or `table-auto` (Tailwind) — as plain markup
you can edit in Code view like any other block's classes, since there's no
dedicated dialog for it (the ⚙ cog only edits `<div>` wrappers). Its
pagination controls render as a sibling right after `</table>`, not inside
it — a `<div>` can never be a valid direct child of `<table>`.

**The template must load `scripts/list.js`** (already scaffolded; add the
tag by hand, same as `lottie-init.js`/`search.js` above — nothing
auto-injected) or the block renders nothing but its placeholder on the
*live* site, not just in the editor:

```html
<script src="/scripts/list.js"></script>
```

Field types drive rendering: `link` → real `<a href>` (and for "List:
Links", makes the whole entry clickable), `image` → real `<img src>`,
`date`/`text` → plain text, with a `date` value reformatted for display
(e.g. "Sept. 28, 2026") rather than shown as its raw stored `yyyy-mm-dd`.
Every rendered piece gets a `cs-list-field cs-list-field--<type>` /
`cs-list-item` / `cs-list--links`/`cs-list--directory` class to style —
same `cs-*` convention as search's result classes — except "List: Table",
which renders plain `<th>`/`<td>` with no extra classes (a field's label
becomes the `<th>` text; a real `<table>`'s own semantics are already
what you'd style directly).

Only a list actually referenced by a `data-list-src` on some page gets
published to `/lists/<slug>.json` — one an admin filled in but hasn't
placed anywhere yet stays private. Same placeholder-only-in-editor
behavior as Lottie above, and same offline-Packaged support too: each
page's referenced list data gets embedded inline automatically instead of
fetched, since `file://` pages can't fetch anything. Nothing to configure
for this. Pagination, when enabled, is entirely client-side
(`?list_<slug>_page=N` in the URL) — there's no separate crawlable page
per page-number.

**Optional DataTables on "List: Table"** (not bundled — site adds it
itself): CDN `<link>`/`<script>` for DataTables 3.x in the template's
`<head>` (no jQuery needed in 3.x — a 2.x script build would require it), an
`id` on the block's `<table>` (only to target one table), and an init script
that waits for the list to render — don't initialize on page load, the rows
aren't there yet. `list.js` fires a bubbling `cs-list-rendered` event on each
list element after every draw (and sets `data-list-rendered="true"`), so
`document.addEventListener("cs-list-rendered", e => new DataTable(e.target, { order: [] }))`
(guarded to run once per table) works in served and Packaged builds. That
needs a current `scripts/list.js` (copy-once; `grep -c cs-list-rendered
scripts/list.js` is `0` on an older copy); the older fallback is a check-first
`MutationObserver` on the `<tbody>`, because an observer alone never fires in a
Packaged build (rows already exist at `DOMContentLoaded`). Turn the list's own pagination off (it conflicts
with DataTables' paging). Doesn't run in editor preview (CSP); a Packaged
build needs DataTables vendored into `scripts/` to work fully offline. See
`CLAUDE.md`, "Optional: DataTables on a List: Table", for the full snippets.

See this project's `CLAUDE.md`, "Lists" section, for the full story.

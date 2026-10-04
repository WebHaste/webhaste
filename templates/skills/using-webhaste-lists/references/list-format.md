# List file and block markup

## `.webhaste/lists/<slug>.json`

```json
{
  "name": "Team",
  "fields": [
    { "key": "photo",  "label": "Photo",  "type": "image" },
    { "key": "name",   "label": "Name",   "type": "text" },
    { "key": "role",   "label": "Role",   "type": "text" },
    { "key": "joined", "label": "Joined", "type": "date" },
    { "key": "bio",    "label": "Profile","type": "link" }
  ],
  "sortField": "name",
  "sortOrder": "asc",
  "pagination": { "enabled": false, "perPage": 10 },
  "entries": [
    {
      "photo": "/assets/jane.jpg",
      "name": "Jane Smith",
      "role": "Owner",
      "joined": "2019-04-02",
      "bio": "/team/jane.html"
    }
  ]
}
```

- **`name`** — display name (shown in the placeholder and the List Manager).
  The file's slug is separate.
- **`fields`** — ordered. Each `{ key, label, type }`:
  - `key`: unique within the list; entries use it as their property name.
  - `label`: shown as the table column heading and as the label in the
    Directory view (and used as an image's `alt`).
  - `type`: exactly one of `text`, `date`, `link`, `image`. Other values are
    unsupported.
- **`sortField`** — a field `key`, or `""` to keep the entries' file order.
  **`sortOrder`** — `"asc"` or `"desc"`. Sorting compares the *stored* string
  values, so `yyyy-mm-dd` dates sort correctly and text sorts alphabetically;
  numbers stored as text sort as text (`"10"` before `"9"`), so zero-pad or
  prefer another sort field.
- **`pagination`** — `{ "enabled": bool, "perPage": number }`. Client-side
  only; there are no separate URLs per page.
- **`entries`** — array of objects keyed by field `key`. A missing key renders
  as empty. Value formats:
  - `text`: plain text (not HTML).
  - `date`: `yyyy-mm-dd`; displayed as e.g. "Sept. 28, 2026".
  - `link`: a URL or root-relative path (`/blog/post.html`, `https://…`).
  - `image`: a root-relative path to a file in `assets/` (`/assets/jane.jpg`).
    Content images belong in `assets/`; see `building-webhaste-site` for the
    `assets/` vs `elements/` split.

Valid JSON only (no trailing commas or comments). The List Manager dialog
writes this same file, so hand edits and dialog edits are interchangeable.

## What each view renders

- **`links`** — `<ul>` with one `<li><a>` per entry. The entry's first `link`
  field supplies the destination; every other non-image field's value (plus an
  image field, if any) becomes the clickable content. An entry with no link
  value still renders as an `<a>` with `href="#"` (a dead link), so give every
  entry a link, or use the `directory`/`table` views for unlinked data.
- **`directory`** — a grid of cards; each entry shows *every* field labeled
  with its own `label`. `link` fields become real links, `image` fields real
  `<img>`s.
- **`table`** — a real `<table>`: field labels become the `<th>` cells in
  `<thead>`, one `<tr>` per entry, in field order. `link` fields become
  `<a>`s; `image` fields `<img>`s inside their cell.

Rendered elements carry `cs-list-item`, `cs-list-field cs-list-field--<type>`,
and `cs-list--links` / `cs-list--directory` on the container; the table view
renders plain `<th>`/`<td>` with no extra classes. Style them from the site's
CSS, scoping rules per view (e.g. `.cs-list--links .cs-list-field--text`).
Pagination controls use `cs-list-pagination`.

## Block markup to place in a page fragment

Each placement is a standard block wrapper around a placeholder wired with
`data-list-src` and `data-list-view`. The wrapper `id` must be unique on the
page (any `cs-block-xxxxxxxx` string). The `cs-block--<type>` class is
`cs-block--list-links`, `cs-block--list-directory`, or `cs-block--list-table`.

**Links / Directory** (`data-list-view="links"` or `"directory"`):

```html
<div id="cs-block-a1b2c3d4" class="cs-block cs-block--list-directory">
  <div class="cs-list-placeholder" data-list-src="/lists/team.json" data-list-view="directory">
    <span class="cs-list-placeholder__icon">🗂️</span>
    <span class="cs-list-placeholder__label">🗂️ Team</span>
  </div>
</div>
```

**Table** — the placeholder *is* the `<table>`, with a real `<thead>` and
`<tbody>`, because `list.js` only repopulates their contents:

```html
<div id="cs-block-e5f6a7b8" class="cs-block cs-block--list-table">
  <table class="table" data-list-src="/lists/team.json" data-list-view="table">
    <thead></thead>
    <tbody>
      <tr><td class="cs-list-placeholder-cell"><span class="cs-list-placeholder__icon">🗂️</span> <span class="cs-list-placeholder__label">🗂️ Team</span></td></tr>
    </tbody>
  </table>
</div>
```

- Table `class`: `table` (Bootstrap), `table-auto` (Tailwind), or empty for
  no framework; add `table-striped`, `table-sm`, or your own classes freely.
  It's ordinary markup, never injected by script. Match `cssFramework` in
  `site.config.json`.
- Keep `.cs-list-placeholder-cell` on the placeholder row; the DataTables
  recipe waits for it to disappear.
- Don't hand-write rows or `<th>`s into the table; the script replaces them.
- The `data-list-src` slug must match a real file in `.webhaste/lists/`.
- Several lists (or the same list twice) on one page are fine; each
  paginated list tracks its page in its own `?list_<slug>_page=N` parameter.

Prefer inserting blocks with the editor's Blocks dialog and its 🗂️ toolbar
button when the owner is working there; writing the markup by hand is the
route when you're editing files directly.

## Packaged (`file://`) builds

Lists still work: the Packaged target embeds each referenced list's data into
the page (`window.CS_LIST_DATA`), because `fetch()` of local files is blocked.
Nothing to configure. A third-party library such as DataTables loaded from a
CDN still needs internet access in that build (see datatables.md).

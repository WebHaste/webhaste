# Searchable, sortable tables with DataTables

WebHaste doesn't bundle or inject DataTables. A "List: Table" is a real
`<table>` with real `<thead>`/`<tbody>`, so a site can add the free
[DataTables](https://datatables.net) library itself for a search box,
clickable column sorting, and a "show 10/25/50 entries" menu. This is a
recipe in the site's own files, not a WebHaste feature; don't ask for
built-in support.

Four steps, all in the site:

## 1. Turn off the list's own pagination

Set `"pagination": { "enabled": false, … }` in the list's JSON (or in the
List Manager). Otherwise `list.js`'s Previous/Next controls and DataTables'
own paging both render, and `list.js` rebuilding `<tbody>` on a page change
breaks DataTables' internal state.

## 2. Load DataTables in the template `<head>`, after `list.js`

DataTables 3.x needs no jQuery (the 3.1.2 build has no dependencies). Don't
copy a 2.x snippet; the 2.x line's standard build required jQuery. Check
datatables.net for the current version.

```html
<link rel="stylesheet" href="https://cdn.datatables.net/3.1.2/css/dataTables.dataTables.min.css">
<script src="https://cdn.datatables.net/3.1.2/js/dataTables.min.js" defer></script>
```

The template is `.webhaste/templates/<activeTemplate>` (see
`site.config.json`). If a Bootstrap site wants DataTables to match its table
styling, DataTables offers a Bootstrap 5 styling bundle from its download
page.

## 3. Give the table an `id` (single-table version)

On the page with the "List: Table" block, add an `id` to the `<table>` tag
and leave everything else on it alone:

```html
<table id="shows-table" class="table" data-list-src="/lists/shows.json" data-list-view="table">
```

(The multi-table version below needs no ids.)

## 4. Start DataTables only after the rows exist

`list.js` fetches its JSON asynchronously and has no "done" event. **Don't
call `new DataTable()` on page load**: DataTables would initialize against
the one-row placeholder and never notice the real data. Watch `<tbody>`
until the placeholder cell is gone, then initialize. Put this at the bottom
of the page fragment, or in that page's `headCode` in `pages.json`:

```html
<script>
document.addEventListener("DOMContentLoaded", function () {
  var table = document.getElementById("shows-table");
  var tbody = table.querySelector("tbody");
  var obs = new MutationObserver(function () {
    if (tbody.querySelector(".cs-list-placeholder-cell")) return;
    obs.disconnect();
    new DataTable(table, { order: [] }); // [] keeps the list's own sort
  });
  obs.observe(tbody, { childList: true });
});
</script>
```

`order: []` keeps the sort order configured on the list rather than
re-sorting by the first column; remove it to let DataTables sort by column
one.

### Several tables, or every page

To apply DataTables to every "List: Table" on the page without ids, loop over
`table[data-list-src]`. This version can live in the template `<head>` or in
`scripts/main.js` so it covers every page with a list table:

```html
<script>
document.addEventListener("DOMContentLoaded", function () {
  document.querySelectorAll("table[data-list-src]").forEach(function (table) {
    var tbody = table.querySelector("tbody");
    var obs = new MutationObserver(function () {
      if (tbody.querySelector(".cs-list-placeholder-cell")) return;
      obs.disconnect();
      new DataTable(table, { order: [] });
    });
    obs.observe(tbody, { childList: true });
  });
});
</script>
```

Inline `<script>` in a page fragment is fine for a published site, but note
none of this runs in WebHaste's editor or live Preview (the preview's CSP
blocks scripts). Verify in a Render to Local Folder build opened in a browser
tab, or on the published site, and tell the owner you couldn't see it run.

## Things to know

- Link columns stay clickable; image-only columns can't be searched or
  sorted (no text).
- DataTables adds its own wrapper classes (`dt-search`, `dt-length`,
  `dt-paging`) around the table; style them per DataTables' docs.
- **Packaged (`file://`) builds** still render the list, but DataTables from a
  CDN needs internet access. For a truly offline hand-off, download the
  DataTables `.js` and `.css` into `scripts/` and point the two tags at
  `/scripts/…` instead.
- Anything on datatables.net's examples that works on a plain HTML table
  works on a "List: Table" (column visibility, export buttons, fixed headers).

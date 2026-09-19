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

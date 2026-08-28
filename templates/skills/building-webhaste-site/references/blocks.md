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

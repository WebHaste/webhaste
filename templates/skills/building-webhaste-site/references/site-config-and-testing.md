# Site Config, Build Step, and Testing

## Read `.webhaste/site.config.json` before writing markup

Don't assume Bootstrap, `<p>` paragraphs, etc. — they're configurable per
site and change over time. Check this file first:

- `cssFramework` — `bootstrap5`, `tailwind`, or `none`. Write class names
  that match whichever is active; classes for the wrong framework are dead
  weight (or actively wrong) in the published output. This only controls
  which class names nav menus render with — it does NOT pull in the
  framework's actual CSS/JS; that has to be a real `<link>`/`<script>` tag
  in the template's `<head>` (or absent, if `cssFramework` and the template
  markup have drifted apart — check the template itself, not just this
  file, before assuming a framework is actually loaded).
- `paragraphMode` — `p` or `div`. Matches how the visual editor's Enter key
  behaves; hand-written content should follow the same convention so it's
  consistent with what a human editing the same page would produce.
- `activeTemplate` — which template file wraps pages by default (see
  references/pages-and-templates.md for per-page overrides).
- `deploymentTarget` / `deployDirectory` — where "Publish" sends the site.
  Not usually relevant to content edits, but useful context if asked about
  publishing.
- `domain` — the live site's URL (e.g. `https://example.com`). Drives
  `sitemap.xml` generation (see references/seo-and-search.md); no sitemap
  is produced while it's unset.
- `language` — a BCP 47 tag (e.g. `en`, `pt-BR`) that fills the template's
  `{{LANG}}` placeholder for every page site-wide. Individual pages can
  override this — see references/navigation-and-metadata.md.

## No package manager or build step

There's no `package.json`, no `node_modules`, and nothing to `npm install`
— WebHaste never scaffolds any of that into a project (the one exception
is `cssFramework: "tailwind"`, which scaffolds `package.json` +
`tailwind-input.css` + `scripts/custom.css` specifically for compiling
Tailwind's CSS — still nothing else to install). `.webhaste/compose.js` is
a self-contained, dependency-free Node script; running it is the only
"tooling" this repo has. Don't add a `package.json` or install dependencies
for a task unless the user explicitly asks for build tooling beyond what
WebHaste itself provides.

## Testing your changes (requires Node)

Page files are fragments (see references/pages-and-templates.md), so you
can't just open one in a browser to see the real result — it needs the
template/nav/CSS-framework substitution applied first.
`.webhaste/compose.js` does exactly that, headlessly, matching what the
extension's "Render to Local Folder" / Publish would produce:

```
node .webhaste/compose.js --out .agent-preview
```

This writes fully-composed pages (plus `assets/`/`scripts/`) into
`.agent-preview/` inside the project — use a scratch `--out` folder like
this rather than the real `dist/` (or whatever `deployDirectory` is set
to) so you don't clobber the site owner's actual build output. Delete the
scratch folder once you're done checking it; it's not meant to be
committed. Run `node .webhaste/compose.js --help` for the full option
list.

If Node isn't available in this environment, fall back to reasoning from
the template's placeholders and this skill's conventions — there's no
other way to render a page outside the extension itself.

## Do not hand-edit

- `dist/` (or whatever `deployDirectory` points at) — build output from
  "Render to Local Folder," overwritten on every render. WebHaste doesn't
  scaffold a `.gitignore` entry for it, so some projects end up committing
  `dist/` to version control anyway — if so, expect its diffs to show up
  in `git status` after every render; that's expected noise from the
  build, not something to investigate or hand-fix.
- `.webhaste/compose.js`, `.webhaste/compose-core.js`, and
  `.webhaste/block-library.md` — regenerated every time the project
  folder is opened in the editor, so hand edits won't stick. (Unlike
  `CLAUDE.md`, this skill, and `.webhaste/templates/`, which are copied in
  once and then left alone — edit those freely.)
- `sitemap.xml` and `search-index.json` — regenerated on every
  publish/render; see references/seo-and-search.md.
- `.webhaste/` config files (`site.config.json`, `nav.json`, `pages.json`)
  are fine to hand-edit — that's the supported way to bulk-edit them — but
  keep the JSON valid. The editor doesn't validate on load, and a broken
  file falls back to defaults silently rather than erroring.

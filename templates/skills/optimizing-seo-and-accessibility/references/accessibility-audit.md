# Accessibility audit (WCAG-oriented basics)

This covers what can be checked from markup. Anything needing a rendered
page or human testing goes under "Can't verify from here" in the report.

## Template-level (fix once, in `.webhaste/templates/*.html`)

Check the **active template and any per-page template overrides**.

- `<html lang="{{LANG}}">` is present.
- `<meta name="viewport" content="width=device-width, initial-scale=1">` is
  present and doesn't disable zoom (`user-scalable=no`,
  `maximum-scale=1` are problems).
- Landmarks: one `<header>`, one `<main>` around `{{CONTENT}}`, one
  `<footer>`. `{{NAV:<menu>}}` emits only a bare `<ul>` (or `<div>` for
  column/Tailwind layouts) with `cs-menu` classes — **no `<nav>` element and
  no ARIA** — so wrap each placement in the template yourself:
  `<nav aria-label="Primary">{{NAV:header}}</nav>`. Multiple `<nav>`s need
  distinct `aria-label`s (e.g. "Primary", "Footer").
- A **skip link** as the first focusable element:
  `<a class="skip-link" href="#main">Skip to content</a>` with
  `<main id="main">`, styled to be visible on focus.
- The search box (`#cs-search-input`) has a visible label or `aria-label`.
- Don't remove focus outlines in site CSS (`outline: none` without a
  replacement) — report it.
- Menus: confirm the mobile toggle is a real `<button>` with an accessible
  name and `aria-expanded`, not a `<div>`. WebHaste's menu markup is plain
  `<ul>`; any dropdown/hamburger behavior is site JS, so check it.

## Page content (fragments)

### Images
- Every `<img>` has an `alt` attribute.
- Content images: short, specific description of what the image conveys in
  context ("Holstein cows grazing at sunrise"), not "image of…" or a
  filename, and not the site name.
- Decorative images (shapes, dividers, icons beside text that says the same
  thing): `alt=""` (present but empty).
- Images of text or logos: alt = the text. Linked images: alt describes the
  link destination.
- Write alt from nearby headings and captions; if the image's meaning isn't
  clear from context, report it rather than guessing.
- CSS background images carry no alt; if one carries real information, report
  it.

### Headings and structure
- One `<h1>`; no skipped levels; headings are headings, not bold paragraphs.
- Lists are real `<ul>/<ol>/<li>`; tables for data only.
- Data tables have `<th>` cells (with `scope`) and ideally a `<caption>`.
  (WebHaste's "List: Table" renders `<th>`/`<td>` from the list's field
  labels; layout tables should be converted.)

### Links and buttons
- Link text makes sense out of context; multiple identical "Read more"
  links need distinguishing text or `aria-label`.
- Icon-only links/buttons (font-icon `<i>` only) have an accessible name:
  `aria-label="Facebook"`, and the icon element gets `aria-hidden="true"`.
- Links that open a new tab (`target="_blank"`) include `rel="noopener"`.
  Mention the new-tab behavior in the label only if it's confusing.
- Actions are `<button>`s, navigation is `<a href>`; flag `<a>` without
  `href` or `<div onclick>`.

### Forms (usually embedded or placeholders in static sites)
- Every input has a `<label for>` (or `aria-label`); placeholder alone is
  not a label.
- Required fields marked in text, not color alone.
- For embeds, set an iframe `title`.

### Media and embeds
- `<iframe>` has a `title` describing its content (YouTube/Maps/forms).
  The embed dialog supports `title`.
- `<video>` needs captions; `<audio>` a transcript — report if missing.
- Lottie/animation blocks and sliders: auto-playing motion longer than 5 s
  needs a pause control; consider `prefers-reduced-motion` in CSS. Report;
  don't rewrite the animation.
- Decorative Lottie/background animations: `aria-hidden="true"`.

### Language and text
- Passages in another language get a `lang` attribute.
- Avoid ALL-CAPS typed text (use CSS `text-transform`), and avoid text
  justified or tiny. Report; don't rewrite copy.
- Don't convey meaning by color alone.

### ARIA
- Prefer native elements over ARIA. Remove redundant or wrong roles
  (`role="button"` on a `<button>`, `aria-label` that contradicts visible
  text). Fix `aria-labelledby`/`aria-controls` pointing at ids that don't
  exist.
- Page-builder exports (Elementor etc.) often carry noisy or invalid
  attributes; clean them only when clearly wrong.

## Things to flag, not claim

- **Color contrast.** You can sometimes estimate from CSS hex values (body
  text vs. background, button text), and obvious failures (light gray on
  white, white on a pale brand color) are worth listing with a ratio target
  (4.5:1 normal text, 3:1 large text/UI). Don't state a page passes.
- **Keyboard operability** of menus, carousels, modals and accordions.
- **Focus order** and visible focus style.
- **Screen-reader announcements**, zoom/reflow at 400%, touch target size.
- Third-party embeds' own accessibility.

Recommend an actual check with a browser tool (Lighthouse, axe DevTools,
WAVE) and keyboard-only navigation, and say which pages or components to
test first.

## Scripting the scan

Fragments are partial HTML, so a regex/`DOMParser`-style pass over each file
is enough for: missing `alt`, `<img>` without `alt=""` decisions, headings
outline, empty links/buttons, iframes without `title`, duplicate ids, inputs
without labels, `target="_blank"` without `rel`. Run template-level checks on
the **composed** output so the layout's landmarks and nav are included.

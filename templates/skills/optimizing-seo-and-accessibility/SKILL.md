---
name: optimizing-seo-and-accessibility
description: Audit and improve a WebHaste site's SEO and accessibility — page titles and meta descriptions, heading structure, image alt text, link text, schema markup, landmarks, form labels, and other ADA/WCAG basics. Use when asked to optimize, audit, or fix SEO, meta descriptions, alt text, structured data, or accessibility/ADA compliance on a WebHaste project.
---

# Optimizing SEO and Accessibility

This skill is an *audit-and-fix workflow*. How WebHaste produces sitemaps,
search, Open Graph tags and schema is documented in the
`building-webhaste-site` skill
(`references/seo-and-search.md`, `references/navigation-and-metadata.md`) —
read the relevant part of it rather than re-deriving it, and don't duplicate
anything WebHaste already generates.

## What WebHaste already does — don't redo it

- `sitemap.xml`, `search-index.json`, Open Graph / Twitter Card tags, and
  `<meta name="robots" content="noindex">` (from Page Properties) are
  generated at publish/render time. Never hand-write them or put them in a
  page's `headCode`. In particular, **never create a `sitemap.xml` file**: a
  copy in the project root is ignored and never published. If there's no
  sitemap, the cause is a missing `domain` in `site.config.json`.
- Not generated: `<link rel="canonical">` (add via `headCode` — see
  references/seo-audit.md) and `og:image`.
- Organization/LocalBusiness JSON-LD comes from `site.config.json` →
  `schemaMarkup`, on `index.html` only.
- `<title>` and the meta description come from the template's `{{TITLE}}`
  and `{{META_DESCRIPTION}}`, which read each page's `pages.json` entry. So
  most "meta tag" work is really editing `pages.json`.

## What this skill adds

Things WebHaste can't know are right: the *quality* of titles/descriptions,
heading structure, alt text, link text, template landmarks, form labels,
and schema types beyond the homepage's Organization.

## Ground rules

- **Don't invent facts.** Descriptions, alt text and schema values must come
  from the page's actual content or the site's config. Missing business
  details (phone, address, hours) are reported, not made up.
- **Don't rewrite the owner's visible copy.** Fix metadata, attributes and
  structure. Suggest wording changes for body text in the report instead of
  applying them.
- **Fix what's safe; ask or report what's a judgment call.** See the split
  below.
- Page files are body fragments; structural fixes that affect every page
  (landmarks, skip link, `<html lang>`, viewport) belong in the **template**,
  not in each page.
- You can't measure color contrast, keyboard behavior or screen-reader output
  from here. Flag likely problems; don't claim a page "passes".

## Workflow

1. **Orient** — read `.webhaste/site.config.json` (domain, language,
   `schemaMarkup`), the active template, `pages.json`, and `nav.json`.
2. **Audit** — read
   [references/seo-audit.md](references/seo-audit.md) and
   [references/accessibility-audit.md](references/accessibility-audit.md).
   Write a small throwaway Node script (in a scratch folder, not the
   project) to scan every page fragment and `pages.json` rather than eyeballing
   dozens of files. Compose the site (`node .webhaste/compose.js --out
   .agent-preview`) to check template-level and generated output.
3. **Fix the safe items** (below).
4. **Report** — write `SEO-ADA-REPORT.md` at the project root, then delete
   `.agent-preview/`.

## Safe to fix directly

- Missing or too-short/too-long meta descriptions and titles in `pages.json`
  (written from the page's content).
- Missing `alt` on content images; empty `alt=""` on purely decorative ones.
- `title` on iframes; accessible names on icon-only links/buttons
  (`aria-label`).
- Obvious markup errors: duplicate `id`s, empty headings, `<b>`/`<font>`
  misuse for headings, links with bare "click here" text where the target
  makes the label obvious.
- Adding `lang` overrides in `pages.json` for pages clearly in another
  language.

## Report instead of fixing (or ask first)

- Heading hierarchy changes that alter how a page looks (restyling may be
  needed), a missing `<h1>` where no visible title exists.
- Rewriting the template's header/footer structure beyond adding landmarks
  and a skip link.
- Color contrast, font sizes, focus styles, motion/animation concerns.
- Anything needing a business fact you don't have (schema phone/address,
  `sameAs` profiles, a social image).
- Pages that probably should be `noindex` or excluded from the sitemap.
- Thin content.
- Which page to prefer when content is duplicated. Once the owner agrees (or
  it's unambiguous), add canonical tags via `headCode` — see
  references/seo-audit.md.

## Deliverable: `SEO-ADA-REPORT.md`

Sections: **Changed** (file → what, so the owner can review the diff),
**Needs your input** (the judgment calls and missing facts, each with a
specific recommendation), **Can't verify from here** (contrast, keyboard,
screen reader, real-browser behavior — with how to check), and **Already
handled by WebHaste** (so nobody re-adds it). Keep it short enough to read
in a few minutes.

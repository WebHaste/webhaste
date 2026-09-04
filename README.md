# WebHaste Website Builder & Publisher for Chrome

WebHaste is a browser-based website management tool (CMS) for small- to medium-sized informational sites. It runs in any Chromium browser (Chrome, Edge, Brave, etc.). It is designed to let anyone easily edit website pages and publish them directly to Cloudflare Pages or Netlify Pages. It also can render an FTP-ready site that you can host anywhere.

WebHaste is also built from the ground-up to be easy for AI agents to work with. Point your preferred coding agent to your site folder to get help building templates and blocks, as well as generating content directly.

WebHaste does offer a search tool, but otherwise it does not natively handle dynamic elements or server-side processing, such as database-driven features. There are ways to include some of these features using embeds and iframes, but if your site needs advanced features, you probably will want to look at other site management tools.

User-facing help docs and developer docs live at **chromecms.com** (built, naturally, using this extension), not in this README.

## How to install

The preferred installation option for most users is to visit the [Chrome Web Store](https://chromewebstore.google.com/detail/webhaste/ofblooflocfdegjjpgjfbefnjmjmbapa) and install directly from there.

If you are an experienced Chrome developer, you can download/clone/fork the source code from this repo and run it directly in your browser in developer mode.

## How to use WebHaste

Launch the extension in your browser, and then click "Open Project Folder" and then create a new folder or navigate to the directory you have set up for your site files. This directory will be used to store your site content partials, design template and any related settings and metadata.

There is a [Bootstrap 5.x Starter Template](https://github.com/desttools/webhaste-starter-bootstrap) on Github that you can use to accelerate your template and block development.

There is a [Tailwind Starter Template](https://github.com/desttools/webhaste-starter-tailwind) on Github that you can use to accelerate your template and block development. For sites in Tailwind mode, your local machine will need Node/NPM installed. 

## Special Tailwind Instructions

When working with a Tailwind site, you'll need to launch a Command Prompt or Terminal, navigate to your project's root folder, and run once:

``npm install``

While you're making changes to the site, run this and leave running:

``npm run watch:css``

This generates your site's CSS in real time as you edit the site.

Or you can do a one-time CSS generation by running:

``npm run build:css``

## Render Your Site Locally

If your site is set to "Render to Local Folder" mode, you can specify a sub-folder in your site folder (typically "dist" or "www") that will contain your full, stand-alone site. You can serve directly from this folder, or use an SFTP or WebDAV solution to manually move the locally rendered files to a remote server. 

If you open rendered files directly in a browser, they likely will not appear with the correct styling. You typically will need to move the files to a remote server or view your site locally through an HTTP server instance (Node, Homebrew, etc) — unless you use the **Packaged** deployment target described below, which is built specifically to work without one.

Note: Do not serve a website directly from your project's root folder. Doing this will display page stubs without the proper HTML template and structure. Use the "dist" or "www" folder. That contains the fully rendered site files.

### Packaged deployment (open directly in a browser)

If you need a copy of your site that works when opened straight from disk — no server, no upload — set your Deployment Target to **Packaged** in Site Settings. It composes your site the same way as "Render to Local Folder," except every internal link, image, and script reference is rewritten to a relative path instead of the usual root-relative one, so double-clicking `index.html` (or any other page) inside the rendered folder just works in any browser.

This is a good fit anywhere the person opening the site shouldn't need to install or run anything — a student handing in a class project as a zip file, a quick demo shared by email, a portable copy for a USB drive or shared drive.

A couple of things work differently in a Packaged build:

- **Site search still works** (see below), but instead of a separate `search-index.json` fetched at runtime — which browsers block for local files — the search data is embedded directly into each page.
- **`sitemap.xml`, `robots.txt`, and `404.html` are not included.** All three only make sense for a site with a real domain and a server routing requests to it, neither of which applies to a folder opened directly on your computer.

### Cloudflare Pages and Netlify Pages Integration

WebHaste has tools to deploy rendered sites directly to Cloudflare Pages and Netlify, two popular static HTML hosting services. In most cases, if you deploy to these services your hosting and SSL certificate are provided for free.

In the case of both services, you will need to set up an account with the provider first, set up your hosting, retrieve a connection key, and enter that information in your WebHaste project.

## Site search

Every Publish / Render to Local Folder pass generates `search-index.json` at your site's root — a plain-text extract of every published, non-excluded page's title, meta description, and body content. It isn't turned into a visible search box automatically (WebHaste doesn't inject markup into your template on your behalf, same as CSS framework tags), but the client-side pieces are scaffolded into every project's `scripts/` folder for you:
`scripts/lunr.min.js` (the vendored [Lunr.js](https://lunrjs.com) search
library) and `scripts/search.js` (a small vanilla-JS wrapper that builds an in-memory index from `search-index.json` and renders results).

To turn search on, add this to your template's `<head>` (after `main.js`):

```html
<script src="/scripts/lunr.min.js"></script>
<script src="/scripts/search.js"></script>
```

and place a search box wherever you want one to appear:

```html
<input type="search" id="cs-search-input" placeholder="Search...">
<div id="cs-search-results"></div>
```

`search.js` looks for those two element IDs and wires itself up automatically — a template that doesn't include them simply never loads the index, at no cost. Results render as `<ul class="cs-search-list"><li class="cs-search-item">` entries (or a `<p class="cs-search-empty">` when there are none) — unstyled by default, so style those classes the same way you would any other `cs-*` class from a block or menu.

Page Properties has three checkboxes for keeping individual pages out of these generated files — none of them affect whether the page itself
publishes:

- **Exclude from sitemap.xml** — leaves the page out of `sitemap.xml`.
- **Exclude from site search** — leaves the page out of `search-index.json`.
- **Hide from search engines (noindex)** — adds a real
  `<meta name="robots" content="noindex">` tag to the page.

If your site uses the **Packaged** deployment target, search still works with no extra setup — it just draws on data embedded in each page instead of fetching `search-index.json`. See "Packaged deployment" above.

## How a WebHaste project is put together

```
├── index.html ...              ← page content (fragments — see below)
├── 404.html (don't edit)       ← default 404 page needed for Cloudflare and Netlify
│                                  (not included in Packaged output — see below)
├── package.json                ← Tailwind only — scaffolded automatically when
│                                  cssFramework is "tailwind"; run npm install once
├── tailwind-input.css          ← Tailwind only — real source for scripts/styles.css;
│                                  edit this, not the generated file (see below)
├── assets/                     ← images and files referenced by pages
├── elements/                   ← favicons, template backgrounds, shims
├── scripts/
│   ├── bootstrap.min.css ...   ← Optional if you choose to store a css Framework
│   │                              locally instead of using a CDN (either works)
│   ├── styles.css              ← site-wide CSS
│   │                              Bootstrap: This contains your custom CSS
│   │                              and overrides for the framework's variables
│   │                              Tailwind: generated by `npm run build:css` /
│   │                              `watch:css` from tailwind-input.css — don't
│   │                              edit this file directly
│   ├── custom.css              ← Tailwind only — scaffolded automatically for
│   │                              hand-written CSS/classes that aren't run
│   │                              through the Tailwind build
│   ├── bootstrap.bundle.min.js ← JS for CSS library if stored locally (if needed)
│   ├── scripts.js              ← site-wide custom JS
│   ├── lunr.min.js             ← scaffolded automatically — search library, see below
│   └── search.js               ← scaffolded automatically — search UI logic, see below
├── search-index.json           ← generated at publish/render time, alongside sitemap.xml
├── dist/                       ← generated build output — deploy this, don't hand-edit
└── .webhaste/
    ├── site.config.json        ← framework, paragraph mode, deploy target
    ├── nav.json                ← header/footer menu structure
    ├── pages.json              ← optional per-page <title>/meta overrides
    ├── block-library.md        ← generated list of available blocks
    ├── blocks/                 ← this site's reusable custom blocks
    ├── templates/              ← page layout(s); active one set in config
    ├── compose.js              ← generated — headless preview renderer
    └── compose-core.js         ← generated — shared substitution logic
```

### Page files are fragments, not full documents

Every `*.html` file at the project root is just the **body content** for
that page.

### The template controls everything around the content

The template defines where these placeholders go:

| Placeholder            | Filled with                                   |
| ----------------------- | ---------------------------------------------- |
| `{{CONTENT}}`           | The current page's fragment                    |
| `{{TITLE}}`              | From `pages.json`, or a default built from the filename + site name |
| `{{META_DESCRIPTION}}`  | From `pages.json`, or blank                    |
| `{{NAV:header}}` / `{{NAV:footer}}` | Rendered menu markup from `nav.json`, per the framework in use |
| `{{SITE_NAME}}`         | From `site.config.json`                        |
| `{{YEAR}}`              | Current year                                   |
| `{{LANG}}`              | Used in the page language declaration          |

`cssFramework` only controls which class names `{{NAV:...}}` renders with
(Bootstrap, Tailwind, or plain). It does not pull in that framework's actual
CSS/JS — add a real `<link>`/`<script>` tag to the template's `<head>`
yourself (a CDN URL, or a local file under `scripts/`) if you want one.

Setting `cssFramework` to `tailwind` is the one exception that scaffolds
something extra: since Tailwind's no-build CDN script doesn't work inside
WebHaste's own preview, a `package.json` and `tailwind-input.css` get added
to the project root (plus `scripts/custom.css` for hand-written CSS) so you
can compile Tailwind locally with `npm install` then `npm run build:css` /
`npm run watch:css`. You still add the resulting `<link
href="/scripts/styles.css">` to your template yourself, same as any other
framework choice.

To build your own template, copy one of the existing files in
`.webhaste/templates/`, adjust markup, and point `activeTemplate` at it.

For how the extension itself is built — the File System Access storage
model, block library, publish pipeline, and headless rendering internals —
see [CLAUDE.md](CLAUDE.md).
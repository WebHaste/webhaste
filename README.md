# WebHaste Website Builder & Publisher for Chrome

WebHaste is a browser-based website management tool (CMS) for small- to medium-sized informational sites. It runs in any Chromium browser (Chrome, Edge, Brave, etc.). It is designed to let anyone easily edit website pages and publish them directly to Cloudflare Pages or Netlify Pages. It also can render an FTP-ready site that you can host anywhere.

WebHaste is also built from the ground-up to be easy for AI agents to work with. Point your preferred coding agent to your site folder to get help building templates and blocks, as well as generating content directly.

WebHaste does not natively handle dynamic elements or server-side processing, such as database-driven features. There are ways to include some of these features using embeds and iframes, but if your site needs those, you probably will want to look at other site management tools.

User-facing help docs and developer docs live at **chromecms.com** (built, naturally, using this extension), not in this README.

## How to install

The preferred installation option for most users is to visit the Chrome Web Store and install directly from there.

If you are an experienced Chrome developer, you can download/clone/fork the source code from this repo and run it directly in your browser in developer mode.

## How to use WebHaste

Launch the extension in your browser, and then navigate to the folder you have set up for your site files. This directory will be used to store your site content partials, design template and any related settings and metadata.

There is a [Bootstrap 5.x Starter Template](https://github.com/desttools/chromesite-starter-bootstrap) on Github that you can use to accelerate your template and block development.

Note: Do not serve a website directly from your project's root folder. Doing this will display page stubs without the proper HTML template structure. If your site is set to "Render to Local Folder" mode, you can specify a sub-folder in your site folder (typically "dist" or "www") that will contain your full, stand-alone site. You CAN serve directly from this location, or use a sync to move it to your hosting server. You also can use an SFTP solution to manually move the files to a server if needed.

### Cloudflare Pages and Netlify Pages Integration

WebHaste has tools to deploy rendered sites directly to Cloudflare Pages and Netlify Pages, two popular static HTML hosting services. In most cases, if you deploy to these services your hosting and SSL certificate are provided for free.

In the case of both services, you will need to set up an account with the provider first, and set up your Pages project.

## How a WebHaste project is put together

```
├── index.html ...              ← page content (fragments — see below)
├── 404.html (don't edit)       ← default 404 page needed for Cloudflare and Netlify
├── assets/                     ← images and files referenced by pages
├── elements/                   ← favicons, template backgrounds, shims
├── scripts/
│   ├── styles.css              ← site-wide custom CSS (layered on top
│   │                              of the chosen cssFramework)
│   └── scripts.js              ← site-wide custom JS
├── dist/                       ← build output — generated, don't hand-edit
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
| `{{FRAMEWORK_ASSETS}}`  | CSS/JS tags for whichever `cssFramework` is configured |
| `{{SITE_NAME}}`         | From `site.config.json`                        |
| `{{YEAR}}`              | Current year                                   |

To build your own template, copy one of the existing files in
`.webhaste/templates/`, adjust markup, and point `activeTemplate` at it.

For how the extension itself is built — the File System Access storage
model, block library, publish pipeline, and headless rendering internals —
see [CLAUDE.md](CLAUDE.md).
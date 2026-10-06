# Changelog

What changed in each WebHaste release, newest first. Write entries for the
people using WebHaste (what they'll notice), not for the code.

`scripts/package-extension.ps1` turns the `[Unreleased]` section into the
new version's section when you package a release. Keep adding to
`[Unreleased]` as you work. The same text is published at
https://chromecms.com/docs/changelog.html and pasted into the GitHub Release
and the Chrome Web Store "what's new" field.

Version boundaries for 0.4.0 – 0.6.2 were reconstructed from commit dates.

## [Unreleased]

## [0.6.3] - 2026-10-06

### Added
- **`</> Code` toolbar button** wraps the selected text in `<code>`; click inside existing code to remove it.
- **`⚓ Anchor` toolbar button** sets an ID on the paragraph or heading you're in, so links can jump to it. The Link dialog suggests the page's IDs as `#id` entries.
- **About WebHaste** dialog (Site Admin menu) shows the installed version.
- Switching projects now logs a "Switched project to …" line in the status bar history.

### Changed
- The status bar resets to "✅ Ready..." when you switch projects instead of showing the previous site's last message.
- Links inside dialogs use light colors that are readable on the dark theme.

### Fixed
- Dragging the editor/preview divider to the right could get stuck when the pointer moved over the preview. It now follows the pointer reliably.
- Headless rendering (`.webhaste/compose.js --out …`) no longer treats the deploy folder as source pages.
- New projects' `.gitignore` now ignores `.webhaste/backups/`.

## [0.6.2] - 2026-10-04

### Added
- Lists fire a `cs-list-rendered` event after rendering, for scripts that enhance the output (for example DataTables).

### Fixed
- The DataTables recipe now works in Packaged builds.
- Toolbar brand icon no longer grows too wide.
- Skills index renamed to `skills-index.json` (the Chrome Web Store rejects packages with more than one `manifest.json`).

## [0.6.1] - 2026-10-03

### Added
- Versioned skill scaffolding: projects get a `building-webhaste-site` skill (plus new agent skills) that is refreshed when WebHaste updates, without overwriting your own edits.

### Fixed
- Packaged (`file://`) builds: inline search/Lottie/List data no longer breaks pages whose text contains `</script>`.
- Packaged builds: List links and extensionless links (`/blog/my-post`) now point at the real `.html` files.

## [0.6.0] - 2026-10-01

### Added
- Optional **Templates / Styles / Scripts** tabs (Site Settings → "Enable template, style & script editing") for editing those files in code view, with live preview of template and stylesheet changes.
- The live preview keeps its scroll position as you type.

## [0.5.2] - 2026-09-30

### Added
- Lists: a "Remove all" button for entries.

### Fixed
- Lists no longer leave a placeholder class behind on rendered output.

## [0.5.1] - 2026-09-29

### Added
- Lists: **table** output option, import/export, and drag handles for sorting entries.

### Fixed
- False "changed elsewhere" warning while editing in Code view.

## [0.5.0] - 2026-09-28

### Added
- **Lists**: structured, repeatable content (blog indexes, directories, price lists) managed from Site Admin → Lists and displayed with a List block.

## [0.4.0] - 2026-09-24

### Added
- **Redirects**: 301/302 rules from Site Admin → Redirects, published as a `_redirects` file for Cloudflare Pages and Netlify.
- **Link checking**: the Menu editor flags broken internal links as you type, and Site Admin → Check Links scans the whole site.
- Creates new Site Settings dropdown in toolbar, which consolidates
Settings, Menus, Redirects and Check Links into one dropdown

### Fixed
- Redirects now take effect on Cloudflare Direct Upload publishes.


## [0.3.3] - 2026-09-21

### Added
- Interface updates, including tweaks to colors and button hover styles.

### Fixed
- Includes Google Sans font as part of package to remove external call to Google Fonts.


## [0.3.2] - 2026-09-18

### Added
- Editor Support and front-end JS needed to display Lottie Animations
- Added schemaMarkup support, which can be added automatically to site homepages; support for Organization or LocalBusiness variants.
- Created new Max Size option in site settings; Extension now resizes images larger than 1920px on their longest edge (or whatever value set in Site Settings).

### Fixed
- Added mask on locked editor blocks to prevent errant clicks
- Update SKILL.md and CLAUDE.md to better document /assets, /elements and /scripts folder structure


## [0.3.1] - 2026-09-11

### Added
- Per-page header scripts, support for OpenGraph/Twitter tags

### Fixed
- Reworded Deployment dropdown wording for clarity


## [0.3.0] - 2026-09-04

### Added
- Editor support for HTML tables, ability to edit directly in visual view
- Improve pasted content scrubbing
- Add Packaged deployment option for self-contained sites or local previewing


## [0.2.4] - 2026-09-03

### Added
- Hide/show toggle for preview pane, allowing editor pane to use majority of screen on smaller devices
- Include search markup by default in simple-layout.html
- styles.css now scaffolded by default, includes starter CSS for search box
- Added more emojis to editor, because why not?

### Fixed
- Added viewport tag on simple-layout.html to fix mobile display


## [0.2.3] - 2026-09-01

### Added
- Special characters/emojis dialog to editor, now includes commonly used characters and emojis
- Ability to lock a div or block from edits in editor pane


## [0.2.2] - 2026-08-28

### Added
- SKILL.md created for "building a WebHaste Site," which expands upon what CLAUDE.md includes


## [0.2.1] - 2026-08-27

### Added
- Page Properties now has a Template dropdown that can be used to override the site-wide template; useful for blogs or section-specific pages.
- Page Sidebar now shows green/gold when a page has not been published or has been modified.
- Creates a .webhaste/publish-state.json to track per-page publishing status
- File view, editor and preview panes are now drag-resizable

### Fixed
- Remove duplicate entries in Recent Projects list


## [0.2.0] - 2026-08-24

### Added
- Site Search index now generated at deployment, scaffold lunr.js and search.js for front-end display
- Page Properties now allows pages to be excluded from site search, from the sitemap.xml or rendered with a noindex tag

### Fixed
- Updates documentation and CLAUDE.md for new search feature


## [0.1.4] - 2026-08-17

### Added
- Ability to clone pages


## [0.1.3] - 2026-08-14

### Added
- Support for collapsable folders in files panel

### Fixed
- Path issue in sitemap.xml generation


## [0.1.2] - 2026-08-12

### Added
- Support Tailwind CSS generation at project scaffold
- More editor blocks available
- Now scaffolds and deploys robots.txt and 404.html by default

### Fixed
- Significant refactors to compose/editor scripts
- Fix project deployment creds being lost when switching projects


## [0.1.1] - 2026-08-10

### Added
- Language localization added for entire sites and individual pages
- Added {lang} template token
- Ability to remove or edit existing links in editor

### Fixed
- Remove auto inclusion of scaffolded CSS libs, now favors CDN calls for frameworks (addresses Google policy issue)


## [0.1.0] - 2026-07-27

### Added
- Initial release and Chrome Web Store submission
#!/usr/bin/env node
"use strict";
/*
 * compose.js — headless equivalent of the extension's "Render to Local
 * Folder" (editor.js: renderToLocalFolder()). Composes every *.html page at
 * a site's project root against its active template/nav/site config and
 * writes the result to a dist folder, plus copies of assets/ and scripts/
 * — no browser, no extension install, just Node. Built so an agent (or CI)
 * editing site files directly can check what actually ships, instead of
 * just guessing from the template placeholders.
 *
 * This file lives in two places, and works unmodified in both:
 *   1. this repo's own cli/compose.js — the extension's own dev-tool copy,
 *      requiring "../compose-core.js" (repo root). Point it at any project
 *      with a siteDir argument.
 *   2. <site>/.webhaste/compose.js — auto-scaffolded into every project
 *      by ensureScaffold() in editor.js, alongside a sibling copy of
 *      compose-core.js, so a site is self-contained and composable without
 *      the webhaste extension's source repo being checked out anywhere.
 *      Regenerated on every folder open (not copy-once like CLAUDE.md),
 *      so it never drifts from whatever version of the extension actually
 *      renders the live preview/publish output.
 * Both copies use compose-core.js for the actual substitution logic — the
 * single source of truth also used by the browser extension for Publish /
 * Render to Local Folder, so a headless render here always matches what
 * the extension would produce.
 *
 * Usage:
 *   node compose.js [siteDir] [--out outDir]
 *
 *   siteDir  Project folder to compose. Must contain a .webhaste/ folder.
 *            Default: this site's own root when run from a scaffolded
 *            .webhaste/compose.js, otherwise the current directory.
 *   --out    Output folder, relative to siteDir (default: deployDirectory
 *            from .webhaste/site.config.json, or "dist"). Use this to
 *            render to a scratch folder instead of overwriting the site's
 *            real dist/ output.
 *
 * Exits non-zero with an error if site.config.json/nav.json/pages.json
 * exist but fail to parse — unlike the browser extension, which silently
 * falls back to defaults (see readJSON() below for why that's the wrong
 * call here).
 *
 * No npm dependencies — only Node's built-in fs/path.
 */

const fs = require("fs");
const path = require("path");

// compose-core.js sits next to this file when scaffolded into a site's own
// .webhaste/ (case 2 above), or one level up when this is the webhaste
// repo's own cli/compose.js (case 1).
let WebhasteCompose;
try {
  WebhasteCompose = require("./compose-core.js");
} catch {
  WebhasteCompose = require("../compose-core.js");
}

// When scaffolded, this file's parent directory is literally named
// .webhaste/ — use that as the signal to default siteDir to the site's
// own root, so `node .webhaste/compose.js` works regardless of the
// caller's cwd. The repo dev-tool copy has no such parent and keeps
// defaulting to cwd, since it's meant to be pointed at whatever project a
// webhaste contributor is testing against.
const scaffoldedSiteRoot = path.basename(__dirname) === ".webhaste" ? path.join(__dirname, "..") : null;

const DEFAULT_CONFIG = {
  siteName: "My Site",
  domain: "",
  paragraphMode: "p",
  activeTemplate: "simple-layout.html",
  cssFramework: "bootstrap5",
  deploymentTarget: "cloudflare",
  deployDirectory: "dist",
};

const DEFAULT_NAV = {
  menus: {
    header: [
      { label: "Home", href: "/index.html" },
      { label: "About", href: "/about.html" },
    ],
    footer: [{ label: "Contact", href: "/contact.html" }],
  },
};

// Same stripped-character set as sanitizeDeployDirectory() in editor.js.
function sanitizeDeployDirectory(input) {
  const cleaned = (input || "").trim().replace(/[\\/:*?"<>|]+/g, "");
  return cleaned || "dist";
}

// Unlike readJSONFile() in editor.js (which silently falls back to defaults
// on any failure — fine there, since a human sees the live preview look
// wrong and investigates), this distinguishes "file doesn't exist yet"
// (expected on a fresh scaffold, fall back quietly) from "file exists but
// isn't valid JSON" (a real error). An agent running this CLI has no live
// preview to notice something's off, so composing against silent defaults
// here would produce a plausible-looking render of the WRONG config and
// let a broken nav.json/site.config.json/pages.json go unnoticed.
function readJSON(filePath, fallback) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    console.error(`Invalid JSON in ${filePath}: ${err.message}`);
    console.error("Fix the file and re-run — composing against silent defaults here would hide the problem.");
    process.exit(1);
  }
}

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      count += copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
      count++;
    }
  }
  return count;
}

// Recursively finds every .html page under dir, returning "/"-joined
// relative paths (e.g. "about/team.html") — always "/", never path.join,
// so the ids match the browser side's convention and pagesData[relPath]
// lookups work identically on Windows and POSIX. `exclude` is a set of
// top-level folder names (assets/scripts/.webhaste/the dist dir) that
// must be skipped so re-running compose doesn't rediscover its own prior
// output as new source pages.
function collectHtmlFiles(dir, exclude, prefix = "") {
  let results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (prefix === "" && exclude.has(entry.name)) continue;
      results = results.concat(
        collectHtmlFiles(path.join(dir, entry.name), exclude, prefix ? `${prefix}/${entry.name}` : entry.name)
      );
    } else if (entry.isFile() && entry.name.endsWith(".html")) {
      results.push(prefix ? `${prefix}/${entry.name}` : entry.name);
    }
  }
  return results;
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      "Usage: node compose.js [siteDir] [--out outDir]\n\n" +
        "  siteDir  Project folder to compose (default: this site's own root if\n" +
        "           run from a scaffolded .webhaste/compose.js, else cwd)\n" +
        "  --out    Output folder, relative to siteDir (default: deployDirectory\n" +
        "           from .webhaste/site.config.json, or \"dist\")"
    );
    process.exit(0);
  }
  let siteDir = null;
  let outDir = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") {
      outDir = argv[++i];
    } else if (!siteDir) {
      siteDir = argv[i];
    }
  }
  return { siteDir: siteDir || scaffoldedSiteRoot || process.cwd(), outDir };
}

function main() {
  const { siteDir, outDir } = parseArgs(process.argv.slice(2));
  const root = path.resolve(siteDir);
  const cfgDir = path.join(root, ".webhaste");

  if (!fs.existsSync(cfgDir)) {
    console.error(`No .webhaste/ folder found in ${root} — is this a WebHaste project?`);
    process.exit(1);
  }

  const config = readJSON(path.join(cfgDir, "site.config.json"), DEFAULT_CONFIG);
  const navData = readJSON(path.join(cfgDir, "nav.json"), DEFAULT_NAV);
  const pagesData = readJSON(path.join(cfgDir, "pages.json"), {});

  let templateText = null;
  if (config.activeTemplate) {
    const templatePath = path.join(cfgDir, "templates", config.activeTemplate);
    if (!fs.existsSync(templatePath)) {
      console.error(`activeTemplate "${config.activeTemplate}" not found at ${templatePath}`);
      process.exit(1);
    }
    templateText = fs.readFileSync(templatePath, "utf8");
  }

  const distName = sanitizeDeployDirectory(outDir || config.deployDirectory);
  const distDir = path.join(root, distName);
  fs.mkdirSync(distDir, { recursive: true });

  const exclude = new Set(["assets", "scripts", "elements", ".webhaste", distName]);
  // Drafts (pages.json status: "draft", set via the extension's Page
  // Properties dialog) are skipped here the same way Publish/Render to
  // Local Folder skip them — WebhasteCompose.isDraftPage() is the single
  // source of truth for both, so this CLI never ships a page the extension
  // itself would exclude.
  const pageFiles = collectHtmlFiles(root, exclude).filter(
    (relPath) => !WebhasteCompose.isDraftPage(pagesData[relPath])
  );

  const pageEntries = [];
  for (const relPath of pageFiles) {
    const srcPath = path.join(root, relPath);
    const rawContent = fs.readFileSync(srcPath, "utf8");
    const composed = WebhasteCompose.composePage({
      templateText,
      rawContent,
      title: relPath,
      config,
      navData,
      pagesData,
    });
    const dest = path.join(distDir, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, composed);
    pageEntries.push({
      relPath,
      lastmod: fs.statSync(srcPath).mtime.toISOString().slice(0, 10),
      rawContent,
    });
  }

  const assetCount = copyDirRecursive(path.join(root, "assets"), path.join(distDir, "assets"));
  const scriptCount = copyDirRecursive(path.join(root, "scripts"), path.join(distDir, "scripts"));
  const elementCount = copyDirRecursive(path.join(root, "elements"), path.join(distDir, "elements"));

  // sitemap.xml — regenerated every run from the current page list, same as
  // a real Publish/Render would. buildSitemap() returns null when no domain
  // is configured, since a sitemap of host-less URLs is meaningless.
  const sitemapEntries = pageEntries.map(({ relPath, lastmod }) => ({ path: relPath, lastmod }));
  const sitemap = WebhasteCompose.buildSitemap({ pageEntries: sitemapEntries, pagesData, config });
  if (sitemap) fs.writeFileSync(path.join(distDir, "sitemap.xml"), sitemap);

  // search-index.json — same page list, but keyed off each page's raw
  // pre-composition content (see buildSearchIndex()'s comment in
  // compose-core.js for why: composed output would duplicate nav/footer
  // chrome into every page's indexed text).
  const searchEntries = pageEntries.map(({ relPath, lastmod, rawContent }) => ({
    path: relPath,
    lastmod,
    rawContent,
  }));
  const searchIndex = WebhasteCompose.buildSearchIndex({ pageEntries: searchEntries, pagesData });
  if (searchIndex) fs.writeFileSync(path.join(distDir, "search-index.json"), searchIndex);

  // robots.txt — a real, hand-editable project-root file (see ensureScaffold()
  // in editor.js), copied through untouched rather than regenerated.
  const robotsPath = path.join(root, "robots.txt");
  const hasRobots = fs.existsSync(robotsPath);
  if (hasRobots) fs.copyFileSync(robotsPath, path.join(distDir, "robots.txt"));

  const extras = [sitemap && "sitemap.xml", searchIndex && "search-index.json", hasRobots && "robots.txt"]
    .filter(Boolean)
    .join(", ");
  console.log(
    `Rendered ${pageFiles.length} page(s), ${assetCount} asset(s), ${scriptCount} script(s), and ${elementCount} element(s)${extras ? `, plus ${extras},` : ""} to ${path.join(path.relative(root, distDir) || ".", "/")}`
  );
}

main();

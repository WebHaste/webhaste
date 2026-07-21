/* ---------------------------------------------------------------------
   Local Site Builder — core logic
   ---------------------------------------------------------------------
   Three moving parts:
   1. File System Access API  -> read/write the user's local project folder
   2. Template/layout system  -> wraps raw page content with a shared
      header/nav/footer at PREVIEW and PUBLISH time (not stored in the
      raw files themselves, so editing the nav once updates every page)
   3. Cloudflare Pages Direct Upload API -> ships the composed output
   ------------------------------------------------------------------- */

let dirHandle = null;          // FileSystemDirectoryHandle for the project root
let currentFileHandle = null;  // handle for whatever file is open in the editor
let currentFileName = null;
const fileCache = new Map();   // name -> text content, kept in sync with disk

const HTML_VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);
// Matches an opening or closing tag while respecting quoted attribute
// values, so a stray "<" or ">" inside e.g. title="a > b" doesn't throw off
// tag matching.
const HTML_TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*?)(\/?)>/g;

// Flags unclosed/mismatched HTML tags in Code view via CodeMirror's lint
// addon. CodeMirror ships no HTML linter of its own (only JS/CSS ones that
// need external JSHint/CSSLint), and without this a deleted or mismatched
// closing tag gave zero feedback until the Visual view (or a block's
// move/delete toolbar) broke in some confusing way. This is tag-name
// balance tracking, not a full HTML5 parser — good enough for what
// actually goes wrong (a missing/extra closing tag), not a validator for
// every HTML edge case.
function htmlTagLint(text, options, cm) {
  const annotations = [];
  const stack = [];
  HTML_TAG_RE.lastIndex = 0;
  let match;
  while ((match = HTML_TAG_RE.exec(text))) {
    const [full, closingSlash, rawName, , selfClosingSlash] = match;
    const name = rawName.toLowerCase();
    const start = match.index;
    const end = start + full.length;

    if (closingSlash) {
      let i = stack.length - 1;
      while (i >= 0 && stack[i].name !== name) i--;
      if (i === -1) {
        annotations.push({
          from: cm.posFromIndex(start),
          to: cm.posFromIndex(end),
          message: `Unexpected closing tag </${name}> — no matching opening tag.`,
          severity: "error",
        });
      } else {
        for (let j = stack.length - 1; j > i; j--) {
          annotations.push({
            from: stack[j].from,
            to: stack[j].to,
            message: `Unclosed <${stack[j].name}> tag.`,
            severity: "error",
          });
        }
        stack.length = i;
      }
    } else if (!selfClosingSlash && !HTML_VOID_ELEMENTS.has(name)) {
      stack.push({ name, from: cm.posFromIndex(start), to: cm.posFromIndex(end) });
    }
  }
  for (const open of stack) {
    annotations.push({
      from: open.from,
      to: open.to,
      message: `Unclosed <${open.name}> tag.`,
      severity: "error",
    });
  }
  return annotations;
}

// CodeMirror replaces the plain #codeArea textarea for the "Code" view.
// fromTextArea() hides the original textarea and inserts its own wrapper
// element right after it, so all reads/writes go through the `cm` API
// instead of `.value` from here on.
const cm = CodeMirror.fromTextArea(document.getElementById("codeArea"), {
  mode: "htmlmixed",
  theme: "dracula",
  lineNumbers: true,
  matchBrackets: true,
  autoCloseTags: true,
  styleActiveLine: true,
  tabSize: 2,
  indentUnit: 2,
  gutters: ["CodeMirror-linenumbers", "CodeMirror-lint-markers"],
  lint: { getAnnotations: htmlTagLint, delay: 400 },
});
cm.getWrapperElement().classList.add("hidden");
// setValue() (used when loading a file or switching views) fires "change"
// too — only autosave on edits that actually came from the user typing.
cm.on("change", (instance, changeObj) => {
  if (changeObj.origin === "setValue") return;
  scheduleSave();
});

// ---- Editor enabled/disabled state ----
// No file is open until the user opens or creates one; until then the
// visual/code panes must not look interactable, since saveCurrentFile()
// (further down) is a silent no-op without a currentFileHandle to write to
// — typing there gives the impression content is being saved when it isn't.
function setEditorEnabled(enabled) {
  document.querySelector(".editor-pane").classList.toggle("editor-disabled", !enabled);
  document.getElementById("visualArea").contentEditable = enabled ? "true" : "false";
  cm.setOption("readOnly", enabled ? false : "nocursor");
  document.querySelectorAll("#richControls button, #assetControls button, #viewVisual, #viewCode").forEach((btn) => {
    btn.disabled = !enabled;
  });
}
setEditorEnabled(false);

// Drops whatever file is currently open and re-disables the editor — used
// both when the open file is deleted out from under it, and when switching
// project folders (a file handle from the old folder has no business still
// being live in the editor once a different folder's file list is showing).
function clearEditorState() {
  currentFileHandle = null;
  currentFileName = null;
  cm.setValue("");
  document.getElementById("visualArea").innerHTML = "";
  document.getElementById("previewFrame").srcdoc = "";
  setEditorEnabled(false);
}

const DB_NAME = "site-builder";
const STORE = "handles";

// ---- IndexedDB just to persist the directory handle across sessions ----
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function saveHandle(key, handle) {
  const db = await idb();
  db.transaction(STORE, "readwrite").objectStore(STORE).put(handle, key);
}
async function loadHandle(key) {
  const db = await idb();
  return new Promise((resolve) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}

// ---- Folder picking + listing ----
document.getElementById("pickFolder").addEventListener("click", async () => {
  try {
    dirHandle = await window.showDirectoryPicker();
    await saveHandle("projectDir", dirHandle);
    document.getElementById("folderName").textContent = dirHandle.name;
    clearEditorState();
    await ensureScaffold();
    await refreshFileList();
  } catch (err) {
    setStatus("Folder selection cancelled or failed: " + err.message);
  }
});

// ---- .chromesite/ scaffolding ----
// Creates the config directory (site.config.json, nav.json, templates/) the
// first time a folder is opened, so project settings live in the repo
// itself rather than the browser's extension storage.
const DEFAULT_CONFIG = {
  siteName: "My Site",
  domain: "",
  paragraphMode: "p",
  activeTemplate: "simple-layout.html",
  cssFramework: "bootstrap5",
  deploymentTarget: "cloudflare",
  deployDirectory: "dist"
};
const DEFAULT_NAV = {
  menus: {
    header: [
      { label: "Home", href: "/index.html" },
      { label: "About", href: "/about.html" }
    ],
    footer: [
      { label: "Contact", href: "/contact.html" }
    ]
  }
};

async function getConfigDir(create = true) {
  return dirHandle.getDirectoryHandle(".chromesite", { create });
}

// ---- assets/ — a published (not dot-prefixed) folder for images/files the
// user inserts into pages. Unlike .chromesite/, it doesn't exist until the
// first upload, so callers that only want to *read* it (listing, publish)
// pass create=false and must handle a null return.
async function getAssetsDirHandle(create = false) {
  try {
    return await dirHandle.getDirectoryHandle("assets", { create });
  } catch (err) {
    if (err.name === "NotFoundError") return null;
    throw err;
  }
}

// ---- scripts/ — a published (not dot-prefixed) folder for template-level
// styles.css/main.js, kept separate from assets/ so the assets dialog (an
// "insert into page content" picker) never has to filter them out — it
// simply never reads this folder. Same lazy-create behavior as assets/.
async function getScriptsDirHandle(create = false) {
  try {
    return await dirHandle.getDirectoryHandle("scripts", { create });
  } catch (err) {
    if (err.name === "NotFoundError") return null;
    throw err;
  }
}

// ---- .chromesite/blocks/ — the site-specific extension point for
// BLOCK_LIBRARY (see below). Not auto-scaffolded like templates/, since
// it's opt-in: it doesn't exist until a site owner adds a block file by
// hand, same as assets/.
async function getBlocksDirHandle(create = false) {
  try {
    return await (await getConfigDir(true)).getDirectoryHandle("blocks", { create });
  } catch (err) {
    if (err.name === "NotFoundError") return null;
    throw err;
  }
}

// One block per .html file in .chromesite/blocks/. Content is used as-is
// for any CSS framework, since it's markup the site author already wrote
// for their own site — no editor changes needed to add one, just the file.
async function getCustomBlocks() {
  const dir = await getBlocksDirHandle(false);
  if (!dir) return [];
  const blocks = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== "file" || !name.endsWith(".html")) continue;
    const html = await (await handle.getFile()).text();
    blocks.push({ id: `custom:${name}`, label: labelFromBlockFilename(name), icon: "🧩", html });
  }
  return blocks;
}

function labelFromBlockFilename(name) {
  return name.replace(/\.html?$/i, "").replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const ASSET_MIME_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  pdf: "application/pdf",
  css: "text/css",
  js: "text/javascript",
};
const ASSET_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp"]);

function assetExtension(name) {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

function assetMimeType(name) {
  return ASSET_MIME_TYPES[assetExtension(name)] || "application/octet-stream";
}

function isImageAsset(name) {
  return ASSET_IMAGE_EXTENSIONS.has(assetExtension(name));
}

// Snippet inserted into page content for a given uploaded asset. Root-
// relative (leading /) so it resolves correctly regardless of how deep the
// page it's inserted into ends up living (e.g. /shows/baldknobbers.html) —
// a page-relative "assets/x.png" only survives on top-level pages, since
// browsers resolve it against the URL's own directory, not the site root.
function assetSnippet(name) {
  return isImageAsset(name)
    ? `<img src="/assets/${name}" alt="${name}">`
    : `<a href="/assets/${name}">${name}</a>`;
}

// Lowercases and strips spaces/reserved URL characters from a page filename
// so what's typed in the "New File" prompt is always a safe, predictable
// path segment (e.g. "My Cool Page #1" -> "my-cool-page-1.html").
function slugifyFileName(input) {
  let base = input.trim().replace(/\.html?$/i, "");
  base = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (base || "untitled") + ".html";
}

// Unlike slugifyFileName(), this deliberately preserves case (deploy-folder
// conventions like "docs" or "gh-pages" are case-sensitive and shouldn't be
// mangled) — it only strips characters that would break
// dirHandle.getDirectoryHandle(), which treats the whole string as a single
// path segment, not a nested path.
function sanitizeDeployDirectory(input) {
  const cleaned = (input || "").trim().replace(/[\\/:*?"<>|]+/g, "");
  return cleaned || "dist";
}

async function ensureScaffold() {
  const cfgDir = await getConfigDir(true);

  // site.config.json
  try {
    await cfgDir.getFileHandle("site.config.json");
  } catch {
    await writeJSONFile(cfgDir, "site.config.json", DEFAULT_CONFIG);
  }

  // nav.json
  try {
    await cfgDir.getFileHandle("nav.json");
  } catch {
    await writeJSONFile(cfgDir, "nav.json", DEFAULT_NAV);
  }

  // templates/ + a starter layout, copied in from the extension's own bundled copy
  const templatesDir = await cfgDir.getDirectoryHandle("templates", { create: true });
  try {
    await templatesDir.getFileHandle("simple-layout.html");
  } catch {
    const res = await fetch(chrome.runtime.getURL("templates/simple-layout.html"));
    const text = await res.text();
    const handle = await templatesDir.getFileHandle("simple-layout.html", { create: true });
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
  }

  // CLAUDE.md — agent-facing guide to this project's conventions (fragment
  // pages, template placeholders, nav/pages.json wiring, block format).
  // Lives at the project root, not .chromesite/, so it's discoverable the
  // same way a repo-root CLAUDE.md/AGENTS.md normally is. Same
  // copied-in-once-then-left-alone pattern as simple-layout.html above —
  // never overwritten if the site owner already has one (e.g. edited it, or
  // replaced it with their own).
  try {
    await dirHandle.getFileHandle("CLAUDE.md");
  } catch {
    const res = await fetch(chrome.runtime.getURL("templates/CLAUDE.md"));
    const text = await res.text();
    const handle = await dirHandle.getFileHandle("CLAUDE.md", { create: true });
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
  }

  // compose-core.js + compose.js — a self-contained, dependency-free Node
  // CLI for headlessly rendering this site (see cli/compose.js's own header
  // comment for the full story). Copied into .chromesite/ so the site is
  // composable without the chromesite extension's source repo being
  // checked out anywhere else. Regenerated on every folder open, same as
  // block-library.md below — unlike CLAUDE.md/simple-layout.html, nobody's
  // meant to hand-edit these, and staleness here would mean "the CLI check
  // passed" stops actually meaning "matches what Publish produces."
  for (const name of ["compose-core.js", "cli/compose.js"]) {
    const res = await fetch(chrome.runtime.getURL(name));
    const text = await res.text();
    const destName = name === "cli/compose.js" ? "compose.js" : name;
    const handle = await cfgDir.getFileHandle(destName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
  }

  await populateTemplateDropdown();
  const config = await readJSONFile(cfgDir, "site.config.json", DEFAULT_CONFIG);
  applyParagraphMode(config.paragraphMode);
  await writeBlockLibraryDoc(cfgDir, config.cssFramework || "bootstrap5");
}

async function writeJSONFile(dir, name, obj) {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(obj, null, 2));
  await writable.close();
}

async function readJSONFile(dir, name, fallback) {
  try {
    const handle = await dir.getFileHandle(name);
    const file = await handle.getFile();
    return JSON.parse(await file.text());
  } catch {
    return fallback;
  }
}

async function populateTemplateDropdown() {
  const cfgDir = await getConfigDir(true);
  const templatesDir = await cfgDir.getDirectoryHandle("templates", { create: true });
  const select = document.getElementById("templateSelect");
  select.innerHTML = '<option value="">No layout (raw HTML)</option>';
  for await (const [name, handle] of templatesDir.entries()) {
    if (handle.kind !== "file" || !name.endsWith(".html")) continue;
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  }
  const config = await readJSONFile(cfgDir, "site.config.json", DEFAULT_CONFIG);
  if (config.activeTemplate) select.value = config.activeTemplate;
}

async function tryRestoreFolder() {
  const handle = await loadHandle("projectDir");
  if (!handle) return;
  const perm = await handle.queryPermission({ mode: "readwrite" });
  if (perm === "granted") {
    dirHandle = handle;
    document.getElementById("folderName").textContent = dirHandle.name;
    await ensureScaffold();
    await refreshFileList();
  } else {
    // Chrome requires a user gesture to re-request; show a reconnect hint
    setStatus(`Folder "${handle.name}" needs to be reconnected — click "Open Project Folder".`);
  }
}

document.getElementById("newFile").addEventListener("click", async () => {
  if (!dirHandle) {
    setStatus("Open a project folder first.");
    return;
  }
  let name = prompt("New file name (e.g. about.html):", "untitled.html");
  if (!name) return;
  name = slugifyFileName(name);

  // { create: true } makes getFileHandle create the file if it doesn't exist.
  const handle = await dirHandle.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write("<h1>New page</h1>\n<p>Start writing here.</p>");
  await writable.close();

  await refreshFileList();
  await openFile(name, handle);
  setStatus(`Created ${name}`);
});

async function refreshFileList() {
  const listEl = document.getElementById("fileList");
  listEl.innerHTML = "";
  fileCache.clear();

  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind !== "file") continue;
    if (!name.endsWith(".html")) continue; // scope v0.1 to HTML pages
    const item = document.createElement("div");
    item.className = "file-item";
    item.dataset.name = name;

    const nameEl = document.createElement("span");
    nameEl.className = "file-item-name";
    nameEl.textContent = name;
    if (name === "index.html") {
      const homeIcon = document.createElement("span");
      homeIcon.className = "file-item-home";
      homeIcon.title = "Home page";
      homeIcon.textContent = " 🏠";
      nameEl.appendChild(homeIcon);
    }
    item.appendChild(nameEl);

    const actions = document.createElement("span");
    actions.className = "file-item-actions";
    const propsBtn = document.createElement("button");
    propsBtn.type = "button";
    propsBtn.className = "file-item-action";
    propsBtn.dataset.action = "props";
    propsBtn.title = "Page properties (title, meta description)";
    propsBtn.textContent = "⚙";
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "file-item-action file-item-delete";
    deleteBtn.dataset.action = "delete";
    deleteBtn.title = "Delete page";
    deleteBtn.textContent = "🗑";
    actions.append(propsBtn, deleteBtn);
    item.appendChild(actions);

    item.addEventListener("click", () => openFile(name, handle));
    listEl.appendChild(item);
  }
}

// Delegated so the ⚙/🗑 buttons work no matter how #fileList gets
// re-rendered, and so their clicks can be stopped before they bubble up to
// the row's own "open this file" listener above.
document.getElementById("fileList").addEventListener("click", async (e) => {
  const actionBtn = e.target.closest(".file-item-action");
  if (!actionBtn) return;
  e.stopPropagation();
  const name = actionBtn.closest(".file-item").dataset.name;

  if (actionBtn.dataset.action === "props") {
    await openPagePropertiesDialog(name);
  } else if (actionBtn.dataset.action === "delete") {
    await deletePage(name);
  }
});

// ---- Page Properties dialog — per-page <title>/meta description override ----
const pagePropertiesDialog = document.getElementById("pagePropertiesDialog");
let pagePropsFileName = null;

async function openPagePropertiesDialog(name) {
  pagePropsFileName = name;
  const pagesData = await getPagesData();
  const meta = pagesData[name] || {};
  document.getElementById("pagePropsFileName").textContent = name;
  document.getElementById("pagePropsTitle").value = meta.title || "";
  document.getElementById("pagePropsDescription").value = meta.description || "";
  pagePropertiesDialog.showModal();
}

document.getElementById("pagePropsCancel").addEventListener("click", () => pagePropertiesDialog.close());

document.getElementById("pagePropsSave").addEventListener("click", async () => {
  const title = document.getElementById("pagePropsTitle").value.trim();
  const description = document.getElementById("pagePropsDescription").value.trim();
  const pagesData = await getPagesData();

  if (!title && !description) {
    delete pagesData[pagePropsFileName];
  } else {
    pagesData[pagePropsFileName] = { title, description };
  }

  const cfgDir = await getConfigDir(true);
  await writeJSONFile(cfgDir, "pages.json", pagesData);
  pagePropertiesDialog.close();
  renderPreview();
  setStatus(`Saved properties for ${pagePropsFileName}.`);
});

// ---- Delete page ----
async function deletePage(name) {
  if (!confirm(`Delete "${name}"? This can't be undone.`)) return;

  await dirHandle.removeEntry(name);
  fileCache.delete(name);

  const pagesData = await getPagesData();
  if (pagesData[name]) {
    delete pagesData[name];
    const cfgDir = await getConfigDir(true);
    await writeJSONFile(cfgDir, "pages.json", pagesData);
  }

  if (currentFileName === name) {
    clearEditorState();
  }

  await refreshFileList();
  setStatus(`Deleted ${name}.`);
}

async function openFile(name, handle) {
  currentFileHandle = handle;
  currentFileName = name;
  const file = await handle.getFile();
  const text = await file.text();
  fileCache.set(name, text);
  cm.setValue(text);
  document.getElementById("visualArea").innerHTML = text;
  decorateBlocks();
  renderPreview();
  highlightActiveFile(name);
  setEditorEnabled(true);
}

// ---- Visual / Code view toggle ----
// Both views edit the SAME underlying HTML string in fileCache; switching
// views just serializes whichever one was active into that shared string.
let currentView = "visual";

// <img src="assets/x.jpg"> is correct for the saved file and for published
// output (a real relative path next to the page), but it can't resolve
// inside editor.html itself — that's chrome-extension://<id>/, and the
// actual bytes live only in the user's local project folder, reachable
// only through the File System Access handle, not any URL the browser can
// fetch on its own. So the browser fires an "error" event for every such
// <img> the moment it's inserted (openFile, switchView, or a fresh
// insert). Rather than intercepting every insertion point separately, one
// capture-phase listener (media "error"/"load" don't bubble) catches all of
// them uniformly and swaps in a blob: URL built from the real file — purely
// for display. The clean "assets/x.jpg" value is preserved in
// data-asset-src so serializeVisualArea() (used whenever this view's
// content is read back out, e.g. to save) can restore it — the saved file,
// and therefore published output, must never contain a blob: URL, which is
// only valid for this tab's lifetime.
document.getElementById("visualArea").addEventListener("error", async (e) => {
  const img = e.target;
  if (!img || img.tagName !== "IMG") return;
  const original = img.dataset.assetSrc || img.getAttribute("src");
  // Accepts both "assets/x.jpg" (page-relative) and "/assets/x.jpg" (root-
  // relative) — the latter is what assetSnippet() now emits by default, but
  // hand-authored templates/content may use either form.
  const unrooted = original?.replace(/^\//, "");
  if (!unrooted || !unrooted.startsWith("assets/")) return;
  const assetsDir = await getAssetsDirHandle(false);
  if (!assetsDir) return;
  try {
    const fileHandle = await assetsDir.getFileHandle(unrooted.slice("assets/".length));
    img.dataset.assetSrc = original;
    img.src = URL.createObjectURL(await fileHandle.getFile());
  } catch {
    // File genuinely missing from assets/ — leave it broken.
  }
}, true);

// Appends a move-up/move-down/delete toolbar to every block wrapper that
// doesn't already have one — idempotent, so it's safe to call after any
// wholesale replacement of #visualArea's content (loading a file, switching
// back from Code view, inserting a new block). contenteditable="false" on
// the toolbar keeps it from being treated as editable text by the
// surrounding contenteditable region; serializeVisualArea() strips it back
// out before anything gets saved or published.
function decorateBlocks() {
  document.querySelectorAll("#visualArea .cs-block").forEach((block) => {
    if (block.querySelector(":scope > .cs-block-toolbar")) return;
    const toolbar = document.createElement("div");
    toolbar.className = "cs-block-toolbar";
    toolbar.contentEditable = "false";
    toolbar.innerHTML =
      '<button type="button" data-action="move-up" title="Move block up">↑</button>' +
      '<button type="button" data-action="move-down" title="Move block down">↓</button>' +
      '<button type="button" data-action="delete" title="Delete block">🗑</button>';
    block.appendChild(toolbar);
  });
}

document.getElementById("visualArea").addEventListener("click", (e) => {
  const btn = e.target.closest(".cs-block-toolbar button");
  if (!btn) return;
  e.preventDefault();
  const block = btn.closest(".cs-block");
  if (btn.dataset.action === "delete") {
    if (!confirm("Delete this block? This can't be undone.")) return;
    block.remove();
  } else if (btn.dataset.action === "move-up" && block.previousElementSibling) {
    block.parentNode.insertBefore(block, block.previousElementSibling);
  } else if (btn.dataset.action === "move-down" && block.nextElementSibling) {
    block.parentNode.insertBefore(block.nextElementSibling, block);
  }
  scheduleSave();
});

// Reverts any live-display blob: URLs back to their real "assets/x.jpg"
// path before the content is read out of #visualArea — used any time that
// content needs to leave this view (saving, switching to Code view, etc.).
function serializeVisualArea() {
  const clone = document.getElementById("visualArea").cloneNode(true);
  clone.querySelectorAll("img[data-asset-src]").forEach((img) => {
    img.setAttribute("src", img.dataset.assetSrc);
    img.removeAttribute("data-asset-src");
  });
  clone.querySelectorAll(".cs-block-toolbar").forEach((el) => el.remove());
  return clone.innerHTML;
}

function syncFromActiveView() {
  if (!currentFileName) return;
  if (currentView === "visual") {
    fileCache.set(currentFileName, serializeVisualArea());
  } else {
    fileCache.set(currentFileName, cm.getValue());
  }
}

function switchView(target) {
  syncFromActiveView();
  const html = fileCache.get(currentFileName) || "";
  currentView = target;

  const visualEl = document.getElementById("visualArea");
  const cmEl = cm.getWrapperElement();
  const richControls = document.getElementById("richControls");

  if (target === "visual") {
    visualEl.innerHTML = html;
    decorateBlocks();
    visualEl.classList.remove("hidden");
    cmEl.classList.add("hidden");
    richControls.style.visibility = "visible";
    document.getElementById("viewVisual").classList.add("active");
    document.getElementById("viewCode").classList.remove("active");
  } else {
    cm.setValue(html);
    cmEl.classList.remove("hidden");
    visualEl.classList.add("hidden");
    richControls.style.visibility = "hidden";
    document.getElementById("viewCode").classList.add("active");
    document.getElementById("viewVisual").classList.remove("active");
    // CodeMirror measures layout lazily; it was hidden (display:none) until
    // just now, so it needs a nudge to lay out correctly once visible.
    cm.refresh();
    cm.focus();
  }
  renderPreview();
}

document.getElementById("viewVisual").addEventListener("click", () => switchView("visual"));
document.getElementById("viewCode").addEventListener("click", () => switchView("code"));

// Rich text toolbar — thin wrapper around document.execCommand. It's a
// deprecated API but still functional in Chrome and needs zero external
// libraries, which matters inside an extension's stricter CSP.
document.getElementById("richControls").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-cmd]");
  if (!btn) return;
  document.getElementById("visualArea").focus();
  const cmd = btn.dataset.cmd;
  if (cmd === "createLink") {
    const url = prompt("Link URL:", "https://");
    if (url) document.execCommand(cmd, false, url);
  } else {
    document.execCommand(cmd, false, btn.dataset.value || undefined);
  }
  scheduleSave();
});

document.getElementById("visualArea").addEventListener("input", scheduleSave);

// ---- Asset insertion (Image button + Assets dialog share this) ----
// The rich-text toolbar above gets away with focus()-then-execCommand()
// because the click-to-command gap is instant. Inserting from the Assets
// dialog is not instant — showModal() makes the rest of the page inert and
// moves focus into the dialog, so the Visual view's caret isn't reliably
// where it was just by refocusing #visualArea afterward. Capturing the
// Range up front and restoring it right before execCommand fixes that.
// Code view doesn't need this: CodeMirror keeps its own selection model
// independent of DOM focus.
let savedVisualRange = null;

function captureSelection() {
  if (currentView !== "visual") return;
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) savedVisualRange = sel.getRangeAt(0);
}

function insertSnippet(snippet) {
  if (currentView === "visual") {
    const visualEl = document.getElementById("visualArea");
    visualEl.focus();
    const sel = window.getSelection();
    // A saved range can go stale (nodes no longer in the document) if the
    // user switched files/views between capturing it and inserting — e.g.
    // openFile() replaces visualArea's whole innerHTML. Restoring it in
    // that case would either no-op or throw, so just skip and let
    // insertHTML fall back to wherever the browser places the caret.
    if (savedVisualRange && savedVisualRange.startContainer.isConnected) {
      sel.removeAllRanges();
      sel.addRange(savedVisualRange);
    }
    document.execCommand("insertHTML", false, snippet);
  } else {
    cm.replaceSelection(snippet);
    cm.focus();
  }
  scheduleSave();
}

function blockWrapperAttrs(blockTypeId) {
  return {
    id: `cs-block-${crypto.randomUUID().slice(0, 8)}`,
    className: `cs-block cs-block--${slugifyBlockType(blockTypeId)}`,
  };
}

// Inserts a block. Visual view builds a real DOM node and inserts it via
// Range.insertNode() rather than routing through insertSnippet()'s
// execCommand("insertHTML", ...) — Blink's insertHTML command re-parses and
// "cleans up" the HTML string during insertion, and for a wrapper <div>
// whose only content is several structurally similar block siblings (e.g.
// the 3-column features block: three .col-md-4 divs), that cleanup can
// split/duplicate the wrapper across each child instead of keeping one
// wrapper around the whole block. Building the node ourselves and
// inserting it directly sidesteps that reconciliation entirely. Code view
// has no such quirk — it's plain text, not contenteditable — so it keeps
// using a wrapped string via CodeMirror's own replaceSelection.
function insertBlock(blockTypeId, html) {
  const { id, className } = blockWrapperAttrs(blockTypeId);

  if (currentView === "visual") {
    const wrapper = document.createElement("div");
    wrapper.id = id;
    wrapper.className = className;
    const template = document.createElement("template");
    template.innerHTML = html;
    wrapper.appendChild(template.content);

    const visualEl = document.getElementById("visualArea");
    visualEl.focus();
    const sel = window.getSelection();
    if (savedVisualRange && savedVisualRange.startContainer.isConnected) {
      sel.removeAllRanges();
      sel.addRange(savedVisualRange);
    }

    let range;
    if (sel && sel.rangeCount > 0 && visualEl.contains(sel.getRangeAt(0).startContainer)) {
      range = sel.getRangeAt(0);
      range.deleteContents();
    } else {
      // No usable caret (e.g. a stale/cleared selection) — insert at the
      // end, same fallback spirit as the comment in insertSnippet() above.
      range = document.createRange();
      range.selectNodeContents(visualEl);
      range.collapse(false);
    }
    range.insertNode(wrapper);
    range.setStartAfter(wrapper);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);

    decorateBlocks();
  } else {
    cm.replaceSelection(`<div id="${id}" class="${className}">\n${html}\n</div>`);
    cm.focus();
  }
  scheduleSave();
}

function scheduleSave() {
  syncFromActiveView();
  renderPreview();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveCurrentFile, 400);
}

function highlightActiveFile(name) {
  document.querySelectorAll(".file-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.name === name);
  });
}

// ---- Image button — fast path: pick, upload, insert, done ----
document.getElementById("insertImageBtn").addEventListener("click", () => {
  if (!dirHandle) {
    setStatus("Open a project folder first.");
    return;
  }
  captureSelection();
  document.getElementById("imageFastPathInput").click();
});

document.getElementById("imageFastPathInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = ""; // allow picking the same file again later
  if (!file) return;
  const assetsDir = await getAssetsDirHandle(true);
  const writable = await (await assetsDir.getFileHandle(file.name, { create: true })).createWritable();
  await writable.write(await file.arrayBuffer());
  await writable.close();
  insertSnippet(assetSnippet(file.name));
  setStatus(`Uploaded and inserted ${file.name}.`);
});

// ---- Assets dialog — browse/upload/reuse everything in assets/ ----
const assetsDialog = document.getElementById("assetsDialog");
let assetObjectUrls = [];

function revokeAssetObjectUrls() {
  assetObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  assetObjectUrls = [];
}

async function renderAssetGrid() {
  revokeAssetObjectUrls();
  const grid = document.getElementById("assetGrid");
  grid.innerHTML = "";

  const assetsDir = await getAssetsDirHandle(false);
  if (!assetsDir) {
    grid.innerHTML = '<p class="hint">No assets uploaded yet.</p>';
    return;
  }

  for await (const [name, handle] of assetsDir.entries()) {
    if (handle.kind !== "file") continue;
    const tile = document.createElement("div");
    tile.className = "asset-tile";
    tile.dataset.name = name;

    if (isImageAsset(name)) {
      const url = URL.createObjectURL(await handle.getFile());
      assetObjectUrls.push(url);
      const img = document.createElement("img");
      img.src = url;
      img.alt = name;
      tile.appendChild(img);
    } else {
      const icon = document.createElement("div");
      icon.className = "asset-file-icon";
      icon.textContent = "📄";
      tile.appendChild(icon);
    }

    const nameEl = document.createElement("div");
    nameEl.className = "asset-name";
    nameEl.textContent = name;
    tile.appendChild(nameEl);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "asset-delete-btn";
    deleteBtn.title = `Delete ${name}`;
    deleteBtn.textContent = "✕";
    tile.appendChild(deleteBtn);

    grid.appendChild(tile);
  }

  if (!grid.children.length) {
    grid.innerHTML = '<p class="hint">No assets uploaded yet.</p>';
  }
}

document.getElementById("openAssetsBtn").addEventListener("click", async () => {
  if (!dirHandle) {
    setStatus("Open a project folder first.");
    return;
  }
  captureSelection();
  await renderAssetGrid();
  assetsDialog.showModal();
});

document.getElementById("assetsDialogClose").addEventListener("click", () => assetsDialog.close());

// Covers Close button, Escape, and backdrop dismissal uniformly, unlike
// hanging cleanup off a single button's click handler.
assetsDialog.addEventListener("close", revokeAssetObjectUrls);

document.getElementById("assetGrid").addEventListener("click", async (e) => {
  const deleteBtn = e.target.closest(".asset-delete-btn");
  if (deleteBtn) {
    const tile = deleteBtn.closest(".asset-tile");
    const name = tile.dataset.name;
    if (!confirm(`Delete "${name}"? This can't be undone.`)) return;
    const assetsDir = await getAssetsDirHandle(false);
    if (assetsDir) await assetsDir.removeEntry(name);
    await renderAssetGrid();
    setStatus(`Deleted ${name}.`);
    return;
  }

  const tile = e.target.closest(".asset-tile");
  if (!tile) return;
  // Close BEFORE inserting — showModal() makes the rest of the page inert
  // while open, so #visualArea can't actually take focus (and execCommand
  // then has nothing to insert into) until the dialog is gone.
  assetsDialog.close();
  insertSnippet(assetSnippet(tile.dataset.name));
});

document.getElementById("assetUploadInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const assetsDir = await getAssetsDirHandle(true);
  const writable = await (await assetsDir.getFileHandle(file.name, { create: true })).createWritable();
  await writable.write(await file.arrayBuffer());
  await writable.close();
  await renderAssetGrid();
  setStatus(`Uploaded ${file.name}.`);
});

// ---- Blocks dialog — built-in BLOCK_LIBRARY + site-specific .chromesite/blocks/ ----
const blocksDialog = document.getElementById("blocksDialog");
let blockHtmlById = new Map();

function makeBlockTile(id, icon, label, html) {
  const tile = document.createElement("div");
  tile.className = "block-tile";
  tile.dataset.id = id;
  if (html) {
    blockHtmlById.set(id, html);
  } else {
    tile.classList.add("block-tile-disabled");
    tile.title = "Not available for the site's current CSS framework.";
  }
  const iconEl = document.createElement("div");
  iconEl.className = "block-tile-icon";
  iconEl.textContent = icon;
  const labelEl = document.createElement("div");
  labelEl.className = "block-tile-label";
  labelEl.textContent = label;
  tile.append(iconEl, labelEl);
  return tile;
}

async function renderBlockGrid() {
  blockHtmlById = new Map();
  const grid = document.getElementById("blockGrid");
  grid.innerHTML = "";

  const config = await getSiteConfig();
  const framework = config.cssFramework || "bootstrap5";

  BLOCK_LIBRARY.forEach((block) => {
    grid.appendChild(makeBlockTile(block.id, block.icon, block.label, block.frameworks[framework]));
  });
  (await getCustomBlocks()).forEach((block) => {
    grid.appendChild(makeBlockTile(block.id, block.icon, block.label, block.html));
  });
}

document.getElementById("openBlocksBtn").addEventListener("click", async () => {
  if (!dirHandle) {
    setStatus("Open a project folder first.");
    return;
  }
  captureSelection();
  await renderBlockGrid();
  blocksDialog.showModal();
});

document.getElementById("blocksDialogClose").addEventListener("click", () => blocksDialog.close());

document.getElementById("blockGrid").addEventListener("click", (e) => {
  const tile = e.target.closest(".block-tile");
  if (!tile || tile.classList.contains("block-tile-disabled")) return;
  const html = blockHtmlById.get(tile.dataset.id);
  if (!html) return;
  // Close BEFORE inserting — see the identical comment on the assets grid
  // click handler above for why.
  blocksDialog.close();
  insertBlock(tile.dataset.id, html);
  setStatus("Inserted block.");
});

// ---- Image properties dialog — alt text + framework class presets ----
// Mutates an existing <img> by direct element reference rather than
// inserting new content at a caret, so (unlike insertSnippet) this never
// needs captureSelection()/execCommand — inert (while the dialog is open)
// doesn't block plain DOM property writes the way it blocks focus/Selection.
const imagePropsDialog = document.getElementById("imagePropsDialog");
let selectedImage = null;

document.getElementById("visualArea").addEventListener("click", async (e) => {
  if (currentView !== "visual") return; // belt-and-suspenders; a hidden
  // contenteditable can't dispatch clicks to its descendants anyway.
  const img = e.target.closest("img");
  if (!img) return;
  selectedImage = img;
  await openImagePropsDialog();
});

function presetTokens(name) {
  return name ? name.split(/\s+/).filter(Boolean) : [];
}

async function openImagePropsDialog() {
  const config = await getSiteConfig();
  const framework = config.cssFramework || "bootstrap5";
  const presets = IMAGE_CLASS_PRESETS[framework] || null;

  document.getElementById("imgAltInput").value = selectedImage.alt || "";
  document.getElementById("imagePropsPresets").classList.toggle("hidden", !presets);

  if (presets) {
    const currentTokens = new Set(presetTokens(selectedImage.className));
    document.querySelectorAll("#imagePropsPresets .preset-group").forEach((group) => {
      const groupName = group.dataset.group;
      const groupPresets = presets[groupName];
      const buttons = group.querySelectorAll("button");
      if (groupName === "style") {
        // Independent checkboxes — each button active iff ALL of its
        // tokens are present (a preset can be more than one class).
        buttons.forEach((btn) => {
          const tokens = presetTokens(groupPresets[btn.dataset.value]);
          btn.classList.toggle("active", tokens.length > 0 && tokens.every((t) => currentTokens.has(t)));
        });
      } else {
        // Radio-style — activate whichever non-"none" value fully matches,
        // else fall back to "none".
        let matched = "none";
        for (const [value, classStr] of Object.entries(groupPresets)) {
          if (value === "none") continue;
          const tokens = presetTokens(classStr);
          if (tokens.length && tokens.every((t) => currentTokens.has(t))) {
            matched = value;
            break;
          }
        }
        buttons.forEach((btn) => btn.classList.toggle("active", btn.dataset.value === matched));
      }
    });
  }

  imagePropsDialog.showModal();
}

document.getElementById("imagePropsPresets").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-group]");
  if (!btn) return;
  const group = btn.closest(".preset-group");
  if (btn.dataset.group === "style") {
    btn.classList.toggle("active");
  } else {
    group.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
  }
});

document.getElementById("imagePropsCancel").addEventListener("click", () => imagePropsDialog.close());

document.getElementById("imagePropsApply").addEventListener("click", async () => {
  if (!selectedImage || !selectedImage.isConnected) {
    imagePropsDialog.close();
    return;
  }
  selectedImage.alt = document.getElementById("imgAltInput").value;

  const config = await getSiteConfig();
  const presets = IMAGE_CLASS_PRESETS[config.cssFramework || "bootstrap5"];
  if (presets) {
    // Recomputed from scratch, not incrementally added/removed per click —
    // that's what lets shared tokens (e.g. Tailwind's "rounded" appearing
    // in both the standalone toggle and the thumbnail bundle) resolve
    // correctly regardless of click order, and what keeps unrelated
    // hand-written classes (from Code view) untouched.
    const knownTokens = new Set();
    Object.values(presets).forEach((group) =>
      Object.values(group).forEach((classStr) => presetTokens(classStr).forEach((t) => knownTokens.add(t)))
    );
    const currentTokens = new Set(presetTokens(selectedImage.className));
    const customTokens = [...currentTokens].filter((t) => !knownTokens.has(t));

    const selectedTokens = [];
    document.querySelectorAll("#imagePropsPresets .preset-group").forEach((group) => {
      const groupName = group.dataset.group;
      const groupPresets = presets[groupName];
      group.querySelectorAll("button.active").forEach((btn) => {
        selectedTokens.push(...presetTokens(groupPresets[btn.dataset.value]));
      });
    });

    const finalTokens = [...new Set([...customTokens, ...selectedTokens])];
    if (finalTokens.length) {
      selectedImage.className = finalTokens.join(" ");
    } else {
      selectedImage.removeAttribute("class");
    }
  }

  scheduleSave();
  imagePropsDialog.close();
});

// "close" (Cancel, Escape, or backdrop dismissal) always runs after Apply's
// own close() call too, so this is the single place selectedImage is
// cleared — Apply must read/mutate it before calling close(), not after.
imagePropsDialog.addEventListener("close", () => {
  selectedImage = null;
});

// Save on every keystroke (debounced) so the local file always matches
// what's on screen — this is the "local drive as source of truth" model.
// (codeArea's autosave hook lives on the `cm.on("change", ...)` listener
// above, since CodeMirror owns that view now.)
let saveTimer = null;

async function saveCurrentFile() {
  if (!currentFileHandle) return;
  const writable = await currentFileHandle.createWritable();
  await writable.write(fileCache.get(currentFileName));
  await writable.close();
  setStatus(`Saved ${currentFileName}`);
}

// ---- Template / global nav system ----
// Pages never contain header/nav/footer themselves. A layout.html template
// has named placeholders — {{NAV:header}}, {{NAV:footer}}, etc. — resolved
// against .chromesite/nav.json, which supports nested "children" arrays for
// dropdowns. Markup for each menu is generated per the site's chosen CSS
// framework, so the same nav.json can render as Bootstrap 5, Tailwind, or
// plain HTML depending on one setting.

// Used by blockWrapperAttrs() (see insertBlock()) to build each block's
// type-scoped class, e.g. "hero" -> cs-block--hero.
function slugifyBlockType(id) {
  return id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Pre-baked, framework-styled HTML blocks — inserted via insertBlock(),
// then hand-edited in place (headline/copy/images), Elementor-style. Only
// bootstrap5 markup exists today; a block with no entry for the site's
// active framework is shown disabled in the grid rather than hidden, so
// it's discoverable once that variant gets added. Site-specific custom
// blocks don't belong here — see getCustomBlocks() / .chromesite/blocks/.
const BLOCK_LIBRARY = [
  {
    id: "hero",
    label: "Hero",
    icon: "🖼️",
    frameworks: {
      bootstrap5: `<div class="px-4 py-5 my-5 text-center">
  <h1 class="display-5 fw-bold">Your Headline Here</h1>
  <div class="col-lg-6 mx-auto">
    <p class="lead mb-4">A short, compelling line about what you offer and why it matters.</p>
    <div class="d-grid gap-2 d-sm-flex justify-content-sm-center">
      <button type="button" class="btn btn-primary btn-lg px-4 gap-3">Get Started</button>
      <button type="button" class="btn btn-outline-secondary btn-lg px-4">Learn More</button>
    </div>
  </div>
</div>`,
    },
  },
  {
    id: "cta",
    label: "Call to Action",
    icon: "📣",
    frameworks: {
      bootstrap5: `<div class="p-5 mb-4 bg-light rounded-3 text-center">
  <h2 class="fw-bold">Ready to get started?</h2>
  <p class="fs-5 mb-4">Join hundreds of happy customers today.</p>
  <button type="button" class="btn btn-primary btn-lg">Sign Up Now</button>
</div>`,
    },
  },
  {
    id: "testimonial",
    label: "Testimonial",
    icon: "💬",
    frameworks: {
      bootstrap5: `<div class="text-center p-4">
  <blockquote class="blockquote">
    <p>&ldquo;This product completely changed the way we work. Couldn't imagine going back.&rdquo;</p>
  </blockquote>
  <figcaption class="blockquote-footer mt-2">
    Jane Doe, <cite title="Company">Acme Co.</cite>
  </figcaption>
</div>`,
    },
  },
  {
    id: "contact",
    label: "Contact",
    icon: "✉️",
    frameworks: {
      bootstrap5: `<div class="row g-4 p-4">
  <div class="col-md-6">
    <h2>Get in Touch</h2>
    <p>We'd love to hear from you. Reach out any time.</p>
    <p>📍 123 Main St, Anytown USA<br>📞 (555) 123-4567<br>✉️ hello@example.com</p>
  </div>
  <div class="col-md-6">
    <form>
      <div class="mb-3"><input type="text" class="form-control" placeholder="Your Name"></div>
      <div class="mb-3"><input type="email" class="form-control" placeholder="Your Email"></div>
      <div class="mb-3"><textarea class="form-control" rows="4" placeholder="Message"></textarea></div>
      <button type="button" class="btn btn-primary">Send Message</button>
    </form>
  </div>
</div>`,
    },
  },
  {
    id: "feature-columns",
    label: "3-Column Features",
    icon: "▦",
    frameworks: {
      bootstrap5: `<div class="row g-4 p-4 text-center">
  <div class="col-md-4">
    <h3>Feature One</h3>
    <p>A short description of this feature and the value it provides.</p>
  </div>
  <div class="col-md-4">
    <h3>Feature Two</h3>
    <p>A short description of this feature and the value it provides.</p>
  </div>
  <div class="col-md-4">
    <h3>Feature Three</h3>
    <p>A short description of this feature and the value it provides.</p>
  </div>
</div>`,
    },
  },
  {
    id: "video-embed",
    label: "Video Embed",
    icon: "📺",
    frameworks: {
      // Fixed 16:9 ratio wrapper — right for video (YouTube, Vimeo, etc.),
      // wrong for anything whose content height isn't a fixed proportion of
      // its width. See "form-embed" below for that case. There's no
      // editable-in-place way to retarget an iframe's src from Visual view
      // (unlike text content), so the placeholder URL is meant to be swapped
      // out via Code view for the real embed URL.
      bootstrap5: `<div class="ratio ratio-16x9 my-4">
  <iframe src="https://example.com/replace-with-your-embed-url" title="Video embed" allowfullscreen></iframe>
</div>`,
    },
  },
  {
    id: "form-embed",
    label: "Form Embed",
    icon: "📋",
    frameworks: {
      // No aspect-ratio wrapper — forms (Zoho Forms, etc.) vary in height by
      // content, not by width, so a ratio div would either clip them or leave
      // dead space. min-height is just a reasonable starting point; the site
      // author adjusts it in Code view to match their actual form's height.
      bootstrap5: `<iframe src="https://example.com/replace-with-your-embed-url" title="Form embed" class="w-100 border-0 my-4" style="min-height: 600px;"></iframe>`,
    },
  },
];

// ---- .chromesite/block-library.md — agent/human-readable reference for
// every block available in the Blocks dialog (built-in BLOCK_LIBRARY above,
// plus this site's custom .chromesite/blocks/*.html), filtered to the
// site's active cssFramework. This is purely generated output — nobody's
// meant to hand-edit it — so unlike CLAUDE.md/simple-layout.html (see
// ensureScaffold()), it's safe to regenerate on every folder open, keeping
// it in sync with both the site's current framework and whatever the
// extension's own BLOCK_LIBRARY looks like after an update, instead of
// going stale like a copy-once file would.
async function writeBlockLibraryDoc(cfgDir, framework) {
  const lines = [
    "# Available blocks",
    "",
    `Auto-generated by ChromeSite — reflects the extension's built-in block ` +
      `library plus this site's custom blocks in \`.chromesite/blocks/\`, ` +
      `filtered to this site's current CSS framework (\`${framework}\`). ` +
      `Regenerated every time the project folder is opened in the editor — ` +
      `don't hand-edit, changes here won't stick.`,
    "",
    "## Built-in",
    "",
    "Insert via the editor's 🧩 Blocks dialog, or copy the markup directly into a page.",
    "",
  ];

  for (const block of BLOCK_LIBRARY) {
    lines.push(`### ${block.label}`);
    const markup = block.frameworks[framework];
    if (markup) {
      lines.push("```html", markup, "```");
    } else {
      lines.push(`_No \`${framework}\` markup yet for this block — shown disabled in the Blocks dialog._`);
    }
    lines.push("");
  }

  lines.push("## Custom (`.chromesite/blocks/`)", "");
  const customBlocks = await getCustomBlocks();
  if (customBlocks.length) {
    for (const block of customBlocks) {
      lines.push(`- **${block.label}** — \`.chromesite/blocks/${block.id.replace(/^custom:/, "")}\``);
    }
  } else {
    lines.push(
      "None yet. Add one by dropping an `.html` file into `.chromesite/blocks/` — see `CLAUDE.md`."
    );
  }
  lines.push("");

  const handle = await cfgDir.getFileHandle("block-library.md", { create: true });
  const writable = await handle.createWritable();
  await writable.write(lines.join("\n"));
  await writable.close();
}

// The Live Preview pane renders via iframe.srcdoc, which inherits editor.html's
// extension CSP (script-src 'self') — so the CDN <script> tags above get
// silently blocked there (CSS <link> tags are unaffected, which is why the
// preview still looked right but dropdowns etc. didn't respond to clicks).
// Published output isn't an extension page, so it keeps using the CDN
// directly via ChromesiteCompose.FRAMEWORK_ASSETS (compose-core.js); only
// the preview swaps in these locally-vendored copies of the same scripts.
const FRAMEWORK_ASSETS_PREVIEW = {
  bootstrap5:
    '<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">\n' +
    `<script src="${chrome.runtime.getURL("vendor/bootstrap/bootstrap.bundle.min.js")}"></script>`,
  tailwind: `<script src="${chrome.runtime.getURL("vendor/tailwind/tailwind-cdn.js")}"></script>`,
  none: "",
};

// Backs the Image Properties dialog's preset buttons. Each group's values
// map to a class string that may be more than one token (Tailwind has no
// single-class equivalent for Bootstrap's img-fluid/img-thumbnail) — the
// dialog logic always treats a preset's value as a whitespace-split set of
// tokens, never assumes exactly one class per preset. "none" intentionally
// maps to "" so a radio-style group can include a "clear this group" option
// without special-casing it separately from the other values.
const IMAGE_CLASS_PRESETS = {
  bootstrap5: {
    width: { none: "", "25": "w-25", "50": "w-50", "75": "w-75", "100": "w-100" },
    float: { none: "", left: "float-start", right: "float-end" },
    margin: { none: "", small: "mx-1", large: "mx-2" },
    style: { fluid: "img-fluid", thumbnail: "img-thumbnail", rounded: "rounded" },
  },
  tailwind: {
    width: { none: "", "25": "w-1/4", "50": "w-1/2", "75": "w-3/4", "100": "w-full" },
    float: { none: "", left: "float-left", right: "float-right" },
    margin: { none: "", small: "mx-1", large: "mx-2" },
    style: { fluid: "max-w-full h-auto", thumbnail: "border rounded p-1", rounded: "rounded" },
  },
};

// Nav rendering + FRAMEWORK_ASSETS (published-output CDN tags) now live in
// compose-core.js (loaded before this file, see editor.html) — it's the
// shared source of truth with cli/compose.js's headless Node render, so the
// two never drift. See composePage() below for the one place framework
// asset handling still branches locally, which is preview-only (CSP forces
// vendored copies in the sandboxed iframe instead of the real CDN).

async function getSiteConfig() {
  const cfgDir = await getConfigDir(true);
  return readJSONFile(cfgDir, "site.config.json", DEFAULT_CONFIG);
}

async function getNavData() {
  const cfgDir = await getConfigDir(true);
  return readJSONFile(cfgDir, "nav.json", DEFAULT_NAV);
}

// Per-page <title>/meta-description overrides, keyed by filename. Pages with
// no entry fall back to the default "filename | Site Name" title.
async function getPagesData() {
  const cfgDir = await getConfigDir(true);
  return readJSONFile(cfgDir, "pages.json", {});
}

async function getActiveTemplateText() {
  const templateName = document.getElementById("templateSelect").value;
  if (!templateName) return null;
  const cfgDir = await getConfigDir(true);
  const templatesDir = await cfgDir.getDirectoryHandle("templates", { create: true });
  const handle = await templatesDir.getFileHandle(templateName);
  const file = await handle.getFile();
  return file.text();
}

// The preview iframe (sandbox="allow-scripts", no allow-top-navigation) can't
// navigate itself to a new page — and even if it could, the composed HTML for
// other project pages only exists in memory, not anywhere the iframe could
// actually fetch it from. So in preview mode only, real link clicks are
// intercepted client-side instead of letting Chrome show its "this page has
// been blocked" interstitial. In-page "#" jumps (e.g. Bootstrap's dropdown
// toggle, which already calls preventDefault() itself once its JS loads) are
// left alone.
// Extension pages get script-src 'self' with no 'unsafe-inline', so this has
// to be a <script src> pointing at a real vendored file — an inline <script>
// block here would get CSP-blocked the same way the CDN scripts were.
const PREVIEW_LINK_GUARD_SCRIPT = `<script src="${chrome.runtime.getURL("preview-guard.js")}"></script>`;

// Same underlying problem as PREVIEW_LINK_GUARD_SCRIPT's comment above:
// <img src="assets/x.jpg"> is the correct, published-site-relative path, but
// the preview iframe is its own chrome-extension:// document and can't
// resolve it either — the real bytes only exist behind the File System
// Access handle this (parent) page holds, which the iframe can't reach.
//
// blob: URLs (used for this same problem in the Visual editor, see the
// #visualArea "error" listener above) do NOT work here: they're
// origin-scoped, and the preview iframe is sandboxed with no
// allow-same-origin, so it gets an opaque origin that can never match the
// blob's owning origin no matter who created it — Chrome just shows a
// broken image, with no console error to explain why. data: URLs aren't
// origin-scoped at all, so they work inside the sandbox without having to
// loosen it (adding allow-same-origin alongside allow-scripts is a known
// anti-pattern — that combination lets sandboxed content escape the
// sandbox entirely, which isn't worth it just for image display).
// Published output (isPreview=false) never goes through this — it keeps
// the clean relative path, which is what a real site needs.
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Matches both "assets/x.jpg" (page-relative) and "/assets/x.jpg" (root-
// relative) — templates need the root-relative form to resolve correctly on
// nested pages once published (see rewriteScriptsForPreview's comment
// below for the same issue on the CSS side), but the preview iframe has no
// real root to resolve either form against, so both need rewriting here.
const ASSET_SRC_RE = /src="\/?assets\/([^"]+)"/g;

async function rewriteAssetSrcsForPreview(html) {
  const names = new Set();
  html.replace(ASSET_SRC_RE, (match, name) => {
    names.add(name);
    return match;
  });
  if (!names.size) return html;

  const assetsDir = await getAssetsDirHandle(false);
  if (!assetsDir) return html;

  const urlByName = {};
  for (const name of names) {
    try {
      const fileHandle = await assetsDir.getFileHandle(name);
      urlByName[name] = await fileToDataUrl(await fileHandle.getFile());
    } catch {
      // File genuinely missing from assets/ — leave it broken in preview too.
    }
  }

  return html.replace(ASSET_SRC_RE, (match, name) =>
    urlByName[name] ? `src="${urlByName[name]}"` : match
  );
}

// scripts/*.css hits the same broken-relative-path problem as assets/*.jpg
// above, but the fix differs: a <link href="scripts/x.css"> can't be
// swapped for a data: URL and left as a <link> the way images can, because
// that's still a resource *load*, and while style-src isn't restricted by
// editor.html's CSP (see FRAMEWORK_ASSETS_PREVIEW's comment above), there's
// no reason to route through a URL at all when the actual CSS text is sitting
// right there on disk — so the whole <link> tag is replaced with an inline
// <style> block containing the file's real contents instead.
// scripts/*.js is NOT handled here: executing it would require a <script>
// that's either inline or src="data:"/"blob:", and script-src 'self' (a
// Manifest V3 platform restriction, see FRAMEWORK_ASSETS_PREVIEW's comment)
// blocks all three for anything not shipped inside the extension package
// itself — which arbitrary per-site scripts/main.js never is. There's no
// preview-side workaround; test JS via "Render to local folder" and opening
// the output directly in a normal browser tab (no extension CSP there), or
// via the published site.
// Same page-relative vs. root-relative duality as ASSET_SRC_RE above.
const SCRIPTS_CSS_HREF_RE = /href="\/?scripts\/([^"]+\.css)"/g;
const SCRIPTS_CSS_LINK_RE = /<link[^>]*href="\/?scripts\/([^"]+\.css)"[^>]*>/g;

async function rewriteScriptsForPreview(html) {
  const names = new Set();
  html.replace(SCRIPTS_CSS_HREF_RE, (match, name) => {
    names.add(name);
    return match;
  });
  if (!names.size) return html;

  const scriptsDir = await getScriptsDirHandle(false);
  if (!scriptsDir) return html;

  const cssByName = {};
  for (const name of names) {
    try {
      const fileHandle = await scriptsDir.getFileHandle(name);
      cssByName[name] = await (await fileHandle.getFile()).text();
    } catch {
      // File genuinely missing from scripts/ — leave the link broken in preview too.
    }
  }

  return html.replace(SCRIPTS_CSS_LINK_RE, (match, name) =>
    cssByName[name] !== undefined ? `<style>\n${cssByName[name]}\n</style>` : match
  );
}

async function composePage(rawContent, title, isPreview = false) {
  const templateText = await getActiveTemplateText();
  if (!templateText) {
    // "raw HTML" mode, no wrapping
    if (!isPreview) return rawContent;
    let out = await rewriteAssetSrcsForPreview(rawContent);
    out = await rewriteScriptsForPreview(out);
    return out + PREVIEW_LINK_GUARD_SCRIPT;
  }

  const [config, navData, pagesData] = await Promise.all([getSiteConfig(), getNavData(), getPagesData()]);

  // Non-preview (Publish, Render to Local Folder) delegates entirely to the
  // shared module — this is the exact same function cli/compose.js calls
  // under Node, so a headless render always matches what actually ships.
  if (!isPreview) {
    return ChromesiteCompose.composePage({ templateText, rawContent, title, config, navData, pagesData });
  }

  // Preview can't reuse composePage() as-is: it needs FRAMEWORK_ASSETS_PREVIEW
  // (vendored CDN copies, see comment above) instead of the real CDN tags,
  // and rewriteAssetSrcsForPreview/rewriteScriptsForPreview + the link guard
  // script only make sense inside the sandboxed srcdoc iframe.
  const framework = config.cssFramework || "bootstrap5";
  const pageMeta = pagesData[title] || {};
  const pageTitle = pageMeta.title || title;

  let out = templateText.replace(/{{NAV:(\w+)}}/g, (_, menuName) =>
    ChromesiteCompose.renderMenu(navData.menus?.[menuName], framework)
  );
  out = out
    .replace(/{{FRAMEWORK_ASSETS}}/g, FRAMEWORK_ASSETS_PREVIEW[framework] || "")
    .replace(/{{CONTENT}}/g, rawContent)
    .replace(/{{TITLE}}/g, pageTitle ? `${pageTitle} | ${config.siteName || ""}` : config.siteName || "Untitled")
    .replace(/{{META_DESCRIPTION}}/g, pageMeta.description || "")
    .replace(/{{SITE_NAME}}/g, config.siteName || "")
    .replace(/{{YEAR}}/g, String(new Date().getFullYear()));
  out = await rewriteAssetSrcsForPreview(out);
  out = await rewriteScriptsForPreview(out);
  out += PREVIEW_LINK_GUARD_SCRIPT;
  return out;
}

// The popped-out preview window (see openPreviewWindowBtn below) — kept as
// a plain reference rather than something reopened per-edit, so the user
// can park it on a second monitor and just keep resizing/refreshing the one
// window while they work in the main one.
let previewWindow = null;

async function renderPreview() {
  const raw = fileCache.get(currentFileName) || "";
  const composed = await composePage(raw, currentFileName, true);
  document.getElementById("previewFrame").srcdoc = composed;

  // Every edit/save/settings-change already funnels through this one
  // function to refresh the iframe, so piggybacking here is what keeps the
  // popped-out window "live" without needing to hook it in at every call
  // site separately.
  if (previewWindow && !previewWindow.closed) {
    previewWindow.document.open();
    previewWindow.document.write(composed);
    previewWindow.document.close();
  }
}

document.getElementById("openPreviewWindowBtn").addEventListener("click", () => {
  // A fixed window name means clicking this again reuses/focuses the same
  // OS window rather than spawning duplicates, even if our `previewWindow`
  // reference above is stale (e.g. the user closed it without us noticing).
  previewWindow = window.open("", "chromesite-preview-window", "width=1280,height=900");
  if (!previewWindow) {
    setStatus("Preview window was blocked — allow pop-ups for this extension to use it.");
    return;
  }
  previewWindow.focus();
  renderPreview();
});

// ---- Menu editor dialog — drag-and-drop tree, backed by SortableJS ----
// Menus are edited as a working copy (navWorkingData) that only gets
// written to nav.json on Save. Each rendered <li> is tagged with a random
// id mapping to the actual item object in itemsById, so label/href text
// inputs mutate that object directly and structural changes (add, delete,
// drag-reorder) just need to rebuild the *arrays* from current DOM order —
// object identity (and therefore in-progress edits) is never lost.
const navDialog = document.getElementById("navDialog");
let navWorkingData = null;
let currentMenuName = null;
let itemsById = new Map();
let navJsonMode = false;

document.getElementById("editNav").addEventListener("click", async () => {
  if (!dirHandle) {
    setStatus("Open a project folder first.");
    return;
  }
  const navData = await getNavData();
  navWorkingData = JSON.parse(JSON.stringify(navData)); // deep copy — Cancel must not mutate the saved version
  if (!navWorkingData.menus) navWorkingData.menus = {};
  const names = Object.keys(navWorkingData.menus);
  currentMenuName = names[0] || null;
  navJsonMode = false;
  setNavViewMode(false);
  renderMenuTabs();
  renderMenuTree(currentMenuName ? navWorkingData.menus[currentMenuName] : []);
  navDialog.showModal();
});
document.getElementById("navCancel").addEventListener("click", () => navDialog.close());

document.getElementById("navSave").addEventListener("click", async () => {
  if (navJsonMode && !syncJsonIntoWorkingData()) return; // bad JSON — bail, message already shown
  const cfgDir = await getConfigDir(true);
  await writeJSONFile(cfgDir, "nav.json", navWorkingData);
  navDialog.close();
  renderPreview();
  setStatus("Menus updated (.chromesite/nav.json).");
});

// ---- Menu tabs (header / footer / custom names) ----
function renderMenuTabs() {
  const tabsEl = document.getElementById("navMenuTabs");
  tabsEl.innerHTML = "";
  Object.keys(navWorkingData.menus).forEach((name) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "menu-tab" + (name === currentMenuName ? " active" : "");
    btn.textContent = name;
    btn.addEventListener("click", () => selectMenu(name));
    tabsEl.appendChild(btn);
  });
}

function selectMenu(name) {
  currentMenuName = name;
  renderMenuTabs();
  renderMenuTree(navWorkingData.menus[name] || []);
}

document.getElementById("navAddMenu").addEventListener("click", () => {
  const name = prompt("New menu name (e.g. sidebar):", "");
  if (!name) return;
  if (navWorkingData.menus[name]) {
    setStatus(`A menu named "${name}" already exists.`);
    return;
  }
  navWorkingData.menus[name] = [];
  selectMenu(name);
});

document.getElementById("navDeleteMenu").addEventListener("click", () => {
  if (!currentMenuName) return;
  if (!confirm(`Delete the "${currentMenuName}" menu? This can't be undone until you Save.`)) return;
  delete navWorkingData.menus[currentMenuName];
  const remaining = Object.keys(navWorkingData.menus);
  currentMenuName = remaining[0] || null;
  renderMenuTabs();
  renderMenuTree(currentMenuName ? navWorkingData.menus[currentMenuName] : []);
});

// ---- Tree rendering ----
function renderMenuTree(items) {
  itemsById.clear();
  const root = document.getElementById("navTreeRoot");
  root.innerHTML = "";
  (items || []).forEach((item) => root.appendChild(renderNavItem(item, false)));
  attachSortable(root, "nav-root");
}

function makeItemId() {
  return "n" + Math.random().toString(36).slice(2, 10);
}

function renderNavItem(item, isChild) {
  const id = makeItemId();
  itemsById.set(id, item);

  const li = document.createElement("li");
  li.className = "nav-tree-item";
  li.dataset.id = id;

  const row = document.createElement("div");
  row.className = "nav-item-row";
  row.innerHTML =
    '<span class="drag-handle" title="Drag to reorder">⠷</span>' +
    '<input class="item-label" type="text" placeholder="Label" />' +
    '<input class="item-href" type="text" placeholder="/path.html" />' +
    (isChild ? "" : '<button type="button" class="nav-add-child" title="Add dropdown item">+ Child</button>') +
    '<button type="button" class="nav-delete-item" title="Delete">✕</button>';

  const labelInput = row.querySelector(".item-label");
  const hrefInput = row.querySelector(".item-href");
  labelInput.value = item.label || "";
  hrefInput.value = item.href || "";
  labelInput.addEventListener("input", (e) => { item.label = e.target.value; });
  hrefInput.addEventListener("input", (e) => { item.href = e.target.value; });

  row.querySelector(".nav-delete-item").addEventListener("click", () => {
    li.remove();
    itemsById.delete(id);
    syncMenuFromDOM();
  });

  if (!isChild) {
    row.querySelector(".nav-add-child").addEventListener("click", () => {
      const childUl = ensureChildrenList(li);
      const childItem = { label: "New item", href: "#" };
      childUl.appendChild(renderNavItem(childItem, true));
      syncMenuFromDOM();
    });
  }

  li.appendChild(row);

  if (!isChild && item.children && item.children.length) {
    const childUl = document.createElement("ul");
    childUl.className = "nav-children";
    item.children.forEach((c) => childUl.appendChild(renderNavItem(c, true)));
    li.appendChild(childUl);
    attachSortable(childUl, "nav-children");
  }

  return li;
}

function ensureChildrenList(li) {
  let ul = li.querySelector(":scope > ul.nav-children");
  if (!ul) {
    ul = document.createElement("ul");
    ul.className = "nav-children";
    li.appendChild(ul);
    attachSortable(ul, "nav-children");
  }
  return ul;
}

// Root items only reorder among themselves; dropdown items can be dragged
// between different parents' dropdowns but never promoted to root — that
// would need a third nesting level the renderers (renderNavBootstrap5 etc.)
// don't support.
function attachSortable(listEl, group) {
  new Sortable(listEl, {
    group,
    handle: ".drag-handle",
    animation: 150,
    ghostClass: "sortable-ghost",
    onEnd: syncMenuFromDOM,
  });
}

document.getElementById("navAddRootItem").addEventListener("click", () => {
  if (!currentMenuName) {
    setStatus("Add or select a menu first.");
    return;
  }
  const root = document.getElementById("navTreeRoot");
  root.appendChild(renderNavItem({ label: "New item", href: "#" }, false));
  syncMenuFromDOM();
});

// Rebuilds navWorkingData.menus[currentMenuName] from the current DOM
// order/nesting. Item objects themselves are reused via itemsById, so text
// already typed into label/href inputs is preserved.
function syncMenuFromDOM() {
  if (!currentMenuName) return;
  const root = document.getElementById("navTreeRoot");
  navWorkingData.menus[currentMenuName] = Array.from(root.children).map(buildItemFromLi);
}

function buildItemFromLi(li) {
  const item = itemsById.get(li.dataset.id);
  const childUl = li.querySelector(":scope > ul.nav-children");
  const children = childUl ? Array.from(childUl.children).map(buildItemFromLi) : [];
  if (children.length) {
    item.children = children;
  } else {
    delete item.children;
  }
  return item;
}

// ---- Tree / raw-JSON toggle — power-user escape hatch ----
document.getElementById("navToggleJson").addEventListener("click", () => {
  if (!navJsonMode) {
    document.getElementById("navEditor").value = JSON.stringify(navWorkingData, null, 2);
    setNavViewMode(true);
  } else {
    if (!syncJsonIntoWorkingData()) return;
    const names = Object.keys(navWorkingData.menus);
    currentMenuName = names.includes(currentMenuName) ? currentMenuName : names[0] || null;
    renderMenuTabs();
    renderMenuTree(currentMenuName ? navWorkingData.menus[currentMenuName] : []);
    setNavViewMode(false);
  }
});

function setNavViewMode(jsonMode) {
  navJsonMode = jsonMode;
  document.getElementById("navEditor").classList.toggle("hidden", !jsonMode);
  document.getElementById("navTreeRoot").classList.toggle("hidden", jsonMode);
  document.getElementById("navMenuTabs").classList.toggle("hidden", jsonMode);
  document.getElementById("navAddMenu").classList.toggle("hidden", jsonMode);
  document.getElementById("navDeleteMenu").classList.toggle("hidden", jsonMode);
  document.getElementById("navAddRootItem").classList.toggle("hidden", jsonMode);
  document.getElementById("navToggleJson").textContent = jsonMode ? "Back to Tree" : "Edit as JSON";
}

function syncJsonIntoWorkingData() {
  try {
    const parsed = JSON.parse(document.getElementById("navEditor").value);
    if (!parsed || typeof parsed.menus !== "object") throw new Error('JSON must have a top-level "menus" object.');
    navWorkingData = parsed;
    return true;
  } catch (err) {
    setStatus("Invalid JSON in menu editor: " + err.message);
    return false;
  }
}

// ---- Site Settings dialog ----
const siteSettingsDialog = document.getElementById("siteSettingsDialog");
document.getElementById("siteSettingsBtn").addEventListener("click", async () => {
  if (!dirHandle) {
    setStatus("Open a project folder first.");
    return;
  }
  const config = await getSiteConfig();
  document.getElementById("cfgSiteName").value = config.siteName || "";
  document.getElementById("cfgDomain").value = config.domain || "";
  document.getElementById("templateSelect").value = config.activeTemplate || "";
  document.getElementById("cfgParagraphMode").value = config.paragraphMode || "p";
  document.getElementById("cfgCssFramework").value = config.cssFramework || "bootstrap5";
  document.getElementById("cfgDeploymentTarget").value = config.deploymentTarget || "cloudflare";
  document.getElementById("cfgDeployDirectory").value = config.deployDirectory || "dist";
  siteSettingsDialog.showModal();
});
document.getElementById("siteSettingsCancel").addEventListener("click", () => siteSettingsDialog.close());
document.getElementById("siteSettingsSave").addEventListener("click", async () => {
  const config = {
    siteName: document.getElementById("cfgSiteName").value.trim(),
    domain: document.getElementById("cfgDomain").value.trim(),
    paragraphMode: document.getElementById("cfgParagraphMode").value,
    activeTemplate: document.getElementById("templateSelect").value,
    cssFramework: document.getElementById("cfgCssFramework").value,
    deploymentTarget: document.getElementById("cfgDeploymentTarget").value,
    deployDirectory: sanitizeDeployDirectory(document.getElementById("cfgDeployDirectory").value),
  };
  const cfgDir = await getConfigDir(true);
  await writeJSONFile(cfgDir, "site.config.json", config);
  applyParagraphMode(config.paragraphMode);
  siteSettingsDialog.close();
  renderPreview();
  setStatus("Site settings saved (.chromesite/site.config.json).");
});

function applyParagraphMode(mode) {
  try {
    document.execCommand("defaultParagraphSeparator", false, mode === "div" ? "div" : "p");
  } catch {
    // Non-fatal — some Chrome versions ignore this command silently.
  }
}


// ---- Publish flow — routes to the configured deployment target ----
document.getElementById("publishBtn").addEventListener("click", async () => {
  const config = await getSiteConfig();
  const target = config.deploymentTarget || "cloudflare";

  if (target === "netlify") {
    const stored = await chrome.storage.local.get(["ntlSiteId", "ntlToken"]);
    document.getElementById("ntlSiteId").value = stored.ntlSiteId || "";
    document.getElementById("ntlToken").value = stored.ntlToken || "";
    document.getElementById("netlifyDialog").showModal();
    return;
  }

  if (target === "local") {
    const folderName = sanitizeDeployDirectory(config.deployDirectory);
    document.getElementById("localBuildHint").innerHTML =
      `Composes every page (template + nav applied) into a <code>${folderName}/</code> folder inside your project directory — nothing gets uploaded. Point your SFTP client (or git repo) at that folder afterward. Change the folder name under Site Settings → Local Render Folder.`;
    document.getElementById("localBuildDialog").showModal();
    return;
  }

  const stored = await chrome.storage.local.get(["cfAccount", "cfProject", "cfToken"]);
  document.getElementById("cfAccount").value = stored.cfAccount || "";
  document.getElementById("cfProject").value = stored.cfProject || "";
  document.getElementById("cfToken").value = stored.cfToken || "";
  document.getElementById("publishDialog").showModal();
});

document.getElementById("publishCancel").addEventListener("click", () => document.getElementById("publishDialog").close());

document.getElementById("publishConfirm").addEventListener("click", async () => {
  const account = document.getElementById("cfAccount").value.trim();
  const project = document.getElementById("cfProject").value.trim();
  const token = document.getElementById("cfToken").value.trim();
  await chrome.storage.local.set({ cfAccount: account, cfProject: project, cfToken: token });
  document.getElementById("publishDialog").close();
  await publishSite(account, project, token);
});

// Shared by all three deployment targets — walks the project root, skips
// .chromesite/ automatically (it's a directory, not a file), and returns
// { "index.html": "<composed html>", ... }.
async function getComposedPages() {
  const pages = {};
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind !== "file" || !name.endsWith(".html")) continue;
    const file = await handle.getFile();
    const raw = await file.text();
    pages[name] = await composePage(raw, name);
  }
  return pages;
}

// Raw bytes, not composed text — kept separate from getComposedPages()
// since composePage()'s template/nav substitution is meaningless for
// binary blobs. Returns {} if assets/ doesn't exist yet (the default state
// of every project until the first upload).
async function getProjectAssets() {
  const assetsDir = await getAssetsDirHandle(false);
  if (!assetsDir) return {};
  const assets = {};
  for await (const [name, handle] of assetsDir.entries()) {
    if (handle.kind !== "file") continue;
    assets[name] = await (await handle.getFile()).arrayBuffer();
  }
  return assets;
}

// Same shape as getProjectAssets(), for scripts/ instead — kept as a
// separate function (rather than a shared helper with a folder-name arg)
// since the two are read by different call sites for different reasons.
async function getProjectScripts() {
  const scriptsDir = await getScriptsDirHandle(false);
  if (!scriptsDir) return {};
  const scripts = {};
  for await (const [name, handle] of scriptsDir.entries()) {
    if (handle.kind !== "file") continue;
    scripts[name] = await (await handle.getFile()).arrayBuffer();
  }
  return scripts;
}

// ---- Cloudflare Pages Direct Upload — a content-hash-addressed protocol ----
// This is NOT a single multipart POST of raw files + a size manifest (an
// earlier version of this function assumed that, and produced deployments
// that looked correct in Cloudflare's dashboard but 404'd everywhere —
// Cloudflare accepted the upload but never actually indexed it as servable
// content). The real flow, reverse-engineered from Wrangler's own CLI
// source (packages/wrangler/src/pages/upload.ts / src/api/pages/deploy.ts):
// get an upload token, BLAKE3-hash every file, ask Cloudflare which hashes
// it doesn't already have cached, upload only those, then create the
// deployment referencing a manifest of hashes (not sizes).

// Converts an ArrayBuffer to base64 without spreading the whole byte array
// into String.fromCharCode at once — that blows the call stack on anything
// more than a few MB. 32KB slices avoid that.
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK_SIZE = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

// Cloudflare's hash algorithm needs the extension exactly as Node's
// path.extname() would produce it — case-preserving, no dot. Deliberately
// separate from assetExtension() above, which lowercases for MIME lookup,
// an unrelated concern.
function hashExtension(filePath) {
  const slash = filePath.lastIndexOf("/");
  const name = slash === -1 ? filePath : filePath.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1);
}

function withCharset(mimeType) {
  return mimeType.startsWith("text/") ? `${mimeType}; charset=utf-8` : mimeType;
}

// Normalizes composed pages (strings) and raw assets/scripts (ArrayBuffers)
// into one list, with the leading-slash paths Cloudflare's manifest requires.
function buildPagesFileList(pages, assets, scripts = {}) {
  const files = [];
  for (const [name, html] of Object.entries(pages)) {
    files.push({
      path: "/" + name,
      arrayBuffer: new TextEncoder().encode(html).buffer,
      contentType: withCharset("text/html"),
    });
  }
  for (const [name, arrayBuffer] of Object.entries(assets)) {
    files.push({
      path: "/assets/" + name,
      arrayBuffer,
      contentType: withCharset(assetMimeType(name)),
    });
  }
  for (const [name, arrayBuffer] of Object.entries(scripts)) {
    files.push({
      path: "/scripts/" + name,
      arrayBuffer,
      contentType: withCharset(assetMimeType(name)),
    });
  }
  return files;
}

// hash = blake3(base64(fileBytes) + extensionNoDot, 128 bits).hex() — cross-
// validated this exact algorithm against the real blake3-wasm package
// Wrangler uses, byte-identical output on the same input.
async function hashFileList(files) {
  for (const file of files) {
    file.base64 = arrayBufferToBase64(file.arrayBuffer);
    file.hash = await hashwasm.blake3(file.base64 + hashExtension(file.path), 128);
  }
}

async function getPagesUploadToken(account, project, token) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects/${project}/upload-token`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  if (!data.success) throw new Error("Could not get upload token: " + JSON.stringify(data.errors));
  return data.result.jwt;
}

async function checkMissingHashes(jwt, hashes) {
  const res = await fetch("https://api.cloudflare.com/client/v4/pages/assets/check-missing", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ hashes }),
  });
  const data = await res.json();
  if (!data.success) throw new Error("Could not check asset cache: " + JSON.stringify(data.errors));
  return new Set(data.result);
}

const UPLOAD_BATCH_MAX_FILES = 200;
const UPLOAD_BATCH_MAX_BYTES = 35 * 1024 * 1024; // conservative, under Cloudflare's 40MB/batch limit

function chunkForUpload(files) {
  const batches = [];
  let current = [];
  let currentBytes = 0;
  for (const file of files) {
    const size = file.base64.length;
    const wouldOverflow =
      current.length >= UPLOAD_BATCH_MAX_FILES || currentBytes + size > UPLOAD_BATCH_MAX_BYTES;
    if (wouldOverflow && current.length) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(file);
    currentBytes += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

async function uploadBatch(jwt, batch) {
  const payload = batch.map((f) => ({
    key: f.hash,
    value: f.base64,
    metadata: { contentType: f.contentType },
    base64: true,
  }));
  const res = await fetch("https://api.cloudflare.com/client/v4/pages/assets/upload", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.success) throw new Error("Batch upload failed: " + JSON.stringify(data.errors));
}

// Sequential batches — this project's realistic file counts don't need
// Wrangler's concurrent-bucket-packing — with one retry per batch before
// letting a real failure abort the publish (a missing file means a broken
// deployment, the same 404 symptom this whole rewrite exists to fix).
async function uploadMissingFiles(jwt, files, onProgress) {
  const batches = chunkForUpload(files);
  for (let i = 0; i < batches.length; i++) {
    try {
      await uploadBatch(jwt, batches[i]);
    } catch (err) {
      await uploadBatch(jwt, batches[i]);
    }
    onProgress(i + 1, batches.length);
  }
}

// Best-effort cache warming — Wrangler treats this as non-fatal, so a
// failure here is logged but never aborts the publish.
async function upsertHashes(jwt, hashes) {
  try {
    await fetch("https://api.cloudflare.com/client/v4/pages/assets/upsert-hashes", {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ hashes }),
    });
  } catch (err) {
    console.warn("upsert-hashes failed (non-fatal):", err);
  }
}

async function createPagesDeployment(account, project, token, manifest) {
  const formData = new FormData();
  formData.append("manifest", JSON.stringify(manifest));
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects/${project}/deployments`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: formData }
  );
  return res.json();
}

async function publishSite(account, project, token) {
  try {
    setStatus("Composing pages...");
    const pages = await getComposedPages();
    const assets = await getProjectAssets();
    const scripts = await getProjectScripts();
    const files = buildPagesFileList(pages, assets, scripts);

    setStatus(`Hashing ${files.length} file(s)...`);
    await hashFileList(files);

    setStatus("Requesting upload token...");
    const jwt = await getPagesUploadToken(account, project, token);

    setStatus("Checking Cloudflare's asset cache...");
    const missing = await checkMissingHashes(jwt, files.map((f) => f.hash));
    const toUpload = files.filter((f) => missing.has(f.hash));

    if (toUpload.length) {
      setStatus(`Uploading ${toUpload.length} of ${files.length} file(s)...`);
      await uploadMissingFiles(jwt, toUpload, (done, total) =>
        setStatus(`Uploading batch ${done}/${total}...`)
      );
    } else {
      setStatus("All files already cached by Cloudflare — nothing to upload.");
    }

    await upsertHashes(jwt, files.map((f) => f.hash));

    setStatus("Finalizing deployment...");
    const manifest = {};
    for (const f of files) manifest[f.path] = f.hash;
    const data = await createPagesDeployment(account, project, token, manifest);

    if (data.success) {
      setStatus(`Published! Live at: ${data.result.url}`);
    } else {
      setStatus("Publish failed: " + JSON.stringify(data.errors));
    }
  } catch (err) {
    setStatus("Publish failed: " + err.message);
  }
}

// ---- Netlify publish (manual deploy via file digest API) ----
// Netlify's API avoids needing a zip library in the extension: you POST a
// manifest of {path: sha1}, it tells you which files it doesn't already
// have cached, then you PUT the raw bytes for just those files.
// https://docs.netlify.com/api/get-started/#deploy-a-site
document.getElementById("netlifyCancel").addEventListener("click", () =>
  document.getElementById("netlifyDialog").close()
);
document.getElementById("netlifyConfirm").addEventListener("click", async () => {
  const siteId = document.getElementById("ntlSiteId").value.trim();
  const token = document.getElementById("ntlToken").value.trim();
  await chrome.storage.local.set({ ntlSiteId: siteId, ntlToken: token });
  document.getElementById("netlifyDialog").close();
  await publishToNetlify(siteId, token);
});

// Accepts either a string (composed page text) or an ArrayBuffer (raw
// asset bytes) — crypto.subtle.digest takes ArrayBuffer natively, so assets
// don't need to be forced through TextEncoder at all.
async function sha1Hex(data) {
  const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-1", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function publishToNetlify(siteId, token) {
  setStatus("Composing pages...");
  const pages = await getComposedPages();
  const assets = await getProjectAssets();
  const scripts = await getProjectScripts();

  setStatus("Hashing files...");
  const fileEntries = Object.entries(pages).map(([name, content]) => ({
    path: "/" + name,
    content,
  }));
  for (const [name, arrayBuffer] of Object.entries(assets)) {
    fileEntries.push({ path: "/assets/" + name, content: arrayBuffer });
  }
  for (const [name, arrayBuffer] of Object.entries(scripts)) {
    fileEntries.push({ path: "/scripts/" + name, content: arrayBuffer });
  }
  const digests = {};
  for (const f of fileEntries) digests[f.path] = await sha1Hex(f.content);

  try {
    setStatus("Creating Netlify deploy...");
    const createRes = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/deploys`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ files: digests }),
    });
    const deploy = await createRes.json();
    if (!createRes.ok) {
      setStatus("Netlify deploy creation failed: " + JSON.stringify(deploy));
      return;
    }

    const required = new Set(deploy.required || []);
    const toUpload = fileEntries.filter((f) => required.has(digests[f.path]));
    setStatus(`Uploading ${toUpload.length} file(s) to Netlify...`);

    for (const f of toUpload) {
      await fetch(
        `https://api.netlify.com/api/v1/deploys/${deploy.id}/files${f.path}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/octet-stream",
          },
          body: f.content,
        }
      );
    }

    setStatus(`Published! Live at: ${deploy.ssl_url || deploy.url}`);
  } catch (err) {
    setStatus("Netlify publish failed: " + err.message);
  }
}

// ---- Local folder render (for manual SFTP, GitHub Pages, or any other host) ----
// Writes every composed page into the configured deployDirectory folder
// (site.config.json, "dist" by default) inside the project directory.
// Nothing is uploaded — the user points their own SFTP client, git repo, or
// any other deploy method at that folder afterward.
document.getElementById("localBuildCancel").addEventListener("click", () =>
  document.getElementById("localBuildDialog").close()
);
document.getElementById("localBuildConfirm").addEventListener("click", async () => {
  document.getElementById("localBuildDialog").close();
  await renderToLocalFolder();
});

async function renderToLocalFolder() {
  const config = await getSiteConfig();
  const folderName = sanitizeDeployDirectory(config.deployDirectory);

  setStatus("Composing pages...");
  const pages = await getComposedPages();
  const assets = await getProjectAssets();
  const scripts = await getProjectScripts();

  setStatus(`Writing ${folderName}/ folder...`);
  const distDir = await dirHandle.getDirectoryHandle(folderName, { create: true });
  for (const [name, content] of Object.entries(pages)) {
    const handle = await distDir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
  }

  if (Object.keys(assets).length) {
    const distAssetsDir = await distDir.getDirectoryHandle("assets", { create: true });
    for (const [name, arrayBuffer] of Object.entries(assets)) {
      const handle = await distAssetsDir.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(arrayBuffer);
      await writable.close();
    }
  }

  if (Object.keys(scripts).length) {
    const distScriptsDir = await distDir.getDirectoryHandle("scripts", { create: true });
    for (const [name, arrayBuffer] of Object.entries(scripts)) {
      const handle = await distScriptsDir.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(arrayBuffer);
      await writable.close();
    }
  }

  setStatus(`Rendered ${Object.keys(pages).length} page(s), ${Object.keys(assets).length} asset(s), and ${Object.keys(scripts).length} script(s) to the ${folderName}/ folder.`);
}

function setStatus(msg) {
  document.getElementById("statusBar").textContent = '🔔 ' + msg;
}

// Surfaces the PREVIEW_LINK_GUARD_SCRIPT's blocked-link notices in the
// status bar, so clicking a nav link in the preview gives feedback instead
// of just silently doing nothing.
window.addEventListener("message", (e) => {
  if (e.data && e.data.source === "chromesite-preview" && e.data.type === "blocked-link") {
    setStatus(`Preview: links aren't navigable here (would have opened "${e.data.href}") — open that file directly to preview it.`);
  }
});

// Kick things off
tryRestoreFolder();

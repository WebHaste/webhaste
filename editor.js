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

// Folder names (top-level path segment) the user has collapsed in the file
// list — session-only. refreshFileList() rebuilds the sidebar from scratch
// on every call (innerHTML = ""), which would otherwise reset every <details>
// to its default open state each time; this survives those rebuilds since
// it lives outside the DOM. It only needs to survive rebuilds, not page
// reloads — refreshFileList() runs solely on add/change/delete/switch-folder,
// never on every keystroke, so this doesn't need to be more durable than that.
const collapsedFolders = new Set();

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
// visual/code panes must not look interactable, since flushPendingSave()
// (further down) is a silent no-op without a pending save queued — typing
// there gives the impression content is being saved when it isn't.
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
// Also drops any save still queued for that file — deletePage() has already
// removed it from disk by the time this runs, and pickFolder's new dirHandle
// makes the old handle meaningless, so there's nothing left to flush.
function clearEditorState() {
  clearTimeout(saveTimer);
  pendingSave = null;
  currentFileHandle = null;
  currentFileName = null;
  cm.setValue("");
  document.getElementById("visualArea").innerHTML = "";
  document.getElementById("previewFrame").srcdoc = "";
  hideLinkBubble();
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
// Generic key-value helpers on the same store — "Handle" in the name is a
// holdover from when this only ever stored the one directory handle, but
// IndexedDB structured-clones plain objects/arrays just as well, so recent-
// projects bookkeeping below reuses these rather than opening a second store.
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
async function deleteHandle(key) {
  const db = await idb();
  db.transaction(STORE, "readwrite").objectStore(STORE).delete(key);
}

// ---- Recent projects (for the "Recent Projects" dropdown) ----
// Keyed by site.config.json's projectId (see ensureScaffold()) rather than
// folder name, since that's already the stable per-project id this codebase
// uses to tell two project folders apart (originally for credential
// namespacing — see projectStorageKey()) — folder names alone can collide.
const RECENT_PROJECTS_KEY = "recentProjects";
const RECENT_PROJECTS_LIMIT = 8;

async function recordRecentProject(handle, config) {
  if (!config.projectId) return;
  const list = (await loadHandle(RECENT_PROJECTS_KEY)) || [];

  // Dedupe both by projectId (the normal case) and by the underlying
  // physical folder (isSameEntry()) — projectId is meant to be stable per
  // project, but gets regenerated by ensureScaffold() if .webhaste/
  // site.config.json is ever deleted and recreated (e.g. resetting a test
  // project). Without this, the same folder reopened after that would show
  // up as a second, unrelated-looking "duplicate" entry in Recent forever,
  // since the old id's entry has no reason to ever get evicted on its own.
  const kept = [];
  for (const entry of list) {
    if (entry.id === config.projectId) continue;
    const oldHandle = await loadHandle(`recentHandle:${entry.id}`);
    const samePhysicalFolder = oldHandle && (await handlesReferSameEntry(oldHandle, handle));
    if (samePhysicalFolder) {
      await deleteHandle(`recentHandle:${entry.id}`);
      continue;
    }
    kept.push(entry);
  }

  const next = [{ id: config.projectId, name: config.siteName || handle.name, lastOpened: Date.now() }, ...kept];
  const dropped = next.splice(RECENT_PROJECTS_LIMIT);
  await saveHandle(RECENT_PROJECTS_KEY, next);
  await saveHandle(`recentHandle:${config.projectId}`, handle);
  for (const entry of dropped) await deleteHandle(`recentHandle:${entry.id}`);
}

async function handlesReferSameEntry(a, b) {
  try {
    return await a.isSameEntry(b);
  } catch {
    return false;
  }
}

async function forgetRecentProject(id) {
  const list = (await loadHandle(RECENT_PROJECTS_KEY)) || [];
  await saveHandle(RECENT_PROJECTS_KEY, list.filter((e) => e.id !== id));
  await deleteHandle(`recentHandle:${id}`);
}

async function populateRecentProjectsDropdown() {
  const select = document.getElementById("recentProjects");
  if (!select) return;
  const list = (await loadHandle(RECENT_PROJECTS_KEY)) || [];
  select.innerHTML = '<option value="">🕘 Recent…</option>';
  for (const entry of list) {
    const opt = document.createElement("option");
    opt.value = entry.id;
    opt.textContent = entry.name;
    select.appendChild(opt);
  }
  select.style.display = list.length ? "" : "none";
}

document.getElementById("recentProjects").addEventListener("change", async (e) => {
  const id = e.target.value;
  e.target.value = "";
  if (!id) return;

  const handle = await loadHandle(`recentHandle:${id}`);
  if (!handle) {
    setStatus("That recent project's folder reference was lost — please reopen it via \"Open Project Folder\".");
    await forgetRecentProject(id);
    await populateRecentProjectsDropdown();
    return;
  }

  // Choosing an option is itself a user gesture, so — unlike the automatic
  // restore-on-launch path in tryRestoreFolder() — this can request
  // permission directly instead of just telling the user to reconnect.
  let perm = await handle.queryPermission({ mode: "readwrite" });
  if (perm !== "granted") perm = await handle.requestPermission({ mode: "readwrite" });
  if (perm !== "granted") {
    setStatus(`Permission to "${handle.name}" was denied.`);
    return;
  }

  dirHandle = handle;
  await saveHandle("projectDir", dirHandle);
  document.getElementById("folderName").textContent = dirHandle.name;
  clearEditorState();
  await ensureScaffold();
  await refreshFileList();
  await recordRecentProject(dirHandle, await getSiteConfig());
  await populateRecentProjectsDropdown();
});

// ---- Folder picking + listing ----
document.getElementById("pickFolder").addEventListener("click", async () => {
  try {
    dirHandle = await window.showDirectoryPicker();
    await saveHandle("projectDir", dirHandle);
    document.getElementById("folderName").textContent = dirHandle.name;
    clearEditorState();
    await ensureScaffold();
    await refreshFileList();
    await recordRecentProject(dirHandle, await getSiteConfig());
    await populateRecentProjectsDropdown();
  } catch (err) {
    setStatus("Folder selection cancelled or failed: " + err.message);
  }
});

// ---- .webhaste/ scaffolding ----
// Creates the config directory (site.config.json, nav.json, templates/) the
// first time a folder is opened, so project settings live in the repo
// itself rather than the browser's extension storage.
const DEFAULT_CONFIG = {
  siteName: "My Site",
  domain: "",
  paragraphMode: "p",
  activeTemplate: "simple-layout.html",
  cssFramework: "bootstrap5",
  language: "en",
  deploymentTarget: "cloudflare",
  deployDirectory: "dist"
};

// Curated BCP 47 tags covering the common case for both Site Settings'
// default-language picker and Page Properties' per-page override — not the
// full ISO 639-1 list (180+ entries is worse UX for the 95% case). Either
// dialog also offers a free-text "Other" option for anything not listed
// here (regional variants like pt-BR, or rarer languages).
const COMMON_LANGUAGES = [
  ["en", "English"], ["es", "Spanish"], ["fr", "French"], ["de", "German"],
  ["it", "Italian"], ["pt", "Portuguese"], ["pt-BR", "Portuguese (Brazil)"],
  ["nl", "Dutch"], ["sv", "Swedish"], ["no", "Norwegian"], ["da", "Danish"],
  ["fi", "Finnish"], ["pl", "Polish"], ["ru", "Russian"], ["uk", "Ukrainian"],
  ["tr", "Turkish"], ["el", "Greek"], ["cs", "Czech"], ["ro", "Romanian"],
  ["hu", "Hungarian"], ["he", "Hebrew"], ["ar", "Arabic"], ["hi", "Hindi"],
  ["bn", "Bengali"], ["ur", "Urdu"], ["fa", "Persian"], ["th", "Thai"],
  ["vi", "Vietnamese"], ["id", "Indonesian"], ["ms", "Malay"],
  ["zh-Hans", "Chinese (Simplified)"], ["zh-Hant", "Chinese (Traditional)"],
  ["ja", "Japanese"], ["ko", "Korean"], ["sw", "Swahili"],
  ["af", "Afrikaans"], ["sq", "Albanian"], ["bg", "Bulgarian"],
  ["hr", "Croatian"], ["sk", "Slovak"],
];

// Fills a language <select> with COMMON_LANGUAGES plus an "Other…" escape
// hatch; includeSiteDefault adds a leading "(Use site default)" option for
// Page Properties, where an unset value means "inherit site.config.json".
function languageOptionsHTML(includeSiteDefault) {
  const opts = includeSiteDefault ? [`<option value="">(Use site default)</option>`] : [];
  for (const [code, label] of COMMON_LANGUAGES) {
    opts.push(`<option value="${code}">${label} (${code})</option>`);
  }
  opts.push(`<option value="__other__">Other…</option>`);
  return opts.join("");
}

// Sets a populated language <select> + its paired free-text "other" input
// to reflect `value` (a BCP 47 tag, or "" to mean "no override"/inherit).
function setLanguageSelectValue(selectEl, otherInputEl, value) {
  const known = COMMON_LANGUAGES.some(([code]) => code === value);
  if (!value) {
    selectEl.value = "";
    otherInputEl.style.display = "none";
    otherInputEl.value = "";
  } else if (known) {
    selectEl.value = value;
    otherInputEl.style.display = "none";
    otherInputEl.value = "";
  } else {
    selectEl.value = "__other__";
    otherInputEl.style.display = "";
    otherInputEl.value = value;
  }
}

// Reads back whatever setLanguageSelectValue() populated: "" (no override),
// or the chosen/typed BCP 47 tag.
function getLanguageSelectValue(selectEl, otherInputEl) {
  return selectEl.value === "__other__" ? otherInputEl.value.trim() : selectEl.value;
}
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
  return dirHandle.getDirectoryHandle(".webhaste", { create });
}

// ---- assets/ — a published (not dot-prefixed) folder for images/files the
// user inserts into pages. Unlike .webhaste/, it doesn't exist until the
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

// ---- elements/ — a published (not dot-prefixed) folder for template-only
// resources (background images, favicons, etc.) that a template's <head>/
// CSS references directly (e.g. link href="/elements/favicon.ico"), as
// opposed to assets/, which is for things inserted into page content
// through the editor's Assets picker. No editor UI manages this folder —
// it's meant to be hand-populated on disk — so, like assets/ and scripts/,
// it doesn't exist until the site owner creates it themselves; callers pass
// create=false and handle a null return.
async function getElementsDirHandle(create = false) {
  try {
    return await dirHandle.getDirectoryHandle("elements", { create });
  } catch (err) {
    if (err.name === "NotFoundError") return null;
    throw err;
  }
}

// ---- .webhaste/blocks/ — the site-specific extension point for
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

// One block per .html file in .webhaste/blocks/. Content is used as-is
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

// ---- .webhaste/backups/ — safety net for an edit that scheduleSave()
// queued but flushPendingSave() had to defer (see openFile()'s
// outgoing-file conflict check): rather than let that edit sit only in
// memory until the file is revisited — vulnerable to being lost outright if
// the tab closes first — it's written here immediately, at the moment it's
// deferred. Lazy-created like blocks/, mirrors the page's own relative path
// (getNestedFileHandle) so two same-named pages in different folders can't
// collide, and lives under .webhaste/ so it's excluded from page discovery
// the same way nav.json/blocks/ are — never shows in the sidebar, never
// gets published. Cleaned up once the conflict is actually resolved
// (flushPendingSave()'s filesWithBackup check) — it's a stopgap for the
// unresolved window, not a version history feature.
async function getBackupsDirHandle(create) {
  try {
    return await (await getConfigDir(true)).getDirectoryHandle("backups", { create });
  } catch (err) {
    if (err.name === "NotFoundError") return null;
    throw err;
  }
}

async function writeConflictBackup(name, text) {
  const dir = await getBackupsDirHandle(true);
  const handle = await getNestedFileHandle(dir, name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}

async function removeConflictBackup(name) {
  try {
    const dir = await getBackupsDirHandle(false);
    if (!dir) return;
    const { dir: parent, name: leaf } = await getNestedParentDirHandle(dir, name);
    await parent.removeEntry(leaf);
  } catch (err) {
    if (err.name !== "NotFoundError") throw err;
  }
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
  ico: "image/x-icon",
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

// Same char-class rule as slugifyFileName(), but for a single folder
// segment (no ".html" stripping). Notably, since this strips every
// non-alphanumeric character, a ".." segment always collapses to "" and
// gets dropped by buildPagePath() below — that's what keeps folder input
// safe from path traversal without a separate ".." check.
function slugifyPathSegment(input) {
  return (input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Combines the New File dialog's Folder + File name fields into one
// relative path. Splits on "/" first so a stray slash typed into either
// field (or pasted across both) normalizes the same way either field would
// alone, then slugifies every folder segment and slugifyFileName()'s the
// last one.
function buildPagePath(folderInput, nameInput) {
  const raw = `${folderInput || ""}/${nameInput || ""}`;
  const parts = raw.split("/").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return slugifyFileName("");
  const fileName = slugifyFileName(parts.pop());
  const folders = parts.map(slugifyPathSegment).filter(Boolean);
  return [...folders, fileName].join("/");
}

// getFileHandle()/getDirectoryHandle() only accept a single path segment —
// a "/" in the name throws a TypeError — so a relative path like
// "about/team.html" has to be resolved one directory segment at a time.
async function getNestedFileHandle(rootDir, relativePath, opts) {
  const parts = relativePath.split("/").filter(Boolean);
  let dir = rootDir;
  for (let i = 0; i < parts.length - 1; i++) {
    dir = await dir.getDirectoryHandle(parts[i], { create: !!(opts && opts.create) });
  }
  return dir.getFileHandle(parts[parts.length - 1], opts);
}

// Same walk as getNestedFileHandle(), but stops one level short — for
// callers (like removeEntry()) that need the parent directory handle plus
// the leaf name rather than a file handle.
async function getNestedParentDirHandle(rootDir, relativePath, opts) {
  const parts = relativePath.split("/").filter(Boolean);
  let dir = rootDir;
  for (let i = 0; i < parts.length - 1; i++) {
    dir = await dir.getDirectoryHandle(parts[i], { create: !!(opts && opts.create) });
  }
  return { dir, name: parts[parts.length - 1] };
}

// Recursively walks a project folder yielding every page (.html file), at
// any depth, as { path, handle } — path is the full "/"-joined relative
// path (e.g. "about/team.html"). `exclude` is a set of top-level folder
// names (.webhaste, assets, scripts, the deploy dir) that aren't pages
// and must never be treated as one, so re-rendering doesn't rediscover a
// prior dist/ output as new source pages.
async function* walkPages(dir, exclude, prefix = "") {
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === "directory") {
      if (prefix === "" && exclude.has(name)) continue;
      yield* walkPages(handle, exclude, prefix ? `${prefix}/${name}` : name);
    } else if (name.endsWith(".html")) {
      yield { path: prefix ? `${prefix}/${name}` : name, handle };
    }
  }
}

async function getPageExcludeSet() {
  const config = await getSiteConfig();
  return new Set([".webhaste", "assets", "scripts", "elements", sanitizeDeployDirectory(config.deployDirectory)]);
}

async function ensureScaffold() {
  const cfgDir = await getConfigDir(true);

  // site.config.json
  try {
    await cfgDir.getFileHandle("site.config.json");
  } catch {
    await writeJSONFile(cfgDir, "site.config.json", DEFAULT_CONFIG);
  }
  let config = await readJSONFile(cfgDir, "site.config.json", DEFAULT_CONFIG);

  // projectId — a random, non-secret id that namespaces this project's
  // deployment credentials (Cloudflare/Netlify account + token) inside
  // chrome.storage.local — see projectStorageKey() and the publish/Netlify
  // dialog handlers below. Without it, every project shared the same fixed
  // storage keys, so switching between two sites' folders in one browser
  // profile silently reused (and could overwrite) whichever site's
  // credentials were entered most recently — a real risk of publishing one
  // site's content to another site's Cloudflare/Netlify project. Generated
  // once and written back into site.config.json — safe to commit to git,
  // since it's just a random id, never a secret — so cloning the same repo
  // onto another machine keeps the same id, but two different projects
  // never collide. Backfilled here (not just at file-creation time above)
  // so projects scaffolded before this existed still get one the next time
  // they're opened.
  if (!config.projectId) {
    config = { ...config, projectId: crypto.randomUUID() };
    await writeJSONFile(cfgDir, "site.config.json", config);
  }

  // nav.json
  try {
    await cfgDir.getFileHandle("nav.json");
  } catch {
    await writeJSONFile(cfgDir, "nav.json", DEFAULT_NAV);
  }

  // assets/, scripts/, elements/ — published (not dot-prefixed) folders
  // copied wholesale at publish/render time (see getProjectAssets() et al.).
  // Created upfront so they're visible on disk from the start rather than
  // only lazily appearing on first upload; { create: true } is already a
  // no-op if the folder exists, so this never disturbs existing content.
  const projectDirs = {};
  for (const name of ["assets", "scripts", "elements"]) {
    projectDirs[name] = await dirHandle.getDirectoryHandle(name, { create: true });
  }

  // Tailwind build tooling — package.json, tailwind-input.css, and
  // scripts/custom.css — only scaffolded when cssFramework is "tailwind".
  // Tailwind is the one framework option that can't just be a CDN <link>/
  // <script> a site owner types into their template's <head> like Bootstrap
  // or "none" can: Tailwind's CDN "browser build" script gets blocked by
  // this extension's own CSP inside the preview iframe (script-src 'self',
  // same restriction that blocks a site's own scripts/main.js there — see
  // rewriteScriptsForPreview()'s comment), so its runtime class-scanner
  // never runs and nothing renders in preview even though it would once
  // actually published. Precompiling avoids that gap entirely. Copied in
  // once, same never-overwritten pattern as CLAUDE.md/simple-layout.html
  // below — switching cssFramework away and back later won't clobber a
  // site owner's edits to any of these three files.
  if (config.cssFramework === "tailwind") {
    for (const [src, dir, destName] of [
      ["templates/tailwind/package.json", dirHandle, "package.json"],
      ["templates/tailwind/tailwind-input.css", dirHandle, "tailwind-input.css"],
      ["templates/tailwind/custom.css", projectDirs.scripts, "custom.css"],
    ]) {
      try {
        await dir.getFileHandle(destName);
      } catch {
        const res = await fetch(chrome.runtime.getURL(src));
        const text = await res.text();
        const handle = await dir.getFileHandle(destName, { create: true });
        const writable = await handle.createWritable();
        await writable.write(text);
        await writable.close();
      }
    }
  }

  // Site search — scripts/search.js (this repo's own vanilla-JS search UI,
  // consuming search-index.json) plus scripts/lunr.min.js (the vendored
  // third-party search library it depends on — see vendor/lunr/, bundled
  // locally rather than referenced by CDN, for the same Manifest V3
  // no-remotely-hosted-code reason CodeMirror is vendored below scripts/
  // isn't; unlike CodeMirror, neither of these ever runs inside the
  // extension itself — only in a published site's own visitor's browser).
  // Copied in once, same never-overwritten pattern as the files above — a
  // site owner who customizes either file, or never adds the <script> tags
  // to their template at all, won't have it silently reappear/get clobbered.
  const searchScaffoldFiles = [
    ["templates/search.js", "search.js"],
    ["vendor/lunr/lunr.min.js", "lunr.min.js"],
  ];
  // scripts/styles.css too, but not for Tailwind — that path's own build
  // (npm run build:css) generates scripts/styles.css itself from
  // tailwind-input.css, so seeding a different file there would just get
  // silently overwritten on the first real build. A Tailwind site's search
  // CSS belongs in scripts/custom.css instead, which the block above already
  // scaffolds as this site's hand-written-CSS destination.
  if (config.cssFramework !== "tailwind") {
    searchScaffoldFiles.push(["templates/styles.css", "styles.css"]);
  }
  for (const [src, destName] of searchScaffoldFiles) {
    try {
      await projectDirs.scripts.getFileHandle(destName);
    } catch {
      const res = await fetch(chrome.runtime.getURL(src));
      const text = await res.text();
      const handle = await projectDirs.scripts.getFileHandle(destName, { create: true });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
    }
  }

  // 404.html — Cloudflare Pages and Netlify both auto-serve a root-level
  // 404.html for any unmatched path (otherwise they fall back to serving
  // the homepage, which is confusing). Copied in once from the extension's
  // own bundled copy, same never-overwritten pattern as CLAUDE.md below.
  // It's a complete standalone document on purpose (not a template
  // fragment) — see composePage()'s own-full-document check, which passes
  // it through unwrapped regardless of the site's activeTemplate.
  try {
    await dirHandle.getFileHandle("404.html");
  } catch {
    const res = await fetch(chrome.runtime.getURL("templates/404.html"));
    const text = await res.text();
    const handle = await dirHandle.getFileHandle("404.html", { create: true });
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
  }

  // robots.txt — a real, hand-editable root file (not regenerated on every
  // publish like sitemap.xml, since Disallow rules etc. are something a
  // site owner sets once and expects to stick). Same copied-in-once-then-
  // left-alone pattern as CLAUDE.md/404.html below.
  try {
    await dirHandle.getFileHandle("robots.txt");
  } catch {
    const res = await fetch(chrome.runtime.getURL("templates/robots.txt"));
    const text = await res.text();
    const handle = await dirHandle.getFileHandle("robots.txt", { create: true });
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
  }

  // .gitignore — scaffolded from templates/gitignore (stored there without
  // the leading dot so it doesn't act as a real ignore file inside *this*
  // repo's own templates/ folder — only at a project's root once copied).
  // Currently just excludes publish-state.json (see
  // writePublishStateSnapshot()) — a per-machine "what did I last ship"
  // cache, not project state a clone should inherit. Copy-once, same as
  // robots.txt above: a site owner's own .gitignore (pre-existing or
  // hand-edited afterward) is never touched.
  try {
    await dirHandle.getFileHandle(".gitignore");
  } catch {
    const res = await fetch(chrome.runtime.getURL("templates/gitignore"));
    const text = await res.text();
    const handle = await dirHandle.getFileHandle(".gitignore", { create: true });
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
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
  // Lives at the project root, not .webhaste/, so it's discoverable the
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

  // .claude/skills/building-webhaste-site/ — the same conventions CLAUDE.md
  // covers in full prose, reorganized as a Claude Code skill (a short
  // SKILL.md workflow index plus topic-scoped references/*.md) so an agent
  // that supports skills can load just the section it needs instead of all
  // of CLAUDE.md at once. Lives at the project root under .claude/, not
  // .webhaste/, for the same reason CLAUDE.md does — that's where Claude
  // Code's own skill discovery looks, without being told where to find it.
  // Same copied-in-once-then-left-alone pattern as CLAUDE.md above — never
  // overwritten once it exists, so a site owner's edits (or a deliberate
  // deletion) stick.
  const skillFiles = [
    "SKILL.md",
    "references/pages-and-templates.md",
    "references/navigation-and-metadata.md",
    "references/blocks.md",
    "references/seo-and-search.md",
    "references/site-config-and-testing.md",
  ];
  const claudeDir = await dirHandle.getDirectoryHandle(".claude", { create: true });
  const skillsDir = await claudeDir.getDirectoryHandle("skills", { create: true });
  const skillDir = await skillsDir.getDirectoryHandle("building-webhaste-site", { create: true });
  for (const relPath of skillFiles) {
    const parts = relPath.split("/");
    const fileName = parts.pop();
    let targetDir = skillDir;
    for (const part of parts) {
      targetDir = await targetDir.getDirectoryHandle(part, { create: true });
    }
    try {
      await targetDir.getFileHandle(fileName);
    } catch {
      const res = await fetch(chrome.runtime.getURL(`templates/skills/building-webhaste-site/${relPath}`));
      const text = await res.text();
      const handle = await targetDir.getFileHandle(fileName, { create: true });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
    }
  }

  // compose-core.js + compose.js — a self-contained, dependency-free Node
  // CLI for headlessly rendering this site (see cli/compose.js's own header
  // comment for the full story). Copied into .webhaste/ so the site is
  // composable without the webhaste extension's source repo being
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

// Every *.html file in .webhaste/templates/ — the set both the site-level
// "Layout Template" select (Site Settings) and the per-page "Template"
// override (Page Properties) choose from. Shared so the two never drift
// out of sync on what counts as an available template.
async function listTemplateFiles() {
  const cfgDir = await getConfigDir(true);
  const templatesDir = await cfgDir.getDirectoryHandle("templates", { create: true });
  const names = [];
  for await (const [name, handle] of templatesDir.entries()) {
    if (handle.kind === "file" && name.endsWith(".html")) names.push(name);
  }
  return names.sort();
}

async function populateTemplateDropdown() {
  const select = document.getElementById("templateSelect");
  select.innerHTML = '<option value="">No layout (raw HTML)</option>';
  for (const name of await listTemplateFiles()) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  }
  const config = await getSiteConfig();
  if (config.activeTemplate) select.value = config.activeTemplate;
}

// Page Properties' per-page override of the site's Layout Template — see
// composePage()'s templateName resolution below. Blank means "inherit the
// site default," spelled out with the current default's name so it's clear
// what "default" actually resolves to without having to go check Site
// Settings separately.
async function populatePagePropsTemplateDropdown(selectedValue) {
  const select = document.getElementById("pagePropsTemplate");
  const config = await getSiteConfig();
  const defaultLabel = config.activeTemplate
    ? `(Use site default — ${config.activeTemplate})`
    : "(Use site default — no layout)";
  select.innerHTML = `<option value="">${defaultLabel}</option>`;
  for (const name of await listTemplateFiles()) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  }
  select.value = selectedValue || "";
}

async function tryRestoreFolder() {
  await populateRecentProjectsDropdown();
  const handle = await loadHandle("projectDir");
  if (!handle) return;
  const perm = await handle.queryPermission({ mode: "readwrite" });
  if (perm === "granted") {
    dirHandle = handle;
    document.getElementById("folderName").textContent = dirHandle.name;
    await ensureScaffold();
    await refreshFileList();
    await recordRecentProject(dirHandle, await getSiteConfig());
    await populateRecentProjectsDropdown();
  } else {
    // Chrome requires a user gesture to re-request; show a reconnect hint
    setStatus(`Folder "${handle.name}" needs to be reconnected — click "Open Project Folder".`);
  }
}

document.getElementById("newFile").addEventListener("click", () => {
  if (!dirHandle) {
    setStatus("Open a project folder first.");
    return;
  }
  openNewFileDialog();
});

// ---- New File dialog — separate Folder + File name fields so users don't
// have to type a correct nested path (e.g. "about/team.html") by hand ----
const newFileDialog = document.getElementById("newFileDialog");
const newFileDialogTitle = document.getElementById("newFileDialogTitle");
const newFileTitleInput = document.getElementById("newFileTitle");
const newFileFolderInput = document.getElementById("newFileFolder");
const newFileNameInput = document.getElementById("newFileName");
const newFilePreview = document.getElementById("newFilePreview");
const newFileSaveBtn = document.getElementById("newFileSave");

// Set only while the dialog is open on behalf of the Clone action below —
// the dialog itself (fields, exists-check, "already exists" warning) is
// otherwise identical for "new page" and "clone", so it's shared rather
// than forked into a second dialog.
let cloneSourceName = null;

function openNewFileDialog() {
  cloneSourceName = null;
  newFileDialogTitle.textContent = "New Page";
  newFileSaveBtn.textContent = "Create";
  newFileTitleInput.value = "";
  newFileFolderInput.value = "";
  newFileNameInput.value = "untitled.html";
  updateNewFilePreview();
  newFileDialog.showModal();
}

async function openCloneDialog(name) {
  const pagesData = await getPagesData();
  const sourceTitle = pagesData[name]?.title || "";

  const slash = name.lastIndexOf("/");
  const folder = slash === -1 ? "" : name.slice(0, slash);
  const base = slash === -1 ? name : name.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  const stem = dot === -1 ? base : base.slice(0, dot);
  const ext = dot === -1 ? "" : base.slice(dot);

  cloneSourceName = name;
  newFileDialogTitle.textContent = `Clone "${name}"`;
  newFileSaveBtn.textContent = "Clone";
  newFileTitleInput.value = sourceTitle ? `${sourceTitle} (Copy)` : "";
  newFileFolderInput.value = folder;
  newFileNameInput.value = `${stem}-copy${ext}`;
  updateNewFilePreview();
  newFileDialog.showModal();
}

document.getElementById("newFileCancel").addEventListener("click", () => {
  cloneSourceName = null;
  newFileDialog.close();
});
newFileFolderInput.addEventListener("input", updateNewFilePreview);
newFileNameInput.addEventListener("input", updateNewFilePreview);

// Live preview of the resolved path, and the slot for the reserved-name /
// already-exists warnings — resolved fresh on every keystroke since it's
// cheap and gives immediate feedback instead of failing on Create.
async function updateNewFilePreview() {
  const path = buildPagePath(newFileFolderInput.value, newFileNameInput.value);
  const exclude = await getPageExcludeSet();
  const firstSegment = path.split("/")[0].toLowerCase();

  if ([...exclude].some((e) => e.toLowerCase() === firstSegment)) {
    newFilePreview.textContent = `"${path.split("/")[0]}/" is reserved for site elements and can't contain pages.`;
    newFilePreview.classList.add("warning");
    newFileSaveBtn.disabled = true;
    return;
  }

  let exists = false;
  try {
    await getNestedFileHandle(dirHandle, path, { create: false });
    exists = true;
  } catch {
    exists = false;
  }

  newFileSaveBtn.disabled = false;
  newFilePreview.classList.toggle("warning", exists);
  newFilePreview.textContent = exists
    ? `A page already exists at "${path}" — ${cloneSourceName ? "Clone" : "Create"} will open it as-is.`
    : `Will ${cloneSourceName ? "clone into" : "create"}: ${path}`;
}

newFileSaveBtn.addEventListener("click", async () => {
  const path = buildPagePath(newFileFolderInput.value, newFileNameInput.value);
  const handle = await getNestedFileHandle(dirHandle, path, { create: true });
  const title = newFileTitleInput.value.trim();
  const sourceName = cloneSourceName;
  cloneSourceName = null;

  // Only seed content for a genuinely new (empty) file — an already-existing
  // page (the "warn, don't silently clobber" case) keeps whatever it already
  // has, cloning or not.
  const file = await handle.getFile();
  if (file.size === 0) {
    let content = `<div class="container my-5"><h1>${title || "New page"}</h1>\n<p>Start writing here, or delete this block if not needed.</p></div>`;
    if (sourceName) {
      // Flush first in case sourceName is the page currently open with
      // unsaved edits — same ordering flushPendingSave()'s other callers use
      // to avoid reading stale disk content out from under an in-progress edit.
      await flushPendingSave();
      const sourceHandle = await getNestedFileHandle(dirHandle, sourceName, { create: false });
      content = await (await sourceHandle.getFile()).text();
    }
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
  }

  // Save the page title (and, when cloning, the source page's description/
  // language) into pages.json right away — same store Page Properties
  // writes to — so a clone isn't left blank if the author forgets to revisit
  // Page Properties. Status is deliberately not carried over: a clone of a
  // draft defaults back to active, same as any other new page.
  const pagesData = await getPagesData();
  const sourceMeta = sourceName ? pagesData[sourceName] : null;
  if (title || sourceMeta) {
    pagesData[path] = {
      ...pagesData[path],
      ...(sourceMeta?.description ? { description: sourceMeta.description } : {}),
      ...(sourceMeta?.language ? { language: sourceMeta.language } : {}),
      ...(title ? { title } : {}),
    };
    const cfgDir = await getConfigDir(true);
    await writeJSONFile(cfgDir, "pages.json", pagesData);
  }

  newFileDialog.close();
  await refreshFileList();
  await openFile(path, handle);
  setStatus(sourceName ? `Cloned ${sourceName} to ${path}` : `Created ${path}`);
});

async function refreshFileList() {
  const listEl = document.getElementById("fileList");
  listEl.innerHTML = "";
  fileCache.clear();

  const exclude = await getPageExcludeSet();
  const pagesData = await getPagesData();
  const publishState = await getPublishState();
  const entries = [];
  for await (const entry of walkPages(dirHandle, exclude)) entries.push(entry);
  entries.sort((a, b) => a.path.localeCompare(b.path));

  for (const entry of entries) {
    const file = await entry.handle.getFile();
    entry.publishStatus = classifyPublishStatus(entry.path, file.lastModified, publishState);
  }

  // 404.html is a full standalone HTML document (see compose-core.js's
  // isFullDocument()), not a body fragment like every other page — loading
  // its <!DOCTYPE>/<head>/<style> into visualArea's contenteditable innerHTML
  // doesn't survive intact and breaks editing. It's still discovered and
  // published normally by collectPublishPages() (a separate walkPages()
  // call); this only hides it from the sidebar so it can't be opened here.
  const visibleEntries = entries.filter((e) => e.path.toLowerCase() !== "404.html");

  // Group anything inside a subfolder under its top-level folder name as a
  // collapsible <details> — only one level deep, since static sites built
  // here are rarely nested further than e.g. "shows/baldknobbers.html", and
  // a fully recursive tree isn't worth the complexity for that. Rows (files
  // and folder groups alike) are re-sorted using a shared key so a folder
  // still lands where its name would have sorted as a path segment, keeping
  // the same overall ordering the flat list used to have.
  const rows = [];
  const folderGroups = new Map();
  for (const entry of visibleEntries) {
    const slash = entry.path.indexOf("/");
    if (slash === -1) {
      rows.push({ type: "file", entry, sortKey: entry.path });
      continue;
    }
    const folder = entry.path.slice(0, slash);
    let group = folderGroups.get(folder);
    if (!group) {
      group = { type: "folder", name: folder, entries: [], sortKey: `${folder}/` };
      folderGroups.set(folder, group);
      rows.push(group);
    }
    group.entries.push(entry);
  }
  rows.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  for (const row of rows) {
    if (row.type === "file") {
      listEl.appendChild(
        buildFileItem(row.entry.path, row.entry.handle, pagesData, row.entry.path, row.entry.publishStatus)
      );
      continue;
    }

    const details = document.createElement("details");
    details.className = "file-folder";
    details.open = !collapsedFolders.has(row.name);
    details.addEventListener("toggle", () => {
      collapsedFolders[details.open ? "delete" : "add"](row.name);
    });

    const summary = document.createElement("summary");
    summary.textContent = row.name;
    details.appendChild(summary);

    const itemsWrap = document.createElement("div");
    itemsWrap.className = "file-folder-items";
    for (const { path: name, handle, publishStatus } of row.entries) {
      itemsWrap.appendChild(
        buildFileItem(name, handle, pagesData, name.slice(row.name.length + 1), publishStatus)
      );
    }
    details.appendChild(itemsWrap);

    listEl.appendChild(details);
  }
}

// "New" (never published) vs "modified since publish" mirrors VS Code's
// git-status coloring, but diffed against publish-state.json instead of git
// — see writePublishStateSnapshot()'s comment for why. A page absent from
// that snapshot has never gone out in a Publish/Render; one present but with
// a newer mtime has changed since it last did.
function classifyPublishStatus(path, mtime, publishState) {
  const snapshotMtime = publishState[path];
  return snapshotMtime === undefined ? "new" : mtime > snapshotMtime ? "modified" : null;
}

function applyPublishStatusClass(nameEl, publishStatus) {
  nameEl.classList.remove("file-item-name--new", "file-item-name--modified");
  if (publishStatus === "new") {
    nameEl.classList.add("file-item-name--new");
    nameEl.title = "Never published";
  } else if (publishStatus === "modified") {
    nameEl.classList.add("file-item-name--modified");
    nameEl.title = "Modified since last publish";
  } else {
    nameEl.removeAttribute("title");
  }
}

// Updates one sidebar row's color in place after a debounced keystroke-save
// — refreshFileList() itself deliberately never runs on every keystroke (see
// collapsedFolders' comment above), since it rebuilds the whole sidebar and
// clears fileCache. Finding the row by matching dataset.name (rather than an
// attribute-selector string) sidesteps ever having to escape a filename for
// use in a CSS selector.
async function refreshFileItemPublishStatus(name, mtime) {
  let item = null;
  for (const el of document.querySelectorAll("#fileList .file-item")) {
    if (el.dataset.name === name) {
      item = el;
      break;
    }
  }
  if (!item) return;
  const publishState = await getPublishState();
  applyPublishStatusClass(item.querySelector(".file-item-name"), classifyPublishStatus(name, mtime, publishState));
}

function buildFileItem(name, handle, pagesData, displayName, publishStatus) {
  const item = document.createElement("div");
  item.className = "file-item";
  item.dataset.name = name;

  const nameEl = document.createElement("span");
  nameEl.className = "file-item-name";
  applyPublishStatusClass(nameEl, publishStatus);
  nameEl.textContent = displayName;
  if (name === "index.html") {
    const homeIcon = document.createElement("span");
    homeIcon.className = "file-item-home";
    homeIcon.title = "Home page";
    homeIcon.textContent = " 🏠";
    nameEl.appendChild(homeIcon);
  }
  if (WebhasteCompose.isDraftPage(pagesData[name])) {
    const draftBadge = document.createElement("span");
    draftBadge.className = "file-item-draft-badge";
    draftBadge.title = "Draft — excluded from Publish/Render and sitemap.xml";
    draftBadge.textContent = "DRAFT";
    nameEl.appendChild(draftBadge);
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
  const cloneBtn = document.createElement("button");
  cloneBtn.type = "button";
  cloneBtn.className = "file-item-action";
  cloneBtn.dataset.action = "clone";
  cloneBtn.title = "Clone page";
  cloneBtn.textContent = "⧉";
  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "file-item-action file-item-delete";
  deleteBtn.dataset.action = "delete";
  deleteBtn.title = "Delete page";
  deleteBtn.textContent = "🗑";
  actions.append(propsBtn, cloneBtn, deleteBtn);
  item.appendChild(actions);

  item.addEventListener("click", () => openFile(name, handle));
  return item;
}

// Delegated so the ⚙/⧉/🗑 buttons work no matter how #fileList gets
// re-rendered, and so their clicks can be stopped before they bubble up to
// the row's own "open this file" listener above.
document.getElementById("fileList").addEventListener("click", async (e) => {
  const actionBtn = e.target.closest(".file-item-action");
  if (!actionBtn) return;
  e.stopPropagation();
  const name = actionBtn.closest(".file-item").dataset.name;

  if (actionBtn.dataset.action === "props") {
    await openPagePropertiesDialog(name);
  } else if (actionBtn.dataset.action === "clone") {
    await openCloneDialog(name);
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
  const pagePropsLanguageSelect = document.getElementById("pagePropsLanguage");
  pagePropsLanguageSelect.innerHTML = languageOptionsHTML(true);
  setLanguageSelectValue(pagePropsLanguageSelect, document.getElementById("pagePropsLanguageOther"), meta.language || "");
  document.getElementById("pagePropsStatus").value = WebhasteCompose.isDraftPage(meta) ? "draft" : "active";
  await populatePagePropsTemplateDropdown(meta.template || "");
  document.getElementById("pagePropsExcludeSitemap").checked = WebhasteCompose.isSitemapExcluded(meta);
  document.getElementById("pagePropsExcludeSearch").checked = WebhasteCompose.isSearchExcluded(meta);
  document.getElementById("pagePropsNoindex").checked = !!meta.noindex;
  pagePropertiesDialog.showModal();
}

document.getElementById("pagePropsLanguage").addEventListener("change", (e) => {
  document.getElementById("pagePropsLanguageOther").style.display = e.target.value === "__other__" ? "" : "none";
});

document.getElementById("pagePropsCancel").addEventListener("click", () => pagePropertiesDialog.close());

document.getElementById("pagePropsSave").addEventListener("click", async () => {
  const title = document.getElementById("pagePropsTitle").value.trim();
  const description = document.getElementById("pagePropsDescription").value.trim();
  const language = getLanguageSelectValue(document.getElementById("pagePropsLanguage"), document.getElementById("pagePropsLanguageOther"));
  const isDraft = document.getElementById("pagePropsStatus").value === "draft";
  const template = document.getElementById("pagePropsTemplate").value;
  const excludeFromSitemap = document.getElementById("pagePropsExcludeSitemap").checked;
  const excludeFromSearch = document.getElementById("pagePropsExcludeSearch").checked;
  const noindex = document.getElementById("pagePropsNoindex").checked;
  const pagesData = await getPagesData();

  if (!title && !description && !language && !isDraft && !template && !excludeFromSitemap && !excludeFromSearch && !noindex) {
    delete pagesData[pagePropsFileName];
  } else {
    pagesData[pagePropsFileName] = {
      title,
      description,
      ...(language ? { language } : {}),
      ...(isDraft ? { status: "draft" } : {}),
      ...(template ? { template } : {}),
      ...(excludeFromSitemap ? { excludeFromSitemap: true } : {}),
      ...(excludeFromSearch ? { excludeFromSearch: true } : {}),
      ...(noindex ? { noindex: true } : {}),
    };
  }

  const cfgDir = await getConfigDir(true);
  await writeJSONFile(cfgDir, "pages.json", pagesData);
  pagePropertiesDialog.close();

  // refreshFileList() clears fileCache to rebuild it from disk — flush any
  // edit still sitting in the save debounce first (same ordering openFile()
  // uses), or a pending flushPendingSave() would fire after the clear and
  // write "undefined" over the currently-open page. renderPreview() must
  // run before that clear too, since it reads the current page straight out
  // of fileCache.
  await flushPendingSave();
  renderPreview();
  await refreshFileList();
  setStatus(`Saved properties for ${pagePropsFileName}.`);
});

// ---- Delete page ----
async function deletePage(name) {
  if (!confirm(`Delete "${name}"? This can't be undone.`)) return;

  const { dir, name: leaf } = await getNestedParentDirHandle(dirHandle, name);
  await dir.removeEntry(leaf);
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
  // Flush any edit still queued for whatever was open before this — this
  // read below is a fresh handle.getFile(), and if that's the same file
  // being reopened with a save still in flight, reading now would win the
  // race and clobber fileCache with the stale on-disk copy.
  //
  // If the queued edit is for a *different* file than the one being opened
  // here, don't let a conflict on it block this navigation — the user is
  // leaving that file, so there's no one looking at it to ask "keep yours
  // or theirs?" right now. Write it if it's clean; if not, leave it queued
  // (fileCache/pendingSave keep the edit, nothing is lost or written over)
  // and let the check run again — and finally surface the dialog — next
  // time that file is itself written: reopened, saved via Page Properties,
  // or published. Also back it up to .webhaste/backups/ right away, rather
  // than only on tab close: a deferred edit can now sit unflushed for the
  // rest of the session, and beforeunload isn't reliable enough (doesn't
  // fire on a crash or a killed process) to be the only thing standing
  // between that edit and being lost outright.
  if (pendingSave && pendingSave.name !== name) {
    const outgoing = pendingSave;
    const diskFile = await outgoing.handle.getFile();
    if (fileMetaChanged(outgoing.name, diskFile)) {
      await writeConflictBackup(outgoing.name, fileCache.get(outgoing.name));
      filesWithBackup.add(outgoing.name);
      setStatus(`"${outgoing.name}" changed elsewhere — your edit there is backed up and queued, and will be resolved next time you open it.`);
    } else {
      await flushPendingSave();
    }
  } else {
    await flushPendingSave();
  }
  clearTimeout(saveTimer);
  currentFileHandle = handle;
  currentFileName = name;
  const file = await handle.getFile();
  const text = await file.text();
  fileCache.set(name, text);
  recordFileMeta(name, file);
  cm.setValue(text);
  document.getElementById("visualArea").innerHTML = text;
  decorateVisualArea();
  hideLinkBubble();
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
      '<button type="button" data-action="edit-attrs" title="Edit ID / classes">⚙</button>' +
      '<button type="button" data-action="move-up" title="Move block up">↑</button>' +
      '<button type="button" data-action="move-down" title="Move block down">↓</button>' +
      '<button type="button" data-action="cursor-after" title="Place cursor below this block">⏎</button>' +
      '<button type="button" data-action="delete" title="Delete block">🗑</button>';
    block.appendChild(toolbar);
  });
}

// Same idea as decorateBlocks() above, but for every plain <div> in the
// content — not just .cs-block wrappers — so nested layout divs (a
// 3-column block's individual columns, a hand-authored wrapper, etc.) are
// visible and gain a small cog for editing id/class without dropping into
// Code view. .cs-block itself is skipped: it already has the move/delete
// toolbar in the same top-right corner, and a second one would overlap it.
function decorateDivs() {
  document.querySelectorAll("#visualArea div").forEach((div) => {
    if (div.classList.contains("cs-block")) return;
    if (div.classList.contains("cs-block-toolbar") || div.classList.contains("cs-div-toolbar")) return;
    if (div.querySelector(":scope > .cs-div-toolbar")) return;
    const toolbar = document.createElement("div");
    toolbar.className = "cs-div-toolbar";
    toolbar.contentEditable = "false";
    toolbar.innerHTML =
      '<button type="button" data-action="edit-attrs" title="Edit ID / classes">⚙</button>' +
      '<button type="button" data-action="cursor-after" title="Place cursor below this div">⏎</button>';
    div.appendChild(toolbar);
  });
}

// Nested divs used to all highlight (and all show their toolbar) at once
// on hover, because CSS :hover bubbles to every ancestor — hovering three
// levels deep lit up three outlines and stacked three toolbars, with no
// way to tell which one belonged to which box. This tracks the single
// nearest .cs-block/div under the pointer (e.target is always the
// innermost element hit-tested, so .closest() from there naturally finds
// the most specific decorated box, not the outermost one) and toggles
// .cs-hovered on just that one box, so exactly one outline/toolbar is
// active at a time. The 1px padding on plain divs (see editor.css) matters
// here too: it leaves a thin sliver of a parent div that isn't covered by
// any child's box, so hovering that sliver targets the parent specifically.
let hoveredBox = null;
function setHoveredBox(box) {
  if (box === hoveredBox) return;
  if (hoveredBox) hoveredBox.classList.remove("cs-hovered");
  hoveredBox = box;
  if (hoveredBox) hoveredBox.classList.add("cs-hovered");
}
// A locked block's toolbar (with its Locked checkbox) should still be
// reachable, but nested divs inside it shouldn't surface their own cogs —
// there's no per-child lock, so a nested div's toolbar would otherwise let
// its id/class be edited (and its own move-after cursor placed) right
// through the parent's lock. Rather than masking those toolbars with CSS
// (they're only ever painted while cs-hovered, at different z-indices per
// tier), redirect the hover target itself: walk up from whatever's under
// the pointer and if any ancestor is .wh-locked, highlight the outermost
// one instead. That ancestor's toolbar is still the one cs-hovered shows.
function outermostLockAncestor(box) {
  const visualEl = document.getElementById("visualArea");
  let found = null;
  for (let el = box; el && el !== visualEl; el = el.parentElement) {
    if (el.classList.contains("wh-locked")) found = el;
  }
  return found;
}
document.getElementById("visualArea").addEventListener("mouseover", (e) => {
  const box = e.target.closest("#visualArea .cs-block, #visualArea div:not(.cs-block-toolbar):not(.cs-div-toolbar)");
  setHoveredBox(box && (outermostLockAncestor(box) || box));
});
document.getElementById("visualArea").addEventListener("mouseleave", () => setHoveredBox(null));

// Defensive re-application of contenteditable="false" to any .wh-locked
// element that's missing it — normally redundant, since the Div Attrs
// dialog sets both together (see divAttrsSave above), but this also has to
// hold for markup loaded straight from disk (hand-edited in Code view, or
// authored outside WebHaste entirely) where the class made it in without
// the attribute.
function enforceLocks() {
  document.querySelectorAll("#visualArea .wh-locked").forEach((el) => {
    if (el.getAttribute("contenteditable") !== "false") el.setAttribute("contenteditable", "false");
  });
}

function decorateVisualArea() {
  decorateBlocks();
  decorateDivs();
  enforceLocks();
}

// Shared by both toolbars' "edit id/class" cog — the block toolbar's ⚙
// opens it on the .cs-block wrapper itself, the div toolbar's ⚙ opens it
// on that plain div. Editable here same as any div; nothing stops the user
// from clearing "cs-block" off a block's own class field, which would just
// make it a plain div on the next decoration pass (loses its move/delete
// toolbar, gains a cog like any other div) — no different in kind from the
// risk of hand-editing structure in Code view.
let editingDivEl = null;
const divAttrsDialog = document.getElementById("divAttrsDialog");

function openDivAttrsDialog(el) {
  editingDivEl = el;
  document.getElementById("divAttrsId").value = el.id || "";
  // el may be the currently cs-hovered box (that's why its cog is visible
  // to click) — strip that editor-only class back out so it doesn't show up
  // as one of "its" classes in the field, or get saved as a real class if
  // the user hits Save without touching this field.
  document.getElementById("divAttrsClass").value = el.className.replace(/\bcs-hovered\b/g, "").replace(/\s+/g, " ").trim();
  document.getElementById("divAttrsLocked").checked = el.classList.contains("wh-locked");
  divAttrsDialog.showModal();
}

// A collapsed Range positioned between two block-level siblings has no line
// box to render a caret in, so Blink silently snaps it back to the nearest
// real text no matter how the Range is built — real content is needed to
// hold a caret. A bare "&nbsp;" text node rather than a wrapping <p> matters
// for what happens *next*, not just for the caret itself: insertBlock()
// deliberately inserts new blocks via plain Range.insertNode() instead of
// execCommand (see the comment above insertBlock() — execCommand's
// insertHTML "cleans up"/reconciles the inserted HTML in ways that mangle
// multi-child wrapper blocks). Range.insertNode() inserts as a *child* when
// the Range's container is an Element — which is exactly why a <p> caused
// the next block to land inside it — but *splits and inserts as a sibling*
// when the container is a Text node. A lone nbsp text node gives Blink
// something to render a caret in while keeping that container a Text node,
// so a block inserted from here lands next to it, not inside it. Shared by
// the .cs-block and plain div toolbars' "place cursor after" buttons.
function placeCursorAfter(el) {
  const gap = document.createTextNode(" ");
  el.after(gap);
  const visualEl = document.getElementById("visualArea");
  visualEl.focus();
  const range = document.createRange();
  range.setStart(gap, 0);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

document.getElementById("visualArea").addEventListener("click", (e) => {
  const btn = e.target.closest(".cs-block-toolbar button");
  if (!btn) return;
  e.preventDefault();
  const block = btn.closest(".cs-block");
  if (btn.dataset.action === "edit-attrs") {
    openDivAttrsDialog(block);
    return;
  } else if (btn.dataset.action === "delete") {
    if (!confirm("Delete this block? This can't be undone.")) return;
    block.remove();
  } else if (btn.dataset.action === "move-up" && block.previousElementSibling) {
    block.parentNode.insertBefore(block, block.previousElementSibling);
  } else if (btn.dataset.action === "move-down" && block.nextElementSibling) {
    block.parentNode.insertBefore(block.nextElementSibling, block);
  } else if (btn.dataset.action === "cursor-after") {
    placeCursorAfter(block);
  }
  scheduleSave();
});

document.getElementById("visualArea").addEventListener("click", (e) => {
  const btn = e.target.closest(".cs-div-toolbar button");
  if (!btn) return;
  e.preventDefault();
  const div = btn.closest(".cs-div-toolbar").parentElement;
  if (btn.dataset.action === "cursor-after") {
    placeCursorAfter(div);
    scheduleSave();
    return;
  }
  openDivAttrsDialog(div);
});

document.getElementById("divAttrsCancel").addEventListener("click", () => divAttrsDialog.close());

divAttrsDialog.addEventListener("close", () => {
  editingDivEl = null;
});

document.getElementById("divAttrsSave").addEventListener("click", () => {
  if (editingDivEl) {
    const id = document.getElementById("divAttrsId").value.trim();
    const className = document.getElementById("divAttrsClass").value.trim();
    const locked = document.getElementById("divAttrsLocked").checked;
    // The Locked checkbox is authoritative over whatever's typed in the
    // class field, so a stray "wh-locked" left in/out of that text doesn't
    // fight the checkbox — reconcile after splitting on whitespace rather
    // than string-matching.
    const classes = new Set(className.split(/\s+/).filter(Boolean));
    if (locked) classes.add("wh-locked");
    else classes.delete("wh-locked");
    if (id) editingDivEl.id = id;
    else editingDivEl.removeAttribute("id");
    if (classes.size) editingDivEl.className = Array.from(classes).join(" ");
    else editingDivEl.removeAttribute("class");
    // contenteditable="false" is what actually blocks stray typing (see
    // enforceLocks() below) — saved as a literal attribute alongside the
    // class rather than toggled only in-memory, since it's inert on a
    // published page (never contenteditable to begin with) and this way
    // there's nothing to strip back out at save time.
    if (locked) editingDivEl.setAttribute("contenteditable", "false");
    else editingDivEl.removeAttribute("contenteditable");
    // Overwriting className above just wiped cs-hovered along with it (this
    // div's own cog is only clickable while it's the hovered box) — restore
    // it so the outline doesn't look "un-hovered" until the mouse re-enters.
    if (editingDivEl === hoveredBox) editingDivEl.classList.add("cs-hovered");
    scheduleSave();
  }
  divAttrsDialog.close();
});

// Tags that always get their own line when serializing out of the visual
// editor — everything else (a, b, span, strong, img, etc.) is treated as
// inline and left running within its block parent's line, so prose isn't
// broken mid-sentence.
const HTML_BLOCK_ELEMENTS = new Set([
  "address", "article", "aside", "blockquote", "details", "dialog",
  "dd", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer",
  "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li",
  "main", "nav", "ol", "p", "pre", "section", "table", "thead", "tbody",
  "tfoot", "tr", "td", "th", "ul", "video", "audio", "iframe", "canvas",
  "summary", "picture", "script", "style", "noscript",
]);

function hasBlockDescendant(el) {
  return Array.from(el.querySelectorAll("*")).some((child) =>
    HTML_BLOCK_ELEMENTS.has(child.tagName.toLowerCase())
  );
}

// Recursively lays out a container's children one block-level element per
// line, indented 2 spaces per nesting level. A block element whose subtree
// contains no further block elements (e.g. "<li>asdf</li>", "<p>Some
// <b>bold</b> text</p>") is kept on a single line rather than split further
// — only actual nesting (a <ul> full of <li>s, a <div> full of <p>s) gets
// expanded, which is the crammed-together case this exists to fix.
function formatVisualChildren(parent, depth, lines) {
  const indent = "  ".repeat(depth);
  let buffer = "";

  const flush = () => {
    if (buffer.trim()) lines.push(indent + buffer.trim());
    buffer = "";
  };

  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      buffer += node.textContent;
      continue;
    }
    if (node.nodeType === Node.COMMENT_NODE) {
      buffer += `<!--${node.textContent}-->`;
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;

    const tag = node.tagName.toLowerCase();
    if (!HTML_BLOCK_ELEMENTS.has(tag)) {
      buffer += node.outerHTML;
      continue;
    }

    flush();
    // A shallow clone's outerHTML gives just "<tag attrs></tag>" (or
    // "<tag attrs>" for a void element) with none of the real children —
    // stripping the trailing close tag, if any, isolates the opening tag
    // with its attributes correctly escaped by the browser's own serializer.
    const openTag = node.cloneNode(false).outerHTML.replace(/<\/[a-zA-Z0-9-]+>$/, "");
    if (HTML_VOID_ELEMENTS.has(tag)) {
      lines.push(indent + openTag);
    } else if (!hasBlockDescendant(node)) {
      lines.push(`${indent}${openTag}${node.innerHTML}</${tag}>`);
    } else {
      lines.push(indent + openTag);
      formatVisualChildren(node, depth + 1, lines);
      lines.push(`${indent}</${tag}>`);
    }
  }
  flush();
}

// Reverts any live-display blob: URLs back to their real "assets/x.jpg"
// path before the content is read out of #visualArea — used any time that
// content needs to leave this view (saving, switching to Code view, etc.).
// Also pretty-prints the result: contenteditable naturally produces one
// long crammed line (e.g. "<ul><li>a</li><li>b</li></ul>"), which is what
// ends up in Code view and in the saved file if left as-is.
function serializeVisualArea() {
  const clone = document.getElementById("visualArea").cloneNode(true);
  clone.querySelectorAll("img[data-asset-src]").forEach((img) => {
    img.setAttribute("src", img.dataset.assetSrc);
    img.removeAttribute("data-asset-src");
  });
  clone.querySelectorAll(".cs-block-toolbar, .cs-div-toolbar").forEach((el) => el.remove());
  clone.querySelectorAll(".cs-hovered").forEach((el) => {
    el.classList.remove("cs-hovered");
    if (!el.className) el.removeAttribute("class");
  });
  const lines = [];
  formatVisualChildren(clone, 0, lines);
  return lines.join("\n");
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
  hideLinkBubble();

  const visualEl = document.getElementById("visualArea");
  const cmEl = cm.getWrapperElement();
  const richControls = document.getElementById("richControls");

  if (target === "visual") {
    visualEl.innerHTML = html;
    decorateVisualArea();
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
    // Firing the toolbar's Link button with the caret already inside an
    // existing link (no fresh selection made) means "edit this link", not
    // "wrap this text in a new one" — same link the click-to-open bubble
    // below would show. getEnclosingLink() covers both a collapsed caret
    // inside the <a> and a selection that starts within it.
    const sel = document.getSelection();
    const anchorLink = sel.rangeCount ? getEnclosingLink(sel.getRangeAt(0).commonAncestorContainer) : null;
    openLinkDialog(anchorLink);
  } else {
    document.execCommand(cmd, false, btn.dataset.value || undefined);
  }
  scheduleSave();
});

// ---- Link dialog — URL + Same Window/New Window, replacing a plain
// prompt() since execCommand("createLink") only ever takes a URL, not a
// target attribute. Doubles as the Edit-Link dialog: openLinkDialog(link)
// pre-fills from an existing <a> and linkSave writes straight back to its
// attributes instead of running createLink again (see editingLinkEl below) ----
const linkDialog = document.getElementById("linkDialog");
const LINK_MARKER_HREF = "webhaste:new-link";
let savedLinkRange = null;
// Non-null only while editing an existing link (openLinkDialog(link) was
// given an element) — distinguishes "Save" writing straight to this <a>'s
// attributes from the normal execCommand("createLink") insert path.
let editingLinkEl = null;

function getEnclosingLink(node) {
  const el = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
  return el ? el.closest("#visualArea a") : null;
}

function openLinkDialog(existingLink) {
  editingLinkEl = existingLink || null;
  document.getElementById("linkDialogTitle").textContent = editingLinkEl ? "Edit Link" : "Insert Link";
  document.getElementById("linkSave").textContent = editingLinkEl ? "Save" : "Insert";
  document.getElementById("linkRemove").classList.toggle("hidden", !editingLinkEl);

  if (editingLinkEl) {
    // Select the link's full contents so the dialog's context matches what
    // the bubble's Edit button and a link double-click both do — editing
    // never depends on how much of the link text happened to be selected.
    const range = document.createRange();
    range.selectNodeContents(editingLinkEl);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    savedLinkRange = range.cloneRange();
    document.getElementById("linkUrlInput").value = editingLinkEl.getAttribute("href") || "";
    document.getElementById("linkTargetSelect").value = editingLinkEl.getAttribute("target") === "_blank" ? "_blank" : "_self";
  } else {
    const selection = document.getSelection();
    if (!selection.rangeCount) return; // nothing selected/focused in the editor to link
    savedLinkRange = selection.getRangeAt(0).cloneRange();
    document.getElementById("linkUrlInput").value = "";
    document.getElementById("linkTargetSelect").value = "_self";
  }
  linkDialog.showModal();
}

document.getElementById("linkCancel").addEventListener("click", () => linkDialog.close());

document.getElementById("linkRemove").addEventListener("click", () => {
  const link = editingLinkEl;
  linkDialog.close();
  if (!link) return;
  link.replaceWith(...link.childNodes);
  scheduleSave();
});

document.getElementById("linkSave").addEventListener("click", () => {
  const url = document.getElementById("linkUrlInput").value.trim();
  const target = document.getElementById("linkTargetSelect").value;
  const range = savedLinkRange;
  const link = editingLinkEl;
  linkDialog.close();
  if (!url || !range) return;

  const visualArea = document.getElementById("visualArea");
  visualArea.focus();

  if (link) {
    // Editing in place — no need to re-run createLink, this <a> already
    // exists and its text content is untouched.
    link.setAttribute("href", url);
    if (target === "_blank") {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    } else {
      link.removeAttribute("target");
      link.removeAttribute("rel");
    }
    scheduleSave();
    return;
  }

  const selection = document.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  // createLink with a unique marker href first, then swap it for the real
  // URL on the resulting <a> — lets the just-created link be found
  // unambiguously afterward even if the real URL already appears elsewhere
  // on the page.
  document.execCommand("createLink", false, LINK_MARKER_HREF);
  const newLink = visualArea.querySelector(`a[href="${LINK_MARKER_HREF}"]`);
  if (newLink) {
    newLink.setAttribute("href", url);
    if (target === "_blank") {
      newLink.setAttribute("target", "_blank");
      newLink.setAttribute("rel", "noopener noreferrer");
    } else {
      newLink.removeAttribute("target");
      newLink.removeAttribute("rel");
    }
  }
  scheduleSave();
});

// ---- Link info bubble — clicking an existing link in Visual view used to
// be a dead end: the only way to see its URL, let alone change it, was
// switching to Code view. This shows the href plus Edit/Unlink right where
// you clicked, and doubles as the entry point for "select this whole link"
// (see the dblclick handler below) rather than requiring a manual
// click-drag across it first. ----
const linkBubble = document.getElementById("linkBubble");
let bubbleLinkEl = null;

function hideLinkBubble() {
  linkBubble.classList.add("hidden");
  bubbleLinkEl = null;
}

function showLinkBubble(link) {
  bubbleLinkEl = link;
  const href = link.getAttribute("href") || "";
  // Deliberately plain text, not a real <a href>: relative hrefs like
  // "about.html" are relative to the *site* being edited, not to this
  // extension's own editor.html, so making it clickable here would
  // navigate the bubble to the wrong place for anything but absolute URLs.
  const hrefEl = document.getElementById("linkBubbleHref");
  hrefEl.textContent = href || "(no URL)";
  hrefEl.title = href;

  linkBubble.classList.remove("hidden");
  const linkRect = link.getBoundingClientRect();
  const bubbleRect = linkBubble.getBoundingClientRect();
  let top = linkRect.bottom + 6;
  if (top + bubbleRect.height > window.innerHeight) top = linkRect.top - bubbleRect.height - 6;
  let left = linkRect.left;
  if (left + bubbleRect.width > window.innerWidth) left = window.innerWidth - bubbleRect.width - 8;
  linkBubble.style.top = `${Math.max(4, top)}px`;
  linkBubble.style.left = `${Math.max(4, left)}px`;
}

document.getElementById("visualArea").addEventListener("click", (e) => {
  if (currentView !== "visual") return;
  const link = e.target.closest("a");
  if (link) {
    showLinkBubble(link);
  } else {
    hideLinkBubble();
  }
});

// Overrides the browser's default double-click-selects-one-word behavior
// specifically on links — most links are short phrases, not single words
// ("Contact us"), so a plain double-click leaves the rest unselected and a
// URL/target edit would only apply cleanly to that one word's worth of <a>.
// Selecting the full link here is what makes the Edit dialog's range always
// correct without the user having to drag-select it by hand first.
document.getElementById("visualArea").addEventListener("dblclick", (e) => {
  if (currentView !== "visual") return;
  const link = e.target.closest("a");
  if (!link) return;
  e.preventDefault();
  const range = document.createRange();
  range.selectNodeContents(link);
  const selection = document.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  showLinkBubble(link);
});

document.getElementById("visualArea").addEventListener("scroll", hideLinkBubble);

// Clicks on the link itself are handled by the visualArea listener above
// (which runs first, since the event bubbles from the <a> up through
// visualArea before reaching document) — this only needs to catch clicks
// that land outside both the bubble and visualArea, e.g. the toolbar or a
// dialog, where nothing else would ever close it.
document.addEventListener("click", (e) => {
  if (linkBubble.classList.contains("hidden")) return;
  if (linkBubble.contains(e.target)) return;
  if (e.target.closest("#visualArea")) return;
  hideLinkBubble();
});

document.getElementById("linkBubbleEdit").addEventListener("click", () => {
  const link = bubbleLinkEl;
  hideLinkBubble();
  if (link) openLinkDialog(link);
});

document.getElementById("linkBubbleUnlink").addEventListener("click", () => {
  const link = bubbleLinkEl;
  hideLinkBubble();
  if (!link) return;
  link.replaceWith(...link.childNodes);
  scheduleSave();
});

// Keeps the dropdown showing the *actual* style of wherever the caret/
// selection currently sits, instead of whatever was last picked — without
// this, clicking into a paragraph right after applying "Heading 1"
// elsewhere left the select still reading "Heading 1", and since <select>
// only fires "change" on an actual value change, re-picking "Heading 1" for
// the new selection silently did nothing until you first picked something
// else. document-level because selectionchange doesn't bubble from a
// specific element; the visualArea.contains() check scopes it to only fire
// while the caret is actually inside the editor.
const FORMAT_BLOCK_TAGS = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "PRE"]);

document.addEventListener("selectionchange", () => {
  if (currentView !== "visual") return;
  const visualArea = document.getElementById("visualArea");
  const selection = document.getSelection();
  if (!selection.rangeCount) return;
  let node = selection.getRangeAt(0).startContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  if (!node || !visualArea.contains(node)) return;

  let tag = "P";
  for (let el = node; el && el !== visualArea; el = el.parentElement) {
    if (FORMAT_BLOCK_TAGS.has(el.tagName)) {
      tag = el.tagName;
      break;
    }
  }
  document.getElementById("formatBlockSelect").value = tag;
});

document.getElementById("formatBlockSelect").addEventListener("change", (e) => {
  document.getElementById("visualArea").focus();
  document.execCommand("formatBlock", false, e.target.value);
  scheduleSave();
});

// Align/List dropdowns group several one-shot actions under a single
// control (like formatBlockSelect above), but unlike paragraph style,
// "current alignment" and "current list type" aren't tracked, so leaving
// the picked option displayed would misrepresent the doc as soon as the
// user clicks elsewhere. Snapping back to the placeholder after firing
// keeps these read as action menus, not state indicators.
document.querySelectorAll("select.action-select").forEach((select) => {
  select.addEventListener("change", (e) => {
    const cmd = e.target.value;
    if (!cmd) return;
    document.getElementById("visualArea").focus();
    document.execCommand(cmd, false, undefined);
    e.target.selectedIndex = 0;
    scheduleSave();
  });
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

    decorateVisualArea();
  } else {
    cm.replaceSelection(`<div id="${id}" class="${className}">\n${html}\n</div>`);
    cm.focus();
  }
  scheduleSave();
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

// ---- Blocks dialog — built-in BLOCK_LIBRARY + site-specific .webhaste/blocks/ ----
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

// ---- Symbols dialog — common punctuation + a small curated emoji set,
// same insert-at-cursor pattern as the Assets/Blocks grids above
// (captureSelection() before showModal() steals focus, insertSnippet()
// restores the saved range). Not the full TinyMCE-style character map —
// just what's actually common on a website (typographic dashes/quotes,
// copyright/trademark, fractions, currency, arrows) plus a fixed emoji set,
// per James's ask rather than an exhaustive Unicode picker. ----
const SPECIAL_CHARACTERS = [
  { char: "–", name: "En dash" },
  { char: "—", name: "Em dash" },
  { char: "…", name: "Ellipsis" },
  { char: "•", name: "Bullet" },
  { char: "§", name: "Section" },
  { char: "©", name: "Copyright" },
  { char: "®", name: "Registered trademark" },
  { char: "™", name: "Trademark" },
  { char: "°", name: "Degree" },
  { char: "±", name: "Plus-minus" },
  { char: "×", name: "Multiplication" },
  { char: "÷", name: "Division" },
  { char: "¼", name: "One quarter" },
  { char: "½", name: "One half" },
  { char: "¾", name: "Three quarters" },
  { char: "€", name: "Euro" },
  { char: "£", name: "Pound" },
  { char: "¥", name: "Yen" },
  { char: "¢", name: "Cent" },
  { char: "‘", name: "Left single quote" },
  { char: "’", name: "Right single quote" },
  { char: "“", name: "Left double quote" },
  { char: "”", name: "Right double quote" },
  { char: "→", name: "Right arrow" },
  { char: "←", name: "Left arrow" },
  { char: "✓", name: "Check mark" },
];

const COMMON_EMOJI = [
  { char: "✅", name: "Check mark button" },
  { char: "❌", name: "Cross mark" },
  { char: "⛔", name: "No entry" },
  { char: "❗", name: "Exclaimation mark" },
  { char: "❓", name: "Question mark" },
  { char: "💯", name: "Hundred points" },
  { char: "✔️", name: "Check mark" },
  { char: "🔴", name: "Red circle" },
  { char: "🔵", name: "Blue circle" },
  { char: "🔹", name: "Small blue diamond" },
  { char: "🔷", name: "Large blue diamond" },
  { char: "❤️", name: "Red heart" },
  { char: "💔", name: "Broken heart" },
  { char: "🔔", name: "Bell" },
  { char: "📣", name: "Megaphone" },
  { char: "🎯", name: "Direct hit" },
  { char: "🥇", name: "First place medal" },
  { char: "🏖️", name: "Beach with umbrella" },
  { char: "🏛️", name: "Classical building" },
  { char: "⛪", name: "Church" },
  { char: "🏠", name: "House" },
  { char: "\u{1F600}", name: "Grinning face" },
  { char: "☹️", name: "Frowning face" },
  { char: "\u{1F642}", name: "Slightly smiling face" },
  { char: "🥳", name: "Partying face" },
  { char: "\u{1F44D}", name: "Thumbs up" },
  { char: "👎", name: "Thumbs down" },
  { char: "👈", name: "Backhand index pointing left" },
  { char: "👉", name: "Backhand index pointing right" },
  { char: "💪", name: "Flexed biceps" },
  { char: "👏", name: "Clapping hands" },
  { char: "💁", name: "Person tipping hand" },
  { char: "🤷", name: "Person shrugging" },
  { char: "🤦", name: "Person facepalming" },
  { char: "🤖", name: "Robot" },
  { char: "\u{1F4A9}", name: "Pile of poo" },
  { char: "\u{1F354}", name: "Hamburger" },
  { char: "\u{1F964}", name: "Cup with straw" },
  { char: "\u{1F3B8}", name: "Guitar" },
  { char: "\u{1F3AC}", name: "Clapper board" },
  { char: "\u{1F3B9}", name: "Musical keyboard" },
  { char: "\u{1F697}", name: "Car" },
  { char: "\u{1F4EB}", name: "Mailbox" },
  { char: "✒️", name: "Fountain pen" },
  { char: "\u{1F4BB}", name: "Laptop" },
];

function renderSymbolGrid(gridId, entries) {
  const grid = document.getElementById(gridId);
  entries.forEach(({ char, name }) => {
    const tile = document.createElement("div");
    tile.className = "symbol-tile";
    tile.title = name;
    tile.dataset.char = char;
    tile.textContent = char;
    grid.appendChild(tile);
  });
}
renderSymbolGrid("symbolGrid", SPECIAL_CHARACTERS);
renderSymbolGrid("emojiGrid", COMMON_EMOJI);

const symbolsDialog = document.getElementById("symbolsDialog");
document.getElementById("openSymbolsBtn").addEventListener("click", () => {
  captureSelection();
  symbolsDialog.showModal();
});
document.getElementById("symbolsDialogClose").addEventListener("click", () => symbolsDialog.close());
document.querySelectorAll("#symbolsDialog .symbol-grid").forEach((grid) => {
  grid.addEventListener("click", (e) => {
    const tile = e.target.closest(".symbol-tile");
    if (!tile) return;
    // Close BEFORE inserting — see the identical comment on the assets grid
    // click handler above for why.
    symbolsDialog.close();
    insertSnippet(tile.dataset.char);
  });
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
//
// pendingSave captures *which* file a queued write targets at the moment
// it's scheduled, rather than flushPendingSave() reading the then-current
// currentFileHandle/currentFileName when its timer fires. Without that
// capture, switching to a different file within the 400ms debounce window
// re-targeted the queued write at whatever file was open when the timer
// fired — silently dropping the original edit on the floor (it stayed in
// fileCache, but openFile() re-reads from disk on open, so reopening the
// first file later in the session clobbered that in-memory edit with the
// stale on-disk copy). openFile() below also flushes any pending save
// before it reads from disk, so a same-file "switch away and back" within
// the debounce window can't hit that stale-read race either.
let saveTimer = null;
let pendingSave = null; // { handle, name } or null

function scheduleSave() {
  syncFromActiveView();
  renderPreview();
  pendingSave = { handle: currentFileHandle, name: currentFileName };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushPendingSave, 400);
}

// Cross-user/cross-tab conflict guard for shared-drive projects (Dropbox,
// Google Drive, a network share): tracks the size/lastModified this client
// last saw for each open file — from its own read in openFile() or its own
// write in flushPendingSave() — so a write can tell "unchanged since I last
// touched it" apart from "someone else wrote a newer version I haven't seen
// yet." Same cheap metadata-only comparison previewDataUrlCache already
// uses instead of reading full file contents.
const knownFileMeta = new Map(); // name -> { lastModified, size }

function recordFileMeta(name, file) {
  knownFileMeta.set(name, { lastModified: file.lastModified, size: file.size });
}

function fileMetaChanged(name, file) {
  const known = knownFileMeta.get(name);
  if (!known) return false;
  return known.lastModified !== file.lastModified || known.size !== file.size;
}

// Names with a live .webhaste/backups/ copy from openFile()'s outgoing-file
// conflict check — checked here so the (rare) cleanup call only happens for
// files that actually have a backup to remove, not on every ordinary save.
const filesWithBackup = new Set();

async function clearBackupIfAny(name) {
  if (!filesWithBackup.has(name)) return;
  await removeConflictBackup(name);
  filesWithBackup.delete(name);
}

// pendingSave is only cleared on a *successful* write — if createWritable/
// write/close throws (permission lapsed, disk full, file locked by another
// program), the previous version of this silently ate the rejection and the
// status bar kept showing the last successful "Saved" message, so a failed
// write looked identical to a real one. Leaving pendingSave set here means
// the edit isn't lost even though it didn't land on disk yet: the next
// keystroke's scheduleSave() will overwrite it with the same target (no-op
// for the retry), and — more importantly — openFile()'s flush-before-read
// will retry it before ever navigating away, instead of quietly reading
// stale disk content over top of it.
async function flushPendingSave() {
  if (!pendingSave) return;
  const { handle, name } = pendingSave;
  try {
    const diskFile = await handle.getFile();
    if (fileMetaChanged(name, diskFile)) {
      // Someone else's write landed on disk since we last read/wrote this
      // file — writing straight over it would silently discard their
      // change. confirm() blocks here on purpose: this can't be resolved
      // silently either way, and a plain OK/Cancel is the simplest UI that
      // still lets the user choose which side wins.
      const keepMine = confirm(
        `"${name}" was changed elsewhere (another device or tab) since you last saved it here.\n\n` +
        `Click OK to overwrite that version with your changes.\n` +
        `Click Cancel to discard your changes here and load the newer version instead.`
      );
      if (!keepMine) {
        pendingSave = null;
        const text = await diskFile.text();
        fileCache.set(name, text);
        recordFileMeta(name, diskFile);
        if (currentFileName === name) {
          cm.setValue(text);
          document.getElementById("visualArea").innerHTML = text;
          decorateVisualArea();
          hideLinkBubble();
          renderPreview();
        }
        // The user explicitly chose to discard their edit in favor of the
        // newer version — any backup made while it sat deferred no longer
        // has anything worth keeping.
        await clearBackupIfAny(name);
        setStatus(`Loaded the newer version of ${name} from disk — your local changes here were discarded.`);
        return;
      }
    }
    const writable = await handle.createWritable();
    await writable.write(fileCache.get(name));
    await writable.close();
    pendingSave = null;
    const savedFile = await handle.getFile();
    recordFileMeta(name, savedFile);
    // Covers both the "OK, overwrite theirs" choice above and the plain
    // clean-save case — either way this edit just made it to disk, so a
    // backup from an earlier deferred attempt is now redundant.
    await clearBackupIfAny(name);
    setStatus(`Saved ${name}`);
    await refreshFileItemPublishStatus(name, savedFile.lastModified);
  } catch (err) {
    setStatus(`Couldn't save ${name}: ${err.message} — your edits are still here and will be retried.`);
  }
}

// ---- Template / global nav system ----
// Pages never contain header/nav/footer themselves. A layout.html template
// has named placeholders — {{NAV:header}}, {{NAV:footer}}, etc. — resolved
// against .webhaste/nav.json, which supports nested "children" arrays for
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
// blocks don't belong here — see getCustomBlocks() / .webhaste/blocks/.
const BLOCK_LIBRARY = [
  {
    id: "container",
    label: "Container",
    icon: "📝",
    frameworks: {
      bootstrap5: `
      <div class="container mx-auto my-3">
  <h1>Your Headline Here</h1>
  <p>Text Content Here</p>
</div>
`,
tailwind: `
<div class="container mx-auto my-3">
  <h1>Your Headline Here</h1>
  <p>Text Content Here</p>
</div>
`,
    },
  },
  {
    id: "hero",
    label: "Hero",
    icon: "🖼️",
    frameworks: {
      bootstrap5: `
      <div class="hero-content d-flex flex-column justify-content-center align-items-center px-4 py-5 my-5 text-center">
  <h1 class="display-5 fw-bold">Your Headline Here</h1>
  <div class="col-lg-6 mx-auto">
    <p class="lead mb-4">A short, compelling line about what you offer and why it matters.</p>
    <div class="d-grid gap-2 d-sm-flex justify-content-sm-center">
      <button type="button" class="btn btn-primary btn-lg px-4 gap-3">Get Started</button>
      <button type="button" class="btn btn-outline-secondary btn-lg px-4">Learn More</button>
    </div>
  </div>
</div>
`,
    },
  },
  {
    id: "cta",
    label: "Call to Action",
    icon: "📣",
    frameworks: {
      bootstrap5: `
      <div class="cta-content d-flex flex-column justify-content-center align-items-center p-5 mb-4 bg-light rounded-3">
  <h2 class="fw-bold">Ready to get started?</h2>
  <p class="fs-5 mb-4">Join hundreds of happy customers today.</p>
  <button type="button" class="btn btn-primary btn-lg">Sign Up Now</button>
</div>
`,
    },
  },
  {
    id: "testimonial",
    label: "Testimonial",
    icon: "💬",
    frameworks: {
      bootstrap5: `
      <div class="testimonial-content text-center p-4">
  <blockquote class="blockquote">
    <p>&ldquo;This product completely changed the way we work. Couldn't imagine going back.&rdquo;</p>
  </blockquote>
  <figcaption class="blockquote-footer mt-2">
    Jane Doe, <cite title="Company">Acme Co.</cite>
  </figcaption>
</div>
`,
    },
  },
  {
    id: "contact",
    label: "Contact",
    icon: "✉️",
    frameworks: {
      bootstrap5: `
      <div class="contact-content row g-4 p-4">
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
</div>
`,
    },
  },
  {
    id: "feature-columns",
    label: "3-Column Features",
    icon: "▦",
    frameworks: {
      bootstrap5: `
      <div class="feature-column-content row g-4 p-4 text-center">
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
</div>
`,
    },
  },
  {
    id: "table",
    label: "Table",
    icon: "📊",
    frameworks: {
      bootstrap5: `
      <table class="table table-striped">
  <thead>
    <tr>
      <th>Song</th>
      <th>Artist</th>
      <th>Year</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>The Sliding Mr. Bones</td>
      <td>Malcolm Lockyer</td>
      <td>1961</td>
    </tr>
    <tr>
      <td>Witchy Woman</td>
      <td>The Eagles</td>
      <td>1972</td>
    </tr>
    <tr>
      <td>Shining Star</td>
      <td>Earth, Wind, and Fire</td>
      <td>1975</td>
    </tr>
  </tbody>
</table>
`,
      tailwind: `
      <table class="table-auto">
  <thead>
    <tr>
      <th>Song</th>
      <th>Artist</th>
      <th>Year</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>The Sliding Mr. Bones</td>
      <td>Malcolm Lockyer</td>
      <td>1961</td>
    </tr>
    <tr>
      <td>Witchy Woman</td>
      <td>The Eagles</td>
      <td>1972</td>
    </tr>
    <tr>
      <td>Shining Star</td>
      <td>Earth, Wind, and Fire</td>
      <td>1975</td>
    </tr>
  </tbody>
</table>
`,
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
      bootstrap5: `
      <div class="video-content ratio ratio-16x9 my-4">
  <iframe src="https://example.com/replace-with-your-embed-url" title="Video embed" allowfullscreen></iframe>
</div>
`,
    },
  },
  {
    id: "misc-embed",
    label: "Misc Embed",
    icon: "📋",
    frameworks: {
      // No aspect-ratio wrapper — forms (Zoho Forms, etc.) vary in height by
      // content, not by width, so a ratio div would either clip them or leave
      // dead space. min-height is just a reasonable starting point; the site
      // author adjusts it in Code view to match their actual form's height.
      bootstrap5: `
      <div class="embed-content my-4">
      <iframe src="https://example.com/replace-with-your-embed-url" title="Misc embed" class="w-100 border-0 my-4" style="min-height: 600px;"></iframe>
      </div>
      `,
    },
  },
];

// ---- .webhaste/block-library.md — agent/human-readable reference for
// every block available in the Blocks dialog (built-in BLOCK_LIBRARY above,
// plus this site's custom .webhaste/blocks/*.html), filtered to the
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
    `Auto-generated by WebHaste — reflects the extension's built-in block ` +
      `library plus this site's custom blocks in \`.webhaste/blocks/\`, ` +
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

  lines.push("## Custom (`.webhaste/blocks/`)", "");
  const customBlocks = await getCustomBlocks();
  if (customBlocks.length) {
    for (const block of customBlocks) {
      lines.push(`- **${block.label}** — \`.webhaste/blocks/${block.id.replace(/^custom:/, "")}\``);
    }
  } else {
    lines.push(
      "None yet. Add one by dropping an `.html` file into `.webhaste/blocks/` — see `CLAUDE.md`."
    );
  }
  lines.push("");

  const handle = await cfgDir.getFileHandle("block-library.md", { create: true });
  const writable = await handle.createWritable();
  await writable.write(lines.join("\n"));
  await writable.close();
}

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

// Nav rendering lives in compose-core.js (loaded before this file, see
// editor.html) — it's the shared source of truth with cli/compose.js's
// headless Node render, so the two never drift. WebHaste doesn't inject any
// CSS framework assets itself (published or preview) — a template's
// <head> is expected to reference whatever the site author wants directly,
// same as it already does for scripts/styles.css and scripts/main.js.

async function getSiteConfig() {
  const cfgDir = await getConfigDir(true);
  return readJSONFile(cfgDir, "site.config.json", DEFAULT_CONFIG);
}

async function getNavData() {
  const cfgDir = await getConfigDir(true);
  return readJSONFile(cfgDir, "nav.json", DEFAULT_NAV);
}

// publish-state.json — a per-page mtime snapshot taken after every
// successful Publish (Cloudflare/Netlify) or Render to Local Folder, so the
// sidebar can flag which files have changed since. Deliberately not
// committed to git (see ensureScaffold()'s .gitignore scaffolding) — it's a
// local cache of "what this machine last shipped," not project state
// anyone else's clone should inherit. Failure to write it should never
// undo an otherwise-successful publish, so callers treat this as
// best-effort, same as upsertHashes() above.
async function writePublishStateSnapshot(pageEntries) {
  try {
    const cfgDir = await getConfigDir(true);
    const state = {};
    for (const { path, mtime } of pageEntries) state[path] = mtime;
    await writeJSONFile(cfgDir, "publish-state.json", state);
  } catch (err) {
    console.warn("Could not write publish-state.json (non-fatal):", err);
  }
}

async function getPublishState() {
  const cfgDir = await getConfigDir(true);
  return readJSONFile(cfgDir, "publish-state.json", {});
}

// Per-page <title>/meta-description overrides, keyed by filename. Pages with
// no entry fall back to the default "filename | Site Name" title.
async function getPagesData() {
  const cfgDir = await getConfigDir(true);
  return readJSONFile(cfgDir, "pages.json", {});
}

async function getTemplateText(templateName) {
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

// renderPreview() runs on every keystroke in the visual editor (see
// scheduleSave() — only the disk *write* is debounced, the preview
// recomposition is not), so re-reading and re-base64-encoding every
// asset/element/CSS-background image on every single input event would
// waste work proportional to file size, on every keystroke, for files that
// essentially never change while the user is typing elsewhere on the page.
// Keyed on the file's own size/lastModified — cheap metadata available from
// getFile() without reading its bytes — so a cache hit costs one
// getFileHandle()/getFile() call instead of a full read + base64 encode.
const previewDataUrlCache = new Map(); // `${dirName}:${name}` -> { size, lastModified, dataUrl }

async function getCachedDataUrl(dirHandle, dirName, name) {
  const fileHandle = await dirHandle.getFileHandle(name);
  const file = await fileHandle.getFile();
  const key = `${dirName}:${name}`;
  const cached = previewDataUrlCache.get(key);
  if (cached && cached.size === file.size && cached.lastModified === file.lastModified) {
    return cached.dataUrl;
  }
  const dataUrl = await fileToDataUrl(file);
  previewDataUrlCache.set(key, { size: file.size, lastModified: file.lastModified, dataUrl });
  return dataUrl;
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
      urlByName[name] = await getCachedDataUrl(assetsDir, "assets", name);
    } catch {
      // File genuinely missing from assets/ — leave it broken in preview too.
    }
  }

  return html.replace(ASSET_SRC_RE, (match, name) =>
    urlByName[name] ? `src="${urlByName[name]}"` : match
  );
}

// Same problem again for elements/ (see getElementsDirHandle()'s comment) —
// that folder was only ever meant for <link>-style references, but a
// template's <img src="/elements/logo.png"> hits the exact same
// can't-reach-the-real-file issue as assets/*.jpg above, so it needs the
// same data: URL rewrite for preview.
const ELEMENTS_SRC_RE = /src="\/?elements\/([^"]+)"/g;

async function rewriteElementsSrcsForPreview(html) {
  const names = new Set();
  html.replace(ELEMENTS_SRC_RE, (match, name) => {
    names.add(name);
    return match;
  });
  if (!names.size) return html;

  const elementsDir = await getElementsDirHandle(false);
  if (!elementsDir) return html;

  const urlByName = {};
  for (const name of names) {
    try {
      urlByName[name] = await getCachedDataUrl(elementsDir, "elements", name);
    } catch {
      // File genuinely missing from elements/ — leave it broken in preview too.
    }
  }

  return html.replace(ELEMENTS_SRC_RE, (match, name) =>
    urlByName[name] ? `src="${urlByName[name]}"` : match
  );
}

// scripts/*.css hits the same broken-relative-path problem as assets/*.jpg
// above, but the fix differs: a <link href="scripts/x.css"> can't be
// swapped for a data: URL and left as a <link> the way images can, because
// that's still a resource *load*, and while style-src isn't restricted by
// editor.html's manifest CSP (script-src 'self' 'wasm-unsafe-eval'), there's
// no reason to route through a URL at all when the actual CSS text is sitting
// right there on disk — so the whole <link> tag is replaced with an inline
// <style> block containing the file's real contents instead.
// scripts/*.js is NOT handled here: executing it would require a <script>
// that's either inline or src="data:"/"blob:", and script-src 'self' (the
// same Manifest V3 platform restriction as above) blocks all three for
// anything not shipped inside the extension package
// itself — which arbitrary per-site scripts/main.js never is. There's no
// preview-side workaround; test JS via "Render to local folder" and opening
// the output directly in a normal browser tab (no extension CSP there), or
// via the published site.
// Same page-relative vs. root-relative duality as ASSET_SRC_RE above.
const SCRIPTS_CSS_HREF_RE = /href="\/?scripts\/([^"]+\.css)"/g;
const SCRIPTS_CSS_LINK_RE = /<link[^>]*href="\/?scripts\/([^"]+\.css)"[^>]*>/g;

// A CSS background-image (or any other url()) pointing at assets/elements/
// scripts hits the exact same can't-reach-the-real-file problem as
// ASSET_SRC_RE — it's just embedded in CSS text instead of an HTML
// attribute, so it needs the same data: URL treatment before the CSS gets
// inlined into a <style> block above. Captures which top-level folder it
// points at so the right directory handle can be picked per match; quote
// character (or lack of one) is captured too so it can be required to match
// on the closing side via the \2 backreference.
const CSS_URL_RE = /url\((["']?)(?:\/)?(assets|elements|scripts)\/([^"')]+?)\1\)/g;
const CSS_URL_DIR_GETTERS = {
  assets: getAssetsDirHandle,
  elements: getElementsDirHandle,
  scripts: getScriptsDirHandle,
};

async function rewriteCssUrlsForPreview(css) {
  const refs = new Set();
  css.replace(CSS_URL_RE, (match, quote, dirName, name) => {
    refs.add(`${dirName}/${name}`);
    return match;
  });
  if (!refs.size) return css;

  const dataUrlByRef = {};
  for (const ref of refs) {
    const slash = ref.indexOf("/");
    const dirName = ref.slice(0, slash);
    const name = ref.slice(slash + 1);
    try {
      const dir = await CSS_URL_DIR_GETTERS[dirName](false);
      if (!dir) continue;
      dataUrlByRef[ref] = await getCachedDataUrl(dir, dirName, name);
    } catch {
      // File genuinely missing — leave that url() broken in preview too.
    }
  }

  return css.replace(CSS_URL_RE, (match, quote, dirName, name) => {
    const dataUrl = dataUrlByRef[`${dirName}/${name}`];
    return dataUrl ? `url(${dataUrl})` : match;
  });
}

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
      const rawCss = await (await fileHandle.getFile()).text();
      cssByName[name] = await rewriteCssUrlsForPreview(rawCss);
    } catch {
      // File genuinely missing from scripts/ — leave the link broken in preview too.
    }
  }

  return html.replace(SCRIPTS_CSS_LINK_RE, (match, name) =>
    cssByName[name] !== undefined ? `<style>\n${cssByName[name]}\n</style>` : match
  );
}

async function composePage(rawContent, title, isPreview = false) {
  // Page Properties' per-page "Template" override, checked before the site
  // default — see populatePagePropsTemplateDropdown()'s comment. Needs
  // pagesData/config fetched up front (rather than after the raw-HTML/
  // full-document early return below) since even that early return depends
  // on knowing whether a template actually applies to this page.
  const [config, pagesData] = await Promise.all([getSiteConfig(), getPagesData()]);
  const templateName = (pagesData[title] && pagesData[title].template) || config.activeTemplate;
  const templateText = await getTemplateText(templateName);
  if (!templateText || WebhasteCompose.isFullDocument(rawContent)) {
    // "raw HTML" mode, no wrapping — either no template resolved for this
    // page, or it's already a complete document (e.g. the scaffolded
    // 404.html) that must never be nested inside another one.
    if (!isPreview) return rawContent;
    let out = await rewriteAssetSrcsForPreview(rawContent);
    out = await rewriteElementsSrcsForPreview(out);
    out = await rewriteScriptsForPreview(out);
    return out + PREVIEW_LINK_GUARD_SCRIPT;
  }

  const navData = await getNavData();

  // Non-preview (Publish, Render to Local Folder) delegates entirely to the
  // shared module — this is the exact same function cli/compose.js calls
  // under Node, so a headless render always matches what actually ships.
  if (!isPreview) {
    return WebhasteCompose.composePage({ templateText, rawContent, title, config, navData, pagesData });
  }

  // Preview can't reuse composePage() as-is: rewriteAssetSrcsForPreview/
  // rewriteElementsSrcsForPreview/rewriteScriptsForPreview + the link guard
  // script only make sense inside the sandboxed srcdoc iframe.
  const framework = config.cssFramework || "bootstrap5";
  const pageMeta = pagesData[title] || {};
  const pageTitle = pageMeta.title || title;
  const pageLang = pageMeta.language || config.language || "en";

  let out = templateText.replace(/{{NAV:(\w+)}}/g, (_, menuName) =>
    WebhasteCompose.renderMenu(navData.menus?.[menuName], framework, navData.layouts?.[menuName], menuName)
  );
  out = out
    .replace(/{{CONTENT}}/g, rawContent)
    .replace(/{{TITLE}}/g, pageTitle ? `${pageTitle} | ${config.siteName || ""}` : config.siteName || "Untitled")
    .replace(/{{META_DESCRIPTION}}/g, pageMeta.description || "")
    .replace(/{{SITE_NAME}}/g, config.siteName || "")
    .replace(/{{LANG}}/g, pageLang)
    .replace(/{{YEAR}}/g, String(new Date().getFullYear()));
  out = await rewriteAssetSrcsForPreview(out);
  out = await rewriteElementsSrcsForPreview(out);
  out = await rewriteScriptsForPreview(out);
  out += PREVIEW_LINK_GUARD_SCRIPT;
  return out;
}

// The popped-out preview window (see openPreviewWindowBtn below) — kept as
// a plain reference rather than something reopened per-edit, so the user
// can park it on a second monitor and just keep resizing/refreshing the one
// window while they work in the main one.
let previewWindow = null;

// Chrome around the composed page in the popped-out window: a ribbon
// showing live viewport dimensions (like DevTools' device toolbar) plus
// device-size presets, above a sandboxed iframe holding the actual preview.
// This has to be its own document.write'n shell rather than writing
// `composed` straight into the popup (the pre-ribbon approach) — a plain
// top-level document has nowhere to anchor a ribbon that survives
// renderPreview() re-rendering the page underneath it. The iframe here uses
// the same sandbox="allow-scripts" (no allow-same-origin) as #previewFrame
// in the main window, since `composed` is already built for that exact
// constraint (data: URLs for assets, not blob: — see fileToDataUrl above).
//
// resizeTo() sets the *outer* window size, but the device presets need to
// land on an exact *viewport* width/height (the iframe's content box), so
// each preset click measures the current chrome/ribbon overhead
// (outerWidth - innerWidth, outerHeight - innerHeight - ribbon height) and
// adds it back before calling resizeTo — otherwise the OS title bar and
// this ribbon would eat into the requested device size instead of the
// iframe getting exactly e.g. 375x667.
const PREVIEW_WINDOW_SHELL = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Preview</title>
<style>
  html, body { margin: 0; height: 100%; }
  body { display: flex; flex-direction: column; }
  #cs-preview-ribbon {
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
    height: 34px;
    box-sizing: border-box;
    padding: 0 10px;
    background: #252525;
    border-bottom: 1px solid #3d3d3d;
    font: 12px/1 -apple-system, "Segoe UI", sans-serif;
  }
  #cs-preview-ribbon button {
    background: #2d2d2d;
    color: #e0e0e0;
    border: 1px solid #4a4a4a;
    border-radius: 4px;
    padding: 4px 10px;
    font-size: 12px;
    cursor: pointer;
  }
  #cs-preview-ribbon button:hover { background: #3a3a3a; }
  #cs-preview-size {
    margin-left: auto;
    color: #999;
    font-variant-numeric: tabular-nums;
  }
  #cs-preview-frame { flex: 1; width: 100%; border: 0; }
</style>
</head>
<body>
  <div id="cs-preview-ribbon">
    <button type="button" data-w="375" data-h="667">Phone</button>
    <button type="button" data-w="800" data-h="1024">Tablet</button>
    <button type="button" data-w="1100" data-h="800">Laptop</button>
    <button type="button" data-w="1400" data-h="900">Desktop</button>
    <span id="cs-preview-size"></span>
  </div>
  <iframe id="cs-preview-frame" sandbox="allow-scripts"></iframe>
  <script src="${chrome.runtime.getURL("preview-window.js")}"></script>
</body>
</html>`;

async function renderPreview() {
  const raw = fileCache.get(currentFileName) || "";
  const composed = await composePage(raw, currentFileName, true);
  document.getElementById("previewFrame").srcdoc = composed;

  // Every edit/save/settings-change already funnels through this one
  // function to refresh the iframe, so piggybacking here is what keeps the
  // popped-out window "live" without needing to hook it in at every call
  // site separately. Only the inner iframe's srcdoc is touched — the ribbon
  // shell itself is written once, in openPreviewWindowBtn below, and must
  // survive every re-render.
  if (previewWindow && !previewWindow.closed) {
    const frame = previewWindow.document.getElementById("cs-preview-frame");
    if (frame) frame.srcdoc = composed;
  }
}

document.getElementById("openPreviewWindowBtn").addEventListener("click", () => {
  // A fixed window name means clicking this again reuses/focuses the same
  // OS window rather than spawning duplicates, even if our `previewWindow`
  // reference above is stale (e.g. the user closed it without us noticing).
  const isNewWindow = !previewWindow || previewWindow.closed;
  previewWindow = window.open("", "webhaste-preview-window", "width=1280,height=900");
  if (!previewWindow) {
    setStatus("Preview window was blocked — allow pop-ups for this extension to use it.");
    return;
  }
  previewWindow.focus();
  // Only (re)write the ribbon shell for a window that doesn't have it yet —
  // doing this unconditionally on every click would wipe out whatever
  // device size the user had already resized to, just to refocus a window
  // that's already open and live.
  if (isNewWindow || !previewWindow.document.getElementById("cs-preview-frame")) {
    previewWindow.document.open();
    previewWindow.document.write(PREVIEW_WINDOW_SHELL);
    previewWindow.document.close();
  }
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
  syncLayoutSelect();
  navDialog.showModal();
});
document.getElementById("navCancel").addEventListener("click", () => navDialog.close());

document.getElementById("navSave").addEventListener("click", async () => {
  if (navJsonMode && !syncJsonIntoWorkingData()) return; // bad JSON — bail, message already shown
  const cfgDir = await getConfigDir(true);
  await writeJSONFile(cfgDir, "nav.json", navWorkingData);
  navDialog.close();
  renderPreview();
  setStatus("Menus updated (.webhaste/nav.json).");
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
  syncLayoutSelect();
}

// Reflects navWorkingData.layouts[currentMenuName] ("navbar"/"columns",
// default "navbar") into the toolbar <select>. Called whenever the selected
// menu or navWorkingData itself changes underneath it.
function syncLayoutSelect() {
  document.getElementById("navMenuLayout").value =
    (currentMenuName && navWorkingData.layouts && navWorkingData.layouts[currentMenuName]) || "navbar";
}

document.getElementById("navMenuLayout").addEventListener("change", (e) => {
  if (!currentMenuName) return;
  if (!navWorkingData.layouts) navWorkingData.layouts = {};
  navWorkingData.layouts[currentMenuName] = e.target.value;
});

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
  if (navWorkingData.layouts) delete navWorkingData.layouts[currentMenuName];
  const remaining = Object.keys(navWorkingData.menus);
  currentMenuName = remaining[0] || null;
  renderMenuTabs();
  renderMenuTree(currentMenuName ? navWorkingData.menus[currentMenuName] : []);
  syncLayoutSelect();
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
    syncLayoutSelect();
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
  document.getElementById("navLayoutLabel").classList.toggle("hidden", jsonMode);
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
  const cfgLanguageSelect = document.getElementById("cfgLanguage");
  cfgLanguageSelect.innerHTML = languageOptionsHTML(false);
  setLanguageSelectValue(cfgLanguageSelect, document.getElementById("cfgLanguageOther"), config.language || "en");
  document.getElementById("cfgDeploymentTarget").value = config.deploymentTarget || "cloudflare";
  document.getElementById("cfgDeployDirectory").value = config.deployDirectory || "dist";
  siteSettingsDialog.showModal();
});
document.getElementById("cfgLanguage").addEventListener("change", (e) => {
  document.getElementById("cfgLanguageOther").style.display = e.target.value === "__other__" ? "" : "none";
});
document.getElementById("siteSettingsCancel").addEventListener("click", () => siteSettingsDialog.close());
document.getElementById("siteSettingsSave").addEventListener("click", async () => {
  const config = {
    siteName: document.getElementById("cfgSiteName").value.trim(),
    domain: document.getElementById("cfgDomain").value.trim(),
    paragraphMode: document.getElementById("cfgParagraphMode").value,
    activeTemplate: document.getElementById("templateSelect").value,
    cssFramework: document.getElementById("cfgCssFramework").value,
    language: getLanguageSelectValue(document.getElementById("cfgLanguage"), document.getElementById("cfgLanguageOther")) || "en",
    deploymentTarget: document.getElementById("cfgDeploymentTarget").value,
    deployDirectory: sanitizeDeployDirectory(document.getElementById("cfgDeployDirectory").value),
  };
  const cfgDir = await getConfigDir(true);
  await writeJSONFile(cfgDir, "site.config.json", config);
  applyParagraphMode(config.paragraphMode);
  // Re-run scaffolding so switching cssFramework to "tailwind" here (not
  // just on a brand-new folder open) still gets the Tailwind build files —
  // see ensureScaffold()'s own comment. Also keeps block-library.md's
  // framework-specific markup and compose.js/compose-core.js in sync
  // immediately, rather than only on the next folder open.
  await ensureScaffold();
  siteSettingsDialog.close();
  renderPreview();
  setStatus("Site settings saved (.webhaste/site.config.json).");
});

function applyParagraphMode(mode) {
  try {
    document.execCommand("defaultParagraphSeparator", false, mode === "div" ? "div" : "p");
  } catch {
    // Non-fatal — some Chrome versions ignore this command silently.
  }
}


// Namespaces a chrome.storage.local key to this one project via its
// site.config.json → projectId (see ensureScaffold()), so two different
// projects' deployment credentials — entered into the same dialogs below,
// in the same browser profile — never collide or silently overwrite each
// other. `config` must come from getSiteConfig()/readJSONFile() on an
// already-scaffolded project, so projectId is always present by the time
// this runs (ensureScaffold() runs on every folder open, before Publish is
// reachable).
function projectStorageKey(config, name) {
  return `${config.projectId}:${name}`;
}

// Saves credential fields under this project's namespaced keys — or, if
// `remember` is false, actively *removes* any previously-saved values for
// those same keys instead of just skipping the write. The removal matters:
// a junior editor unchecking "Remember" only stops a new save from
// sticking, but does nothing about a credential the site owner already
// saved in an earlier session — which would otherwise keep autofilling
// regardless of what this session does. See the "Remember these details"
// checkbox in publishDialog/netlifyDialog (editor.html).
async function persistCredentials(config, fields, remember) {
  const keyed = Object.entries(fields).map(([name, value]) => [projectStorageKey(config, name), value]);
  if (remember) {
    await chrome.storage.local.set(Object.fromEntries(keyed));
  } else {
    await chrome.storage.local.remove(keyed.map(([key]) => key));
  }
}

// ---- Publish flow — routes to the configured deployment target ----
document.getElementById("publishBtn").addEventListener("click", async () => {
  const config = await getSiteConfig();
  const target = config.deploymentTarget || "cloudflare";

  if (target === "netlify") {
    const siteIdKey = projectStorageKey(config, "ntlSiteId");
    const tokenKey = projectStorageKey(config, "ntlToken");
    const stored = await chrome.storage.local.get([siteIdKey, tokenKey]);
    document.getElementById("ntlSiteId").value = stored[siteIdKey] || "";
    document.getElementById("ntlToken").value = stored[tokenKey] || "";
    // Reset to "remember" (the safe/previous default) on every open, rather
    // than letting an earlier uncheck this session stick silently — an
    // opt-out should be a deliberate choice each time, not a sticky one.
    document.getElementById("ntlRemember").checked = true;
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

  const accountKey = projectStorageKey(config, "cfAccount");
  const projectKey = projectStorageKey(config, "cfProject");
  const tokenKey = projectStorageKey(config, "cfToken");
  const stored = await chrome.storage.local.get([accountKey, projectKey, tokenKey]);
  document.getElementById("cfAccount").value = stored[accountKey] || "";
  document.getElementById("cfProject").value = stored[projectKey] || "";
  document.getElementById("cfToken").value = stored[tokenKey] || "";
  // Reset to "remember" (the safe/previous default) on every open, rather
  // than letting an earlier uncheck this session stick silently — an
  // opt-out should be a deliberate choice each time, not a sticky one.
  document.getElementById("cfRemember").checked = true;
  document.getElementById("publishDialog").showModal();
});

document.getElementById("publishCancel").addEventListener("click", () => document.getElementById("publishDialog").close());

document.getElementById("publishConfirm").addEventListener("click", async () => {
  const account = document.getElementById("cfAccount").value.trim();
  const project = document.getElementById("cfProject").value.trim();
  const token = document.getElementById("cfToken").value.trim();
  const remember = document.getElementById("cfRemember").checked;
  const config = await getSiteConfig();
  await persistCredentials(config, { cfAccount: account, cfProject: project, cfToken: token }, remember);
  document.getElementById("publishDialog").close();
  await publishSite(account, project, token);
});

// Shared by all three deployment targets — recursively walks the project
// root, skips .webhaste/assets/scripts/deploy-dir automatically, skips
// pages.json-marked drafts (see WebhasteCompose.isDraftPage — Page
// Properties' Status field), and returns both the composed pages and the
// per-page mtimes sitemap.xml needs, in one pass rather than walking the
// directory tree twice.
async function collectPublishPages() {
  const pages = {};
  const pageEntries = [];
  const exclude = await getPageExcludeSet();
  const pagesData = await getPagesData();
  for await (const { path, handle } of walkPages(dirHandle, exclude)) {
    if (WebhasteCompose.isDraftPage(pagesData[path])) continue;
    const file = await handle.getFile();
    const raw = await file.text();
    pages[path] = await composePage(raw, path);
    pageEntries.push({
      path,
      lastmod: new Date(file.lastModified).toISOString().slice(0, 10),
      mtime: file.lastModified,
      rawContent: raw,
    });
  }
  return { pages, pageEntries, pagesData };
}

// robots.txt is a real, hand-editable project-root file (scaffolded once,
// see ensureScaffold()) rather than something regenerated like sitemap.xml
// — read and passed through untouched at publish time, same treatment as
// assets/. Returns null if the site owner deleted it.
async function getRobotsTxtContent() {
  try {
    const handle = await dirHandle.getFileHandle("robots.txt");
    return await (await handle.getFile()).text();
  } catch (err) {
    if (err.name === "NotFoundError") return null;
    throw err;
  }
}

// Raw bytes, not composed text — kept separate from collectPublishPages()
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

// Same shape again, for elements/ — see getElementsDirHandle()'s comment
// for why it's a separate published folder from assets/ and scripts/.
async function getProjectElements() {
  const elementsDir = await getElementsDirHandle(false);
  if (!elementsDir) return {};
  const elements = {};
  for await (const [name, handle] of elementsDir.entries()) {
    if (handle.kind !== "file") continue;
    elements[name] = await (await handle.getFile()).arrayBuffer();
  }
  return elements;
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
function buildPagesFileList(pages, assets, scripts = {}, elements = {}) {
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
  for (const [name, arrayBuffer] of Object.entries(elements)) {
    files.push({
      path: "/elements/" + name,
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
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/pages/projects/${encodeURIComponent(project)}/upload-token`,
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
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/pages/projects/${encodeURIComponent(project)}/deployments`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: formData }
  );
  return res.json();
}

async function publishSite(account, project, token) {
  try {
    setStatus("Composing pages...");
    const { pages, pageEntries, pagesData } = await collectPublishPages();
    const config = await getSiteConfig();
    const assets = await getProjectAssets();
    const scripts = await getProjectScripts();
    const elements = await getProjectElements();
    const files = buildPagesFileList(pages, assets, scripts, elements);

    const sitemap = WebhasteCompose.buildSitemap({ pageEntries, pagesData, config });
    if (sitemap) {
      files.push({
        path: "/sitemap.xml",
        arrayBuffer: new TextEncoder().encode(sitemap).buffer,
        contentType: withCharset("application/xml"),
      });
    }
    const searchIndex = WebhasteCompose.buildSearchIndex({ pageEntries, pagesData });
    if (searchIndex) {
      files.push({
        path: "/search-index.json",
        arrayBuffer: new TextEncoder().encode(searchIndex).buffer,
        contentType: withCharset("application/json"),
      });
    }
    const robots = await getRobotsTxtContent();
    if (robots) {
      files.push({
        path: "/robots.txt",
        arrayBuffer: new TextEncoder().encode(robots).buffer,
        contentType: withCharset("text/plain"),
      });
    }

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
      await writePublishStateSnapshot(pageEntries);
      await refreshFileList();
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
  const remember = document.getElementById("ntlRemember").checked;
  const config = await getSiteConfig();
  await persistCredentials(config, { ntlSiteId: siteId, ntlToken: token }, remember);
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
  const { pages, pageEntries, pagesData } = await collectPublishPages();
  const config = await getSiteConfig();
  const assets = await getProjectAssets();
  const scripts = await getProjectScripts();
  const elements = await getProjectElements();

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
  for (const [name, arrayBuffer] of Object.entries(elements)) {
    fileEntries.push({ path: "/elements/" + name, content: arrayBuffer });
  }
  const sitemap = WebhasteCompose.buildSitemap({ pageEntries, pagesData, config });
  if (sitemap) fileEntries.push({ path: "/sitemap.xml", content: sitemap });
  const searchIndex = WebhasteCompose.buildSearchIndex({ pageEntries, pagesData });
  if (searchIndex) fileEntries.push({ path: "/search-index.json", content: searchIndex });
  const robots = await getRobotsTxtContent();
  if (robots) fileEntries.push({ path: "/robots.txt", content: robots });
  const digests = {};
  for (const f of fileEntries) digests[f.path] = await sha1Hex(f.content);

  try {
    setStatus("Creating Netlify deploy...");
    const createRes = await fetch(`https://api.netlify.com/api/v1/sites/${encodeURIComponent(siteId)}/deploys`, {
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

    await writePublishStateSnapshot(pageEntries);
    await refreshFileList();
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
  const { pages, pageEntries, pagesData } = await collectPublishPages();
  const assets = await getProjectAssets();
  const scripts = await getProjectScripts();
  const elements = await getProjectElements();

  setStatus(`Writing ${folderName}/ folder...`);
  const distDir = await dirHandle.getDirectoryHandle(folderName, { create: true });
  for (const [name, content] of Object.entries(pages)) {
    const handle = await getNestedFileHandle(distDir, name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
  }

  const sitemap = WebhasteCompose.buildSitemap({ pageEntries, pagesData, config });
  if (sitemap) {
    const handle = await getNestedFileHandle(distDir, "sitemap.xml", { create: true });
    const writable = await handle.createWritable();
    await writable.write(sitemap);
    await writable.close();
  }
  const searchIndex = WebhasteCompose.buildSearchIndex({ pageEntries, pagesData });
  if (searchIndex) {
    const handle = await getNestedFileHandle(distDir, "search-index.json", { create: true });
    const writable = await handle.createWritable();
    await writable.write(searchIndex);
    await writable.close();
  }
  const robots = await getRobotsTxtContent();
  if (robots) {
    const handle = await getNestedFileHandle(distDir, "robots.txt", { create: true });
    const writable = await handle.createWritable();
    await writable.write(robots);
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

  if (Object.keys(elements).length) {
    const distElementsDir = await distDir.getDirectoryHandle("elements", { create: true });
    for (const [name, arrayBuffer] of Object.entries(elements)) {
      const handle = await distElementsDir.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(arrayBuffer);
      await writable.close();
    }
  }

  const extras = [sitemap && "sitemap.xml", robots && "robots.txt"].filter(Boolean).join(", ");
  await writePublishStateSnapshot(pageEntries);
  await refreshFileList();
  setStatus(
    `Rendered ${Object.keys(pages).length} page(s), ${Object.keys(assets).length} asset(s), ${Object.keys(scripts).length} script(s), and ${Object.keys(elements).length} element(s)${extras ? `, plus ${extras},` : ""} to the ${folderName}/ folder.`
  );
}

// Session-only (like collapsedFolders/fileCache) — the status bar only ever
// shows the latest message, which is easy to miss if you looked away at the
// wrong moment. Keeping a short scrollback in the element's native `title`
// means hovering reveals what happened recently, without building a custom
// popover just for this.
const STATUS_HISTORY_LIMIT = 10;
const statusHistory = [];

function setStatus(msg) {
  statusHistory.unshift(`${new Date().toLocaleTimeString()}  ${msg}`);
  statusHistory.length = Math.min(statusHistory.length, STATUS_HISTORY_LIMIT);

  const statusBar = document.getElementById("statusBar");
  statusBar.textContent = '🔔 ' + msg;
  statusBar.title = statusHistory.join("\n");
}

// Surfaces the PREVIEW_LINK_GUARD_SCRIPT's blocked-link notices in the
// status bar, so clicking a nav link in the preview gives feedback instead
// of just silently doing nothing.
//
// The sandboxed preview iframes (no allow-same-origin) post with an opaque
// origin, so e.origin is always the string "null" and can't tell one opaque
// sender from another — checking e.source against the two iframes we
// actually control (the main #previewFrame and, if open, the popped-out
// window's #cs-preview-frame) is what actually verifies this came from our
// own preview and not some other page that happened to get a reference to
// this tab and forged the same {source, type} shape.
function isKnownPreviewFrameWindow(win) {
  const mainFrame = document.getElementById("previewFrame");
  if (mainFrame && win === mainFrame.contentWindow) return true;
  if (previewWindow && !previewWindow.closed) {
    const popoutFrame = previewWindow.document.getElementById("cs-preview-frame");
    if (popoutFrame && win === popoutFrame.contentWindow) return true;
  }
  return false;
}

window.addEventListener("message", (e) => {
  if (!e.data || e.data.source !== "webhaste-preview" || e.data.type !== "blocked-link") return;
  if (!isKnownPreviewFrameWindow(e.source)) return;
  setStatus(`Preview: links aren't navigable here (would have opened "${e.data.href}") — open that file directly to preview it.`);
});

// ---- Resizable file-list/editor-pane/preview-pane columns ----
// .workspace is a 5-track grid: file-list, a drag handle, editor-pane,
// another drag handle, preview-pane (see editor.html/editor.css). file-list
// is tracked as a fixed px width (like a VS Code sidebar); editor-pane and
// preview-pane are tracked as fr weights, same unit the CSS default (1fr
// 1fr) already used — dragging their handle just changes the weights, so
// they keep splitting whatever space is left proportionally on window
// resize, exactly like the un-dragged default did. Persisted across
// sessions in localStorage (a UI preference, not project content, so it's
// deliberately not per-project the way collapsedFolders/publish-state are).
const COLUMN_WIDTHS_KEY = "webhaste.columnWidths";
const COLUMN_MIN_PX = 160;
const FILE_LIST_MAX_PX = 500;

let columnState = loadColumnWidths() || { fileList: 200, editor: 1, preview: 1, previewHidden: false };

function loadColumnWidths() {
  try {
    const saved = JSON.parse(localStorage.getItem(COLUMN_WIDTHS_KEY));
    if (saved && typeof saved.fileList === "number" && typeof saved.editor === "number" && typeof saved.preview === "number") {
      return { previewHidden: false, ...saved };
    }
  } catch {
    // fall through to default
  }
  return null;
}

function saveColumnWidths() {
  try {
    localStorage.setItem(COLUMN_WIDTHS_KEY, JSON.stringify(columnState));
  } catch (err) {
    console.warn("Could not persist column widths (non-fatal):", err);
  }
}

function applyColumnState() {
  // Preview resizer is data-idx="1", the second .col-resizer — hidden
  // alongside .preview-pane itself so there's no dead drag handle left
  // floating in the grid when there's nothing next to it to resize.
  const previewResizer = document.querySelectorAll(".col-resizer")[1];
  const previewPane = document.querySelector(".preview-pane");
  previewPane.classList.toggle("pane-hidden", columnState.previewHidden);
  previewResizer.classList.toggle("pane-hidden", columnState.previewHidden);
  document.querySelector(".workspace").style.gridTemplateColumns = columnState.previewHidden
    ? `${columnState.fileList}px 6px 1fr`
    : `${columnState.fileList}px 6px ${columnState.editor}fr 6px ${columnState.preview}fr`;
}

// Small-screen escape hatch (ChromeOS devices are a large share of installs
// and many run tiny display widths) — resizing the preview down still leaves
// it eating width the editor could use, so let it be hidden outright instead.
// Shown by default; state persists alongside the column widths above since
// it's the same "workspace layout preference" bucket.
function setPreviewHidden(hidden) {
  columnState.previewHidden = hidden;
  applyColumnState();
  saveColumnWidths();
  const btn = document.getElementById("togglePreviewBtn");
  btn.textContent = hidden ? "👁️ Show Preview" : "👁️ Hide Preview";
  btn.title = hidden
    ? "Show the live preview pane"
    : "Hide the live preview pane to give the editor more room — handy on small/ChromeOS screens";
  // Editor pane's width just changed without a window resize event, and
  // CodeMirror only measures layout on those — same fix switchView() uses
  // when un-hiding the CodeMirror element itself.
  if (currentView === "code") cm.refresh();
}

function startColumnResizerDrag(startEvent, resizer) {
  startEvent.preventDefault();
  const idx = Number(resizer.dataset.idx);
  const startX = startEvent.clientX;
  let onMove;

  if (idx === 0) {
    const startFileList = columnState.fileList;
    onMove = (moveEvent) => {
      columnState.fileList = Math.max(
        COLUMN_MIN_PX,
        Math.min(FILE_LIST_MAX_PX, startFileList + (moveEvent.clientX - startX))
      );
      applyColumnState();
    };
  } else {
    // editor-pane/preview-pane are fr-weighted, not px, so a plain "add the
    // mouse delta" doesn't mean anything on its own — measuring their
    // current rendered widths here and using those (adjusted by the drag)
    // directly as the new fr weights keeps the same visual ratio the user
    // just dragged to, since fr values are only ever compared to each other.
    const startEditorPx = document.querySelector(".editor-pane").getBoundingClientRect().width;
    const startPreviewPx = document.querySelector(".preview-pane").getBoundingClientRect().width;
    onMove = (moveEvent) => {
      const delta = moveEvent.clientX - startX;
      columnState.editor = Math.max(COLUMN_MIN_PX, startEditorPx + delta);
      columnState.preview = Math.max(COLUMN_MIN_PX, startPreviewPx - delta);
      applyColumnState();
    };
  }

  resizer.classList.add("resizing");
  document.body.classList.add("resizing-columns");

  function onUp() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    resizer.classList.remove("resizing");
    document.body.classList.remove("resizing-columns");
    saveColumnWidths();
  }
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function initColumnResizers() {
  applyColumnState();
  if (columnState.previewHidden) {
    const btn = document.getElementById("togglePreviewBtn");
    btn.textContent = "👁️ Show Preview";
    btn.title = "Show the live preview pane";
  }
  document.querySelectorAll(".col-resizer").forEach((resizer) => {
    resizer.addEventListener("mousedown", (e) => startColumnResizerDrag(e, resizer));
  });
  document.getElementById("togglePreviewBtn").addEventListener("click", () => setPreviewHidden(!columnState.previewHidden));
}
initColumnResizers();

// Kick things off
tryRestoreFolder();

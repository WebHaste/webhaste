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
});
cm.getWrapperElement().classList.add("hidden");
// setValue() (used when loading a file or switching views) fires "change"
// too — only autosave on edits that actually came from the user typing.
cm.on("change", (instance, changeObj) => {
  if (changeObj.origin === "setValue") return;
  scheduleSave();
});

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
  deploymentTarget: "cloudflare"
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

const ASSET_MIME_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  pdf: "application/pdf",
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

// Snippet inserted into page content for a given uploaded asset.
function assetSnippet(name) {
  return isImageAsset(name)
    ? `<img src="assets/${name}" alt="${name}">`
    : `<a href="assets/${name}">${name}</a>`;
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

  await populateTemplateDropdown();
  const config = await readJSONFile(cfgDir, "site.config.json", DEFAULT_CONFIG);
  applyParagraphMode(config.paragraphMode);
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
  if (!name.endsWith(".html")) name += ".html";

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
    item.textContent = name;
    item.addEventListener("click", () => openFile(name, handle));
    listEl.appendChild(item);
  }
}

async function openFile(name, handle) {
  currentFileHandle = handle;
  currentFileName = name;
  const file = await handle.getFile();
  const text = await file.text();
  fileCache.set(name, text);
  cm.setValue(text);
  document.getElementById("visualArea").innerHTML = text;
  renderPreview();
  highlightActiveFile(name);
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
  if (!original || !original.startsWith("assets/")) return;
  const assetsDir = await getAssetsDirHandle(false);
  if (!assetsDir) return;
  try {
    const fileHandle = await assetsDir.getFileHandle(original.slice("assets/".length));
    img.dataset.assetSrc = original;
    img.src = URL.createObjectURL(await fileHandle.getFile());
  } catch {
    // File genuinely missing from assets/ — leave it broken.
  }
}, true);

// Reverts any live-display blob: URLs back to their real "assets/x.jpg"
// path before the content is read out of #visualArea — used any time that
// content needs to leave this view (saving, switching to Code view, etc.).
function serializeVisualArea() {
  const clone = document.getElementById("visualArea").cloneNode(true);
  clone.querySelectorAll("img[data-asset-src]").forEach((img) => {
    img.setAttribute("src", img.dataset.assetSrc);
    img.removeAttribute("data-asset-src");
  });
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

function scheduleSave() {
  syncFromActiveView();
  renderPreview();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveCurrentFile, 400);
}

function highlightActiveFile(name) {
  document.querySelectorAll(".file-item").forEach((el) => {
    el.classList.toggle("active", el.textContent === name);
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

document.getElementById("assetGrid").addEventListener("click", (e) => {
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

const FRAMEWORK_ASSETS = {
  bootstrap5:
    '<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">\n' +
    '<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>',
  tailwind: '<script src="https://cdn.tailwindcss.com"></script>',
  none: "",
};

// The Live Preview pane renders via iframe.srcdoc, which inherits editor.html's
// extension CSP (script-src 'self') — so the CDN <script> tags above get
// silently blocked there (CSS <link> tags are unaffected, which is why the
// preview still looked right but dropdowns etc. didn't respond to clicks).
// Published output isn't an extension page, so it keeps using the CDN
// directly via FRAMEWORK_ASSETS above; only the preview swaps in these
// locally-vendored copies of the same scripts.
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

function renderNavBootstrap5(items) {
  const li = items
    .map((item) => {
      if (item.children) {
        const dropdownItems = item.children
          .map((c) => `<li><a class="dropdown-item" href="${c.href}">${c.label}</a></li>`)
          .join("");
        return `<li class="nav-item dropdown">
          <a class="nav-link dropdown-toggle" href="#" role="button" data-bs-toggle="dropdown">${item.label}</a>
          <ul class="dropdown-menu">${dropdownItems}</ul>
        </li>`;
      }
      return `<li class="nav-item"><a class="nav-link" href="${item.href}">${item.label}</a></li>`;
    })
    .join("");
  return `<ul class="navbar-nav">${li}</ul>`;
}

function renderNavTailwind(items) {
  // CSS-only dropdown via group-hover — no JS dependency needed for a
  // basic hover menu, which keeps this framework option dependency-free.
  const li = items
    .map((item) => {
      if (item.children) {
        const dropdownItems = item.children
          .map((c) => `<a href="${c.href}" class="block px-4 py-2 hover:bg-gray-100">${c.label}</a>`)
          .join("");
        return `<div class="relative group inline-block">
          <button class="px-3 py-2">${item.label}</button>
          <div class="hidden group-hover:block absolute bg-white shadow-md min-w-[160px]">${dropdownItems}</div>
        </div>`;
      }
      return `<a href="${item.href}" class="px-3 py-2 inline-block">${item.label}</a>`;
    })
    .join("");
  return `<div class="flex items-center">${li}</div>`;
}

function renderNavPlain(items) {
  const li = items
    .map((item) => {
      if (item.children) {
        const sub = item.children.map((c) => `<li><a href="${c.href}">${c.label}</a></li>`).join("");
        return `<li>${item.label}<ul>${sub}</ul></li>`;
      }
      return `<li><a href="${item.href}">${item.label}</a></li>`;
    })
    .join("");
  return `<ul>${li}</ul>`;
}

function renderMenu(items, framework) {
  if (!items) return "";
  if (framework === "bootstrap5") return renderNavBootstrap5(items);
  if (framework === "tailwind") return renderNavTailwind(items);
  return renderNavPlain(items);
}

async function getSiteConfig() {
  const cfgDir = await getConfigDir(true);
  return readJSONFile(cfgDir, "site.config.json", DEFAULT_CONFIG);
}

async function getNavData() {
  const cfgDir = await getConfigDir(true);
  return readJSONFile(cfgDir, "nav.json", DEFAULT_NAV);
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

async function rewriteAssetSrcsForPreview(html) {
  const names = new Set();
  html.replace(/src="assets\/([^"]+)"/g, (match, name) => {
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

  return html.replace(/src="assets\/([^"]+)"/g, (match, name) =>
    urlByName[name] ? `src="${urlByName[name]}"` : match
  );
}

async function composePage(rawContent, title, isPreview = false) {
  const templateText = await getActiveTemplateText();
  if (!templateText) {
    // "raw HTML" mode, no wrapping
    if (!isPreview) return rawContent;
    return (await rewriteAssetSrcsForPreview(rawContent)) + PREVIEW_LINK_GUARD_SCRIPT;
  }

  const [config, navData] = await Promise.all([getSiteConfig(), getNavData()]);
  const framework = config.cssFramework || "bootstrap5";
  const assets = isPreview ? FRAMEWORK_ASSETS_PREVIEW : FRAMEWORK_ASSETS;

  let out = templateText.replace(/{{NAV:(\w+)}}/g, (_, menuName) =>
    renderMenu(navData.menus?.[menuName], framework)
  );
  out = out
    .replace(/{{FRAMEWORK_ASSETS}}/g, assets[framework] || "")
    .replace(/{{CONTENT}}/g, rawContent)
    .replace(/{{TITLE}}/g, title ? `${title} | ${config.siteName || ""}` : config.siteName || "Untitled");
  if (isPreview) {
    out = await rewriteAssetSrcsForPreview(out);
    out += PREVIEW_LINK_GUARD_SCRIPT;
  }
  return out;
}

async function renderPreview() {
  const raw = fileCache.get(currentFileName) || "";
  const composed = await composePage(raw, currentFileName, true);
  document.getElementById("previewFrame").srcdoc = composed;
}

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
  document.getElementById("cfgParagraphMode").value = config.paragraphMode || "p";
  document.getElementById("cfgCssFramework").value = config.cssFramework || "bootstrap5";
  document.getElementById("cfgDeploymentTarget").value = config.deploymentTarget || "cloudflare";
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

document.getElementById("templateSelect").addEventListener("change", async () => {
  // Persist the choice into site.config.json so it travels with the repo,
  // not just the current browser session.
  const config = await getSiteConfig();
  config.activeTemplate = document.getElementById("templateSelect").value;
  const cfgDir = await getConfigDir(true);
  await writeJSONFile(cfgDir, "site.config.json", config);
  renderPreview();
});

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

// Normalizes composed pages (strings) and raw assets (ArrayBuffers) into
// one list, with the leading-slash paths Cloudflare's manifest requires.
function buildPagesFileList(pages, assets) {
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
    const files = buildPagesFileList(pages, assets);

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

  setStatus("Hashing files...");
  const fileEntries = Object.entries(pages).map(([name, content]) => ({
    path: "/" + name,
    content,
  }));
  for (const [name, arrayBuffer] of Object.entries(assets)) {
    fileEntries.push({ path: "/assets/" + name, content: arrayBuffer });
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

// ---- Local folder render (for manual SFTP or any other host) ----
// Writes every composed page into a dist/ folder inside the project
// directory. Nothing is uploaded — the user points their own SFTP client
// (or any other deploy method) at that folder afterward.
document.getElementById("localBuildCancel").addEventListener("click", () =>
  document.getElementById("localBuildDialog").close()
);
document.getElementById("localBuildConfirm").addEventListener("click", async () => {
  document.getElementById("localBuildDialog").close();
  await renderToLocalFolder();
});

async function renderToLocalFolder() {
  setStatus("Composing pages...");
  const pages = await getComposedPages();
  const assets = await getProjectAssets();

  setStatus("Writing dist/ folder...");
  const distDir = await dirHandle.getDirectoryHandle("dist", { create: true });
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

  setStatus(`Rendered ${Object.keys(pages).length} page(s) and ${Object.keys(assets).length} asset(s) to the dist/ folder — ready for SFTP upload.`);
}

function setStatus(msg) {
  document.getElementById("statusBar").textContent = msg;
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

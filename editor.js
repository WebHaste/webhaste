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
  document.getElementById("codeArea").value = text;
  document.getElementById("visualArea").innerHTML = text;
  renderPreview();
  highlightActiveFile(name);
}

// ---- Visual / Code view toggle ----
// Both views edit the SAME underlying HTML string in fileCache; switching
// views just serializes whichever one was active into that shared string.
let currentView = "visual";

function syncFromActiveView() {
  if (!currentFileName) return;
  if (currentView === "visual") {
    fileCache.set(currentFileName, document.getElementById("visualArea").innerHTML);
  } else {
    fileCache.set(currentFileName, document.getElementById("codeArea").value);
  }
}

function switchView(target) {
  syncFromActiveView();
  const html = fileCache.get(currentFileName) || "";
  currentView = target;

  const visualEl = document.getElementById("visualArea");
  const codeEl = document.getElementById("codeArea");
  const richControls = document.getElementById("richControls");

  if (target === "visual") {
    visualEl.innerHTML = html;
    visualEl.classList.remove("hidden");
    codeEl.classList.add("hidden");
    richControls.style.visibility = "visible";
    document.getElementById("viewVisual").classList.add("active");
    document.getElementById("viewCode").classList.remove("active");
  } else {
    codeEl.value = html;
    codeEl.classList.remove("hidden");
    visualEl.classList.add("hidden");
    richControls.style.visibility = "hidden";
    document.getElementById("viewCode").classList.add("active");
    document.getElementById("viewVisual").classList.remove("active");
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

// Save on every keystroke (debounced) so the local file always matches
// what's on screen — this is the "local drive as source of truth" model.
let saveTimer = null;
document.getElementById("codeArea").addEventListener("input", scheduleSave);

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

async function composePage(rawContent, title) {
  const templateText = await getActiveTemplateText();
  if (!templateText) return rawContent; // "raw HTML" mode, no wrapping

  const [config, navData] = await Promise.all([getSiteConfig(), getNavData()]);
  const framework = config.cssFramework || "bootstrap5";

  let out = templateText.replace(/{{NAV:(\w+)}}/g, (_, menuName) =>
    renderMenu(navData.menus?.[menuName], framework)
  );
  out = out
    .replace(/{{FRAMEWORK_ASSETS}}/g, FRAMEWORK_ASSETS[framework] || "")
    .replace(/{{CONTENT}}/g, rawContent)
    .replace(/{{TITLE}}/g, title ? `${title} | ${config.siteName || ""}` : config.siteName || "Untitled");
  return out;
}

async function renderPreview() {
  const raw = fileCache.get(currentFileName) || "";
  const composed = await composePage(raw, currentFileName);
  document.getElementById("previewFrame").srcdoc = composed;
}

// ---- Menu editor dialog (raw JSON for now; tree UI planned for later) ----
const navDialog = document.getElementById("navDialog");
document.getElementById("editNav").addEventListener("click", async () => {
  const navData = await getNavData();
  document.getElementById("navEditor").value = JSON.stringify(navData, null, 2);
  navDialog.showModal();
});
document.getElementById("navCancel").addEventListener("click", () => navDialog.close());
document.getElementById("navSave").addEventListener("click", async () => {
  let parsed;
  try {
    parsed = JSON.parse(document.getElementById("navEditor").value);
  } catch (err) {
    setStatus("Invalid JSON in menu editor: " + err.message);
    return;
  }
  const cfgDir = await getConfigDir(true);
  await writeJSONFile(cfgDir, "nav.json", parsed);
  navDialog.close();
  renderPreview();
  setStatus("Menus updated (.chromesite/nav.json).");
});

// ---- Site Settings dialog ----
const siteSettingsDialog = document.getElementById("siteSettingsDialog");
document.getElementById("siteSettingsBtn").addEventListener("click", async () => {
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

async function publishSite(account, project, token) {
  setStatus("Composing pages...");
  const pages = await getComposedPages();

  setStatus(`Uploading ${Object.keys(pages).length} file(s) to Cloudflare Pages...`);

  // Cloudflare's Direct Upload flow expects a multipart manifest of files.
  // See: https://developers.cloudflare.com/pages/configuration/direct-upload/
  const formData = new FormData();
  const manifest = {};
  for (const [name, content] of Object.entries(pages)) {
    const blob = new Blob([content], { type: "text/html" });
    formData.append(name, blob, name);
    manifest[name] = { size: blob.size };
  }
  formData.append("manifest", JSON.stringify(manifest));

  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects/${project}/deployments`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      }
    );
    const data = await res.json();
    if (data.success) {
      setStatus(`Published! Live at: ${data.result.url}`);
    } else {
      setStatus("Publish failed: " + JSON.stringify(data.errors));
    }
  } catch (err) {
    setStatus("Publish request failed: " + err.message);
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

async function sha1Hex(text) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function publishToNetlify(siteId, token) {
  setStatus("Composing pages...");
  const pages = await getComposedPages();

  setStatus("Hashing files...");
  const fileEntries = Object.entries(pages).map(([name, content]) => ({
    path: "/" + name,
    content,
  }));
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

  setStatus("Writing dist/ folder...");
  const distDir = await dirHandle.getDirectoryHandle("dist", { create: true });
  for (const [name, content] of Object.entries(pages)) {
    const handle = await distDir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
  }

  setStatus(`Rendered ${Object.keys(pages).length} file(s) to the dist/ folder — ready for SFTP upload.`);
}

function setStatus(msg) {
  document.getElementById("statusBar").textContent = msg;
}

// Kick things off
tryRestoreFolder();

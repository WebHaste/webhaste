// MV3 service workers are non-persistent, so this file stays intentionally
// thin. All real logic (file handles, editing state, publish flow) lives in
// editor.html/editor.js, which runs as a normal tab and doesn't get killed
// the way the service worker does between events.

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("editor.html");

  // Reuse an existing editor tab if one is already open, instead of
  // spawning duplicates every time the toolbar icon is clicked.
  const existing = await chrome.tabs.query({ url });
  if (existing.length > 0) {
    chrome.tabs.update(existing[0].id, { active: true });
  } else {
    chrome.tabs.create({ url });
  }
});

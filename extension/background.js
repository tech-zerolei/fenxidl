/**
 * FenxiDL browser integration.
 *
 * Reports media requests and intercepted downloads to the local FenxiDL
 * capture service (loopback only). This is the standards-based replacement for
 * the original product's kernel network filter drivers: nothing is installed
 * into the kernel and no traffic is decrypted.
 */

const ENDPOINT = 'http://127.0.0.1:47823/report';
const HEALTH = 'http://127.0.0.1:47823/health';

/** Media types worth offering to the user (mirrors the desktop classifier). */
const MEDIA_TYPES = [
  'video/',
  'audio/',
  'application/vnd.apple.mpegurl',
  'application/dash+xml',
  'application/x-mpegurl',
];

async function report(payload) {
  try {
    await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return true;
  } catch {
    return false;
  }
}

function isMedia(details) {
  const type = (details.type || '').toLowerCase();
  return MEDIA_TYPES.some((t) => type.startsWith(t));
}

// Report media requests so the desktop app can show its floating bar entry.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (!isMedia(details)) return;
    void report({ url: details.url, mimeType: details.type || null });
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] },
);

// Optional: hand real downloads to the desktop app when enabled.
chrome.downloads.onCreated.addListener(async (item) => {
  const { enabled } = await chrome.storage.local.get({ enabled: false });
  if (!enabled) return;
  const url = item.finalUrl || item.url;
  if (!/^https?:/i.test(url)) return;
  const ok = await report({ url, mimeType: item.mime || null, sizeBytes: item.fileSize || null });
  if (ok) chrome.downloads.cancel(item.id).catch(() => undefined);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'fenxidl-download-media',
    title: '使用 FenxiDL 下载该媒体',
    contexts: ['video', 'audio', 'link'],
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  const url = info.srcUrl || info.linkUrl;
  if (url) void report({ url });
});

// Expose a lightweight status probe to the popup.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'health') {
    fetch(HEALTH)
      .then((r) => r.json())
      .then((json) => sendResponse({ ok: true, ...json }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  return false;
});

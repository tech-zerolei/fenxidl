const statusEl = document.getElementById('status');
const toggle = document.getElementById('enabled');

chrome.runtime.sendMessage({ type: 'health' }, (res) => {
  if (res && res.ok) {
    statusEl.className = 'status ok';
    statusEl.textContent = `已连接本地服务（已捕获 ${res.intercepted ?? 0} 个媒体）`;
  } else {
    statusEl.className = 'status no';
    statusEl.textContent = '未检测到 FenxiDL，请先启动桌面程序';
  }
});

chrome.storage.local.get({ enabled: false }, (v) => {
  toggle.checked = !!v.enabled;
});

toggle.addEventListener('change', () => {
  chrome.storage.local.set({ enabled: toggle.checked });
});

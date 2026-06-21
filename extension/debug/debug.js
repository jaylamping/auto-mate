(function () {
  const { MSG, STORAGE_KEYS, BUILD_ID } = window.FAA_MSG;
  const logEl = document.getElementById('log');
  const summaryEl = document.getElementById('summary');
  let events = [];

  function render() {
    summaryEl.textContent = `${events.length} event(s) · build ${BUILD_ID}`;
    logEl.textContent = JSON.stringify(
      {
        meta: {
          exportedAt: new Date().toISOString(),
          buildId: BUILD_ID,
          eventCount: events.length
        },
        events
      },
      null,
      2
    );
    logEl.parentElement.scrollTop = logEl.parentElement.scrollHeight;
  }

  async function load() {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.DEBUG_LOG);
    events = Array.isArray(stored[STORAGE_KEYS.DEBUG_LOG]) ? stored[STORAGE_KEYS.DEBUG_LOG] : [];
    render();
  }

  function downloadJson() {
    const blob = new Blob([logEl.textContent], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `auto-mate-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  document.getElementById('btnCopy').addEventListener('click', async () => {
    await navigator.clipboard.writeText(logEl.textContent);
  });

  document.getElementById('btnDownload').addEventListener('click', downloadJson);

  document.getElementById('btnClear').addEventListener('click', async () => {
    events = [];
    render();
    await chrome.runtime.sendMessage({ type: MSG.CLEAR_DEBUG_LOG });
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== MSG.DEBUG_EVENT) return;
    if (message.payload && message.payload.kind === 'debug:cleared') {
      events = [];
    } else if (message.payload) {
      events.push(message.payload);
    }
    render();
  });

  load();
})();

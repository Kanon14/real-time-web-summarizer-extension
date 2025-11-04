// background.js (MV3 service worker)

const DEFAULT_HOST = '127.0.0.1';
const PORT = 7864;
const ENDPOINT = '/summarize_stream_status';

// Build full URL from host/IP or full URL
function buildUrl(hostFromStorage) {
  const host = (hostFromStorage || DEFAULT_HOST).trim();
  if (/^https?:\/\//i.test(host)) return `${host}${ENDPOINT}`;
  return `http://${host}:${PORT}${ENDPOINT}`;
}

// Ask content script for text; fallback to executeScript if needed
async function getPageText(tabId) {
  // 1) Try content script path
  try {
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout waiting for content script')), 2000);
      chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_TEXT' }, (resp) => {
        clearTimeout(timer);
        const err = chrome.runtime.lastError;
        if (err) return reject(err);
        resolve(resp);
      });
    });

    if (response?.error) throw new Error(response.error);
    if (typeof response?.text === 'string' && response.text.trim()) {
      return response.text;
    }
  } catch (e) {
    console.warn('[background] Content script failed, will try executeScript:', e?.message || e);
  }

  // 2) Fallback to executeScript
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      try {
        return document?.body?.innerText || 'EMPTY';
      } catch {
        return 'SCRIPT_ERROR';
      }
    }
  });

  const result = injection?.result;
  if (result === 'SCRIPT_ERROR') throw new Error('Could not access page content (script error).');
  if (!result || String(result).trim() === '' || result === 'EMPTY') return '';
  return String(result);
}

// Stream POST to backend and forward chunk updates to UI via runtime messages
async function streamSummary({ url, payload }) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}${errText ? ` - ${errText}` : ''}`);
  }
  if (!res.body) throw new Error('No response body (stream) from server.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    full += chunk;

    // Emit incremental progress updates
    chrome.runtime.sendMessage({
      type: 'SUMMARY_PROGRESS',
      chunk
    });
  }

  return full;
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Web Summarizer] background installed.');
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {
    if (request?.type !== 'SUMMARIZE_PAGE') return;

    try {
      // Determine tabId (popup messages often don't include sender.tab)
      let tabId = request.tabId || sender?.tab?.id;
      if (!tabId) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = tab?.id;
      }
      if (!tabId) throw new Error('No active tab found.');

      // 1) Extract page text
      const pageText = await getPageText(tabId);

      if (!pageText || !pageText.trim()) {
        chrome.runtime.sendMessage({
          type: 'SUMMARY_RESULT',
          summary: 'No page text found.'
        });
        sendResponse({ ok: false, reason: 'EMPTY_TEXT' });
        return;
      }

      // Optional: clamp payload size (~500KB)
      const MAX_BYTES = 500_000;
      const enc = new TextEncoder();
      const bytes = enc.encode(pageText);
      let payloadText = pageText;
      if (bytes.byteLength > MAX_BYTES) {
        payloadText = new TextDecoder().decode(bytes.slice(0, MAX_BYTES));
      }

      // Optional: pass through any preferences from the sender (e.g., length)
      const lengthPref = request.length || 'auto';

      // 2) Resolve backend host
      const { database_host } = await chrome.storage.local.get(['database_host']);
      const url = buildUrl(database_host);

      // Notify UI we’re starting the stream
      chrome.runtime.sendMessage({ type: 'SUMMARY_START', url });

      // 3) Stream and forward progress
      const fullSummary = await streamSummary({
        url,
        payload: { content: payloadText, length: lengthPref }
      });

      chrome.runtime.sendMessage({
        type: 'SUMMARY_DONE',
        summary: fullSummary
      });

      sendResponse({ ok: true });
    } catch (err) {
      console.error('[background] Summarize error:', err);
      chrome.runtime.sendMessage({
        type: 'SUMMARY_RESULT',
        summary: 'Error during summarization: ' + (err?.message || String(err))
      });
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();

  // Keep the channel open for async sendResponse
  return true;
});

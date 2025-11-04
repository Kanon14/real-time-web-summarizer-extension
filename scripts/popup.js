document.addEventListener('DOMContentLoaded', () => {
  // ===== Config =====
  let serverAddress = '127.0.0.1';
  const serverPort = 7864;
  const endpointPath = '/summarize_stream_status';

  // ===== UI refs =====
  const btnSummarize = document.getElementById('summarizeBtn');
  const outputEl = document.getElementById('output');
  const copyBtn = document.getElementById('copyBtn');
  const lengthSelect = document.getElementById('lengthSelect');
  const statusText = document.getElementById('statusText');
  const spinner = document.getElementById('spinner');

  const setStatus = (msg = '') => { if (statusText) statusText.textContent = msg; };
  const setLoading = (isLoading) => {
    if (spinner) spinner.classList.toggle('active', !!isLoading);
    if (btnSummarize) btnSummarize.disabled = !!isLoading;
  };
  const normalizeServerUrl = () => {
    if (/^https?:\/\//i.test(serverAddress)) return `${serverAddress}${endpointPath}`;
    return `http://${serverAddress}:${serverPort}${endpointPath}`;
  };

  // Optional: Copy summary button
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(outputEl?.innerText || '');
        setStatus('Copied!');
        setTimeout(() => setStatus(''), 1200);
      } catch (e) {
        setStatus('Copy failed.');
        console.error('Copy failed:', e);
      }
    });
  }

  // Try to get page text via content script; if that fails, fall back to executeScript.
  const getPageText = async (tabId) => {
    // 1) ask content script
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
      if (typeof response?.text === 'string') return response.text;
    } catch (e) {
      console.warn('Content script path failed, falling back to executeScript:', e?.message || e);
    }

    // 2) fallback: executeScript in the tab
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        try {
          return document?.body?.innerText || 'EMPTY';
        } catch (e) {
          return 'SCRIPT_ERROR';
        }
      }
    });
    if (result === 'SCRIPT_ERROR') throw new Error('Could not access page content (script error).');
    if (!result || result === 'EMPTY' || !String(result).trim()) return '';
    return String(result);
  };

  // Main summarize flow
  btnSummarize?.addEventListener('click', async () => {
    setStatus('Reading page…');
    setLoading(true);
    outputEl.innerText = '…';

    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs?.[0];
      if (!tab?.id) {
        setStatus('No active tab.');
        outputEl.innerText = 'No active tab detected.';
        setLoading(false);
        return;
      }

      const pageText = await getPageText(tab.id);

      if (!pageText || !pageText.trim()) {
        setStatus('No text found.');
        outputEl.innerText = 'No page text found.';
        setLoading(false);
        return;
      }

      console.log('Extracted text (first 500 chars):', pageText.slice(0, 500));

      // Optional length preference
      const lengthPref = lengthSelect?.value || 'auto';

      // Prevent massive payloads (≈500KB)
      const MAX_BYTES = 500_000;
      const enc = new TextEncoder();
      const encBytes = enc.encode(pageText);
      let payloadText = pageText;
      if (encBytes.byteLength > MAX_BYTES) {
        payloadText = new TextDecoder().decode(encBytes.slice(0, MAX_BYTES));
      }

      const url = normalizeServerUrl();
      setStatus('Connecting to summarizer…');
      console.log(`Sending streaming POST to ${url}`);

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: payloadText, length: lengthPref })
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText}${errText ? ` - ${errText}` : ''}`);
      }
      if (!res.body) throw new Error('No response body (stream) from server.');

      setStatus('Summarizing…');
      outputEl.innerText = '';

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let resultText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        resultText += chunk;
        outputEl.innerText = resultText;
      }

      setStatus('Done.');
    } catch (err) {
      console.error('Flow error:', err);
      outputEl.innerText = 'Failed to get summary.\n' + (err?.message || String(err));
      setStatus('Error.');
    } finally {
      setLoading(false);
    }
  });
});
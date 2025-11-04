// Listens for messages from popup/background and returns visible text.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.type === "GET_PAGE_TEXT") {
    try {
      // Use a Text Node walker to ignore <script>, <style>, etc.
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
      let text = "";
      while (walker.nextNode()) {
        const nodeText = walker.currentNode.nodeValue;
        if (nodeText && nodeText.trim()) {
          text += nodeText.trim() + " ";
        }
      }
      sendResponse({ text: text.trim() || null });
    } catch (e) {
      console.error("Error reading page text:", e);
      sendResponse({ text: null, error: "Failed to extract text." });
    }
    // Keep the channel open for async sendResponse (best practice)
    return true;
  }
});

/**
 * Background Service Worker
 *
 * 功能：
 *   - 监听来自 content script 和 popup 的消息
 *   - 转发消息
 *   - 管理扩展状态
 */

// ============ 扩展安装/更新 ============
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('[专利审查文档助手] 扩展已安装');
    // 初始化存储
    chrome.storage.local.set({
      settings: {
        tauriEndpoint: 'http://localhost:7865',
        autoExtract: false,
      },
    });
  } else if (details.reason === 'update') {
    console.log('[专利审查文档助手] 扩展已更新');
  }
});

// ============ 消息监听 ============
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 处理来自 popup 的消息，转发到 content script
  if (message.action === 'forwardToContent') {
    const { tabId, payload } = message;
    if (tabId) {
      chrome.tabs.sendMessage(tabId, payload, (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message });
        } else {
          sendResponse(response);
        }
      });
      return true; // 异步响应
    }
    sendResponse({ error: '未指定标签页 ID' });
    return false;
  }

  // 处理来自 content script 的消息
  if (message.action === 'openDocumentTab') {
    // J-PlatPat 文档链接通过 window.open 打开新窗口
    // content script 可以请求 background 打开新标签页
    const { url } = message;
    if (url) {
      chrome.tabs.create({ url }, (tab) => {
        sendResponse({ tabId: tab.id });
      });
      return true;
    }
    sendResponse({ error: '未提供 URL' });
    return false;
  }

  // 处理提取全部文档的请求
  if (message.action === 'extractAllDocuments') {
    handleExtractAllDocuments(message, sender)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  // 处理发送到 Tauri 应用的请求
  if (message.action === 'sendToTauri') {
    const { endpoint, data } = message;
    fetch(`${endpoint}/api/extension/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
      .then((res) => res.json())
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  return false;
});

/**
 * 处理提取全部文档的请求
 * 逐个打开文档页面并提取内容
 */
async function handleExtractAllDocuments(message, sender) {
  const { documents, baseUrl } = message;
  if (!documents || documents.length === 0) {
    return { error: '没有文档需要提取' };
  }

  const results = [];

  for (const doc of documents) {
    try {
      // 打开文档页面
      const tab = await chrome.tabs.create({
        url: baseUrl || 'about:blank',
        active: false,
      });

      // 等待页面加载
      await new Promise((resolve) => {
        chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
          if (tabId === tab.id && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        });
        // 超时保护
        setTimeout(resolve, 10000);
      });

      // 向新标签页的 content script 发送提取请求
      const response = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id, {
          target: 'jplatpat',
          action: 'extractDocument',
        }, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ error: chrome.runtime.lastError.message });
          } else {
            resolve(res);
          }
        });
      });

      results.push({
        name: doc.name,
        date: doc.date,
        category: doc.category,
        ...response,
      });

      // 关闭标签页
      await chrome.tabs.remove(tab.id);
    } catch (error) {
      results.push({
        name: doc.name,
        date: doc.date,
        category: doc.category,
        error: error.message,
      });
    }
  }

  return {
    office: 'JP',
    type: 'documents_batch',
    documents: results,
  };
}

// ============ 标签页更新监听 ============
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // 当 J-PlatPat 或 DPMA 页面加载完成时，可以执行初始化操作
  if (changeInfo.status === 'complete' && tab.url) {
    if (tab.url.includes('j-platpat.inpit.go.jp') || tab.url.includes('register.dpma.de')) {
      // 更新扩展图标状态（可选）
      chrome.action.setBadgeText({ text: '', tabId });
    }
  }
});

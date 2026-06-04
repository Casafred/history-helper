/**
 * 弹窗逻辑
 *
 * 功能：
 *   1. 检测当前页面类型（J-PlatPat / DPMAregister / 不支持）
 *   2. 根据页面类型显示对应操作按钮
 *   3. 执行提取操作并展示结果
 *   4. 提供复制、发送到 Tauri、AI 梳理功能
 */

// ============ DOM 元素引用 ============
const pageInfo = document.getElementById('page-info');
const statusDot = document.getElementById('status-dot');
const pageTypeText = document.getElementById('page-type-text');
const actionsSection = document.getElementById('actions');
const resultSection = document.getElementById('result-section');
const resultContent = document.getElementById('result-content');
const resultCount = document.getElementById('result-count');
const footerActions = document.getElementById('footer-actions');
const btnCopy = document.getElementById('btn-copy');
const btnSend = document.getElementById('btn-send');
const btnAnalyze = document.getElementById('btn-analyze');

// ============ 状态 ============
let currentPage = null; // { office: 'JP'|'DE'|null, pageType: string }
let extractedData = null; // 最近一次提取的数据

// ============ 初始化 ============
document.addEventListener('DOMContentLoaded', async () => {
  await detectCurrentPage();
  renderActions();
});

/**
 * 检测当前标签页的页面类型
 */
async function detectCurrentPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) {
      setPageInfo(null, 'unknown');
      return;
    }

    const url = tab.url;

    // 判断是否为 J-PlatPat 页面
    if (url.includes('j-platpat.inpit.go.jp')) {
      // 向 content script 发送检测消息
      try {
        const response = await chrome.tabs.sendMessage(tab.id, {
          target: 'jplatpat',
          action: 'detectPage',
        });
        currentPage = { office: 'JP', pageType: response.pageType };
        setPageInfo('JP', response.pageType);
      } catch {
        // content script 可能未加载，通过 URL 判断
        let pageType = 'unknown';
        if (url.includes('/h0000')) pageType = 'keika';
        else if (url.includes('/h0101')) pageType = 'document';
        else if (url.includes('/p0200')) pageType = 'bibliography';
        currentPage = { office: 'JP', pageType };
        setPageInfo('JP', pageType);
      }
    }
    // 判断是否为 DPMAregister 页面
    else if (url.includes('register.dpma.de')) {
      try {
        const response = await chrome.tabs.sendMessage(tab.id, {
          target: 'dpma',
          action: 'detectPage',
        });
        currentPage = { office: 'DE', pageType: response.pageType };
        setPageInfo('DE', response.pageType);
      } catch {
        currentPage = { office: 'DE', pageType: 'register' };
        setPageInfo('DE', 'register');
      }
    }
    // 不支持的页面
    else {
      currentPage = { office: null, pageType: 'unsupported' };
      setPageInfo(null, 'unsupported');
    }
  } catch (error) {
    setPageInfo(null, 'error');
  }
}

/**
 * 设置页面识别信息显示
 */
function setPageInfo(office, pageType) {
  // 状态点颜色
  statusDot.className = 'status-dot';
  if (office === 'JP') statusDot.classList.add('jp');
  else if (office === 'DE') statusDot.classList.add('de');
  else statusDot.classList.add('unsupported');

  // 文字描述
  const labels = {
    keika: 'J-PlatPat - 审查经纬页面',
    document: 'J-PlatPat - 文档内容页面',
    bibliography: 'J-PlatPat - 文献表示页面',
    register: 'DPMAregister - 注册信息页面',
    unknown: office === 'JP' ? 'J-PlatPat - 未知页面' : 'DPMAregister - 未知页面',
    unsupported: '当前页面不受支持',
    error: '检测失败',
  };
  pageTypeText.textContent = labels[pageType] || '未知页面';
}

/**
 * 根据页面类型渲染操作按钮
 */
function renderActions() {
  actionsSection.innerHTML = '';

  if (!currentPage || !currentPage.office) {
    const hint = document.createElement('div');
    hint.style.cssText = 'padding: 8px; text-align: center; color: var(--text-secondary); font-size: 12px;';
    hint.textContent = '请打开 J-PlatPat 或 DPMAregister 页面后使用';
    actionsSection.appendChild(hint);
    return;
  }

  const { office, pageType } = currentPage;

  if (office === 'JP') {
    switch (pageType) {
      case 'keika':
        addButton('提取审查经纬列表', () => extractData('extractKeika'), 'btn-primary');
        addButton('提取全部文档内容', () => extractData('extractAllDocuments'), 'btn-secondary');
        break;
      case 'document':
        addButton('提取当前文档内容', () => extractData('extractDocument'), 'btn-primary');
        break;
      case 'bibliography':
        addButton('提取书志信息', () => extractData('extractBibliography'), 'btn-primary');
        break;
      default:
        addHint('请导航到审查经纬、文档内容或文献表示页面');
        break;
    }
  } else if (office === 'DE') {
    switch (pageType) {
      case 'register':
        addButton('提取注册信息', () => extractData('extractRegister'), 'btn-primary');
        break;
      default:
        addHint('请导航到注册信息页面');
        break;
    }
  }
}

/**
 * 添加操作按钮
 */
function addButton(text, onClick, className = 'btn-primary') {
  const btn = document.createElement('button');
  btn.className = `btn ${className}`;
  btn.textContent = text;
  btn.addEventListener('click', onClick);
  actionsSection.appendChild(btn);
}

/**
 * 添加提示文本
 */
function addHint(text) {
  const hint = document.createElement('div');
  hint.style.cssText = 'padding: 8px; text-align: center; color: var(--text-secondary); font-size: 12px;';
  hint.textContent = text;
  actionsSection.appendChild(hint);
}

/**
 * 向 content script 发送提取请求
 */
async function extractData(action) {
  if (!currentPage) return;

  // 显示加载状态
  resultSection.classList.remove('hidden');
  resultContent.innerHTML = '<div style="text-align:center;padding:20px;"><span class="loading"></span> 提取中...</div>';
  resultCount.textContent = '';

  const target = currentPage.office === 'JP' ? 'jplatpat' : 'dpma';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('无法获取当前标签页');

    const response = await chrome.tabs.sendMessage(tab.id, {
      target,
      action,
    });

    if (response.error) {
      showError(response.error);
      return;
    }

    extractedData = response;
    renderResult(response);
    footerActions.classList.remove('hidden');
  } catch (error) {
    showError(`提取失败: ${error.message}`);
  }
}

/**
 * 渲染提取结果
 */
function renderResult(data) {
  resultContent.innerHTML = '';

  if (data.error) {
    showError(data.error);
    return;
  }

  switch (data.type) {
    case 'keika':
      renderKeikaResult(data);
      break;
    case 'keika_all':
      renderKeikaAllResult(data);
      break;
    case 'document':
      renderDocumentResult(data);
      break;
    case 'bibliography':
      renderBibliographyResult(data);
      break;
    case 'register':
      renderRegisterResult(data);
      break;
    default:
      resultContent.textContent = JSON.stringify(data, null, 2);
  }
}

/**
 * 渲染审查经纬列表
 */
function renderKeikaResult(data) {
  const docs = data.documents || [];
  resultCount.textContent = `${docs.length} 个文档`;

  if (data.appNumber) {
    addField('出愿号', data.appNumber);
  }

  if (docs.length === 0) {
    resultContent.innerHTML += '<div style="color:var(--text-secondary);padding:8px 0;">未找到审查文档</div>';
    return;
  }

  for (const doc of docs) {
    const item = document.createElement('div');
    item.className = 'doc-item';
    item.innerHTML = `
      <span class="doc-name">${escapeHtml(doc.name)}</span>
      <span class="doc-date">${escapeHtml(doc.date)}</span>
      <span class="doc-category">${escapeHtml(doc.category)}</span>
    `;
    resultContent.appendChild(item);
  }
}

/**
 * 渲染全部文档提取结果
 */
function renderKeikaAllResult(data) {
  const docs = data.documents || [];
  resultCount.textContent = `${docs.length} 个文档`;

  if (data.message) {
    const msg = document.createElement('div');
    msg.style.cssText = 'color:var(--accent-orange);padding:4px 0;margin-bottom:4px;';
    msg.textContent = data.message;
    resultContent.appendChild(msg);
  }

  if (data.appNumber) {
    addField('出愿号', data.appNumber);
  }

  for (const doc of docs) {
    const item = document.createElement('div');
    item.className = 'doc-item';
    item.innerHTML = `
      <span class="doc-name">${escapeHtml(doc.name)}</span>
      <span class="doc-date">${escapeHtml(doc.date)}</span>
      <span class="doc-category">${escapeHtml(doc.category)}</span>
    `;
    resultContent.appendChild(item);
  }
}

/**
 * 渲染文档内容
 */
function renderDocumentResult(data) {
  if (data.title) {
    addField('标题', data.title);
  }

  // 显示文档内容（截断显示）
  const content = data.content || '';
  resultCount.textContent = `${content.length} 字`;

  const contentDiv = document.createElement('div');
  contentDiv.style.cssText = 'margin-top:6px;white-space:pre-wrap;word-break:break-all;max-height:180px;overflow-y:auto;';

  // 如果内容太长，截断显示
  if (content.length > 2000) {
    contentDiv.textContent = content.substring(0, 2000) + '\n\n... (内容已截断，完整内容可通过复制获取)';
  } else {
    contentDiv.textContent = content;
  }

  resultContent.appendChild(contentDiv);
}

/**
 * 渲染书志信息
 */
function renderBibliographyResult(data) {
  if (data.patentNumber) addField('专利号', data.patentNumber);
  if (data.appNumber) addField('出愿号', data.appNumber);
  if (data.title) addField('发明名称', data.title);
  if (data.applicant) addField('申请人', data.applicant);
  if (data.status) addField('状态', data.status);
}

/**
 * 渲染 DPMA 注册信息
 */
function renderRegisterResult(data) {
  if (data.akz) addField('Aktenzeichen', data.akz);
  if (data.status) addField('Status', data.status);
  if (data.title) addField('Bezeichnung', data.title);
  if (data.applicant) addField('Anmelder', data.applicant);
  if (data.filingDate) addField('Anmeldetag', data.filingDate);
  if (data.publicationDate) addField('Offenlegungstag', data.publicationDate);
  if (data.bescheideCount > 0) addField('Bescheide', String(data.bescheideCount));
  if (data.erwiderungenCount > 0) addField('Erwiderungen', String(data.erwiderungenCount));
  if (data.ipcClasses && data.ipcClasses.length > 0) addField('IPC', data.ipcClasses.join(', '));

  if (data.procedures && data.procedures.length > 0) {
    const procHeader = document.createElement('div');
    procHeader.style.cssText = 'margin-top:8px;font-weight:600;font-size:11px;color:var(--text-secondary);';
    procHeader.textContent = 'Verfahrensdaten';
    resultContent.appendChild(procHeader);

    for (const proc of data.procedures) {
      const item = document.createElement('div');
      item.className = 'doc-item';
      item.innerHTML = `
        <span class="doc-name">${escapeHtml(proc.type)}</span>
        <span class="doc-date">${escapeHtml(proc.date)}</span>
        <span class="doc-category">${escapeHtml(proc.status)}</span>
      `;
      resultContent.appendChild(item);
    }
  }

  if (data.pdfLinks && data.pdfLinks.length > 0) {
    const pdfHeader = document.createElement('div');
    pdfHeader.style.cssText = 'margin-top:8px;font-weight:600;font-size:11px;color:var(--text-secondary);';
    pdfHeader.textContent = 'PDF 文档';
    resultContent.appendChild(pdfHeader);

    for (const pdf of data.pdfLinks) {
      const link = document.createElement('a');
      link.href = pdf.url;
      link.target = '_blank';
      link.style.cssText = 'display:block;padding:2px 0;color:var(--accent-blue);text-decoration:none;font-size:12px;';
      link.textContent = pdf.label;
      resultContent.appendChild(link);
    }
  }
}

/**
 * 添加字段显示
 */
function addField(label, value) {
  const field = document.createElement('div');
  field.className = 'field';
  field.innerHTML = `<span class="field-label">${escapeHtml(label)}: </span><span class="field-value">${escapeHtml(value)}</span>`;
  resultContent.appendChild(field);
}

/**
 * 显示错误
 */
function showError(message) {
  resultSection.classList.remove('hidden');
  resultContent.innerHTML = `<div class="error">${escapeHtml(message)}</div>`;
  resultCount.textContent = '';
}

/**
 * HTML 转义
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

/**
 * 显示 Toast 提示
 */
function showToast(message) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), 2000);
}

// ============ 底部按钮事件 ============

/**
 * 复制到剪贴板
 */
btnCopy.addEventListener('click', async () => {
  if (!extractedData) {
    showToast('没有可复制的数据');
    return;
  }

  try {
    const text = JSON.stringify(extractedData, null, 2);
    await navigator.clipboard.writeText(text);
    showToast('已复制到剪贴板');
  } catch (error) {
    // 回退方案
    const textarea = document.createElement('textarea');
    textarea.value = JSON.stringify(extractedData, null, 2);
    textarea.style.cssText = 'position:fixed;left:-9999px;';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    showToast('已复制到剪贴板');
  }
});

/**
 * 发送到 Tauri 应用
 */
btnSend.addEventListener('click', async () => {
  if (!extractedData) {
    showToast('没有可发送的数据');
    return;
  }

  btnSend.disabled = true;
  const originalText = btnSend.innerHTML;
  btnSend.innerHTML = '<span class="loading"></span> 发送中...';

  try {
    const response = await fetch('http://localhost:7865/api/extension/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        office: extractedData.office,
        data: extractedData,
        source: 'browser-extension',
      }),
    });

    if (response.ok) {
      showToast('发送成功');
    } else {
      showToast(`发送失败: HTTP ${response.status}`);
    }
  } catch (error) {
    showToast('发送失败: 无法连接到 Tauri 应用');
  } finally {
    btnSend.disabled = false;
    btnSend.innerHTML = originalText;
  }
});

/**
 * AI 梳理
 */
btnAnalyze.addEventListener('click', async () => {
  if (!extractedData) {
    showToast('没有可分析的数据');
    return;
  }

  btnAnalyze.disabled = true;
  const originalText = btnAnalyze.innerHTML;
  btnAnalyze.innerHTML = '<span class="loading"></span> 分析中...';

  try {
    const response = await fetch('http://localhost:7865/api/extension/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        office: extractedData.office,
        content: extractedData.content || JSON.stringify(extractedData),
        type: extractedData.type,
      }),
    });

    if (response.ok) {
      const result = await response.json();
      showToast('分析完成');
      // 如果返回了分析结果，显示在结果区域
      if (result.analysis) {
        resultContent.innerHTML += '\n\n--- AI 分析 ---\n' + escapeHtml(result.analysis);
      }
    } else {
      showToast(`分析失败: HTTP ${response.status}`);
    }
  } catch (error) {
    showToast('分析失败: 无法连接到 Tauri 应用');
  } finally {
    btnAnalyze.disabled = false;
    btnAnalyze.innerHTML = originalText;
  }
});

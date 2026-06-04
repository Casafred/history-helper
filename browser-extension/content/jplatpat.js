/**
 * J-PlatPat 页面抓取 Content Script
 *
 * 支持：
 *   - 审查经纬页面 (/h0000)：提取审查文档列表
 *   - 文档内容页面 (/h0101)：提取文档全文
 *   - 文献表示页面 (/p0200)：提取书志信息
 *
 * 注意：J-PlatPat 是 Angular SPA，页面内容通过 JavaScript 动态渲染，
 *       需要等待 DOM 加载完成后再提取数据。
 */

// ============ 防止重复注入 ============
if (typeof window.__patentHelperJpLoaded === 'undefined') {
  window.__patentHelperJpLoaded = true;

// ============ 文档类别映射 ============
const JP_CATEGORY_MAP = {
  '拒絶理由通知書': 'office_action',
  '意見書': 'response',
  '手続補正書': 'amendment',
  '検索報告書': 'search_report',
  '特許査定': 'allowance',
  '出願審査請求書': 'request',
  '明細書': 'specification',
  '請求の範囲': 'claims',
  '要約書': 'abstract',
  '図面': 'drawings',
  '特許願': 'application',
};

// 出愿时同时提交的文档，与特許願共享日期
const JP_CO_FILED_DOCS = ['明細書', '請求の範囲', '要約書', '図面'];

/**
 * 根据文档名称推断类别
 */
function inferCategory(name) {
  for (const [keyword, category] of Object.entries(JP_CATEGORY_MAP)) {
    if (name.includes(keyword)) {
      return category;
    }
  }
  return 'other';
}

/**
 * 从页面内容中提取出愿号
 */
function extractAppNumberFromUrl() {
  const bodyText = document.body.innerText;
  const textMatch = bodyText.match(/特願(\d{4}[-‐]\d+)/);
  if (textMatch) return textMatch[0];
  return '';
}

/**
 * 等待指定选择器的元素出现（用于 SPA 动态加载）
 */
function waitForElement(selector, timeout = 5000) {
  return new Promise((resolve) => {
    const el = document.querySelector(selector);
    if (el) {
      resolve(el);
      return;
    }
    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeout);
  });
}

/**
 * 从审查经纬页面 (/h0000) 提取审查文档列表
 */
function extractKeikaInfo() {
  try {
    const appNumber = extractAppNumberFromUrl();
    const documents = [];

    const links = document.querySelectorAll('a[href="javascript:void(0)"]');

    let applicationDate = '';

    for (const link of links) {
      const name = link.textContent.trim();
      if (!name || name.length < 2) continue;

      const category = inferCategory(name);
      if (category === 'other') continue;

      let date = '';
      const row = link.closest('tr');
      if (row) {
        const cells = row.querySelectorAll('td, th');
        for (const cell of cells) {
          const cellText = cell.textContent.trim();
          const dateMatch = cellText.match(/(\d{4}[\/.]\d{2}[\/.]\d{2})/);
          if (dateMatch) {
            date = dateMatch[1];
            break;
          }
        }
      }

      if (category === 'application' && date) {
        applicationDate = date;
      }

      documents.push({ name, date, category });
    }

    if (applicationDate) {
      for (const doc of documents) {
        if (!doc.date && JP_CO_FILED_DOCS.some(k => doc.name.includes(k))) {
          doc.date = applicationDate;
        }
      }
    }

    if (documents.length === 0) {
      const tables = document.querySelectorAll('table');
      for (const table of tables) {
        const rows = table.querySelectorAll('tr');
        for (const row of rows) {
          const cells = row.querySelectorAll('td, th');
          if (cells.length >= 2) {
            const nameCell = cells[0];
            const dateCell = cells.length >= 2 ? cells[1] : null;
            const name = nameCell.textContent.trim();

            if (name && name.length >= 2) {
              const category = inferCategory(name);
              if (category !== 'other') {
                const date = dateCell ? dateCell.textContent.trim() : '';
                documents.push({
                  name,
                  date: date.match(/(\d{4}[\/.]\d{2}[\/.]\d{2})/)?.[1] || date,
                  category,
                });
              }
            }
          }
        }
      }
    }

    return {
      office: 'JP',
      type: 'keika',
      appNumber,
      documents,
    };
  } catch (error) {
    return {
      office: 'JP',
      type: 'keika',
      error: `提取审查经纬失败: ${error.message}`,
    };
  }
}

/**
 * 从文档内容页面 (/h0101) 提取文档全文
 */
function extractDocumentContent() {
  try {
    let title = '';
    const h2 = document.querySelector('h2');
    if (h2) {
      title = h2.textContent.trim();
    }

    if (!title) {
      const headings = document.querySelectorAll('h1, h2, h3');
      for (const h of headings) {
        const text = h.textContent.trim();
        if (text.length > 2) {
          title = text;
          break;
        }
      }
    }

    let content = '';
    const mainContent = document.querySelector('.processes-content');
    if (mainContent) {
      content = mainContent.innerText.trim();
    } else {
      const contentsArea = document.querySelector('#contents');
      if (contentsArea) {
        const clone = contentsArea.cloneNode(true);
        clone.querySelectorAll('script, style, noscript, .global-nav, header, nav').forEach(el => el.remove());
        content = clone.innerText.trim();
      } else {
        const body = document.body.cloneNode(true);
        body.querySelectorAll('script, style, noscript').forEach(el => el.remove());
        body.querySelectorAll('h1, h2, h3').forEach(el => el.remove());
        content = body.innerText.trim();
      }
    }

    const noisePatterns = [
      /^ヘッダ情報を飛ばしてコンテンツへ\s*/,
      /^特許情報プラットフォーム\s*/,
      /^English\s*/,
      /^閉じる\s*/,
      /^印刷\s*/,
      /^経過情報照会\s*/,
      /^ヘルプ\s*/,
    ];
    for (const pattern of noisePatterns) {
      content = content.replace(pattern, '');
    }

    return {
      office: 'JP',
      type: 'document',
      title,
      content,
    };
  } catch (error) {
    return {
      office: 'JP',
      type: 'document',
      error: `提取文档内容失败: ${error.message}`,
    };
  }
}

/**
 * 从文献表示页面 (/p0200) 提取书志信息
 * 页面结构：书志信息不是表格，而是 【字段名】值 格式的纯文本
 * 使用 <SDO><DP><RTI> 等自定义元素，但 innerText 可以正确获取文本
 */
function extractBibliography() {
  try {
    const result = {
      office: 'JP',
      type: 'bibliography',
      patentNumber: '',
      appNumber: '',
      title: '',
      applicant: '',
      inventor: '',
      filingDate: '',
      registrationDate: '',
      publicationNumber: '',
      publicationDate: '',
      status: '',
    };

    const bodyText = document.body.innerText;

    // 特許番号 — 处理可能的空格和全角字符
    const patentMatch = bodyText.match(/【特許番号】\s*特許第(\d+)号/);
    if (patentMatch) result.patentNumber = `特許${patentMatch[1]}`;

    // 出願番号 — 处理全角横线 ‐ 和半角横线 -
    const appMatch = bodyText.match(/【出願番号】\s*特願(\d{4}[-‐]\d+)/);
    if (appMatch) result.appNumber = `特願${appMatch[1]}`;

    // 発明の名称
    const titleMatch = bodyText.match(/【発明の名称】\s*(.+)/);
    if (titleMatch) result.title = titleMatch[1].trim();

    // 特許権者 → 氏名又は名称（嵌套结构）
    const applicantMatch = bodyText.match(/【特許権者】[\s\S]*?【氏名又は名称】\s*(.+)/);
    if (applicantMatch) {
      result.applicant = applicantMatch[1].trim();
    } else {
      // 尝试出願人格式
      const applicantMatch2 = bodyText.match(/【出願人】[\s\S]*?【氏名又は名称】\s*(.+)/);
      if (applicantMatch2) result.applicant = applicantMatch2[1].trim();
    }

    // 発明者
    const inventorMatch = bodyText.match(/【発明者】[\s\S]*?【氏名】\s*(.+)/);
    if (inventorMatch) result.inventor = inventorMatch[1].trim();

    // 出願日
    const filingMatch = bodyText.match(/【出願日】\s*(.+)/);
    if (filingMatch) result.filingDate = filingMatch[1].trim();

    // 登録日
    const regMatch = bodyText.match(/【登録日】\s*(.+)/);
    if (regMatch) result.registrationDate = regMatch[1].trim();

    // 公開番号
    const pubNumMatch = bodyText.match(/【公開番号】\s*(.+?)[\s(]/);
    if (pubNumMatch) result.publicationNumber = pubNumMatch[1].trim();

    // 公開日
    const pubDateMatch = bodyText.match(/【公開日】\s*(.+)/);
    if (pubDateMatch) result.publicationDate = pubDateMatch[1].trim();

    // 公報種別作为状态
    const statusMatch = bodyText.match(/【公報種別】\s*(.+)/);
    if (statusMatch) result.status = statusMatch[1].trim();

    // 添加调试信息：页面文本前 800 字符，帮助排查提取失败
    result._debug = bodyText.substring(0, 800);

    return result;
  } catch (error) {
    return {
      office: 'JP',
      type: 'bibliography',
      error: `提取书志信息失败: ${error.message}`,
    };
  }
}

/**
 * 根据当前页面 URL 判断页面类型
 */
function detectPageType() {
  const url = window.location.href;
  if (url.includes('/h0000')) return 'keika';
  if (url.includes('/h0101')) return 'document';
  if (url.includes('/p0200')) return 'bibliography';
  return 'unknown';
}

/**
 * 提取全部文档信息（从审查经纬页面）
 */
function extractAllDocuments() {
  const keikaInfo = extractKeikaInfo();
  if (keikaInfo.error) return keikaInfo;

  return {
    office: 'JP',
    type: 'keika_all',
    appNumber: keikaInfo.appNumber,
    documents: keikaInfo.documents,
    message: `发现 ${keikaInfo.documents.length} 个文档，需要逐个打开提取内容`,
  };
}

// ============ 消息监听 ============

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'jplatpat') return false;

  switch (message.action) {
    case 'detectPage':
      sendResponse({ office: 'JP', pageType: detectPageType() });
      return false;

    case 'extractKeika':
      sendResponse(extractKeikaInfo());
      return false;

    case 'extractDocument':
      sendResponse(extractDocumentContent());
      return false;

    case 'extractBibliography':
      sendResponse(extractBibliography());
      return false;

    case 'extractAllDocuments':
      sendResponse(extractAllDocuments());
      return false;

    default:
      sendResponse({ error: `未知操作: ${message.action}` });
      return false;
  }
});

} // end of __patentHelperJpLoaded guard

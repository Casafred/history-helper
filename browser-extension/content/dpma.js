/**
 * DPMAregister 页面抓取 Content Script
 *
 * 支持：
 *   - 注册信息页面 (/DPMAregister/pat/register?AKZ=xxx)：提取专利注册数据
 *
 * 注意：DPMAregister 的表格数据是静态 HTML，可以直接解析。
 *       Akteneinsicht（案卷查阅）需要 CAPTCHA，无法程序化获取。
 */

/**
 * 从注册信息页面提取数据
 * 页面结构：结构化表格，INID 编号 + 字段名 + 字段代码 + 内容
 */
function extractRegisterInfo() {
  try {
    const result = {
      office: 'DE',
      type: 'register',
      akz: '',
      status: '',
      title: '',
      applicant: '',
      inventor: '',
      representative: '',
      filingDate: '',
      publicationDate: '',
      bescheideCount: null,
      erwiderungenCount: null,
      ipcClasses: [],
      procedures: [],
      pdfLinks: [],
    };

    const allText = document.body.innerText;

    // ============ 通过正则从页面文本提取主要字段 ============
    // DPMAregister 页面格式: "标签\t字段代码\t内容"

    // Aktenzeichen（案卷号）
    const akzMatch = allText.match(/Aktenzeichen\s*DE:\s*([\d\s.]+)/);
    if (akzMatch) result.akz = akzMatch[1].trim();

    // 从 URL 参数提取 AKZ 作为备选
    if (!result.akz) {
      const urlParams = new URLSearchParams(window.location.search);
      const akzParam = urlParams.get('AKZ');
      if (akzParam) result.akz = akzParam;
    }

    // Status（状态）
    const statusMatch = allText.match(/Status\s*ST\s*(.+?)[\n\r]/);
    if (statusMatch) result.status = statusMatch[1].trim();

    // Bezeichnung/Titel（标题）
    const titleMatch = allText.match(/Bezeichnung\/Titel\s*TI\s*(.+?)[\n\r]/);
    if (titleMatch) result.title = titleMatch[1].trim();

    // Anmelder/Inhaber（申请人）
    const applicantMatch = allText.match(/Anmelder\/Inhaber\s*INH\s*(.+?)[\n\r]/);
    if (applicantMatch) result.applicant = applicantMatch[1].trim();

    // Erfinder（发明人）
    const inventorMatch = allText.match(/Erfinder\s*IN\s*(.+?)[\n\r]/);
    if (inventorMatch) result.inventor = inventorMatch[1].trim();

    // Vertreter（代理人）
    const repMatch = allText.match(/Vertreter\s*VTR\s*(.+?)[\n\r]/);
    if (repMatch) result.representative = repMatch[1].trim();

    // Anmeldetag（申请日）
    const filingMatch = allText.match(/Anmeldetag\s*DE\s*DAT\s*(\d{2}\.\d{2}\.\d{4})/);
    if (filingMatch) result.filingDate = filingMatch[1];

    // Offenlegungstag（公开日）
    const pubMatch = allText.match(/Offenlegungstag\s*OT\s*(\d{2}\.\d{2}\.\d{4})/);
    if (pubMatch) result.publicationDate = pubMatch[1];

    // Bescheide 数量
    const bescheideMatch = allText.match(/Anzahl\s+der\s+Bescheide\s+(\d+)/);
    if (bescheideMatch) result.bescheideCount = parseInt(bescheideMatch[1], 10);

    // Erwiderungen 数量
    const erwMatch = allText.match(/Anzahl\s+der\s+Erwiderungen\s+(\d+)/);
    if (erwMatch) result.erwiderungenCount = parseInt(erwMatch[1], 10);

    // IPC 分类号 — 包含年份信息
    const ipcMainMatch = allText.match(/IPC-Hauptklasse\s*ICM\s*\(ICMV\)\s*([\w\s/().]+)/);
    if (ipcMainMatch) {
      const cls = ipcMainMatch[1].trim().split(/[\n\r]/)[0].trim();
      if (cls) result.ipcClasses.push(cls);
    }
    const ipcSubMatch = allText.match(/IPC-Nebenklasse\(n\)\s*ICS\s*\(ICSV\)\s*([\w\s/().]+)/);
    if (ipcSubMatch) {
      const cls = ipcSubMatch[1].trim().split(/[\n\r]/)[0].trim();
      if (cls) result.ipcClasses.push(cls);
    }

    // ============ 提取 Verfahrensdaten（程序数据） ============
    // 程序数据在第二个表格中，4列结构：Nr | Verfahrensart | Verfahrensstand | Verfahrensstandstag
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const headerRow = table.querySelector('tr');
      if (!headerRow) continue;
      const headerText = headerRow.textContent.toLowerCase();

      // 判断是否为程序数据表格（包含 Verfahrensart 列）
      if (headerText.includes('verfahrensart') || headerText.includes('verfahrensstand')) {
        const rows = table.querySelectorAll('tr');
        for (let i = 1; i < rows.length; i++) {
          const cells = rows[i].querySelectorAll('td');
          if (cells.length >= 3) {
            // 4列: Nr | Verfahrensart | Verfahrensstand | Verfahrensstandstag
            const nr = cells[0]?.textContent.trim() || '';
            const type = cells[1]?.textContent.trim() || '';
            const status = cells[2]?.textContent.trim() || '';
            const date = cells[3]?.textContent.trim() || '';
            if (type && type !== 'Nr.') {
              result.procedures.push({ nr, type, status, date });
            }
          }
        }
        break; // 只取第一个匹配的表格
      }
    }

    // ============ 提取 PDF 链接 ============
    // 优先查找含 reqToken 的链接（公开文献 PDF）
    const pdfLinkElements = document.querySelectorAll('a[href*="reqToken"]');
    const seenUrls = new Set();
    for (const link of pdfLinkElements) {
      const href = link.getAttribute('href');
      const label = link.textContent.trim();
      if (href && label) {
        const absoluteUrl = new URL(href, window.location.origin).href;
        if (!seenUrls.has(absoluteUrl)) {
          seenUrls.add(absoluteUrl);
          result.pdfLinks.push({ label, url: absoluteUrl });
        }
      }
    }

    // 也查找 Originaldokument / Recherchierbarer Text 链接
    const docLinkElements = document.querySelectorAll('a[href*="PatSchrifteneinsicht"], a[href*="PatRechercheSchrifteneinsicht"]');
    for (const link of docLinkElements) {
      const href = link.getAttribute('href');
      const label = link.textContent.trim();
      if (href && label) {
        const absoluteUrl = new URL(href, window.location.origin).href;
        if (!seenUrls.has(absoluteUrl)) {
          seenUrls.add(absoluteUrl);
          result.pdfLinks.push({ label, url: absoluteUrl });
        }
      }
    }

    return result;
  } catch (error) {
    return {
      office: 'DE',
      type: 'register',
      error: `提取注册信息失败: ${error.message}`,
    };
  }
}

// ============ 消息监听 ============

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'dpma') return false;

  switch (message.action) {
    case 'detectPage':
      sendResponse({ office: 'DE', pageType: 'register' });
      return false;

    case 'extractRegister':
      sendResponse(extractRegisterInfo());
      return false;

    default:
      sendResponse({ error: `未知操作: ${message.action}` });
      return false;
  }
});

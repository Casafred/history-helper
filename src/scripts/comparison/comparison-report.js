/*!
 * PatentLens - 智能比对模块 - 报告生成与导出
 * Copyright (c) 2026 Alfred Shi. All rights reserved.
 * @author Alfred Shi
 * @version 260716
 */

var ComparisonReport = (function () {
  var REPORT_CSS = `
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif; line-height: 1.7; color: #1f2937; background: #f8fafc; padding: 20px; }
.container { max-width: 1100px; margin: 0 auto; background: #fff; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); overflow: hidden; }
.header { background: linear-gradient(135deg, #059669 0%, #10b981 100%); color: white; padding: 32px 40px; }
.header h1 { font-size: 24px; font-weight: 600; margin-bottom: 8px; }
.header .meta { font-size: 13px; opacity: 0.9; }
.toolbar { padding: 16px 40px; background: #f1f5f9; border-bottom: 1px solid #e2e8f0; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.toolbar button { padding: 8px 16px; border: 1px solid #cbd5e1; background: #fff; border-radius: 6px; cursor: pointer; font-size: 13px; transition: all 0.2s; }
.toolbar button:hover { background: #f8fafc; border-color: #10b981; color: #10b981; }
.toolbar .active { background: #10b981; color: white; border-color: #10b981; }
.content { padding: 32px 40px; }
.items-summary { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; margin-bottom: 32px; }
.item-card { border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; background: #f8fafc; }
.item-card h4 { font-size: 14px; font-weight: 600; color: #10b981; margin-bottom: 8px; }
.item-card .patent-num { font-size: 12px; color: #64748b; margin-bottom: 8px; }
.item-card .preview { font-size: 12px; color: #475569; line-height: 1.6; max-height: 80px; overflow: hidden; }
.badge { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 500; margin-left: 8px; }
.badge.ind { background: #dcfce7; color: #16a34a; }
.badge.dep { background: #f1f5f9; color: #64748b; }
.badge.anchor { background: linear-gradient(135deg, #f59e0b, #d97706); color: #fff; }
.badge.manual { background: #fef3c7; color: #92400e; }
.analysis h1 { font-size: 22px; margin-bottom: 20px; padding-bottom: 12px; border-bottom: 2px solid #10b981; }
.analysis h2 { font-size: 18px; margin: 28px 0 16px; padding-bottom: 8px; border-bottom: 1px solid #e2e8f0; color: #10b981; }
.analysis h3 { font-size: 15px; margin: 20px 0 12px; color: #334155; }
.analysis table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 13px; }
.analysis th, .analysis td { border: 1px solid #e2e8f0; padding: 10px 12px; text-align: left; vertical-align: top; }
.analysis th { background: #f1f5f9; font-weight: 600; }
.analysis blockquote { margin: 12px 0; padding: 12px 16px; border-left: 3px solid #10b981; background: #f0fdf4; border-radius: 0 6px 6px 0; font-size: 13px; color: #475569; }
.analysis ul, .analysis ol { padding-left: 24px; margin: 12px 0; line-height: 1.8; }
.analysis li { margin: 4px 0; }
.analysis p { margin: 10px 0; line-height: 1.8; }
.analysis code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
.diff-core { background: #fef2f2; }
.diff-scope { background: #fffbeb; }
.diff-term { background: #eff6ff; }
.diff-add { background: #f0fdf4; }
.diff-del { background: #fef2f2; }
.original-text { margin-top: 32px; padding-top: 24px; border-top: 2px solid #e2e8f0; }
.original-text h2 { color: #64748b; }
.original-item { margin-bottom: 24px; padding: 16px; background: #f8fafc; border-radius: 8px; border-left: 3px solid #94a3b8; }
.original-item h4 { font-size: 14px; margin-bottom: 10px; color: #475569; }
.original-item pre { white-space: pre-wrap; word-break: break-word; font-family: inherit; font-size: 13px; line-height: 1.8; color: #334155; }
.footer { padding: 20px 40px; text-align: center; font-size: 12px; color: #94a3b8; border-top: 1px solid #e2e8f0; }
@media print { body { background: white; padding: 0; } .container { box-shadow: none; } .toolbar { display: none; } }
@media (max-width: 768px) { body { padding: 10px; } .header { padding: 20px; } .content { padding: 20px; } .items-summary { grid-template-columns: 1fr; } }
`;

  function generateFullHtml() {
    var result = ComparisonCore.getResult();
    if (!result) return null;

    var items = result.items;
    var date = new Date(result.timestamp);
    var dateStr = date.getFullYear() + '-' +
      String(date.getMonth() + 1).padStart(2, '0') + '-' +
      String(date.getDate()).padStart(2, '0') + ' ' +
      String(date.getHours()).padStart(2, '0') + ':' +
      String(date.getMinutes()).padStart(2, '0');

    var html = '<!DOCTYPE html>\n';
    html += '<html lang="zh-CN">\n';
    html += '<head>\n';
    html += '  <meta charset="UTF-8">\n';
    html += '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n';
    html += '  <title>智能比对分析报告 - PatentLens</title>\n';
    html += '  <style>' + REPORT_CSS + '</style>\n';
    html += '</head>\n';
    html += '<body>\n';
    html += '<div class="container">\n';

    html += '  <div class="header">\n';
    html += '    <h1>📊 智能比对分析报告</h1>\n';
    html += '    <div class="meta">生成时间: ' + dateStr + ' | 比对项数: ' + items.length + ' | Powered by PatentLens</div>\n';
    html += '  </div>\n';

    html += '  <div class="toolbar">\n';
    html += '    <button onclick="window.print()">🖨️ 打印/导出PDF</button>\n';
    html += '    <button onclick="toggleOriginals()" id="toggle-org-btn">📄 显示/隐藏原文</button>\n';
    html += '  </div>\n';

    html += '  <div class="content">\n';

    html += '    <h2 style="margin-top:0;">一、比对项概览</h2>\n';
    html += '    <div class="items-summary">\n';
    var anchorId = result.anchor ? result.anchor.id : null;
    items.forEach(function(item, idx) {
      var isAnchor = item.id === anchorId;
      var badge = isAnchor
        ? '<span class="badge anchor">⭐ 锚点</span>'
        : (item.source === 'patent'
          ? (item.metadata && item.metadata.claimType === 'independent'
            ? '<span class="badge ind">独权</span>'
            : '<span class="badge dep">从权</span>')
          : '<span class="badge manual">手动输入</span>');
      html += '      <div class="item-card' + (isAnchor ? ' style="border-color:#f59e0b;box-shadow:0 0 0 1px #f59e0b;"' : '') + '">\n';
      html += '        <h4>' + (isAnchor ? '⭐ ' : '') + ComparisonUtils.escapeHtml(item.label) + badge + '</h4>\n';
      if (item.patentNumber) {
        html += '        <div class="patent-num">专利号: ' + ComparisonUtils.escapeHtml(item.patentNumber) + '</div>\n';
      }
      html += '        <div class="preview">' + ComparisonUtils.escapeHtml(ComparisonUtils.truncateText(item.originalText, 200)) + '</div>\n';
      html += '      </div>\n';
    });
    html += '    </div>\n';

    html += '    <div class="analysis">\n';
    html += result.htmlContent;
    html += '    </div>\n';

    html += '    <div class="original-text" id="originals-section" style="display:none;">\n';
    html += '      <h2>附录：原文对照</h2>\n';
    items.forEach(function(item, idx) {
      var isAnchor = item.id === anchorId;
      html += '      <div class="original-item' + (isAnchor ? '" style="border-left-color:#f59e0b;background:#fffbeb;"' : '') + '>\n';
      html += '        <h4>' + (isAnchor ? '⭐ 锚点：' : '比对：') + ComparisonUtils.escapeHtml(item.label) + '</h4>\n';
      html += '        <pre>' + ComparisonUtils.escapeHtml(item.originalText) + '</pre>\n';
      html += '      </div>\n';
    });
    html += '    </div>\n';

    html += '  </div>\n';

    html += '  <div class="footer">本报告由 PatentLens 智能比对功能生成，仅供参考</div>\n';
    html += '</div>\n';

    html += '<script>\n';
    html += 'function toggleOriginals() {\n';
    html += '  var el = document.getElementById("originals-section");\n';
    html += '  var btn = document.getElementById("toggle-org-btn");\n';
    html += '  if (el.style.display === "none") { el.style.display = "block"; btn.classList.add("active"); }\n';
    html += '  else { el.style.display = "none"; btn.classList.remove("active"); }\n';
    html += '}\n';

    html += 'document.querySelectorAll(".analysis table tr").forEach(function(tr) {\n';
    html += '  var cells = tr.querySelectorAll("td");\n';
    html += '  cells.forEach(function(td) {\n';
    html += '    var text = td.textContent || "";\n';
    html += '    if (text.indexOf("核心特征") >= 0 || text.indexOf("⚡") >= 0) td.classList.add("diff-core");\n';
    html += '    else if (text.indexOf("范围") >= 0 && (text.indexOf("宽") >= 0 || text.indexOf("窄") >= 0)) td.classList.add("diff-scope");\n';
    html += '    else if (text.indexOf("术语") >= 0 || text.indexOf("表述") >= 0 || text.indexOf("📝") >= 0) td.classList.add("diff-term");\n';
    html += '    else if (text.indexOf("新增") >= 0 || text.indexOf("➕") >= 0) td.classList.add("diff-add");\n';
    html += '  });\n';
    html += '});\n';
    html += '</script>\n';

    html += '</body>\n';
    html += '</html>';

    return html;
  }

  function exportHtml() {
    var html = generateFullHtml();
    if (!html) {
      alert('暂无比对结果可导出');
      return;
    }

    var blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    var items = ComparisonCore.getResult().items;
    var firstLabel = items[0] ? items[0].label.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_') : 'comparison';
    var filename = 'PatentLens_智能比对_' + firstLabel + '_' + Date.now() + '.html';

    if (typeof saveAs !== 'undefined') {
      saveAs(blob, filename);
    } else {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  }

  return {
    generateFullHtml: generateFullHtml,
    exportHtml: exportHtml,
    REPORT_CSS: REPORT_CSS
  };
})();

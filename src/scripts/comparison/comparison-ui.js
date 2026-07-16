/*!
 * PatentLens - 智能比对模块 - UI渲染
 * Copyright (c) 2026 Alfred Shi. All rights reserved.
 * @author Alfred Shi
 * @version 260729
 */

var ComparisonUI = (function () {
  var _container = null;
  var _streamContent = '';
  var _onStreamUpdate = null;

  function getContainer() {
    if (!_container) {
      _container = document.getElementById('comparison-section');
    }
    return _container;
  }

  function getSimilarityColor(score) {
    if (score >= 0.8) return { bg: '#dcfce7', fg: '#166534', pct: Math.round(score * 100) };
    if (score >= 0.6) return { bg: '#fef9c3', fg: '#854d0e', pct: Math.round(score * 100) };
    if (score >= 0.4) return { bg: '#ffedd5', fg: '#9a3412', pct: Math.round(score * 100) };
    if (score >= 0.2) return { bg: '#fee2e2', fg: '#991b1b', pct: Math.round(score * 100) };
    return { bg: '#f3f4f6', fg: '#6b7280', pct: Math.round(score * 100) };
  }

  function getSimilarityLabel(score) {
    if (score >= 0.8) return '高度相似';
    if (score >= 0.6) return '较为相似';
    if (score >= 0.4) return '部分相似';
    if (score >= 0.2) return '低度相似';
    return '差异较大';
  }

  function render() {
    var container = getContainer();
    if (!container) return;

    var items = ComparisonCore.getItems();
    var selected = ComparisonCore.getSelectedItems();
    var anchor = ComparisonCore.getAnchor();
    var isLoading = ComparisonCore.isLoading();
    var result = ComparisonCore.getResult();
    var inputMode = ComparisonCore.getState().inputMode;

    var html = '';
    html += '<div class="comparison-header">';
    html += '  <div class="comparison-title">';
    html += '    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="18" rx="1"/><rect x="14" y="3" width="7" height="18" rx="1"/><path d="M9 9l6 6"/><path d="M15 9l-6 6"/></svg>';
    html += '    智能比对';
    html += '    <span class="comparison-mode-badge">锚定模式</span>';
    html += '  </div>';
    html += '  <button class="btn-secondary" onclick="ComparisonCore.clearItems();ComparisonUI.render();">清空全部</button>';
    html += '</div>';

    html += '<div class="comparison-usage-hint">';
    html += '  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;flex-shrink:0;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
    html += '  <span>点击任意文本项的 <strong>⭐ 设为锚点</strong> 按钮将其作为基准，其他文本将逐一与锚点对比。支持相似度矩阵和原文并排对照。</span>';
    html += '</div>';

    html += '<div class="comparison-input-tabs">';
    html += '  <button class="comparison-input-tab' + (inputMode === 'manual' ? ' active' : '') + '" data-input-mode="manual">手动输入文本</button>';
    html += '  <button class="comparison-input-tab' + (inputMode === 'patent' ? ' active' : '') + '" data-input-mode="patent">专利号查询</button>';
    html += '</div>';

    html += '<div id="comparison-input-area"></div>';

    html += '<div class="comparison-items-panel">';
    html += '  <div class="comparison-items-header">';
    html += '    <div>';
    html += '      <span class="comparison-items-title">待比对项列表</span>';
    html += '      <span class="comparison-items-count">共 ' + items.length + ' 项，已选 ' + selected.length + ' 项</span>';
    html += '      ' + (anchor ? '<span class="comparison-anchor-indicator"><svg viewBox="0 0 24 24" fill="currentColor" style="width:12px;height:12px;"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>锚点: ' + ComparisonUtils.escapeHtml(anchor.label) + '</span>' : '');
    html += '    </div>';
    html += '    <div class="comparison-items-actions">';
    if (items.length > 0) {
      html += '      <button class="btn-secondary btn-small" onclick="ComparisonCore.selectAll();ComparisonUI.render();">全选</button>';
      html += '      <button class="btn-secondary btn-small" onclick="ComparisonCore.deselectAll();ComparisonUI.render();">取消全选</button>';
    }
    html += '    </div>';
    html += '  </div>';
    html += '  <div class="comparison-items-list">';

    if (items.length === 0) {
      html += '    <div class="comparison-empty-list">';
      html += '      <p>暂无待比对项</p>';
      html += '      <p style="font-size:12px;margin-top:8px;">请通过上方"手动输入文本"添加，或使用"专利号查询"导入权利要求</p>';
      html += '    </div>';
    } else {
      items.forEach(function(item, idx) {
        html += renderItem(item, idx, anchor);
      });
    }

    html += '  </div>';
    html += '</div>';

    if (selected.length >= 2 && anchor && !isLoading && !result) {
      html += renderSimilarityMatrix(selected, anchor);
    }

    if (selected.length >= 2 && anchor && !isLoading && !result) {
      html += renderSideBySide(selected, anchor);
    }

    html += '<div class="comparison-actions-bar">';
    if (isLoading) {
      html += '  <button class="btn-danger comparison-abort-btn" onclick="ComparisonCore.abort()">中止比对</button>';
    } else {
      var canRun = selected.length >= 2 && anchor;
      var hint = '';
      if (!anchor) {
        hint = '请先选择一个文本作为锚点（点击 ⭐ 按钮）';
      } else if (selected.length < 2) {
        hint = '请至少选择2项进行比对（含锚点）';
      } else {
        hint = '锚点: ' + anchor.label + '，将与另外 ' + (selected.length - 1) + ' 项比对';
      }
      html += '  <button class="btn-primary comparison-run-btn" onclick="ComparisonUI.runComparison()" ' + (canRun ? '' : 'disabled') + '>开始锚定比对</button>';
      html += '  <span class="comparison-hint">' + hint + '</span>';
    }
    html += '</div>';

    html += '<div id="comparison-result-container"></div>';

    container.innerHTML = html;
    bindEvents(container);

    ComparisonInput.renderInputArea(document.getElementById('comparison-input-area'), inputMode);
    renderResultArea(document.getElementById('comparison-result-container'));
  }

  function renderItem(item, idx, anchor) {
    var isAnchor = anchor && anchor.id === item.id;
    var html = '';
    html += '<div class="comparison-item' + (item.isSelected ? ' selected' : '') + (isAnchor ? ' is-anchor' : '') + '" data-item-id="' + item.id + '">';
    html += '  <input type="checkbox" class="comparison-item-checkbox" ' + (item.isSelected ? 'checked' : '') + ' onchange="ComparisonCore.toggleItemSelected(\'' + item.id + '\');ComparisonUI.render();">';
    html += '  <div class="comparison-item-content">';
    html += '    <div class="comparison-item-top">';
    html += '      <input type="text" class="comparison-item-label-input" value="' + ComparisonUtils.escapeHtml(item.label) + '" onchange="ComparisonCore.updateItem(\'' + item.id + '\', {label: this.value});">';
    if (isAnchor) {
      html += '  <span class="comparison-item-badge anchor-badge"><svg viewBox="0 0 24 24" fill="currentColor" style="width:10px;height:10px;margin-right:3px;vertical-align:-1px;"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>锚点</span>';
    } else if (item.source === 'patent') {
      var badgeClass = item.metadata && item.metadata.claimType === 'independent' ? 'independent' : 'dependent';
      var badgeText = item.metadata && item.metadata.claimType === 'independent' ? '独权' : '从权';
      html += '  <span class="comparison-item-badge ' + badgeClass + '">' + badgeText + '</span>';
    } else {
      html += '  <span class="comparison-item-badge manual">手动输入</span>';
    }
    if (item.patentNumber) {
      html += '  <span style="font-size:11px;color:var(--text-secondary);">' + ComparisonUtils.escapeHtml(item.patentNumber) + '</span>';
    }
    html += '    </div>';
    html += '    <div class="comparison-item-preview">' + ComparisonUtils.escapeHtml(ComparisonUtils.truncateText(item.originalText, 200)) + '</div>';
    html += '  </div>';
    html += '  <div class="comparison-item-actions">';
    if (!isAnchor && item.isSelected) {
      html += '    <button class="comparison-item-btn anchor-btn" title="设为锚点（基准文本）" onclick="ComparisonCore.setAnchor(\'' + item.id + '\');ComparisonUI.render();"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></button>';
    }
    html += '    <button class="comparison-item-btn" title="预览全文" onclick="ComparisonUI.previewItem(\'' + item.id + '\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>';
    if (idx > 0) {
      html += '  <button class="comparison-item-btn" title="上移" onclick="ComparisonCore.moveItem(\'' + item.id + '\', -1);ComparisonUI.render();"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg></button>';
    }
    if (idx < ComparisonCore.getItems().length - 1) {
      html += '  <button class="comparison-item-btn" title="下移" onclick="ComparisonCore.moveItem(\'' + item.id + '\', 1);ComparisonUI.render();"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></button>';
    }
    html += '    <button class="comparison-item-btn danger" title="删除" onclick="ComparisonCore.removeItem(\'' + item.id + '\');ComparisonUI.render();"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>';
    html += '  </div>';
    html += '</div>';
    return html;
  }

  function renderSimilarityMatrix(selected, anchor) {
    var simMatrix = ComparisonCore.computeSimilarityMatrix();
    if (!simMatrix) return '';

    var anchorIdx = selected.findIndex(function(i) { return i.id === anchor.id; });
    if (anchorIdx === -1) return '';

    var html = '<div class="comparison-sim-panel">';
    html += '  <div class="comparison-sim-header">';
    html += '    <div class="comparison-sim-title">';
    html += '      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;color:var(--accent)"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/></svg>';
    html += '      文本相似度矩阵（基于字符/词元Jaccard相似度，仅供参考）';
    html += '    </div>';
    html += '  </div>';
    html += '  <div class="comparison-sim-scroll">';
    html += '  <table class="comparison-sim-matrix">';
    html += '    <thead><tr><th></th>';
    selected.forEach(function(item, j) {
      var isAnc = item.id === anchor.id;
      html += '<th class="' + (isAnc ? 'sim-anchor-col' : '') + '">' + ComparisonUtils.escapeHtml(ComparisonUtils.truncateText(item.label, 12)) + (isAnc ? ' ⭐' : '') + '</th>';
    });
    html += '    </tr></thead><tbody>';

    selected.forEach(function(item, i) {
      var isAncRow = item.id === anchor.id;
      html += '<tr><th class="' + (isAncRow ? 'sim-anchor-row' : '') + '">' + ComparisonUtils.escapeHtml(ComparisonUtils.truncateText(item.label, 12)) + (isAncRow ? ' ⭐' : '') + '</th>';
      selected.forEach(function(_, j) {
        var score = simMatrix.matrix[i][j];
        var color = getSimilarityColor(score);
        var isDiag = i === j;
        var isAnchorCell = isAncRow || selected[j].id === anchor.id;
        html += '<td class="sim-cell' + (isDiag ? ' sim-diag' : '') + (isAnchorCell ? ' sim-anchor-cell' : '') + '" style="background:' + color.bg + ';color:' + color.fg + ';" title="' + ComparisonUtils.escapeHtml(selected[i].label) + ' vs ' + ComparisonUtils.escapeHtml(selected[j].label) + ': ' + color.pct + '%">' + color.pct + '%</td>';
      });
      html += '</tr>';
    });

    html += '    </tbody></table>';
    html += '  </div>';
    html += '  <div class="comparison-sim-legend">';
    html += '    <span class="sim-legend-item" style="background:#dcfce7;color:#166534;">高度相似 ≥80%</span>';
    html += '    <span class="sim-legend-item" style="background:#fef9c3;color:#854d0e;">较为相似 60-79%</span>';
    html += '    <span class="sim-legend-item" style="background:#ffedd5;color:#9a3412;">部分相似 40-59%</span>';
    html += '    <span class="sim-legend-item" style="background:#fee2e2;color:#991b1b;">低度相似 20-39%</span>';
    html += '    <span class="sim-legend-item" style="background:#f3f4f6;color:#6b7280;">差异较大 &lt;20%</span>';
    html += '  </div>';
    html += '</div>';
    return html;
  }

  function renderSideBySide(selected, anchor) {
    var others = selected.filter(function(i) { return i.id !== anchor.id; });
    if (others.length === 0) return '';

    var html = '<div class="comparison-sxs-panel">';
    html += '  <div class="comparison-sxs-header">';
    html += '    <div class="comparison-sxs-title">';
    html += '      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;color:var(--accent)"><rect x="3" y="3" width="7" height="18" rx="1"/><rect x="14" y="3" width="7" height="18" rx="1"/></svg>';
    html += '      原文并排对照';
    html += '    </div>';
    html += '  </div>';

    others.forEach(function(other) {
      var sim = ComparisonCore.computeTextSimilarity(anchor.originalText, other.originalText);
      var simColor = getSimilarityColor(sim);
      var simLabel = getSimilarityLabel(sim);

      html += '<div class="comparison-sxs-pair">';
      html += '  <div class="comparison-sxs-pair-header">';
      html += '    <span class="comparison-sxs-vs">' + ComparisonUtils.escapeHtml(anchor.label) + ' ⭐</span>';
      html += '    <span class="comparison-sxs-sim" style="background:' + simColor.bg + ';color:' + simColor.fg + ';">' + simColor.pct + '% ' + simLabel + '</span>';
      html += '    <span class="comparison-sxs-vs">vs ' + ComparisonUtils.escapeHtml(other.label) + '</span>';
      html += '  </div>';
      html += '  <div class="comparison-sxs-grid">';

      html += '    <div class="comparison-sxs-col anchor-col">';
      html += '      <div class="comparison-sxs-col-header"><svg viewBox="0 0 24 24" fill="currentColor" style="width:12px;height:12px;margin-right:4px;vertical-align:-1px;"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>锚点原文</div>';
      html += '      <div class="comparison-sxs-text">' + formatTextForDisplay(anchor.originalText) + '</div>';
      html += '    </div>';

      html += '    <div class="comparison-sxs-col compare-col">';
      html += '      <div class="comparison-sxs-col-header">比对原文</div>';
      html += '      <div class="comparison-sxs-text">' + formatTextForDisplay(other.originalText) + '</div>';
      html += '    </div>';

      html += '  </div>';
      html += '</div>';
    });

    html += '</div>';
    return html;
  }

  function formatTextForDisplay(text) {
    if (!text) return '<em style="color:var(--text-secondary)">无内容</em>';
    return ComparisonUtils.escapeHtml(text).replace(/\n/g, '<br>');
  }

  function bindEvents(container) {
    var tabs = container.querySelectorAll('.comparison-input-tab');
    tabs.forEach(function(tab) {
      tab.addEventListener('click', function() {
        var mode = this.dataset.inputMode;
        ComparisonCore.setInputMode(mode);
        render();
      });
    });
  }

  function renderResultArea(container) {
    if (!container) return;
    var isLoading = ComparisonCore.isLoading();
    var result = ComparisonCore.getResult();

    var html = '';
    if (isLoading) {
      html += '<div class="comparison-result-panel">';
      html += '  <div class="comparison-loading">';
      html += '    <div class="comparison-spinner"></div>';
      html += '    <div class="comparison-loading-text">AI正在锚定分析比对，请稍候...</div>';
      html += '    <div id="comparison-stream-preview" class="comparison-stream-preview"></div>';
      html += '  </div>';
      html += '</div>';
    } else if (result) {
      var anchor = result.anchor;
      var others = result.others || [];
      var simMatrix = result.similarityMatrix;

      html += '<div class="comparison-result-panel">';
      html += '  <div class="comparison-result-header">';
      html += '    <div class="comparison-result-title">';
      html += '      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px;height:18px;color:var(--accent)"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
      html += '      锚定比对分析结果';
      html += '    </div>';
      html += '    <div class="comparison-result-actions">';
      html += '      <button class="btn-secondary btn-small" onclick="ComparisonReport.exportHtml()" id="comparison-export-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;margin-right:4px;vertical-align:-2px"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>导出HTML报告</button>';
      html += '    </div>';
      html += '  </div>';

      html += '  <div class="comparison-result-content markdown-body">';
      html += result.htmlContent;
      html += '  </div>';

      html += '  <div class="comparison-result-originals">';
      html += '    <h3 style="font-size:14px;font-weight:600;margin-bottom:12px;color:var(--text-secondary);">附录：原文完整对照</h3>';

      html += '    <div class="comparison-result-anchor">';
      html += '      <div class="comparison-sxs-col-header" style="margin-bottom:8px;"><svg viewBox="0 0 24 24" fill="currentColor" style="width:12px;height:12px;margin-right:4px;vertical-align:-1px;color:#f59e0b;"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>锚点：' + ComparisonUtils.escapeHtml(anchor.label) + '</div>';
      html += '      <div class="comparison-original-block">' + formatTextForDisplay(anchor.originalText) + '</div>';
      html += '    </div>';

      others.forEach(function(other) {
        var sim = ComparisonCore.computeTextSimilarity(anchor.originalText, other.originalText);
        var simColor = getSimilarityColor(sim);
        html += '    <div class="comparison-result-other">';
        html += '      <div class="comparison-sxs-col-header" style="margin-bottom:8px;">比对：' + ComparisonUtils.escapeHtml(other.label) + ' <span class="comparison-sxs-sim" style="background:' + simColor.bg + ';color:' + simColor.fg + ';margin-left:8px;font-size:11px;padding:1px 8px;border-radius:10px;">' + Math.round(sim * 100) + '%</span></div>';
        html += '      <div class="comparison-original-block">' + formatTextForDisplay(other.originalText) + '</div>';
        html += '    </div>';
      });

      html += '  </div>';
      html += '</div>';
    }

    container.innerHTML = html;

    if (isLoading) {
      _streamContent = '';
      var preview = document.getElementById('comparison-stream-preview');
      if (_onStreamUpdate) {
        ComparisonCore.off('streamUpdate', _onStreamUpdate);
      }
      _onStreamUpdate = function(content) {
        _streamContent = content;
        var el = document.getElementById('comparison-stream-preview');
        if (el) {
          el.textContent = content;
          el.scrollTop = el.scrollHeight;
        }
      };
      if (preview) {
        ComparisonCore.on('streamUpdate', _onStreamUpdate);
      }
    }
  }

  function runComparison() {
    _streamContent = '';
    ComparisonCore.runComparison().then(function() {
      render();
    }).catch(function(err) {
      alert('比对失败: ' + err.message);
      render();
    });
    render();
  }

  function previewItem(id) {
    var item = ComparisonCore.getItems().find(function(i) { return i.id === id; });
    if (!item) return;

    var modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;';
    modal.onclick = function(e) { if (e.target === modal) modal.remove(); };

    var box = document.createElement('div');
    box.style.cssText = 'background:var(--bg-card);border-radius:12px;max-width:800px;width:100%;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.3);';

    var isAnchor = ComparisonCore.getAnchor() && ComparisonCore.getAnchor().id === item.id;
    var anchorBadge = isAnchor ? ' <span style="background:linear-gradient(135deg,#f59e0b,#d97706);color:#fff;font-size:11px;padding:2px 8px;border-radius:10px;margin-left:8px;">⭐ 锚点</span>' : '';

    box.innerHTML = '<div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;">' +
      '<h3 style="margin:0;font-size:16px;">' + ComparisonUtils.escapeHtml(item.label) + anchorBadge + '</h3>' +
      '<button onclick="this.closest(\'div[style*=fixed]\').remove()" style="width:32px;height:32px;border:none;background:transparent;color:var(--text-secondary);cursor:pointer;font-size:20px;display:flex;align-items:center;justify-content:center;border-radius:6px;" onmouseover="this.style.background=\'var(--bg-hover)\'" onmouseout="this.style.background=\'transparent\'">&times;</button>' +
      '</div>' +
      '<div style="padding:20px;overflow-y:auto;flex:1;"><pre style="white-space:pre-wrap;word-break:break-word;font-family:inherit;line-height:1.8;font-size:13px;margin:0;">' + ComparisonUtils.escapeHtml(item.originalText) + '</pre></div>';

    modal.appendChild(box);
    document.body.appendChild(modal);
  }

  function showError(message) {
    console.error('Comparison error:', message);
  }

  function init() {
    ComparisonCore.on('itemsChanged', function() {
      render();
    });
    ComparisonCore.on('anchorChanged', function() {
      render();
    });
    ComparisonCore.on('resultReady', function() {
      render();
    });
    ComparisonCore.on('error', function(msg) {
      showError(msg);
    });
  }

  return {
    render: render,
    runComparison: runComparison,
    previewItem: previewItem,
    init: init
  };
})();

/*!
 * PatentLens - 智能比对模块 - UI渲染
 * Copyright (c) 2026 Alfred Shi. All rights reserved.
 * @author Alfred Shi
 * @version 260716
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

  function render() {
    var container = getContainer();
    if (!container) return;

    var items = ComparisonCore.getItems();
    var selectedCount = items.filter(function(i) { return i.isSelected; }).length;
    var isLoading = ComparisonCore.isLoading();
    var result = ComparisonCore.getResult();
    var inputMode = ComparisonCore.getState().inputMode;

    var html = '';
    html += '<div class="comparison-header">';
    html += '  <div class="comparison-title">';
    html += '    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="18" rx="1"/><rect x="14" y="3" width="7" height="18" rx="1"/><path d="M9 9l6 6"/><path d="M15 9l-6 6"/></svg>';
    html += '    智能比对';
    html += '  </div>';
    html += '  <button class="btn-secondary" onclick="ComparisonCore.clearItems();ComparisonUI.render();">清空全部</button>';
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
    html += '      <span class="comparison-items-count">共 ' + items.length + ' 项，已选 ' + selectedCount + ' 项</span>';
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
        html += renderItem(item, idx);
      });
    }

    html += '  </div>';
    html += '</div>';

    html += '<div class="comparison-actions-bar">';
    if (isLoading) {
      html += '  <button class="btn-danger comparison-abort-btn" onclick="ComparisonCore.abort()">中止比对</button>';
    } else {
      html += '  <button class="btn-primary comparison-run-btn" onclick="ComparisonUI.runComparison()" ' + (selectedCount < 2 ? 'disabled' : '') + '>开始智能比对</button>';
    }
    html += '  <span class="comparison-hint">' + (selectedCount < 2 ? '请至少选择2项进行比对' : '已选择 ' + selectedCount + ' 项，点击开始比对') + '</span>';
    html += '</div>';

    html += '<div id="comparison-result-container"></div>';

    container.innerHTML = html;
    bindEvents(container);

    ComparisonInput.renderInputArea(document.getElementById('comparison-input-area'), inputMode);
    renderResultArea(document.getElementById('comparison-result-container'));
  }

  function renderItem(item, idx) {
    var html = '';
    html += '<div class="comparison-item' + (item.isSelected ? ' selected' : '') + '" data-item-id="' + item.id + '">';
    html += '  <input type="checkbox" class="comparison-item-checkbox" ' + (item.isSelected ? 'checked' : '') + ' onchange="ComparisonCore.toggleItemSelected(\'' + item.id + '\');ComparisonUI.render();">';
    html += '  <div class="comparison-item-content">';
    html += '    <div class="comparison-item-top">';
    html += '      <input type="text" class="comparison-item-label-input" value="' + ComparisonUtils.escapeHtml(item.label) + '" onchange="ComparisonCore.updateItem(\'' + item.id + '\', {label: this.value});">';
    if (item.source === 'patent') {
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
      html += '    <div class="comparison-loading-text">AI正在分析比对，请稍候...</div>';
      html += '    <div id="comparison-stream-preview" class="comparison-stream-preview"></div>';
      html += '  </div>';
      html += '</div>';
    } else if (result) {
      html += '<div class="comparison-result-panel">';
      html += '  <div class="comparison-result-header">';
      html += '    <div class="comparison-result-title">';
      html += '      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px;height:18px;color:var(--accent)"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
      html += '      比对分析结果';
      html += '    </div>';
      html += '    <div class="comparison-result-actions">';
      html += '      <button class="btn-secondary btn-small" onclick="ComparisonReport.exportHtml()" id="comparison-export-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;margin-right:4px;vertical-align:-2px"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>导出HTML报告</button>';
      html += '    </div>';
      html += '  </div>';
      html += '  <div class="comparison-result-content markdown-body">';
      html += result.htmlContent;
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

    box.innerHTML = '<div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;">' +
      '<h3 style="margin:0;font-size:16px;">' + ComparisonUtils.escapeHtml(item.label) + '</h3>' +
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

/*!
 * PatentLens - 智能比对模块 - 输入处理
 * Copyright (c) 2026 Alfred Shi. All rights reserved.
 * @author Alfred Shi
 * @version 260716
 */

var ComparisonInput = (function () {
  var _selectedClaims = {};

  function renderInputArea(container, inputMode) {
    if (!container) return;

    if (inputMode === 'manual') {
      renderManualInput(container);
    } else if (inputMode === 'patent') {
      renderPatentInput(container);
    }
  }

  function renderManualInput(container) {
    var html = '<div class="comparison-input-panel">';
    html += '  <div class="comparison-manual-add">';
    html += '    <div style="display:flex;gap:12px;align-items:center;">';
    html += '      <input type="text" id="cmp-manual-label" class="comparison-label-input" placeholder="标签名称（如：US权1、CN独权）" style="max-width:200px;">';
    html += '      <button class="btn-primary comparison-add-btn" onclick="ComparisonInput.addManualText()">';
    html += '        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;margin-right:4px;vertical-align:-2px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
    html += '        添加文本';
    html += '      </button>';
    html += '    </div>';
    html += '    <textarea id="cmp-manual-text" class="comparison-textarea" placeholder="在此粘贴要比对的文本内容（如独立权利要求书）..."></textarea>';
    html += '    <div class="comparison-patent-hint">提示：可添加多组文本，每组建议是一个独立权利要求或一段需要比对的内容</div>';
    html += '  </div>';
    html += '</div>';
    container.innerHTML = html;

    setTimeout(function() {
      var textarea = document.getElementById('cmp-manual-text');
      if (textarea) {
        textarea.focus();
        textarea.addEventListener('keydown', function(e) {
          if (e.ctrlKey && e.key === 'Enter') {
            addManualText();
          }
        });
      }
    }, 100);
  }

  function addManualText() {
    var labelInput = document.getElementById('cmp-manual-label');
    var textInput = document.getElementById('cmp-manual-text');
    if (!labelInput || !textInput) return;

    var text = ComparisonUtils.cleanText(textInput.value);
    if (!text) {
      alert('请输入要比对的文本内容');
      return;
    }

    var label = labelInput.value.trim() || ('文本' + (ComparisonCore.getItems().length + 1));

    ComparisonCore.addItem({
      label: label,
      source: 'manual',
      originalText: text
    });

    textInput.value = '';
    labelInput.value = '';
    var items = ComparisonCore.getItems();
    labelInput.placeholder = '文本' + (items.length + 1);
    ComparisonUI.render();
  }

  function renderPatentInput(container) {
    var html = '<div class="comparison-input-panel">';
    html += '  <div class="comparison-patent-input">';
    html += '    <label style="font-size:13px;font-weight:500;margin-bottom:4px;">输入专利号（每行一个，最多10个）</label>';
    html += '    <textarea id="cmp-patent-numbers" class="comparison-patent-textarea" placeholder="每行输入一个专利号，例如：\nUS12030161B2\nUS17204063\nEP4252965A3"></textarea>';
    html += '    <div class="comparison-patent-hint">支持Google Patents可查询的所有国家/地区专利号</div>';
    html += '    <div style="display:flex;gap:8px;margin-top:8px;">';
    html += '      <button class="btn-primary" id="cmp-fetch-patents-btn" onclick="ComparisonInput.fetchPatents()">查询并获取权利要求</button>';
    html += '      <button class="btn-secondary" onclick="document.getElementById(\'cmp-patent-numbers\').value=\'\'">清空</button>';
    html += '    </div>';
    html += '  </div>';
    html += '  <div id="cmp-patent-progress"></div>';
    html += '  <div id="cmp-claims-selector"></div>';
    html += '</div>';
    container.innerHTML = html;
  }

  async function fetchPatents() {
    var textarea = document.getElementById('cmp-patent-numbers');
    if (!textarea) return;

    var numbers = ComparisonUtils.parsePatentNumbersInput(textarea.value);
    if (numbers.length === 0) {
      alert('请输入至少一个专利号');
      return;
    }
    if (numbers.length > 10) {
      alert('最多支持同时查询10个专利');
      return;
    }

    var btn = document.getElementById('cmp-fetch-patents-btn');
    var progressContainer = document.getElementById('cmp-patent-progress');
    var claimsContainer = document.getElementById('cmp-claims-selector');

    if (btn) btn.disabled = true;
    _selectedClaims = {};

    var fetchedPatents = {};
    var errors = [];

    for (var i = 0; i < numbers.length; i++) {
      var num = numbers[i];
      var normalized = ComparisonUtils.normalizePatentNumber(num);

      if (progressContainer) {
        progressContainer.innerHTML = '<div class="comparison-progress">' +
          '<div class="comparison-progress-text">正在查询 ' + (i + 1) + '/' + numbers.length + ': ' + ComparisonUtils.escapeHtml(num) + '</div>' +
          '<div class="comparison-progress-bar"><div class="comparison-progress-fill" style="width:' + Math.round((i / numbers.length) * 100) + '%"></div></div>' +
          '</div>';
      }

      try {
        var json = await fetchPatentWithRetry(normalized);
        if (json && json.success && json.data) {
          var d = json.data;
          var claims = d.claims || [];
          if (claims.length > 0) {
            fetchedPatents[normalized] = {
              patentNumber: normalized,
              title: d.title || '',
              applicant: d.assignee || d.applicant || '',
              claims: claims
            };
          } else {
            errors.push(num + ': 未找到权利要求数据');
          }
        } else {
          errors.push(num + ': ' + (json && json.error ? json.error : '查询失败'));
        }
      } catch (err) {
        errors.push(num + ': ' + err.message);
      }

      await new Promise(function(r) { setTimeout(r, 800); });
    }

    if (progressContainer) {
      progressContainer.innerHTML = '<div class="comparison-progress">' +
        '<div class="comparison-progress-text">查询完成: 成功 ' + Object.keys(fetchedPatents).length + ' 个' + (errors.length > 0 ? '，失败 ' + errors.length + ' 个' : '') + '</div>' +
        '<div class="comparison-progress-bar"><div class="comparison-progress-fill" style="width:100%"></div></div>' +
        (errors.length > 0 ? '<div style="margin-top:8px;font-size:12px;color:#ef4444;">失败: ' + errors.map(ComparisonUtils.escapeHtml).join('; ') + '</div>' : '') +
        '</div>';
    }

    if (Object.keys(fetchedPatents).length > 0) {
      renderClaimsSelector(claimsContainer, fetchedPatents);
    }

    if (btn) btn.disabled = false;
  }

  function renderClaimsSelector(container, patents) {
    if (!container) return;

    var html = '<div class="claims-selector" style="margin-top:16px;">';

    Object.keys(patents).forEach(function(patentNum) {
      var patent = patents[patentNum];
      var claims = patent.claims;
      var indCount = 0;
      claims.forEach(function(c, i) {
        if (ComparisonCore.isIndependentClaim(c, i)) indCount++;
      });

      html += '<div class="patent-claims-group" data-patent="' + patentNum + '">';
      html += '  <div class="patent-claims-header" onclick="ComparisonInput.togglePatentGroup(this)">';
      html += '    <svg class="patent-claims-toggle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>';
      html += '    <strong>' + ComparisonUtils.escapeHtml(patentNum) + '</strong>';
      if (patent.title) {
        html += '  <span style="color:var(--text-secondary);font-weight:normal;margin-left:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:400px;">' + ComparisonUtils.escapeHtml(patent.title) + '</span>';
      }
      html += '    <span class="patent-claims-count">' + claims.length + '项权利要求 (' + indCount + '项独权)</span>';
      html += '  </div>';
      html += '  <div class="patent-claims-list">';

      claims.forEach(function(claim, idx) {
        var isInd = ComparisonCore.isIndependentClaim(claim, idx);
        var claimNum = claim.num || (idx + 1);
        _selectedClaims[patentNum + '_' + claimNum] = isInd;

        html += '<label class="claim-select-item">';
        html += '  <input type="checkbox" class="claim-select-checkbox" data-patent="' + patentNum + '" data-claim-num="' + claimNum + '" data-claim-idx="' + idx + '" ' + (isInd ? 'checked' : '') + ' onchange="ComparisonInput.toggleClaimSelect(this)">';
        html += '  <div class="claim-select-content">';
        html += '    <span class="claim-select-num">权' + claimNum + (isInd ? ' (独权)' : ' (从权)') + '</span>';
        html += '    <span class="claim-select-text">' + ComparisonUtils.escapeHtml(ComparisonUtils.truncateText(claim.text, 150)) + '</span>';
        html += '  </div>';
        html += '</label>';
      });

      html += '  </div>';
      html += '</div>';
    });

    html += '</div>';

    html += '<div style="display:flex;gap:8px;margin-top:16px;padding-top:16px;border-top:1px solid var(--border);">';
    html += '  <button class="btn-primary" onclick="ComparisonInput.addSelectedClaims()">添加选中权利要求到比对列表</button>';
    html += '  <button class="btn-secondary" onclick="ComparisonInput.selectAllClaims(true)">全选独权</button>';
    html += '  <button class="btn-secondary" onclick="ComparisonInput.selectAllClaims(false)">全选/取消全选</button>';
    html += '</div>';

    container.innerHTML = html;
    container._patentsData = patents;
  }

  function togglePatentGroup(headerEl) {
    headerEl.classList.toggle('collapsed');
    var list = headerEl.nextElementSibling;
    if (list) list.classList.toggle('collapsed');
  }

  function toggleClaimSelect(checkbox) {
    var key = checkbox.dataset.patent + '_' + checkbox.dataset.claimNum;
    _selectedClaims[key] = checkbox.checked;
  }

  function selectAllClaims(indOnly) {
    var container = document.getElementById('cmp-claims-selector');
    if (!container || !container._patentsData) return;

    var checkboxes = container.querySelectorAll('.claim-select-checkbox');
    var allChecked = true;
    checkboxes.forEach(function(cb) {
      if (indOnly) {
        var idx = parseInt(cb.dataset.claimIdx);
        var patent = container._patentsData[cb.dataset.patent];
        if (patent && patent.claims[idx]) {
          var isInd = ComparisonCore.isIndependentClaim(patent.claims[idx], idx);
          cb.checked = isInd;
          _selectedClaims[cb.dataset.patent + '_' + cb.dataset.claimNum] = isInd;
        }
      } else {
        allChecked = allChecked && cb.checked;
      }
    });

    if (!indOnly) {
      checkboxes.forEach(function(cb) {
        cb.checked = !allChecked;
        _selectedClaims[cb.dataset.patent + '_' + cb.dataset.claimNum] = cb.checked;
      });
    }
  }

  function addSelectedClaims() {
    var container = document.getElementById('cmp-claims-selector');
    if (!container || !container._patentsData) return;

    var addedCount = 0;
    var patents = container._patentsData;

    Object.keys(patents).forEach(function(patentNum) {
      var patent = patents[patentNum];
      patent.claims.forEach(function(claim, idx) {
        var claimNum = claim.num || (idx + 1);
        var key = patentNum + '_' + claimNum;
        if (_selectedClaims[key]) {
          var isInd = ComparisonCore.isIndependentClaim(claim, idx);
          var existing = ComparisonCore.getItems().find(function(i) {
            return i.patentNumber === patentNum && i.claimNumber === claimNum;
          });
          if (!existing) {
            ComparisonCore.addItem({
              label: patentNum + ' 权' + claimNum + (isInd ? ' (独权)' : ' (从权)'),
              source: 'patent',
              patentNumber: patentNum,
              claimNumber: claimNum,
              originalText: claim.text || '',
              isSelected: true,
              metadata: {
                title: patent.title,
                applicant: patent.applicant,
                claimType: isInd ? 'independent' : 'dependent',
                claimIndex: idx
              }
            });
            addedCount++;
          }
        }
      });
    });

    if (addedCount > 0) {
      ComparisonUI.render();
    } else {
      alert('请至少选择一项权利要求');
    }
  }

  async function loadFromFamilyPatents(patents) {
    ComparisonCore.clearItems();
    ComparisonCore.setInputMode('patent');
    ComparisonUI.render();

    var progressContainer = document.getElementById('cmp-patent-progress');
    var claimsContainer = document.getElementById('cmp-claims-selector');
    var textarea = document.getElementById('cmp-patent-numbers');

    if (textarea && patents.length > 0) {
      textarea.value = patents.map(function(p) { return p.patentNumber || p.publication_number || ''; }).filter(Boolean).join('\n');
    }

    await fetchPatents();
  }

  return {
    renderInputArea: renderInputArea,
    addManualText: addManualText,
    fetchPatents: fetchPatents,
    togglePatentGroup: togglePatentGroup,
    toggleClaimSelect: toggleClaimSelect,
    selectAllClaims: selectAllClaims,
    addSelectedClaims: addSelectedClaims,
    loadFromFamilyPatents: loadFromFamilyPatents
  };
})();

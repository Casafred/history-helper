/*!
 * PatentLens - 智能比对模块 - 核心状态管理与AI调用
 * Copyright (c) 2026 Alfred Shi. All rights reserved.
 * @author Alfred Shi
 * @version 260716
 */

var ComparisonCore = (function () {
  var _state = {
    items: [],
    result: null,
    isLoading: false,
    isAborted: false,
    abortController: null,
    mode: 'manual',
    inputMode: 'manual',
    pendingPatentClaims: null,
    loadedPatents: {},
    progress: {
      current: 0,
      total: 0,
      message: ''
    }
  };

  var _listeners = {};

  function on(event, fn) {
    if (!_listeners[event]) _listeners[event] = [];
    _listeners[event].push(fn);
  }

  function off(event, fn) {
    if (!_listeners[event]) return;
    _listeners[event] = _listeners[event].filter(function(f) { return f !== fn; });
  }

  function emit(event, data) {
    if (!_listeners[event]) return;
    _listeners[event].forEach(function(fn) {
      try { fn(data); } catch(e) { console.error('Comparison event listener error:', e); }
    });
  }

  function getState() {
    return JSON.parse(JSON.stringify(_state));
  }

  function getItems() {
    return _state.items.slice();
  }

  function getSelectedItems() {
    return _state.items.filter(function(item) { return item.isSelected; });
  }

  function addItem(options) {
    var item = {
      id: ComparisonUtils.generateId(),
      label: options.label || ('文本' + (_state.items.length + 1)),
      source: options.source || 'manual',
      patentNumber: options.patentNumber || '',
      claimNumber: options.claimNumber || null,
      originalText: ComparisonUtils.cleanText(options.originalText || ''),
      originalLang: options.originalLang || ComparisonUtils.detectLanguage(options.originalText || ''),
      translatedText: options.translatedText || '',
      isSelected: options.isSelected !== false,
      metadata: options.metadata || {}
    };
    _state.items.push(item);
    emit('itemsChanged', getItems());
    return item;
  }

  function updateItem(id, updates) {
    var idx = _state.items.findIndex(function(i) { return i.id === id; });
    if (idx === -1) return null;
    _state.items[idx] = Object.assign({}, _state.items[idx], updates);
    emit('itemsChanged', getItems());
    return _state.items[idx];
  }

  function removeItem(id) {
    _state.items = _state.items.filter(function(i) { return i.id !== id; });
    emit('itemsChanged', getItems());
  }

  function toggleItemSelected(id) {
    var item = _state.items.find(function(i) { return i.id === id; });
    if (item) {
      item.isSelected = !item.isSelected;
      emit('itemsChanged', getItems());
    }
  }

  function selectAll() {
    _state.items.forEach(function(i) { i.isSelected = true; });
    emit('itemsChanged', getItems());
  }

  function deselectAll() {
    _state.items.forEach(function(i) { i.isSelected = false; });
    emit('itemsChanged', getItems());
  }

  function clearItems() {
    _state.items = [];
    _state.result = null;
    _state.loadedPatents = {};
    emit('itemsChanged', getItems());
    emit('resultCleared', null);
  }

  function moveItem(id, direction) {
    var idx = _state.items.findIndex(function(i) { return i.id === id; });
    if (idx === -1) return;
    var newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= _state.items.length) return;
    var temp = _state.items[idx];
    _state.items[idx] = _state.items[newIdx];
    _state.items[newIdx] = temp;
    emit('itemsChanged', getItems());
  }

  function setMode(mode) {
    _state.mode = mode;
    emit('modeChanged', mode);
  }

  function setInputMode(inputMode) {
    _state.inputMode = inputMode;
    emit('inputModeChanged', inputMode);
  }

  function abort() {
    if (_state.abortController) {
      _state.isAborted = true;
      _state.abortController.abort();
    }
  }

  function setProgress(current, total, message) {
    _state.progress = { current: current, total: total, message: message || '' };
    emit('progress', _state.progress);
  }

  async function runComparison() {
    var selected = getSelectedItems();
    if (selected.length < 2) {
      throw new Error('请至少选择2项进行比对');
    }

    var config = AI.loadAIConfig();
    var provider = AI.getCurrentProvider(config);
    if (!provider) {
      throw new Error('请先配置AI API Key');
    }

    _state.isLoading = true;
    _state.isAborted = false;
    _state.result = null;
    _state.abortController = new AbortController();
    emit('loading', true);
    emit('progress', { current: 0, total: selected.length, message: '正在准备比对...' });

    var resultContent = '';

    try {
      var messages = [
        { role: 'system', content: ComparisonPrompts.SYSTEM_PROMPT },
        { role: 'user', content: ComparisonPrompts.buildUserPrompt(selected) }
      ];

      var stream = AI.streamChat(
        provider.type,
        provider.apiKey,
        provider.baseUrl,
        {
          model: provider.model,
          messages: messages,
          maxTokens: 65536,
          temperature: 0.1
        },
        _state.abortController.signal
      );

      var itemCount = selected.length;
      var step = 0;

      for await (var chunk of stream) {
        if (_state.isAborted) break;
        if (chunk.content) {
          resultContent += chunk.content;
          emit('streamUpdate', resultContent);
          step += chunk.content.length;
          var progress = Math.min(90, Math.floor(step / 50));
          setProgress(progress, 100, 'AI正在分析比对...');
        }
      }

      if (!_state.isAborted) {
        _state.result = {
          sessionId: 'sess_' + Date.now(),
          timestamp: Date.now(),
          items: selected,
          markdownContent: resultContent,
          htmlContent: marked.parse(resultContent)
        };
        setProgress(100, 100, '比对完成');
        emit('resultReady', _state.result);
      }
    } catch (err) {
      if (_state.isAborted) {
        emit('aborted', null);
      } else {
        console.error('Comparison error:', err);
        emit('error', err.message || '比对失败');
      }
    } finally {
      _state.isLoading = false;
      _state.abortController = null;
      emit('loading', false);
    }

    return _state.result;
  }

  function getResult() {
    return _state.result;
  }

  function isLoading() {
    return _state.isLoading;
  }

  function addPatentClaims(patentNumber, claims, metadata) {
    if (!claims || claims.length === 0) return 0;
    _state.loadedPatents[patentNumber] = {
      patentNumber: patentNumber,
      claims: claims,
      metadata: metadata || {}
    };
    var count = 0;
    claims.forEach(function(claim, idx) {
      var isInd = isIndependentClaim(claim, idx);
      addItem({
        label: patentNumber + ' 权' + (claim.num || (idx + 1)) + (isInd ? ' (独权)' : ' (从权)'),
        source: 'patent',
        patentNumber: patentNumber,
        claimNumber: claim.num || (idx + 1),
        originalText: claim.text || '',
        originalLang: ComparisonUtils.detectLanguage(claim.text || ''),
        isSelected: isInd,
        metadata: Object.assign({}, metadata || {}, {
          claimType: isInd ? 'independent' : 'dependent',
          claimIndex: idx
        })
      });
      count++;
    });
    return count;
  }

  function isIndependentClaim(c, idx) {
    if (!c) return false;
    if (c.type === 'independent') return true;
    if (c.type === 'dependent') return false;
    if (c.dependent_on !== undefined && c.dependent_on !== null && c.dependent_on !== '' && c.dependent_on !== false) return false;
    var text = (c.text || '').trim();
    var head = text.substring(0, 300);
    if (/^(根据|如|按照|依据).*(权利要求|权项|claim|claims)/i.test(head)) return false;
    if (/請求項\s*\d+/i.test(head)) return false;
    if (/に記載/.test(head)) return false;
    if (/のいずれか/.test(head)) return false;
    if (/前記|所述的/.test(text.substring(0, 80))) return false;
    if (/\bclaim\s+\d+/i.test(head)) return false;
    return idx === 0 ? true : false;
  }

  function getLoadedPatents() {
    return Object.assign({}, _state.loadedPatents);
  }

  function setPendingFamilyPatents(patents) {
    window._pendingComparisonPatents = patents;
  }

  function getPendingFamilyPatents() {
    var p = window._pendingComparisonPatents;
    window._pendingComparisonPatents = null;
    return p || null;
  }

  function init() {
    _state.items = [];
    _state.result = null;
    _state.isLoading = false;
    _state.loadedPatents = {};
    emit('itemsChanged', getItems());
    emit('resultCleared', null);
  }

  return {
    on: on,
    off: off,
    getState: getState,
    getItems: getItems,
    getSelectedItems: getSelectedItems,
    addItem: addItem,
    updateItem: updateItem,
    removeItem: removeItem,
    toggleItemSelected: toggleItemSelected,
    selectAll: selectAll,
    deselectAll: deselectAll,
    clearItems: clearItems,
    moveItem: moveItem,
    setMode: setMode,
    setInputMode: setInputMode,
    runComparison: runComparison,
    abort: abort,
    getResult: getResult,
    isLoading: isLoading,
    addPatentClaims: addPatentClaims,
    getLoadedPatents: getLoadedPatents,
    setPendingFamilyPatents: setPendingFamilyPatents,
    getPendingFamilyPatents: getPendingFamilyPatents,
    init: init,
    isIndependentClaim: isIndependentClaim
  };
})();

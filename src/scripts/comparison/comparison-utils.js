/*!
 * PatentLens - 智能比对模块 - 工具函数
 * Copyright (c) 2026 Alfred Shi. All rights reserved.
 * @author Alfred Shi
 * @version 260716
 */

var ComparisonUtils = (function () {
  function generateId() {
    return 'cmp_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6);
  }

  function escapeHtml(str) {
    if (!str) return '';
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function detectLanguage(text) {
    if (!text) return 'auto';
    var chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    var japaneseChars = (text.match(/[\u3040-\u309f\u30a0-\u30ff]/g) || []).length;
    var koreanChars = (text.match(/[\uac00-\ud7af]/g) || []).length;
    var total = text.length;
    if (chineseChars / total > 0.2) return 'zh';
    if (japaneseChars / total > 0.1) return 'ja';
    if (koreanChars / total > 0.1) return 'ko';
    return 'en';
  }

  function cleanText(text) {
    if (!text) return '';
    return text
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\t/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function truncateText(text, maxLen) {
    if (!text) return '';
    maxLen = maxLen || 150;
    if (text.length <= maxLen) return text;
    return text.substring(0, maxLen) + '...';
  }

  function normalizePatentNumber(input) {
    if (!input) return '';
    return input.trim().toUpperCase().replace(/[\s\/]/g, '');
  }

  function parsePatentNumbersInput(text) {
    if (!text) return [];
    return text
      .split(/[\n,;，；]/g)
      .map(function(s) { return s.trim(); })
      .filter(function(s) { return s.length > 0; });
  }

  var PATENT_SYNONYMS = {
    'comprising': ['including', 'consisting essentially of', 'containing', 'characterized by', 'comprises', 'includes', 'contains', '包括', '包含', '其特征在于'],
    'consisting of': ['composed of', 'consists of', '由...组成', '由…组成'],
    'wherein': ['where', 'in which', 'and wherein', 'characterized in that', '其中', '其特征在于'],
    'said': ['the', 'a', 'an', 'plurality of', 'at least one', '所述', '该', '上述', '前述'],
    'plurality of': ['multiple', 'a plurality of', 'two or more', 'a number of', '多个', '数个'],
    'at least one': ['one or more', 'at least one of', '至少一个', '一个或多个'],
    'coupled': ['connected', 'attached', 'joined', 'coupled to', 'connected to', '耦合', '连接', '耦接'],
    'configured to': ['adapted to', 'arranged to', 'operable to', 'constructed to', '被配置为', '用于'],
    'method': ['process', 'method of', 'process for', '方法', '工艺'],
    'apparatus': ['device', 'system', 'arrangement', '装置', '设备', '系统'],
    'and': ['以及', '和', '与', '并', '且'],
    'or': ['或者', '或'],
    'preferably': ['optionally', 'advantageously', '优选地', '可选地']
  };

  function areSynonyms(term1, term2) {
    var t1 = term1.toLowerCase().trim();
    var t2 = term2.toLowerCase().trim();
    if (t1 === t2) return true;
    for (var key in PATENT_SYNONYMS) {
      if (PATENT_SYNONYMS.hasOwnProperty(key)) {
        var list = PATENT_SYNONYMS[key];
        var all = [key].concat(list).map(function(s) { return s.toLowerCase(); });
        var i1 = all.indexOf(t1);
        var i2 = all.indexOf(t2);
        if (i1 >= 0 && i2 >= 0) return true;
      }
    }
    return false;
  }

  function getSynonymGroup(term) {
    var t = term.toLowerCase().trim();
    for (var key in PATENT_SYNONYMS) {
      if (PATENT_SYNONYMS.hasOwnProperty(key)) {
        var list = PATENT_SYNONYMS[key];
        var all = [key].concat(list);
        for (var i = 0; i < all.length; i++) {
          if (all[i].toLowerCase() === t) {
            return [key].concat(list);
          }
        }
      }
    }
    return null;
  }

  function debounce(fn, delay) {
    var timer = null;
    return function() {
      var context = this;
      var args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function() {
        fn.apply(context, args);
      }, delay || 300);
    };
  }

  return {
    generateId: generateId,
    escapeHtml: escapeHtml,
    detectLanguage: detectLanguage,
    cleanText: cleanText,
    truncateText: truncateText,
    normalizePatentNumber: normalizePatentNumber,
    parsePatentNumbersInput: parsePatentNumbersInput,
    areSynonyms: areSynonyms,
    getSynonymGroup: getSynonymGroup,
    PATENT_SYNONYMS: PATENT_SYNONYMS,
    debounce: debounce
  };
})();

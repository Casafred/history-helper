// 共享模块：专利解析逻辑（normalizePatentNumber / extractPatentFromHtml）
// 被 electron-main.js 和 server.js 同时引用。
// 修改专利解析逻辑只需修改本文件，两个入口会自动生效。

function normalizePatentNumber(input) {
  const normalized = input.toUpperCase().replace(/[\s\/]/g, "");
  const countryMatch = normalized.match(/^([A-Z]{2})(\d+[A-Z]?\d*)/);
  if (!countryMatch) return { normalized, variants: [] };
  const country = countryMatch[1];
  const rest = countryMatch[2];
  const numberMatch = rest.match(/^(\d+)([A-Z]+\d*)?$/);
  if (!numberMatch) return { normalized, variants: [] };
  const base = numberMatch[1];
  const suffix = numberMatch[2] || "";
  const variants = [];
  const basePatent = country + base;
  if (basePatent !== normalized) variants.push(basePatent);
  if (suffix) {
    const letterOnly = suffix.match(/^([A-Z]+)/);
    if (letterOnly) {
      const v = country + base + letterOnly[1];
      if (v !== normalized && !variants.includes(v)) variants.push(v);
    }
  }
  return { normalized, variants };
}

function extractPatentFromHtml(html, patentId) {
  // Strategy 1: JSON-LD
  const jsonLdMatch = html.match(/<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
  let jsonLdResult = null;
  if (jsonLdMatch) {
    try {
      const ldData = JSON.parse(jsonLdMatch[1]);
      const graph = ldData["@graph"] || [ldData];
      const patentEntry = graph.find(item => item["@type"] === "Patent");
      if (patentEntry) {
        jsonLdResult = {
          patent_number: patentId,
          title: patentEntry.name || patentEntry.title || "",
          abstract: patentEntry.abstract || "",
          url: `https://patents.google.com/patent/${patentId}`,
          application_date: "",
          publication_date: "",
          inventors: [],
          assignees: [],
          drawings: [],
          patent_citations: [],
          cited_by: [],
          classifications: [],
          claims: [],
          description: "",
          pdf_link: "",
          events_timeline: [],
          legal_events: [],
          similar_documents: [],
          family_id: "",
          family_applications: [],
          country_status: [],
          priority_date: "",
          external_links: {},
          landscapes: [],
        };
        if (patentEntry.inventor) {
          jsonLdResult.inventors = (Array.isArray(patentEntry.inventor) ? patentEntry.inventor : [patentEntry.inventor]).map(i => i.name || i).filter(n => typeof n === "string");
        }
        if (patentEntry.assignee) {
          jsonLdResult.assignees = (Array.isArray(patentEntry.assignee) ? patentEntry.assignee : [patentEntry.assignee]).map(a => a.name || a).filter(n => typeof n === "string");
        }
        if (patentEntry.filingDate) jsonLdResult.application_date = patentEntry.filingDate;
        if (patentEntry.publicationDate) jsonLdResult.publication_date = patentEntry.publicationDate;
        if (patentEntry.image) {
          const imgs = Array.isArray(patentEntry.image) ? patentEntry.image : [patentEntry.image];
          jsonLdResult.drawings = imgs.map(i => (typeof i === "string" ? i : (i.url || i.contentUrl || ""))).filter(u => u && u.startsWith("http"));
        }
      }
    } catch (e) { /* fall through to HTML parsing */ }
  }

  // Strategy 2: HTML element parsing (always run to supplement missing fields)
  const htmlResult = {
    patent_number: patentId,
    title: "",
    abstract: "",
    url: `https://patents.google.com/patent/${patentId}`,
    application_date: "",
    publication_date: "",
    inventors: [],
    assignees: [],
    drawings: [],
    patent_citations: [],
    cited_by: [],
    classifications: [],
    claims: [],
    description: "",
    pdf_link: "",
    events_timeline: [],
    legal_events: [],
    similar_documents: [],
    family_id: "",
    family_applications: [],
    country_status: [],
    priority_date: "",
    external_links: {},
    landscapes: [],
  };

  // Title
  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (titleMatch) htmlResult.title = titleMatch[1].replace(/<[^>]+>/g, "").trim();

  // Abstract
  const abstractMatch = html.match(/<section[^>]*itemprop="abstract"[^>]*>([\s\S]*?)<\/section>/i)
    || html.match(/<div[^>]*class="abstract"[^>]*>([\s\S]*?)<\/div>/i)
    || html.match(/<abstract>([\s\S]*?)<\/abstract>/i);
  if (abstractMatch) htmlResult.abstract = abstractMatch[1].replace(/<[^>]+>/g, "").trim();

  // Inventors
  const inventorMatches = html.matchAll(/<dd[^>]*itemprop="inventor"[^>]*>([\s\S]*?)<\/dd>/gi);
  for (const m of inventorMatches) {
    const name = m[1].replace(/<[^>]+>/g, "").trim();
    if (name) htmlResult.inventors.push(name);
  }

  // Assignees
  const assigneeMatches = html.matchAll(/<dd[^>]*itemprop="assignee(?:Current|Original)"[^>]*>([\s\S]*?)<\/dd>/gi);
  for (const m of assigneeMatches) {
    const name = m[1].replace(/<[^>]+>/g, "").trim();
    if (name && !htmlResult.assignees.includes(name)) htmlResult.assignees.push(name);
  }

  // Dates
  const filingMatch = html.match(/<time[^>]*itemprop="filingDate"[^>]*>([\s\S]*?)<\/time>/i);
  if (filingMatch) htmlResult.application_date = filingMatch[1].replace(/<[^>]+>/g, "").trim();
  const pubMatch = html.match(/<time[^>]*itemprop="publicationDate"[^>]*>([\s\S]*?)<\/time>/i);
  if (pubMatch) htmlResult.publication_date = pubMatch[1].replace(/<[^>]+>/g, "").trim();

  // Drawings - itemprop="images"
  const imageMatches = html.matchAll(/<li[^>]*itemprop="images"[^>]*>([\s\S]*?)<\/li>/gi);
  for (const m of imageMatches) {
    const fullMeta = m[1].match(/<meta[^>]*itemprop="full"[^>]*content="([^"]+)"/);
    if (fullMeta && fullMeta[1].startsWith("http")) {
      htmlResult.drawings.push(fullMeta[1]);
    } else {
      const thumbImg = m[1].match(/<img[^>]*itemprop="thumbnail"[^>]*src="([^"]+)"/);
      if (thumbImg) {
        let url = thumbImg[1];
        if (url.startsWith("//")) url = "https:" + url;
        if (url.startsWith("http")) htmlResult.drawings.push(url);
      }
    }
  }

  // Helper: extract citation fields from a <tr> row, supporting both old class-based
  // and new itemprop-based Google Patents HTML formats
  function extractCitationRow(row) {
    // Patent number: try href link, then itemprop="publicationNumber"
    let patentNumber = "";
    const numMatch = row.match(/<a[^>]*href="\/patent\/([^"]+)"[^>]*>/);
    if (numMatch) {
      patentNumber = numMatch[1].replace(/<[^>]+>/g, "").trim();
      // Remove language suffix from href like "WO2017147208A1/en" -> "WO2017147208A1"
      patentNumber = patentNumber.replace(/\/[a-z]{2}$/, '');
    } else {
      const pubNumMatch = row.match(/itemprop="publicationNumber"[^>]*>([\s\S]*?)<\/span>/i);
      if (pubNumMatch) patentNumber = pubNumMatch[1].replace(/<[^>]+>/g, "").trim();
    }
    if (!patentNumber) return null;

    // Title: try class="patent-title", then itemprop="title"
    let title = "";
    const titleByClass = row.match(/<td[^>]*class="patent-title[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    if (titleByClass) {
      title = titleByClass[1].replace(/<[^>]+>/g, "").trim();
    } else {
      const titleByItemprop = row.match(/<td[^>]*itemprop="title"[^>]*>([\s\S]*?)<\/td>/i);
      if (titleByItemprop) title = titleByItemprop[1].replace(/<[^>]+>/g, "").trim();
    }

    // Publication date: try <time>, then itemprop="publicationDate" on <td>
    let pubDate = "";
    const pubDateByTime = row.match(/<time[^>]*>([\s\S]*?)<\/time>/i);
    if (pubDateByTime) {
      pubDate = pubDateByTime[1].replace(/<[^>]+>/g, "").trim();
    } else {
      const pubDateByItemprop = row.match(/<td[^>]*itemprop="publicationDate"[^>]*>([\s\S]*?)<\/td>/i);
      if (pubDateByItemprop) pubDate = pubDateByItemprop[1].replace(/<[^>]+>/g, "").trim();
    }

    // Assignee: try class="patent-assignee", then itemprop="assigneeOriginal"
    let assignee = "";
    const assigneeByClass = row.match(/<td[^>]*class="patent-assignee[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    if (assigneeByClass) {
      assignee = assigneeByClass[1].replace(/<[^>]+>/g, "").trim();
    } else {
      const assigneeByItemprop = row.match(/itemprop="assigneeOriginal"[^>]*>([\s\S]*?)<\/span>/i);
      if (assigneeByItemprop) assignee = assigneeByItemprop[1].replace(/<[^>]+>/g, "").trim();
    }

    // Priority date: try <time itemprop="priorityDate">, then <td itemprop="priorityDate">
    let priorityDate = "";
    const priorityByTime = row.match(/<time[^>]*itemprop="priorityDate"[^>]*>([\s\S]*?)<\/time>/i);
    if (priorityByTime) {
      priorityDate = priorityByTime[1].replace(/<[^>]+>/g, "").trim();
    } else {
      const priorityByTd = row.match(/<td[^>]*itemprop="priorityDate"[^>]*>([\s\S]*?)<\/td>/i);
      if (priorityByTd) priorityDate = priorityByTd[1].replace(/<[^>]+>/g, "").trim();
    }

    return { patent_number: patentNumber, title, publication_date: pubDate, assignee, priority_date: priorityDate };
  }

  // Patent citations (backward references)
  // backwardReferencesOrig = examiner citations (marked with * in Google Patents)
  const citationMatches = html.matchAll(/<tr[^>]*itemprop="backwardReferencesOrig"[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const m of citationMatches) {
    const row = m[1];
    const extracted = extractCitationRow(row);
    if (extracted) {
      const hasStar = /\*/.test(row.replace(/<[^>]+>/g, ""));
      const entry = {
        ...extracted,
        link: "https://patents.google.com/patent/" + extracted.patent_number,
        citation_type: hasStar ? "examiner" : "applicant",
      };
      if (!extracted.priority_date) delete entry.priority_date;
      htmlResult.patent_citations.push(entry);
    }
  }
  // backwardReferencesFamily = family-level citations (typically applicant)
  const citationFamilyMatches = html.matchAll(/<tr[^>]*itemprop="backwardReferencesFamily"[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const m of citationFamilyMatches) {
    const row = m[1];
    const extracted = extractCitationRow(row);
    if (extracted) {
      const pn = extracted.patent_number;
      if (!htmlResult.patent_citations.find(c => c.patent_number === pn)) {
        const entry = {
          ...extracted,
          link: "https://patents.google.com/patent/" + pn,
          citation_type: "applicant",
        };
        if (!extracted.priority_date) delete entry.priority_date;
        htmlResult.patent_citations.push(entry);
      }
    }
  }

  // CPC Classifications
  const classMatches = html.matchAll(/<li[^>]*itemprop="classifications"[^>]*>([\s\S]*?)<\/li>/gi);
  for (const m of classMatches) {
    const row = m[1];
    const codeMatch = row.match(/<span[^>]*class="classification-code[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const descMatch = row.match(/<span[^>]*class="classification-desc[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    if (codeMatch) {
      htmlResult.classifications.push({
        code: codeMatch[1].replace(/<[^>]+>/g, "").trim(),
        description: descMatch ? descMatch[1].replace(/<[^>]+>/g, "").trim() : "",
      });
    }
  }

  // Claims - extract from section itemprop="claims"
  const claimsSection = html.match(/<section[^>]*itemprop="claims"[^>]*>([\s\S]*?)<\/section>/i)
    || html.match(/<div[^>]*class="claims"[^>]*>([\s\S]*?)<\/div>/i);
  if (claimsSection) {
    const claimsHtml = claimsSection[1];

    // Helper: find matching closing tag for an opening div at given position
    // Returns the index of the closing </div> that matches, or -1
    function findMatchingCloseDiv(html, openStart) {
      let depth = 0;
      let i = openStart;
      while (i < html.length) {
        const openIdx = html.indexOf("<div", i);
        const closeIdx = html.indexOf("</div>", i);
        if (closeIdx === -1) return -1;
        if (openIdx !== -1 && openIdx < closeIdx) {
          // Check it's a real div tag (not e.g. <divider)
          const ch = html.charCodeAt(openIdx + 4);
          if (ch === 32 || ch === 62 || ch === 47 || ch === 10 || ch === 9) {
            depth++;
            i = openIdx + 4;
            continue;
          }
        }
        depth--;
        if (depth === 0) return closeIdx;
        i = closeIdx + 6;
      }
      return -1;
    }

    // Strategy 1: Extract from <div class="claim..." num="N"> or <div num="N" class="claim...">
    function extractDivClaims(html) {
      // First pass: collect all claim fragments, grouped by num
      // wrapperType: 'independent' if inside <div class="claim">, 'dependent' if inside <div class="claim-dependent">, null if unknown
      const claimMap = new Map(); // num -> { texts: [], wrapperType: null|'independent'|'dependent' }
      const claimStartRegex = /<div([^>]*?)>/gi;
      let m;
      while ((m = claimStartRegex.exec(html)) !== null) {
        const attrs = m[1];
        const classMatch = attrs.match(/class="([^"]*)"/i);
        const numMatch = attrs.match(/num="(\d+)"/i);
        if (!classMatch || !numMatch) continue;
        const className = classMatch[1];
        // Only match top-level claim divs: class contains "claim" or "claim-dependent" as standalone words
        // Exclude sub-element classes: claim-text, claim-line, claim-ref, etc.
        const hasClaimClass = /(?:^|\s)claim(?:\s|$)/.test(className);
        const hasDependentClass = /(?:^|\s)claim-dependent(?:\s|$)/.test(className);
        if (!hasClaimClass && !hasDependentClass) continue;
        const claimNum = numMatch[1];
        // Detect parent wrapper class: <div class="claim"> = independent, <div class="claim-dependent"> = dependent
        // The outer wrapper is the MOST RELIABLE indicator of independent/dependent status.
        // For Chinese patents: <div class="claim"><div num="1" class="claim"> = independent
        //                      <div class="claim-dependent"><div num="2" class="claim"> = dependent
        let wrapperType = null; // null = no wrapper info found
        const beforeTag = html.substring(0, m.index);
        // Find ALL <div ...> opening tags before current position and classify them.
        // We distinguish wrappers (no num attribute) from inner claim divs (have num attribute).
        let insideDependentWrapper = false;
        let insideIndependentWrapper = false;
        const allDivBefore = [...beforeTag.matchAll(/<div([^>]*?)>/gi)];
        for (let di = allDivBefore.length - 1; di >= 0; di--) {
          const divAttrs = allDivBefore[di][1];
          const divClassMatch = divAttrs.match(/class="([^"]*)"/i);
          if (!divClassMatch) continue;
          const divClass = divClassMatch[1];
          // Only consider divs that have "claim" or "claim-dependent" as standalone word in class
          const hasClaimWord = /(?:^|\s)claim(?:\s|$)/.test(divClass);
          const hasDependentWord = /(?:^|\s)claim-dependent(?:\s|$)/.test(divClass);
          if (!hasClaimWord && !hasDependentWord) continue;
          // Skip inner claim divs (they have num attribute; wrappers don't)
          if (/num="/i.test(divAttrs)) continue;
          // Check if this wrapper div is still open (unclosed)
          const afterDiv = beforeTag.substring(allDivBefore[di].index + allDivBefore[di][0].length);
          const openCount = (afterDiv.match(/<div[\s>]/gi) || []).length;
          const closeCount = (afterDiv.match(/<\/div>/gi) || []).length;
          if (openCount < closeCount) continue; // already closed
          // Found an unclosed wrapper
          if (hasDependentWord) {
            insideDependentWrapper = true;
            break;
          } else if (hasClaimWord) {
            insideIndependentWrapper = true;
            break;
          }
        }
        if (insideDependentWrapper) wrapperType = 'dependent';
        else if (insideIndependentWrapper) wrapperType = 'independent';
        // Also check if the div itself has claim-dependent class
        if (hasDependentClass) wrapperType = 'dependent';
        const openTagEnd = m.index + m[0].length;
        const closeIdx = findMatchingCloseDiv(html, m.index);
        if (closeIdx === -1) continue;
        const claimBody = html.substring(openTagEnd, closeIdx);
        // Clean HTML
        let claimText = claimBody
          .replace(/<br\s*\/?>/gi, " ")
          .replace(/<\/div>/gi, " ")
          .replace(/<claim-ref[^>]*>/gi, " ")
          .replace(/<[^>]+>/g, "")
          .replace(/&nbsp;/gi, " ")
          .replace(/&amp;/gi, "&")
          .replace(/&lt;/gi, "<")
          .replace(/&gt;/gi, ">")
          .replace(/\s+/g, " ")
          .trim();
        if (claimText.length < 1) continue;
        if (!claimMap.has(claimNum)) {
          claimMap.set(claimNum, { texts: [], wrapperType: null });
        }
        const entry = claimMap.get(claimNum);
        entry.texts.push(claimText);
        // wrapperType: 'dependent' always wins; 'independent' only if not already set to 'dependent'
        if (wrapperType === 'dependent') entry.wrapperType = 'dependent';
        else if (wrapperType === 'independent' && entry.wrapperType !== 'dependent') entry.wrapperType = 'independent';
      }
      // Second pass: merge fragments of the same claim number
      const claims = [];
      for (const [num, entry] of claimMap) {
        const fullText = entry.texts.join(" ").replace(/\s+/g, " ").trim();
        if (fullText.length < 3) continue;
        // Determine dependent/independent:
        // Priority 1: wrapper class (most reliable) — <div class="claim"> = independent, <div class="claim-dependent"> = dependent
        // Priority 2: text-based detection (fallback when no wrapper info)
        let isDependent;
        if (entry.wrapperType === 'dependent') {
          isDependent = true;
        } else if (entry.wrapperType === 'independent') {
          isDependent = false;
        } else {
          // No wrapper info, use text-based detection
          isDependent = /claim\s*\d+/i.test(fullText.substring(0, 200))
            || fullText.includes('根据权利要求')
            || fullText.includes('根據權利要求')
            || /所述的/.test(fullText.substring(0, 80));
        }
        claims.push({ num, text: fullText, type: isDependent ? "dependent" : "independent" });
      }
      // Sort by claim number
      claims.sort((a, b) => parseInt(a.num) - parseInt(b.num));
      return claims;
    }

    // Strategy 2: Extract from <li class="claim"> / <li class="claim-dependent">
    function extractLiClaims(html) {
      const claimMap = new Map();
      const claimMatches = html.matchAll(/<li[^>]*class="claim(?:-dependent)?[^"]*"[^>]*>([\s\S]*?)<\/li>/gi);
      for (const cm of claimMatches) {
        const claimBody = cm[1];
        const isDependent = cm[0].includes('claim-dependent');
        let claimText = claimBody
          .replace(/<br\s*\/?>/gi, " ")
          .replace(/<\/div>/gi, " ")
          .replace(/<claim-ref[^>]*>/gi, " ")
          .replace(/<[^>]+>/g, "")
          .replace(/&nbsp;/gi, " ")
          .replace(/&amp;/gi, "&")
          .replace(/&lt;/gi, "<")
          .replace(/&gt;/gi, ">")
          .replace(/\s+/g, " ")
          .trim();
        const numMatch = cm[0].match(/num="(\d+)"/);
        const claimNum = numMatch ? numMatch[1] : "";
        if (claimText.length < 1) continue;
        if (!claimMap.has(claimNum)) {
          claimMap.set(claimNum, { texts: [], isDependentByClass: false });
        }
        const entry = claimMap.get(claimNum);
        entry.texts.push(claimText);
        if (isDependent) entry.isDependentByClass = true;
      }
      const claims = [];
      for (const [num, entry] of claimMap) {
        const fullText = entry.texts.join(" ").replace(/\s+/g, " ").trim();
        if (fullText.length < 3) continue;
        const isDep = entry.isDependentByClass || /claim\s*\d+/i.test(fullText.substring(0, 200)) || fullText.includes('根据权利要求');
        claims.push({ num, text: fullText, type: isDep ? "dependent" : "independent" });
      }
      claims.sort((a, b) => parseInt(a.num) - parseInt(b.num));
      return claims;
    }

    // Strategy 3: Extract from claim-text divs (some pages use <div class="claim-text">)
    function extractClaimTextDivs(html) {
      const claimMap = new Map();
      const claimTextMatches = html.matchAll(/<div[^>]*class="claim-text"[^>]*>([\s\S]*?)<\/div>/gi);
      for (const cm of claimTextMatches) {
        let claimText = cm[1]
          .replace(/<br\s*\/?>/gi, " ")
          .replace(/<[^>]+>/g, "")
          .replace(/&nbsp;/gi, " ")
          .replace(/\s+/g, " ")
          .trim();
        // Try to find claim number from parent context
        const parentContext = html.substring(Math.max(0, cm.index - 200), cm.index);
        const numMatch = parentContext.match(/num="(\d+)"/);
        const claimNum = numMatch ? numMatch[1] : "";
        if (claimText.length < 1) continue;
        if (!claimMap.has(claimNum)) {
          claimMap.set(claimNum, { texts: [] });
        }
        claimMap.get(claimNum).texts.push(claimText);
      }
      const claims = [];
      for (const [num, entry] of claimMap) {
        const fullText = entry.texts.join(" ").replace(/\s+/g, " ").trim();
        if (fullText.length < 3) continue;
        const isDep = /claim\s*\d+/i.test(fullText.substring(0, 200)) || fullText.includes('根据权利要求');
        claims.push({ num, text: fullText, type: isDep ? "dependent" : "independent" });
      }
      claims.sort((a, b) => parseInt(a.num) - parseInt(b.num));
      return claims;
    }

    // Try all strategies, pick the best one
    // Prefer the strategy with the most reasonable claim count (not too many fragments)
    // After merging by num, the strategy with fewer but longer claims is better
    const divClaims = extractDivClaims(claimsHtml);
    const liClaims = extractLiClaims(claimsHtml);
    const claimTextDivs = extractClaimTextDivs(claimsHtml);

    function avgTextLength(claims) {
      if (claims.length === 0) return 0;
      return claims.reduce((sum, c) => sum + c.text.length, 0) / claims.length;
    }

    const candidates = [
      { claims: divClaims, name: 'divClaims' },
      { claims: liClaims, name: 'liClaims' },
      { claims: claimTextDivs, name: 'claimTextDivs' },
    ].filter(c => c.claims.length > 0);

    if (candidates.length > 0) {
      // Pick the candidate with highest average text length (most complete claims)
      candidates.sort((a, b) => avgTextLength(b.claims) - avgTextLength(a.claims));
      htmlResult.claims = candidates[0].claims;
    }

    // Post-processing: merge fragmented claims
    // Google Patents sometimes uses flat divs where each line is a separate <div class="claim" num="N">
    // with sequential line numbers (not claim numbers). In this case, claims whose text doesn't start
    // with a claim number prefix (e.g., "9.") are continuations of the preceding claim.
    // IMPORTANT: Only merge when there's evidence of fragmentation (e.g., duplicate num values
    // or very short claim texts). If claims are already properly grouped by num, skip merging.
    const needsMerge = htmlResult.claims.length > 1 && (
      // Check for duplicate num values (fragmentation indicator)
      new Set(htmlResult.claims.map(c => c.num)).size < htmlResult.claims.length ||
      // Check for very short claims (< 20 chars) that look like fragments
      htmlResult.claims.some(c => c.text.length < 20)
    );
    if (needsMerge) {
      const merged = [];
      let current = null;
      for (const claim of htmlResult.claims) {
        // Check if this claim starts with a claim number prefix like "9." or "10."
        // Support both "9. " (with space) and "9.中文" (without space after period)
        const prefixMatch = claim.text.match(/^(\d+)\.[\s\u4e00-\u9fff\w]/);
        if (prefixMatch) {
          // Start of a new claim - use the text prefix as the actual claim number
          if (current) merged.push(current);
          current = { ...claim, num: prefixMatch[1] };
        } else if (current) {
          // Continuation of the current claim (no number prefix)
          current.text = (current.text + " " + claim.text).replace(/\s+/g, " ").trim();
          // If continuation comes from a dependent class, mark the whole claim as dependent
          if (claim.type === "dependent") current.type = "dependent";
        } else {
          // No preceding claim to merge with, keep as standalone
          current = { ...claim };
        }
      }
      if (current) merged.push(current);
      // Deduplicate by claim number: if same num appears multiple times, keep the longest text
      const dedupMap = new Map();
      for (const claim of merged) {
        if (!dedupMap.has(claim.num) || dedupMap.get(claim.num).text.length < claim.text.length) {
          dedupMap.set(claim.num, claim);
        }
      }
      htmlResult.claims = Array.from(dedupMap.values());
      htmlResult.claims.sort((a, b) => parseInt(a.num) - parseInt(b.num));
    }

    // Last resort: extract claims by number pattern in plain text
    if (htmlResult.claims.length === 0) {
      const textContent = claimsHtml
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<\/div>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/\s+/g, " ");
      const claimNumRegex = /(?:^|\s)(\d+)\.\s*((?:(?!\s+\d+\.\s)[\s\S])+)/gm;
      let cm;
      while ((cm = claimNumRegex.exec(textContent)) !== null) {
        const claimNum = cm[1];
        let claimText = cm[2].trim();
        if (claimText && claimText.length > 5) {
          const isDep = /claim\s*\d+/i.test(claimText.substring(0, 150)) || claimText.includes('根据权利要求');
          htmlResult.claims.push({ num: claimNum, text: claimText, type: isDep ? "dependent" : "independent" });
        }
      }
    }
  }

  // Description
  const descSection = html.match(/<section[^>]*itemprop="description"[^>]*>([\s\S]*?)<\/section>/i)
    || html.match(/<div[^>]*class="description"[^>]*>([\s\S]*?)<\/div>/i);
  if (descSection) {
    let descHtml = descSection[1];
    // Try to extract from ul.description structure (Google Patents format)
    const ulDesc = descHtml.match(/<ul[^>]*class="description"[^>]*>([\s\S]*?)<\/ul>/i);
    if (ulDesc) {
      // Process headings and list items
      let parts = ulDesc[1].replace(/<heading[^>]*>([\s\S]*?)<\/heading>/gi, '\n\n## $1\n');
      parts = parts.replace(/<\/li>/gi, '\n');
      parts = parts.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      htmlResult.description = parts;
    } else {
      // Try description-paragraph divs
      // Semantic HTML tags (<technical-field>, <background-art>, <disclosure>, etc.) are the
      // most reliable section boundary markers. We extract each semantic tag's content
      // and process its paragraphs, marking the first one as a ## heading.
      const semanticTags = [
        'technical-field', 'background-art', 'disclosure',
        'description-of-drawings', 'best-mode', 'mode-for-invention',
        'embodiment', 'description-of-embodiments',
        'industrial-applicability', 'sequence-list',
      ];

      // Build ranges [start, end) in descHtml for each semantic tag occurrence
      const semanticRanges = [];
      for (const tag of semanticTags) {
        const tagRegex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
        let tagMatch;
        while ((tagMatch = tagRegex.exec(descHtml)) !== null) {
          // tagMatch.index is the start of the opening tag
          // The content starts after the opening tag
          const contentStart = tagMatch.index + tagMatch[0].indexOf('>') + 1;
          const contentEnd = tagMatch.index + tagMatch[0].length - (`</${tag}>`).length;
          semanticRanges.push({ start: tagMatch.index, contentStart, contentEnd, end: tagMatch.index + tagMatch[0].length, tag });
        }
      }

      const paraMatches = [...descHtml.matchAll(/<div[^>]*class="description-paragraph"[^>]*>([\s\S]*?)<\/div>/gi)];

      // For each semantic tag, find which paragraph is the first one inside it
      const firstParaInSemantic = new Set(); // stores pm.index values
      for (const range of semanticRanges) {
        for (const pm of paraMatches) {
          // pm.index is the start of the <div> opening tag
          if (pm.index >= range.contentStart && pm.index < range.contentEnd) {
            firstParaInSemantic.add(pm.index);
            break; // only the first paragraph in each semantic tag
          }
        }
      }

      const paragraphs = [];
      for (const pm of paraMatches) {
        let pText = pm[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        if (!pText) continue;
        // If this paragraph is the first one inside a semantic tag, mark it as a heading
        if (firstParaInSemantic.has(pm.index)) {
          if (!pText.startsWith('## ')) pText = '## ' + pText;
        }
        paragraphs.push(pText);
      }
      if (paragraphs.length > 0) {
        // Fallback: detect common Chinese/English section heading patterns in paragraph text
        // and prefix them with ## if not already marked. This catches headings that don't
        // have semantic tag wrappers (e.g., some Google Patents formats).
        const sectionHeadingPatterns = [
          /^技术领域$/, /^背景技术$/, /^发明内容$/, /^附图说明$/,
          /^具体实施方式$/, /^具体实施例$/, /^实施方式$/, /^实施例$/, /^工业应用性$/,
          /^TECHNICAL FIELD$/i, /^BACKGROUND$/i, /^BACKGROUND OF THE INVENTION$/i,
          /^SUMMARY$/i, /^SUMMARY OF THE INVENTION$/i,
          /^DETAILED DESCRIPTION$/i, /^DETAILED DESCRIPTION OF(?: THE)? (?:PREFERRED)?(?: EMBODIMENTS?)?$/i,
          /^DRAWINGS$/i, /^BRIEF DESCRIPTION OF (?:THE )?DRAWINGS$/i,
          /^EMBODIMENTS?$/i, /^DESCRIPTION OF EMBODIMENTS?$/i,
        ];
        const processedParagraphs = paragraphs.map(p => {
          if (p.startsWith('## ')) return p;
          for (const pattern of sectionHeadingPatterns) {
            if (pattern.test(p)) return '## ' + p;
          }
          return p;
        });
        htmlResult.description = processedParagraphs.join('\n\n');
      } else {
        htmlResult.description = descHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      }
    }
  }

  // PDF link
  const pdfMatch = html.match(/<a[^>]*itemprop="pdfLink"[^>]*href="([^"]+)"[^>]*>/i)
    || html.match(/<a[^>]*href="([^"]*patentimages[^"]*\.pdf)"[^>]*>/i)
    || html.match(/<a[^>]*href="([^"]*)"[^>]*>.*?PDF.*?<\/a>/i);
  if (pdfMatch) htmlResult.pdf_link = pdfMatch[1];

  // Events timeline - extract from application events
  const eventRows = html.matchAll(/<tr[^>]*itemprop="applicationEvents"[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const er of eventRows) {
    const row = er[1];
    const dateMatch = row.match(/<time[^>]*>([\s\S]*?)<\/time>/i);
    const titleMatch = row.match(/<td[^>]*class="event-desc[^"]*"[^>]*>([\s\S]*?)<\/td>/i)
      || row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi);
    if (dateMatch) {
      htmlResult.events_timeline.push({
        date: dateMatch[1].replace(/<[^>]+>/g, "").trim(),
        title: titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : ""
      });
    }
  }
  // Also try legal events from table
  const legalRows = html.matchAll(/<tr[^>]*itemprop="legalEvents"[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const lr of legalRows) {
    const row = lr[1];
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)];
    if (cells.length >= 2) {
      htmlResult.legal_events.push({
        date: cells[0][1].replace(/<[^>]+>/g, "").trim(),
        code: cells.length >= 3 ? cells[1][1].replace(/<[^>]+>/g, "").trim() : "",
        description: cells[cells.length >= 3 ? 2 : 1][1].replace(/<[^>]+>/g, "").trim()
      });
    }
  }

  // Priority date
  const priorityMatch = html.match(/<time[^>]*itemprop="priorityDate"[^>]*>([\s\S]*?)<\/time>/i);
  if (priorityMatch) htmlResult.priority_date = priorityMatch[1].replace(/<[^>]+>/g, "").trim();
  // Also try datetime attribute
  if (!htmlResult.priority_date) {
    const priorityDt = html.match(/<time[^>]*itemprop="priorityDate"[^>]*datetime="([^"]+)"/i);
    if (priorityDt) htmlResult.priority_date = priorityDt[1];
  }

  // Cited by (forward references)
  const citedByMatches = html.matchAll(/<tr[^>]*itemprop="forwardReferencesOrig"[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const m of citedByMatches) {
    const row = m[1];
    const extracted = extractCitationRow(row);
    if (extracted) {
      const entry = {
        ...extracted,
        link: "https://patents.google.com/patent/" + extracted.patent_number,
      };
      if (!extracted.priority_date) delete entry.priority_date;
      htmlResult.cited_by.push(entry);
    }
  }
  // Also try forwardReferencesFamily
  const citedByFamilyMatches = html.matchAll(/<tr[^>]*itemprop="forwardReferencesFamily"[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const m of citedByFamilyMatches) {
    const row = m[1];
    const extracted = extractCitationRow(row);
    if (extracted) {
      const pn = extracted.patent_number;
      // Avoid duplicates
      if (!htmlResult.cited_by.find(c => c.patent_number === pn)) {
        const entry = {
          ...extracted,
          link: "https://patents.google.com/patent/" + pn,
        };
        if (!extracted.priority_date) delete entry.priority_date;
        htmlResult.cited_by.push(entry);
      }
    }
  }

  // Similar documents
  const similarMatches = html.matchAll(/<tr[^>]*itemprop="similarDocuments"[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const m of similarMatches) {
    const row = m[1];
    const numMatch = row.match(/<a[^>]*href="\/patent\/([^"]+)"[^>]*>/);
    if (numMatch) {
      htmlResult.similar_documents.push({
        patent_number: numMatch[1].replace(/<[^>]+>/g, "").trim(),
        link: "https://patents.google.com/patent/" + numMatch[1].replace(/<[^>]+>/g, "").trim(),
      });
    }
  }

  // Family ID
  const familyIdMatch = html.match(/ID=(\d+)/i);
  if (familyIdMatch) htmlResult.family_id = familyIdMatch[1];

  // Family applications
  const familyAppMatches = html.matchAll(/<tr[^>]*itemprop="applications"[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const m of familyAppMatches) {
    const row = m[1];
    const numMatch = row.match(/<a[^>]*href="\/patent\/([^"]+)"[^>]*>/);
    const titleMatch2 = row.match(/<td[^>]*class="patent-title[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    const statusMatch = row.match(/<td[^>]*class="patent-status[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    if (numMatch) {
      htmlResult.family_applications.push({
        publication_number: numMatch[1].replace(/<[^>]+>/g, "").trim(),
        title: titleMatch2 ? titleMatch2[1].replace(/<[^>]+>/g, "").trim() : "",
        status: statusMatch ? statusMatch[1].replace(/<[^>]+>/g, "").trim() : "",
        link: "https://patents.google.com/patent/" + numMatch[1].replace(/<[^>]+>/g, "").trim(),
      });
    }
  }
  // Also try docdbFamily (Also Published As)
  const docdbMatches = html.matchAll(/<tr[^>]*itemprop="docdbFamily"[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const m of docdbMatches) {
    const row = m[1];
    const numMatch = row.match(/<a[^>]*href="\/patent\/([^"]+)"[^>]*>/);
    if (numMatch) {
      const pn = numMatch[1].replace(/<[^>]+>/g, "").trim();
      if (!htmlResult.family_applications.find(f => f.publication_number === pn)) {
        htmlResult.family_applications.push({
          publication_number: pn,
          link: "https://patents.google.com/patent/" + pn,
        });
      }
    }
  }

  // Country status
  const countryMatches = html.matchAll(/<tr[^>]*itemprop="countryStatus"[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const m of countryMatches) {
    const row = m[1];
    const countryMatch = row.match(/<td[^>]*>([\s\S]*?)<\/td>/i);
    const numMatch = row.match(/<a[^>]*href="\/patent\/([^"]+)"[^>]*>/);
    if (countryMatch) {
      const cc = countryMatch[1].replace(/<[^>]+>/g, "").trim();
      htmlResult.country_status.push({
        country_code: cc,
        publication_number: numMatch ? numMatch[1].replace(/<[^>]+>/g, "").trim() : "",
        link: numMatch ? "https://patents.google.com/patent/" + numMatch[1].replace(/<[^>]+>/g, "").trim() : "",
      });
    }
  }

  // External links
  const linkMatches = html.matchAll(/<li[^>]*itemprop="links"[^>]*>([\s\S]*?)<\/li>/gi);
  for (const m of linkMatches) {
    const row = m[1];
    const idMatch = row.match(/<meta[^>]*itemprop="id"[^>]*content="([^"]+)"/i);
    const urlMatch = row.match(/<a[^>]*itemprop="url"[^>]*href="([^"]+)"/i);
    const textMatch = row.match(/<span[^>]*itemprop="text"[^>]*>([\s\S]*?)<\/span>/i);
    if (idMatch) {
      htmlResult.external_links[idMatch[1]] = {
        text: textMatch ? textMatch[1].replace(/<[^>]+>/g, "").trim() : idMatch[1],
        url: urlMatch ? urlMatch[1] : "",
      };
    }
  }

  // Landscapes (technical fields)
  const landscapeMatches = html.matchAll(/<li[^>]*itemprop="landscapes"[^>]*>([\s\S]*?)<\/li>/gi);
  for (const m of landscapeMatches) {
    const row = m[1];
    const nameMatch = row.match(/<span[^>]*itemprop="name"[^>]*>([\s\S]*?)<\/span>/i);
    if (nameMatch) {
      htmlResult.landscapes.push({
        name: nameMatch[1].replace(/<[^>]+>/g, "").trim(),
      });
    }
  }

  // Merge: JSON-LD takes priority for core fields, HTML supplements missing fields
  if (jsonLdResult) {
    // Use JSON-LD for core fields (title, abstract, inventors, assignees, dates, drawings)
    // but supplement with HTML-parsed classifications and citations
    if (htmlResult.classifications.length > 0) jsonLdResult.classifications = htmlResult.classifications;
    if (htmlResult.patent_citations.length > 0) jsonLdResult.patent_citations = htmlResult.patent_citations;
    // Supplement any missing core fields from HTML
    if (!jsonLdResult.title && htmlResult.title) jsonLdResult.title = htmlResult.title;
    if (!jsonLdResult.abstract && htmlResult.abstract) jsonLdResult.abstract = htmlResult.abstract;
    if (!jsonLdResult.application_date && htmlResult.application_date) jsonLdResult.application_date = htmlResult.application_date;
    if (!jsonLdResult.publication_date && htmlResult.publication_date) jsonLdResult.publication_date = htmlResult.publication_date;
    if (jsonLdResult.inventors.length === 0 && htmlResult.inventors.length > 0) jsonLdResult.inventors = htmlResult.inventors;
    if (jsonLdResult.assignees.length === 0 && htmlResult.assignees.length > 0) jsonLdResult.assignees = htmlResult.assignees;
    if (jsonLdResult.drawings.length === 0 && htmlResult.drawings.length > 0) jsonLdResult.drawings = htmlResult.drawings;
    if (htmlResult.claims.length > 0) jsonLdResult.claims = htmlResult.claims;
    if (htmlResult.description) jsonLdResult.description = htmlResult.description;
    if (htmlResult.pdf_link) jsonLdResult.pdf_link = htmlResult.pdf_link;
    if (htmlResult.events_timeline.length > 0) jsonLdResult.events_timeline = htmlResult.events_timeline;
    if (htmlResult.legal_events.length > 0) jsonLdResult.legal_events = htmlResult.legal_events;
    if (htmlResult.priority_date) jsonLdResult.priority_date = htmlResult.priority_date;
    if (htmlResult.cited_by.length > 0) jsonLdResult.cited_by = htmlResult.cited_by;
    if (htmlResult.similar_documents.length > 0) jsonLdResult.similar_documents = htmlResult.similar_documents;
    if (htmlResult.family_id) jsonLdResult.family_id = htmlResult.family_id;
    if (htmlResult.family_applications.length > 0) jsonLdResult.family_applications = htmlResult.family_applications;
    if (htmlResult.country_status.length > 0) jsonLdResult.country_status = htmlResult.country_status;
    if (Object.keys(htmlResult.external_links).length > 0) jsonLdResult.external_links = htmlResult.external_links;
    if (htmlResult.landscapes.length > 0) jsonLdResult.landscapes = htmlResult.landscapes;
    return jsonLdResult;
  }

  return htmlResult;
}

module.exports = { normalizePatentNumber, extractPatentFromHtml };

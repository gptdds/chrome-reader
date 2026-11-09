(() => {
  'use strict';

  // This object lives in the extension's isolated world, not in the page world.
  if (window.__xiaoxiaoReader) return;
  const LIMIT = 200000;
  const NAME = 'xiaoxiao-current';
  const UI = 'data-xiaoxiao-reader-ui';
  const OMIT = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'NAV', 'HEADER',
    'FOOTER', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'SVG', 'CANVAS',
    'IFRAME', 'OBJECT', 'EMBED', 'DIALOG']);
  const PARAGRAPH = /^(P|LI|BLOCKQUOTE|PRE|H[1-6]|DT|DD|TD|TH|FIGCAPTION|ADDRESS|SUMMARY)$/;
  const BLOCK = /^(block|list-item|table-cell|flow-root|flex|grid)$/;
  let snapshot = null;
  let active = null;
  let styleElement = null;
  let highlightSheet = null;
  let overlay = null;
  let overlayRoot = null;
  let renderer = null;
  let epoch = 0;
  let frame = 0;
  let lastFollowTime = -Infinity;
  let followTimer = null;
  let followTarget = null;
  let sequence = 0;
  let resizeObserver = null;
  let observedBlock = null;

  function ownElement(element) {
    return !!element?.closest?.(`[${UI}]`);
  }

  function visibleElement(element, cache) {
    if (!element) return true;
    if (cache.has(element)) return cache.get(element);
    let visible = !OMIT.has(element.tagName) && !ownElement(element) &&
      !element.hidden && !element.inert && element.getAttribute('aria-hidden') !== 'true' &&
      !element.isContentEditable &&
      !(element.hasAttribute('contenteditable') && element.getAttribute('contenteditable') !== 'false');
    if (visible) {
      const css = getComputedStyle(element);
      visible = css.display !== 'none' && css.visibility !== 'hidden' &&
        css.visibility !== 'collapse' && css.contentVisibility !== 'hidden' && Number(css.opacity) !== 0;
    }
    if (visible) visible = visibleElement(element.parentElement, cache);
    cache.set(element, visible);
    return visible;
  }

  function paragraphFor(node, cache) {
    let fallback = null;
    for (let element = node.parentElement; element; element = element.parentElement) {
      if (/^(BODY|HTML|ARTICLE|MAIN)$/.test(element.tagName)) break;
      if (PARAGRAPH.test(element.tagName)) return element;
      if (!fallback && BLOCK.test(getComputedStyle(element).display)) fallback = element;
    }
    // A nearest block is useful for sites built entirely out of divs. Never use
    // article/main/body as a paragraph, even when the capture root is one of them.
    return fallback;
  }

  function rectsOf(range) {
    return Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0);
  }

  function rawRange(node, start, end) {
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    return range;
  }

  function codePointStart(text, index) {
    if (index > 0 && index < text.length && /[\uDC00-\uDFFF]/.test(text[index]) &&
        /[\uD800-\uDBFF]/.test(text[index - 1])) return index - 1;
    return index;
  }

  function codePointEnd(text, index) {
    const code = text.codePointAt(index);
    return Math.min(text.length, index + (code > 0xFFFF ? 2 : 1));
  }

  function captureTree(root, selectedRange) {
    const visibility = new WeakMap();
    const paragraphs = new WeakMap();
    const segments = [];
    const pieces = [];
    let length = 0;
    let previousParagraph;
    let truncated = false;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.data.length && visibleElement(node.parentElement, visibility)
          ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    // TreeWalker.nextNode does not include its root when that root is a text node.
    let node = root.nodeType === Node.TEXT_NODE ? root : walker.nextNode();
    while (node) {
      let from = 0;
      let to = node.data.length;
      if (selectedRange) {
        if (!selectedRange.intersectsNode(node)) {
          node = walker.nextNode();
          continue;
        }
        if (selectedRange.startContainer === node) from = selectedRange.startOffset;
        if (selectedRange.endContainer === node) to = selectedRange.endOffset;
      }
      // Visibility is checked with a range but the copied data is never trimmed,
      // whitespace-normalized, or taken from innerText/Selection.toString().
      if (to > from && rectsOf(rawRange(node, from, to)).length) {
        let paragraph = paragraphs.get(node.parentElement);
        if (paragraph === undefined) {
          paragraph = paragraphFor(node, visibility);
          paragraphs.set(node.parentElement, paragraph);
        }
        const separator = segments.length && previousParagraph !== paragraph ? '\n\n' : '';
        const room = LIMIT - length - separator.length;
        if (room <= 0) { truncated = true; break; }
        let end = Math.min(to, from + room);
        // Do not truncate through a surrogate pair at the global capture limit.
        if (end < to && end > from && /[\uD800-\uDBFF]/.test(node.data[end - 1]) &&
            /[\uDC00-\uDFFF]/.test(node.data[end])) end--;
        if (end <= from) { truncated = true; break; }
        if (separator) { pieces.push(separator); length += separator.length; }
        const piece = node.data.slice(from, end);
        segments.push({node, data: node.data, from, to: end, start: length,
          end: length + piece.length, paragraph});
        pieces.push(piece);
        length += piece.length;
        previousParagraph = paragraph;
        if (end < to) { truncated = true; break; }
      }
      node = walker.nextNode();
    }
    return {text: pieces.join(''), segments, truncated};
  }

  function capture(selectionOnly, fullPage) {
    const selection = window.getSelection();
    let selectedRange = null;
    if (selection && selection.rangeCount && !selection.isCollapsed) {
      selectedRange = selection.getRangeAt(0).cloneRange();
    }
    if (selectionOnly && !selectedRange) throw new Error('请先在网页中选中需要朗读的文字。');
    let result;
    if (selectedRange) {
      const common = selectedRange.commonAncestorContainer;
      const root = common.nodeType === Node.TEXT_NODE ? common.parentNode : common;
      result = captureTree(root, selectedRange);
    } else if (fullPage) {
      // Full-page mode: every visible text node in DOM order, layout untouched.
      result = captureTree(document.body, null);
    } else {
      const candidates = [...document.querySelectorAll('article'), ...document.querySelectorAll('main'), document.body];
      for (const root of candidates) {
        if (!root) continue;
        result = captureTree(root, null);
        if (result.text.trim()) break;
      }
    }
    if (!result?.text.trim()) throw new Error('选区或网页正文中没有可读取的可见文字。');
    clear();
    const documentId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() :
      `${Date.now().toString(36)}-${++sequence}-${Math.random().toString(36).slice(2)}`;
    snapshot = {...result, documentId, selection: !!selectedRange,
      nodeData: new WeakMap(result.segments.map(segment => [segment.node, segment.data]))};
    return {title: document.title, text: result.text, source: location.href, documentId,
      truncated: result.truncated, selection: !!selectedRange};
  }

  function segmentAt(index) {
    const segments = snapshot.segments;
    let low = 0;
    let high = segments.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (segments[middle].end <= index) low = middle + 1;
      else high = middle;
    }
    // Synthetic paragraph separators have no DOM character. Prefer the next
    // actual text character, including when index lands on either separator LF.
    return Math.min(low, segments.length - 1);
  }

  function assertSegment(segment) {
    if (!segment.node.isConnected || segment.node.data !== segment.data) {
      throw new Error('网页文字已变化，请重新捕获正文。');
    }
  }

  function rangesBetween(start, end) {
    const ranges = [];
    for (let i = segmentAt(start); i < snapshot.segments.length; i++) {
      const segment = snapshot.segments[i];
      if (segment.start >= end) break;
      const left = Math.max(start, segment.start);
      const right = Math.min(end, segment.end);
      if (right <= left) continue;
      assertSegment(segment);
      ranges.push(rawRange(segment.node, segment.from + left - segment.start,
        segment.from + right - segment.start));
    }
    return ranges;
  }

  function groupBounds(segmentIndex, paragraphMode) {
    const segments = snapshot.segments;
    const paragraph = segments[segmentIndex].paragraph;
    let first = segmentIndex;
    let last = segmentIndex;
    // Ungrouped body/article text may be adjacent on a visual line, but it must
    // not turn the entire article into a fallback paragraph highlight.
    if (paragraph || !paragraphMode) {
      while (first > 0 && segments[first - 1].paragraph === paragraph) first--;
      while (last + 1 < segments.length && segments[last + 1].paragraph === paragraph) last++;
    }
    return {start: segments[first].start, end: segments[last].end};
  }

  function sameLine(rect, anchor, vertical) {
    const a0 = vertical ? anchor.left : anchor.top;
    const a1 = vertical ? anchor.right : anchor.bottom;
    const b0 = vertical ? rect.left : rect.top;
    const b1 = vertical ? rect.right : rect.bottom;
    const overlap = Math.min(a1, b1) - Math.max(a0, b0);
    // Inline font-size changes and superscripts can have unequal line boxes.
    return overlap > Math.min(a1 - a0, b1 - b0) * 0.45;
  }

  function visualLine(index, segmentIndex) {
    const text = snapshot.text;
    const bounds = groupBounds(segmentIndex, false);
    const probes = new Map();
    const vertical = getComputedStyle(snapshot.segments[segmentIndex].node.parentElement)
      .writingMode.startsWith('vertical');
    let probeCount = 0;
    function probe(position) {
      const start = codePointStart(text, position);
      if (!probes.has(start)) {
        // Exponential search plus binary search uses O(log paragraph length)
        // character layout probes (at most about 80 at the 200k capture limit).
        if (++probeCount > 100) return [];
        probes.set(start, rangesBetween(start, codePointEnd(text, start)).flatMap(range =>
          Array.from(range.getClientRects()).filter(rect => vertical ? rect.width > 0 : rect.height > 0)));
        // Zero-width whitespace rects still carry the browser's line position;
        // retain them for boundary searches, but never paint empty rectangles.
      }
      return probes.get(start);
    }
    let anchor = probe(index)[0];
    if (!anchor) {
      // Collapsed whitespace and zero-width characters may have no painted rect.
      // Find a nearby visible code point without walking an unbounded paragraph.
      for (let distance = 1; distance <= 32 && !anchor; distance++) {
        for (const candidate of [index + distance, index - distance]) {
          if (candidate < bounds.start || candidate >= bounds.end) continue;
          const rect = probe(candidate)[0];
          if (rect) { index = codePointStart(text, candidate); anchor = rect; break; }
        }
      }
    }
    if (!anchor) return {start: index, end: codePointEnd(text, index), anchor: null, vertical};
    function belongs(position) {
      const rects = probe(position);
      // Empty rects at a wrap boundary are treated as a boundary. This avoids
      // assigning a line break or hidden run to an unrelated visual line.
      return rects.some(rect => sameLine(rect, anchor, vertical));
    }
    function edge(direction) {
      let inside = index;
      let distance = 1;
      let outside;
      while (true) {
        const candidate = index + direction * distance;
        if (candidate < bounds.start || candidate >= bounds.end) {
          outside = direction < 0 ? bounds.start - 1 : bounds.end;
          break;
        }
        if (!belongs(candidate)) { outside = candidate; break; }
        inside = candidate;
        distance *= 2;
      }
      // Membership is monotone on each side of a character in normal text flow.
      // A final per-rect clip below also excludes other lines in exotic layouts.
      let low = Math.min(inside, outside);
      let high = Math.max(inside, outside);
      while (high - low > 1) {
        const middle = (low + high) >>> 1;
        if (belongs(middle)) {
          if (direction < 0) high = middle;
          else low = middle;
        } else if (direction < 0) low = middle;
        else high = middle;
      }
      return direction < 0 ? codePointStart(text, high) : codePointEnd(text, codePointStart(text, low));
    }
    return {start: edge(-1), end: edge(1), anchor, anchorIndex: index, vertical};
  }

  function chooseRanges(index, mode) {
    const segmentIndex = segmentAt(index);
    const segment = snapshot.segments[segmentIndex];
    index = codePointStart(snapshot.text, Math.max(index, segment.start));
    let bounds;
    let line = null;
    if (mode === 'paragraph') bounds = groupBounds(segmentIndex, true);
    else if (mode === 'line') bounds = line = visualLine(index, segmentIndex);
    else bounds = {start: index, end: codePointEnd(snapshot.text, index)};
    const ranges = rangesBetween(bounds.start, bounds.end);
    return {ranges, start: bounds.start, end: bounds.end, line, node: segment.node};
  }

  function ensureStyle() {
    const css = `::highlight(${NAME}) { background-color: #ffe15a; color: #111; text-shadow: none; }`;
    // Constructed sheets also work on pages that disallow inline style elements.
    try {
      if (!highlightSheet) {
        highlightSheet = new CSSStyleSheet();
        highlightSheet.replaceSync(css);
      }
      if (!document.adoptedStyleSheets.includes(highlightSheet)) {
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, highlightSheet];
      }
      return;
    } catch (_) { /* Fall back to a regular style element on older engines. */ }
    if (styleElement?.isConnected) return;
    styleElement = document.createElement('style');
    styleElement.setAttribute(UI, 'style');
    styleElement.textContent = css;
    (document.head || document.documentElement).appendChild(styleElement);
  }

  function ensureOverlay() {
    if (overlay?.isConnected) return;
    overlay = document.createElement('div');
    overlay.setAttribute(UI, 'overlay');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;overflow:hidden!important;contain:layout style!important;';
    overlayRoot = overlay.attachShadow({mode: 'closed'});
    document.documentElement.appendChild(overlay);
  }

  function paint(ranges, rects, forceOverlay = false) {
    if (!forceOverlay && globalThis.CSS?.highlights && typeof globalThis.Highlight === 'function') {
      try {
        ensureStyle();
        CSS.highlights.set(NAME, new Highlight(...ranges));
        renderer = 'css-highlight';
        overlay?.remove();
        overlay = overlayRoot = null;
        return;
      } catch (_) { /* Older Chromium or a disabled Highlight implementation. */ }
    }
    globalThis.CSS?.highlights?.delete(NAME);
    ensureOverlay();
    overlayRoot.replaceChildren();
    const fragment = document.createDocumentFragment();
    const clips = new Map();
    for (const rect of rects) {
      if (!clips.has(rect.element)) clips.set(rect.element, clippingBox(rect.element));
      const clip = clips.get(rect.element);
      const left = Math.max(rect.left, clip.left);
      const top = Math.max(rect.top, clip.top);
      const right = Math.min(rect.right, clip.right);
      const bottom = Math.min(rect.bottom, clip.bottom);
      if (right <= left || bottom <= top) continue;
      const box = document.createElement('div');
      // A translucent fallback preserves both dark and light page text. Changing
      // the original foreground color would require modifying the page itself.
      box.style.cssText = `position:absolute;pointer-events:none;left:${left}px;top:${top}px;width:${right - left}px;height:${bottom - top}px;background:rgba(255,221,40,.48);border-radius:2px;`;
      fragment.appendChild(box);
    }
    overlayRoot.appendChild(fragment);
    renderer = 'overlay';
  }

  // Immersive cover: a full-viewport dim layer with holes punched over the
  // spoken text. Pure paint (clip-path on a fixed layer) — layout untouched.
  function paintCover(rects) {
    ensureOverlay();
    overlayRoot.replaceChildren();
    const view = viewport();
    const holes = [];
    for (const rect of rects) {
      const left = Math.max(rect.left, view.left), top = Math.max(rect.top, view.top);
      const right = Math.min(rect.right, view.left + view.width), bottom = Math.min(rect.bottom, view.top + view.height);
      if (right <= left || bottom <= top) continue;
      holes.push(`M${left},${top} H${right} V${bottom} H${left} Z`);
    }
    if (!holes.length) holes.push('M0,0 H0 V0 H0 Z');
    const dim = document.createElement('div');
    const path = `M${view.left},${view.top} H${view.left + view.width} V${view.top + view.height} H${view.left} Z ` + holes.join(' ');
    dim.style.cssText = `position:absolute;inset:0;background:rgba(8,12,20,.86);clip-path:path(evenodd, '${path.trim()}');`;
    overlayRoot.appendChild(dim);
    renderer = 'cover';
  }

  function viewport() {
    const visual = window.visualViewport;
    return {left: visual?.offsetLeft || 0, top: visual?.offsetTop || 0,
      width: visual?.width || document.documentElement.clientWidth || innerWidth,
      height: visual?.height || document.documentElement.clientHeight || innerHeight};
  }

  function clippingBox(element) {
    const view = viewport();
    const clip = {left: view.left, top: view.top, right: view.left + view.width, bottom: view.top + view.height};
    for (let parent = element; parent; parent = parent.parentElement) {
      const css = getComputedStyle(parent);
      const box = parent.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip|overlay)/.test(css.overflowX)) {
        clip.left = Math.max(clip.left, box.left + parent.clientLeft);
        clip.right = Math.min(clip.right, box.left + parent.clientLeft + parent.clientWidth);
      }
      if (/(auto|scroll|hidden|clip|overlay)/.test(css.overflowY)) {
        clip.top = Math.max(clip.top, box.top + parent.clientTop);
        clip.bottom = Math.min(clip.bottom, box.top + parent.clientTop + parent.clientHeight);
      }
    }
    return clip;
  }

  function followRange(chosen, rects) {
    if (performance.now() - lastFollowTime < 320) return;
    // Follow the spoken character, including inside a paragraph taller than the
    // screen. Following the paragraph's first rect loses the current position.
    const location = chooseRanges(active.index, 'character');
    const target = location.ranges.flatMap(rectsOf)[0] || rects[0];
    if (!target) return;
    const view = viewport();
    const centerX = target.left + target.width / 2;
    const centerY = target.top + target.height / 2;
    const delta = (center, low, size) => {
      if (size <= 0) return 0;
      return center < low + size * 0.30 || center > low + size * 0.65
        ? center - (low + size * 0.45) : 0;
    };
    // Work from the innermost scrolling area outward. Skip saturated containers
    // so a nested scroller cannot prevent the surrounding page from following.
    for (let parent = location.node.parentElement; parent; parent = parent.parentElement) {
      if (parent === document.scrollingElement || parent === document.body || parent === document.documentElement) continue;
      const css = getComputedStyle(parent);
      const scrollY = /(auto|scroll|overlay)/.test(css.overflowY) && parent.scrollHeight > parent.clientHeight;
      const scrollX = /(auto|scroll|overlay)/.test(css.overflowX) && parent.scrollWidth > parent.clientWidth;
      if (!scrollY && !scrollX) continue;
      const box = parent.getBoundingClientRect();
      const top = scrollY ? delta(centerY, box.top + parent.clientTop, parent.clientHeight) : 0;
      const left = scrollX ? delta(centerX, box.left + parent.clientLeft, parent.clientWidth) : 0;
      const canY = top < -1 ? parent.scrollTop > 0 : top > 1 && parent.scrollTop < parent.scrollHeight - parent.clientHeight - 1;
      const canX = left < -1 ? parent.scrollLeft > 0 : left > 1 && parent.scrollLeft < parent.scrollWidth - parent.clientWidth - 1;
      if (canY || canX) {
        lastFollowTime = performance.now();
        parent.scrollBy({top: canY ? top : 0, left: canX ? left : 0, behavior: 'smooth'});
        followTarget = parent;
        return;
      }
    }
    const top = delta(centerY, view.top, view.height);
    const left = delta(centerX, view.left, view.width);
    if (Math.abs(top) > 1 || Math.abs(left) > 1) {
      lastFollowTime = performance.now();
      window.scrollBy({top, left, behavior: 'smooth'});
      followTarget = window;
    }
  }

  function stopFollowScroll() {
    const target = followTarget;
    followTarget = null;
    // Cancel a smooth follow already in flight without moving the viewport.
    if (target === window) {
      window.scrollTo({top: window.scrollY, left: window.scrollX, behavior: 'instant'});
    } else if (target?.isConnected) {
      target.scrollTo({top: target.scrollTop, left: target.scrollLeft, behavior: 'instant'});
    }
  }

  function syncFollowTimer() {
    if (active?.follow && !followTimer) {
      followTimer = setInterval(() => {
        if (!active?.follow) return;
        try { updateHighlight(true); }
        catch (error) { const message = error.message; clear(); lastError = message; }
      }, 350);
    } else if (!active?.follow) {
      if (followTimer) clearInterval(followTimer);
      followTimer = null;
      stopFollowScroll();
    }
  }

  function updateHighlight(follow = false) {
    if (!active || !snapshot) return;
    if (active.epoch !== epoch || !active.chosen) {
      active.chosen = chooseRanges(active.index, active.mode);
      active.epoch = epoch;
    }
    const chosen = active.chosen;
    const block = chosen.node.parentElement;
    if (resizeObserver && observedBlock !== block) {
      if (observedBlock && observedBlock !== document.documentElement) resizeObserver.unobserve(observedBlock);
      observedBlock = block;
      resizeObserver.observe(block);
    }
    // Validate on cached calls too: page frameworks may replace or edit a node.
    for (const range of chosen.ranges) {
      const node = range.startContainer;
      if (!node.isConnected || node.data !== snapshot.nodeData.get(node)) {
        throw new Error('网页文字已变化，请重新捕获正文。');
      }
    }
    let rects = chosen.ranges.flatMap(range => rectsOf(range).map(rect => ({
      x: rect.x, y: rect.y, left: rect.left, top: rect.top, right: rect.right,
      bottom: rect.bottom, width: rect.width, height: rect.height,
      element: range.startContainer.parentElement
    })));
    let clippedLine = false;
    if (chosen.line?.anchor) {
      // Scroll offsets may change before the corresponding scroll event arrives.
      // Refresh the anchor position even while reusing the cached text bounds.
      const anchorRects = rangesBetween(chosen.line.anchorIndex,
        codePointEnd(snapshot.text, chosen.line.anchorIndex)).flatMap(range =>
        Array.from(range.getClientRects()).filter(rect => chosen.line.vertical ? rect.width > 0 : rect.height > 0));
      const anchor = anchorRects[0] || chosen.line.anchor;
      const filtered = rects.filter(rect => sameLine(rect, anchor, chosen.line.vertical));
      clippedLine = filtered.length !== rects.length;
      rects = filtered;
    }
    // Normally a visual-line range has only one line. If unusual multi-column or
    // bidi layout violates that assumption, overlay only its matching line rects.
    paint(chosen.ranges, rects, clippedLine);
    if (active.mode === 'cover') paintCover(rects);
    else if (renderer === 'cover') { overlay?.remove(); overlay = overlayRoot = null; }
    active.rects = rects;
    active.error = null;
    if (follow) followRange(chosen, rects);
  }

  function scheduleLayout() {
    epoch++;
    if (!active || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      try { updateHighlight(active?.follow === true); }
      catch (error) {
        const message = error.message;
        clear();
        // Status exposes the reason without exposing captured text.
        lastError = message;
      }
    });
  }

  let lastError = null;
  function clear() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    globalThis.CSS?.highlights?.delete(NAME);
    overlay?.remove();
    overlay = overlayRoot = null;
    active = null;
    renderer = null;
    if (observedBlock && observedBlock !== document.documentElement) resizeObserver?.unobserve(observedBlock);
    observedBlock = null;
    lastError = null;
    if (followTimer) clearInterval(followTimer);
    followTimer = null;
    stopFollowScroll();
    lastFollowTime = -Infinity;
  }

  function requireDocument(documentId, optional = false) {
    if (!snapshot) throw new Error('尚未捕获网页正文。');
    if ((!optional || documentId !== undefined) && documentId !== snapshot.documentId) {
      throw new Error('documentId 不匹配，已忽略请求。');
    }
  }

  function highlight(message) {
    requireDocument(message.documentId);
    if (!Number.isInteger(message.index) || message.index < 0 || message.index >= snapshot.text.length) {
      throw new Error('index 必须是捕获正文范围内的 UTF-16 偏移。');
    }
    if (message.end !== undefined && (!Number.isInteger(message.end) ||
        message.end < message.index || message.end > snapshot.text.length)) {
      throw new Error('end 必须是有效的 UTF-16 结束偏移。');
    }
    const mode = message.mode || 'character';
    if (!['character', 'line', 'paragraph', 'cover'].includes(mode)) throw new Error('未知高亮模式。');
    // end is an optional speech-boundary hint. Mode determines the actual range:
    // one Unicode code point, the visual line, or the captured paragraph.
    if (!active || active.index !== message.index || active.mode !== mode) {
      active = {index: message.index, mode, epoch: -1, chosen: null, rects: []};
    }
    active.follow = message.follow === true;
    syncFollowTimer();
    try { updateHighlight(active.follow); }
    catch (error) {
      clear();
      lastError = error.message;
      throw error;
    }
    return {ok: true, documentId: snapshot.documentId, mode, index: message.index,
      start: active.chosen.start, end: active.chosen.end};
  }

  function status() {
    if (active) {
      try { updateHighlight(false); }
      catch (error) { clear(); lastError = error.message; }
    }
    return {ok: true, documentId: snapshot?.documentId || null,
      textLength: snapshot?.text.length || 0, mode: active?.mode || null, following: active?.follow === true,
      index: active?.index ?? null, start: active?.chosen?.start ?? null,
      end: active?.chosen?.end ?? null, renderer, truncated: snapshot?.truncated || false,
      selection: snapshot?.selection || false, error: lastError,
      highlightRects: (active?.rects || []).map(rect => ({x: rect.x, y: rect.y,
        width: rect.width, height: rect.height}))};
  }

  const listener = (message, _sender, sendResponse) => {
    if (!message || typeof message.action !== 'string') return false;
    if (message.action === 'xiaoxiao-next-link') {
      try { sendResponse(nextLink()); } catch (error) { sendResponse({error: error.message || String(error)}); }
      return false;
    }
    if (!message.action.startsWith('xiaoxiao-')) return false;
    try {
      let response;
      switch (message.action) {
        case 'xiaoxiao-capture': response = capture(message.selectionOnly === true, message.fullPage === true); break;
        case 'xiaoxiao-highlight': response = highlight(message); break;
        case 'xiaoxiao-clear':
          if (message.documentId !== undefined) requireDocument(message.documentId);
          clear();
          response = {ok: true, documentId: snapshot?.documentId || null};
          break;
        case 'xiaoxiao-status': response = status(); break;
        case 'xiaoxiao-extract-html': response = extractHtml(); break;
        default: return false;
      }
      sendResponse(response);
    } catch (error) {
      sendResponse({ok: false, error: error.message || String(error)});
    }
    // All responses are synchronous; returning true would leave an unused port.
    return false;
  };

  // Pull the article subtree out as sanitized HTML for the reader view:
  // scripts/styles/events stripped, links and images absolutized.
  function extractHtml() {
    const candidates = [...document.querySelectorAll('article'), ...document.querySelectorAll('main'), document.body];
    let root = null;
    for (const c of candidates) {
      if (c && c.textContent.trim().length > 200) { root = c; break; }
    }
    if (!root) root = document.body;
    const clone = root.cloneNode(true);
    clone.querySelectorAll('script,style,link,iframe,object,embed,noscript,svg,canvas,template,dialog,form,input,button,select,textarea,video,audio').forEach(el => el.remove());
    clone.querySelectorAll('*').forEach(el => {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on') || name === 'style' || name === 'class' || name === 'id' || name === 'srcset' || name.startsWith('data-')) el.removeAttribute(attr.name);
      }
      if (el.tagName === 'A' && el.getAttribute('href')) {
        try { el.setAttribute('href', new URL(el.getAttribute('href'), location.href).href); } catch { el.removeAttribute('href'); }
      }
      if (el.tagName === 'IMG') {
        const src = el.getAttribute('src');
        if (src) {
          try { el.setAttribute('src', new URL(src, location.href).href); }
          catch { el.removeAttribute('src'); }
        }
      }
    });
    const html = clone.outerHTML;
    if (html.length > 2000000) throw new Error('页面内容过大，无法摘录到新页面。');
    if (!clone.textContent.trim()) throw new Error('没有可摘录的正文。');
    return {title: document.title, html};
  }

  function nextLink() {
    const rel = document.querySelector('link[rel~="next"][href], a[rel~="next"][href]');
    const text = [...document.querySelectorAll('a[href]')].find(anchor =>
      /^(下一篇|下一頁|下一页|下一頁|next|next page|older|下一篇.*|next article)$/i.test(anchor.textContent.trim()));
    const raw = rel?.href || text?.href;
    if (!raw) return {url: null};
    let url;
    try { url = new URL(raw, location.href); } catch { return {url: null}; }
    if (!/^https?:$/.test(url.protocol) || url.origin !== location.origin) return {url: null};
    return {url: url.href};
  }

  // Alt+click on captured text marks where reading should start. The panel
  // receives the sentence index and "从此处开始" begins from it.
  window.addEventListener('click', event => {
    if (!event.altKey || !snapshot) return;
    if (ownElement(event.target)) return;
    const range = document.caretRangeFromPoint(event.clientX, event.clientY);
    if (!range || !range.startContainer || range.startContainer.nodeType !== Node.TEXT_NODE) return;
    const node = range.startContainer;
    const offset = range.startOffset;
    const seg = snapshot.segments.find(s => s.node === node && offset >= s.from && offset <= s.to);
    if (!seg) return;
    const index = seg.start + (offset - seg.from);
    try { chrome.runtime.sendMessage({action: 'xiaoxiao-set-start', index}).catch(() => {}); } catch {}
  }, true);

  window.__xiaoxiaoReader = {version: 1};
  chrome.runtime.onMessage.addListener(listener);
  window.addEventListener('scroll', scheduleLayout, {capture: true, passive: true});
  window.addEventListener('resize', scheduleLayout, {passive: true});
  window.visualViewport?.addEventListener('resize', scheduleLayout, {passive: true});
  window.visualViewport?.addEventListener('scroll', scheduleLayout, {passive: true});
  document.fonts?.addEventListener('loadingdone', scheduleLayout);
  const observer = new MutationObserver(records => {
    if (records.some(record => !ownElement(record.target.nodeType === Node.ELEMENT_NODE
      ? record.target : record.target.parentElement) &&
      !(record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].every(node =>
        node.nodeType === Node.ELEMENT_NODE && node.hasAttribute(UI))))) scheduleLayout();
  });
  observer.observe(document.documentElement, {subtree: true, childList: true,
    characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open', 'dir']});
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(scheduleLayout);
    resizeObserver.observe(document.documentElement);
  }
})();

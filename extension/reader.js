'use strict';
const $ = id => document.getElementById(id);
let session = 0, active = false, paused = false;
let audio = null, controller = null, resumeWaiter = null;
let displayedArticle = null, source = null, highlightFrame = 0;
let highlightKey = '', highlightSequence = 0, lastHighlight = null;
let preloaded = null;
let serviceStartPromise = null, healthSequence = 0;
let currentParts = [];
let currentIndex = -1;
function serviceStatus(text, state) {
  $('serviceStatus').textContent = text;
  $('serviceStatus').dataset.state = state;
}
function status(text, error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}
function sendHighlight(action, data = {}) {
  if (!source?.sourceTabId || !source?.documentId) return Promise.resolve(null);
  return chrome.runtime.sendMessage({action, tabId: source.sourceTabId, documentId: source.documentId, ...data});
}
function clearHighlight() {
  cancelAnimationFrame(highlightFrame);
  highlightFrame = 0;
  highlightKey = '';
  lastHighlight = null;
  sendHighlight('clearHighlight').catch(() => {});
}
function stop() {
  session++;
  active = false;
  paused = false;
  controller?.abort(); controller = null;
  if (audio) { audio.pause(); audio.src = ''; audio = null; }
  resumeWaiter?.(); resumeWaiter = null;
  $('pause').textContent = '暂停';
  clearHighlight();
}
function sentenceList(text) {
  // Prefer sentence endings. Punctuation-free runs are split only as a guard.
  const parts = [];
  const re = /[^\n。！？；.!?;]+[\n。！？；.!?;]*|\n+/gu;
  for (const match of text.matchAll(re)) {
    const value = match[0].trim();
    const left = match[0].search(/\S/u);
    if (value && left >= 0) parts.push({text: value, start: match.index + left});
  }
  return parts;
}
function hardSplit(sentence) {
  // A very long sentence still must respect the 1400-character audio request cap.
  const parts = [];
  let offset = 0;
  while (offset < sentence.text.length) {
    const rest = sentence.text.slice(offset);
    let take = Math.min(1400, rest.length);
    if (offset + take < sentence.text.length) {
      const area = rest.slice(0, take);
      const cut = Math.max(area.lastIndexOf('，'), area.lastIndexOf(','), area.lastIndexOf(' '));
      if (cut > take / 2) take = cut + 1;
    }
    const code = sentence.text.charCodeAt(offset + take - 1);
    if (take > 1 && code >= 0xD800 && code <= 0xDBFF) take--;
    const value = rest.slice(0, take).trim();
    if (value) parts.push({text: value, start: sentence.start + offset + rest.length - rest.trimStart().length});
    offset += take;
  }
  return parts;
}
function splitText(text) {
  const units = [];
  for (const sentence of sentenceList(text)) {
    if (sentence.text.length <= 1400) units.push(sentence);
    else units.push(...hardSplit(sentence));
  }
  return units;
}
function characterAt(boundary, piece, time) {
  const value = piece.text.slice(boundary.startChar, boundary.endChar);
  const points = Array.from(value);
  const fraction = boundary.duration > 0 ? Math.max(0, Math.min(0.99999, (time - boundary.start) / boundary.duration)) : 0;
  const position = Math.min(points.length - 1, Math.floor(fraction * points.length));
  let offset = 0;
  for (let i = 0; i < position; i++) offset += points[i].length;
  const index = piece.start + boundary.startChar + offset;
  return {index, end: index + (points[position]?.length || 1)};
}
function shouldFollow() {
  return active && !paused && audio?.paused === false && !audio.ended && $('follow').checked;
}
function highlightAt(media, boundaries, piece, force = false) {
  if (!source?.documentId || $('highlightMode').value === 'off' || !boundaries.length) return;
  const time = media.currentTime;
  let left = 0, right = boundaries.length - 1, found = -1;
  while (left <= right) {
    const middle = (left + right) >> 1;
    if (boundaries[middle].start <= time) { found = middle; left = middle + 1; }
    else right = middle - 1;
  }
  if (found < 0) return;
  const location = characterAt(boundaries[found], piece, time);
  const mode = $('highlightMode').value;
  const follow = shouldFollow();
  const key = `${source.documentId}:${mode}:${location.index}:${follow}`;
  lastHighlight = {media, boundaries, piece, location};
  if (!force && key === highlightKey) return;
  highlightKey = key;
  const sequence = ++highlightSequence;
  sendHighlight('highlight', {...location, mode, follow}).then(result => {
    if (sequence !== highlightSequence) return;
    if (result?.error) $('highlightStatus').textContent = '原网页已变化或无法定位，点击“读取当前网页”重新定位。';
    else $('highlightStatus').textContent = `已连接原网页 · ${$('highlightMode').selectedOptions[0].textContent}`;
  }).catch(() => { $('highlightStatus').textContent = '原网页连接已断开，点击“读取当前网页”重试。'; });
}
function trackHighlight(media, boundaries, piece, id) {
  cancelAnimationFrame(highlightFrame);
  if (!boundaries.length && source) $('highlightStatus').textContent = '本段没有返回时间标记，暂不高亮；语音可继续播放。';
  const tick = () => {
    if (session !== id || audio !== media) return;
    highlightAt(media, boundaries, piece);
    highlightFrame = requestAnimationFrame(tick);
  };
  tick();
}
async function checkHealth(announce = true) {
  if (announce && serviceStartPromise) return false;
  const sequence = ++healthSequence;
  try {
    const response = await fetch(`${READER_API}/health`, {method: 'GET', signal: AbortSignal.timeout(3000)});
    const data = await response.json();
    if (!response.ok || data?.ok !== true) throw new Error('服务尚未就绪');
    if (sequence === healthSequence) {
      serviceStatus('本机语音服务已连接', 'ready');
      if (announce && !active) status('本机语音服务已连接 · 默认晓晓');
    }
    return true;
  } catch (_) {
    if (sequence === healthSequence) {
      serviceStatus('本机语音服务未连接', 'offline');
      if (announce && !active) status('本机语音服务未连接。请点击“启动本机服务”，启动成功后再点击播放。', true);
    }
    return false;
  }
}
async function requestServiceStart() {
  let timer;
  try {
    return await Promise.race([
      chrome.runtime.sendMessage({action: 'startService'}),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('扩展后台启动请求超时，请稍后重试。')), 16000); })
    ]);
  } finally { clearTimeout(timer); }
}
function startService() {
  if (serviceStartPromise) return serviceStartPromise;
  ++healthSequence;
  $('startService').disabled = true;
  $('startService').textContent = '正在启动…';
  serviceStatus('正在启动本机服务，通常需要 8–10 秒…', 'starting');
  if (!active) status('正在启动本机语音服务，请稍候…');
  serviceStartPromise = (async () => {
    try {
      const response = await requestServiceStart();
      if (response?.ok !== true) throw new Error(response?.error || '扩展后台未返回有效启动结果，请重新加载扩展后重试。');
      serviceStatus('启动程序已返回，正在确认服务健康状态…', 'starting');
      if (!await checkHealth(false)) throw new Error('启动程序已返回，但本机语音服务尚未就绪（/health 检查失败）。请稍后再次点击“启动本机服务”。');
      serviceStatus(response.alreadyRunning ? '本机语音服务已在运行，连接正常' : '本机语音服务已启动，连接正常', 'ready');
      if (!active) status('本机语音服务已就绪，点击“播放”继续朗读。');
      return true;
    } catch (error) {
      serviceStatus(error.message, 'error');
      if (!active) status(error.message, true);
      return false;
    }
  })().finally(() => {
    serviceStartPromise = null;
    $('startService').disabled = false;
    $('startService').textContent = '启动本机服务';
  });
  return serviceStartPromise;
}
async function play(startAt = 0) {
  if (serviceStartPromise) { status('本机语音服务正在启动，请等待就绪后再点击播放。'); return; }
  const parts = splitText($('text').value);
  if (!parts.length) { status('请先读取网页或粘贴文字。', true); return; }
  stop();
  currentParts = parts;
  currentIndex = Math.min(Math.max(startAt, 0), parts.length - 1);
  const id = session;
  active = true;
  controller = new AbortController();
  const signal = controller.signal;
  const voice = $('voice').value;
  const url = `${READER_API}/api/speech`;
  const tts = async (piece, signal) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${READER_TOKEN}`},
      body: JSON.stringify({text: piece.text, voice, rate: '+0%'}),
      signal: AbortSignal.any([signal, AbortSignal.timeout(60000)])
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `语音请求失败（HTTP ${response.status}）`);
    }
    return response.json();
  };
  const pending = new Map();
  const prefetch = index => {
    if (index < 0 || index >= currentParts.length || pending.has(index)) return;
    if (index > currentIndex + 2 || index < currentIndex - 1) return;
    // Cache the request only to keep latency down; audio objects are single-use.
    pending.set(index, tts(currentParts[index], signal).catch(error => ({error})));
  };
  const take = index => {
    const promise = pending.get(index);
    if (!promise) return tts(currentParts[index], signal);
    pending.delete(index);
    return promise;
  };
  const advance = async (index, force = false) => {
    if (session !== id) return false;
    const piece = currentParts[index];
    currentIndex = index;
    $('progress').textContent = `${index + 1} / ${currentParts.length} 句`;
    prefetch(index + 1);
    prefetch(index + 2);
    let speech;
    if (force) status(`正在合成第 ${index + 1} / ${currentParts.length} 句…`);
    try {
      speech = await take(index);
    } catch (error) {
      if (signal.aborted) return false;
      throw new Error('无法取得语音。请确认本机服务已启动且网络可访问微软语音服务。' + (error.name === 'TimeoutError' ? '（请求超时）' : ''));
    }
    if (session !== id) return false;
    if (speech?.error) throw speech.error;
    if (!speech.audio || speech.mime !== 'audio/mpeg') throw new Error('语音服务返回了无效音频，请重启本机服务。');
    const bytes = Uint8Array.from(atob(speech.audio), character => character.charCodeAt(0));
    const blob = new Blob([bytes], {type: speech.mime});
    const boundaries = Array.isArray(speech.boundaries) ? speech.boundaries : [];
    while (paused && session === id) await new Promise(resolve => { resumeWaiter = resolve; });
    if (session !== id) return false;
    const objectUrl = URL.createObjectURL(blob);
    const media = new Audio(objectUrl);
    media.playbackRate = Number($('rate').value);
    media.preservesPitch = true;
    audio = media;
    trackHighlight(media, boundaries, piece, id);
    try {
      await new Promise((resolve, reject) => {
        const aborted = () => { media.pause(); resolve(); };
        signal.addEventListener('abort', aborted, {once: true});
        const clean = () => signal.removeEventListener('abort', aborted);
        media.onended = () => { clean(); resolve(); };
        media.onerror = () => { clean(); reject(new Error('浏览器无法播放音频，请点击播放重试。')); };
        media.play().then(() => {
          if (session === id && !paused) {
            refreshHighlight();
            status(`正在朗读 · 第 ${index + 1} / ${currentParts.length} 句 · ${$('rate').value}×`);
          }
        }).catch(error => { clean(); reject(new Error(`播放被浏览器阻止：${error.message}。请再次点击播放。`)); });
      });
    } finally {
      cancelAnimationFrame(highlightFrame);
      media.pause(); media.src = '';
      if (audio === media) {
        audio = null;
        refreshHighlight();
      }
      URL.revokeObjectURL(objectUrl);
    }
    return true;
  };
  try {
    const healthy = await checkHealth(false);
    if (session !== id) return;
    if (!healthy) {
      stop();
      status('本机语音服务未连接。请点击“启动本机服务”，启动成功后再点击播放。', true);
      return;
    }
    for (let index = currentIndex; index < currentParts.length; index++) {
      if (await advance(index, false) === false) return;
    }
    if (session === id) {
      active = false;
      status('朗读完成');
      // Automatically continue with the next preloaded article, if any.
      if (preloaded?.text) await continueQueue();
    }
  } catch (error) {
    if (session === id) { stop(); status(error.message, true); }
  } finally {
    for (const promise of pending.values()) promise.then(() => {}, () => {});
    pending.clear();
  }
}
// Locate the sentence containing the caret so playback can start anywhere.
function sentenceIndexAt(offset) {
  for (let i = 0; i < currentParts.length; i++) {
    const part = currentParts[i];
    if (offset < part.start + part.text.length) return i;
  }
  return Math.max(0, currentParts.length - 1);
}
function playFromCaret() {
  if (serviceStartPromise) { status('本机语音服务正在启动，请等待就绪后再点击播放。'); return; }
  // Recompute so caret offsets always match the current textarea content.
  currentParts = splitText($('text').value);
  if (!currentParts.length) { status('请先读取网页或粘贴文字。', true); return; }
  const field = $('text');
  const caret = Math.max(0, Math.min(field.selectionStart || 0, field.value.length));
  const index = sentenceIndexAt(caret);
  const preview = currentParts[index].text;
  status(`将从第 ${index + 1} / ${currentParts.length} 句开始：${preview.slice(0, 24)}${preview.length > 24 ? '…' : ''}`);
  play(index);
}
function jump(offset) {
  if (!active || !currentParts.length) return;
  const target = currentIndex + offset;
  if (target < 0) { status('已经是第一句。'); return; }
  if (target >= currentParts.length) { status('已经是最后一句。'); return; }
  session++;
  const wasPaused = paused;
  paused = false;
  $('pause').textContent = '暂停';
  controller?.abort();
  if (audio) { audio.onended = null; audio.pause(); audio.src = ''; audio = null; }
  resumeWaiter?.(); resumeWaiter = null;
  active = true;
  controller = new AbortController();
  // The running loop notices the aborted request and stops; start a fresh one.
  play(target);
  if (wasPaused) {
    // Keep the just-jumped sentence highlighted but do not resume auto-scroll.
    paused = true;
    $('pause').textContent = '暂停';
    audio?.pause();
    refreshHighlight();
    status('已暂停，可自由滚动网页');
  }
}
function setSpeed(value, persist = true) {
  const speed = Math.min(3, Math.max(0.5, Number(value) || 1));
  $('rate').value = String(speed);
  $('rateLabel').value = `${speed}×`;
  if (audio) { audio.playbackRate = speed; audio.preservesPitch = true; }
  document.querySelectorAll('[data-speed]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.speed) === speed)));
  if (persist) chrome.storage.local.set({playbackSpeed: speed});
}
$('startService').addEventListener('click', startService);
$('play').addEventListener('click', () => play());
$('previous').addEventListener('click', () => jump(-1));
$('next').addEventListener('click', () => jump(1));
$('loadNext').addEventListener('click', loadNextArticle);
$('playFrom').addEventListener('click', playFromCaret);
document.addEventListener('keydown', event => {
  const target = event.target;
  const typing = target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
  if (typing) return;
  if (event.key === 'ArrowLeft' && !event.ctrlKey && !event.metaKey && !event.shiftKey) { event.preventDefault(); jump(-1); }
  else if (event.key === 'ArrowRight' && !event.ctrlKey && !event.metaKey && !event.shiftKey) { event.preventDefault(); jump(1); }
  else if (event.key === ' ' && active) { event.preventDefault(); $('pause').click(); }
});
$('stop').addEventListener('click', () => { stop(); status('已停止'); });
$('pause').addEventListener('click', () => {
  if (!active) return;
  paused = !paused;
  $('pause').textContent = paused ? '继续' : '暂停';
  if (paused) {
    audio?.pause();
    refreshHighlight();
    status('已暂停，可自由滚动网页');
  } else {
    const id = session, media = audio;
    resumeWaiter?.(); resumeWaiter = null;
    refreshHighlight();
    if (media) media.play().then(() => {
      if (session === id && audio === media) refreshHighlight();
    }).catch(error => {
      if (session !== id || audio !== media || paused || media.paused === false) return;
      paused = true;
      media.pause();
      $('pause').textContent = '继续';
      refreshHighlight();
      status(error.message, true);
    });
    status('继续朗读…');
  }
});
$('capture').addEventListener('click', async () => {
  status('正在读取当前网页…');
  const response = await chrome.runtime.sendMessage({action: 'capture'}).catch(error => ({error: error.message}));
  if (response?.error) status(response.error, true);
});
// Multi-article sites: preload the following article so the reader can chain it.
async function loadNextArticle() {
  const response = await chrome.runtime.sendMessage({action: 'nextArticle'}).catch(error => ({error: error.message}));
  if (response?.ok === true) { status('已载入后续文章，当前读完会自动继续。'); return; }
  status(response?.error || '没有找到可继续的下一篇。', true);
}
$('rate').addEventListener('input', () => setSpeed($('rate').value));
$('speedButtons').addEventListener('click', event => {
  const button = event.target.closest('[data-speed]');
  if (button) setSpeed(button.dataset.speed);
});
function refreshHighlight() {
  if ($('highlightMode').value === 'off') clearHighlight();
  else if (lastHighlight?.location) {
    // Keep the reading position highlighted, but only scroll while audio plays.
    highlightKey = '';
    sendHighlight('highlight', {...lastHighlight.location, mode: $('highlightMode').value, follow: shouldFollow()})
      .catch(() => { $('highlightStatus').textContent = '原网页连接已断开，点击“读取当前网页”重试。'; });
  } else if (lastHighlight) highlightAt(lastHighlight.media, lastHighlight.boundaries, lastHighlight.piece, true);
}
function updateMode() {
  chrome.storage.local.set({highlightMode: $('highlightMode').value, followReading: $('follow').checked});
  refreshHighlight();
}
$('highlightMode').addEventListener('change', updateMode);
$('follow').addEventListener('change', updateMode);
$('text').addEventListener('input', () => {
  stop(); source = null;
  $('highlightStatus').textContent = '已切换为粘贴文字；读取网页后可同步高亮原文。';
  status('文字已更新，点击播放即可朗读。');
});
async function showArticle(article, options = {}) {
  if (!article || displayedArticle === article.id) return;
  displayedArticle = article.id;
  stop();
  if (article.error) { source = null; status(article.error, true); return; }
  source = article;
  $('title').textContent = article.title || '网页正文';
  $('text').value = article.text || '';
  $('highlightStatus').textContent = '原网页已连接，朗读时同步高亮。';
  if (options.noPlay) status('已预先载入，等待当前文章读完后继续。');
  else await play();
}
// Preloading keeps the next article ready while the current one plays, so
// sites that paginate an article can be read continuously.
function queueNextArticle(article) {
  if (!article?.text) return;
  preloaded = article;
}
async function continueQueue() {
  const next = preloaded;
  preloaded = null;
  if (!next?.text) return false;
  await showArticle(next);
  return true;
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.article) return;
  const article = changes.article.newValue;
  if (article?.preload) { queueNextArticle(article); return; }
  showArticle(article);
});
(async () => {
  const settings = await chrome.storage.local.get(['article', 'playbackSpeed', 'highlightMode', 'followReading']);
  if (settings.playbackSpeed) setSpeed(settings.playbackSpeed, false);
  if (['line', 'paragraph', 'character', 'off'].includes(settings.highlightMode)) $('highlightMode').value = settings.highlightMode;
  $('follow').checked = settings.followReading !== false;
  await checkHealth();
  const article = settings.article;
  if (article?.text && displayedArticle !== article.id) {
    if (Date.now() - (article.requestedAt || 0) < 15000) await showArticle(article);
    else {
      displayedArticle = article.id; source = article;
      $('title').textContent = article.title || '上次读取的文字'; $('text').value = article.text;
    }
  }
})();
window.addEventListener('pagehide', stop);

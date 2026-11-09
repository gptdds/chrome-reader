const MENU = 'xiaoxiao-read-selection';
const NATIVE_HOST = 'com.xiaoxiao.reader';
const START_TIMEOUT = 15000;
let serviceStartPromise = null;
function nativeError(error) {
  const detail = String(error?.message || error || '未知通信错误');
  if (/native messaging host.*(?:not found|not registered|not installed)|specified native messaging host not found/i.test(detail)) {
    return {ok: false, code: 'NATIVE_HOST_NOT_INSTALLED', error: '未安装本机启动桥接。请在项目目录运行 install-native-host.cmd，完成后再点击“启动本机服务”。'};
  }
  return {ok: false, code: 'NATIVE_COMMUNICATION_FAILED', error: `本机启动桥接通信失败，请运行 install-native-host.cmd 重新安装后重试。详细信息：${detail}`};
}
function startService() {
  if (serviceStartPromise) return serviceStartPromise;
  serviceStartPromise = new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ok: false, code: 'START_TIMEOUT', error: '启动本机服务超时（15 秒）。服务可能仍在启动，请稍后重试。'}), START_TIMEOUT);
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, {action: 'start'}, response => {
        const error = chrome.runtime.lastError;
        if (settled) return;
        if (error) { finish(nativeError(error)); return; }
        if (response?.ok === true) { finish({ok: true, alreadyRunning: response.alreadyRunning === true}); return; }
        if (response?.ok === false && typeof response.error === 'string' && response.error.trim()) {
          finish({ok: false, code: 'START_FAILED', error: response.error});
          return;
        }
        finish({ok: false, code: 'INVALID_NATIVE_RESPONSE', error: '本机启动桥接返回了无效结果，请运行 install-native-host.cmd 重新安装后重试。'});
      });
    } catch (error) { finish(nativeError(error)); }
  }).finally(() => { serviceStartPromise = null; });
  return serviceStartPromise;
}
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({id: MENU, title: '用晓晓朗读选中文字', contexts: ['selection']});
});
async function capture(tab, selectionOnly = false, fullPage = false) {
  if (!tab?.id || !/^https?:/.test(tab.url || '')) {
    throw new Error('请切回普通网页后再点击朗读。Chrome 内部页和扩展商店不允许读取。');
  }
  await chrome.scripting.executeScript({target: {tabId: tab.id}, files: ['content.js']});
  const data = await chrome.tabs.sendMessage(tab.id, {action: 'xiaoxiao-capture', selectionOnly, fullPage});
  if (data?.error) throw new Error(data.error);
  if (!data?.text?.trim()) throw new Error('没有读取到文字。请先在网页中选中一段正文。');
  return {...data, sourceTabId: tab.id};
}
async function load(tab, selectionOnly = false, fullPage = false) {
  try {
    const data = await capture(tab, selectionOnly, fullPage);
    await chrome.storage.local.set({article: {...data, id: crypto.randomUUID(), requestedAt: Date.now()}});
  } catch (error) {
    await chrome.storage.local.set({article: {id: crypto.randomUUID(), error: error.message}});
  }
}
function sameOrigin(next, current) {
  try { return new URL(next).origin === new URL(current).origin; } catch { return false; }
}
// Read-in-new-page mode: open the same URL in a fresh tab (identical layout
// by construction), capture and read there, leaving the original tab alone.
let newTab = null;
async function loadInNewTab(tab, requestedUrl) {
  // Prefer the article's own source URL: the panel always knows it, so this
  // never depends on which window/tab currently has focus.
  const targetUrl = (requestedUrl && /^https?:/.test(requestedUrl)) ? requestedUrl
    : (tab?.url && /^https?:/.test(tab.url) ? tab.url : null);
  if (!targetUrl) {
    throw new Error('请先读取一个普通网页，再使用新页面朗读。');
  }
  const {captureScope} = await chrome.storage.local.get('captureScope');
  const fullPage = captureScope === 'full';
  let target = newTab;
  if (!target || target.url !== targetUrl) {
    if (target) chrome.tabs.remove(target.tabId).catch(() => {});
    target = null;
    const created = await chrome.tabs.create({url: targetUrl, active: true});
    target = {tabId: created.id, url: targetUrl};
    await new Promise(resolve => {
      const until = Date.now() + 15000;
      const check = () => chrome.tabs.get(created.id).then(info => {
        if (info.status === 'complete' || Date.now() > until) resolve();
        else setTimeout(check, 150);
      }).catch(() => resolve());
      check();
    });
    await new Promise(r => setTimeout(r, 400));
  }
  newTab = target;
  try {
    await chrome.scripting.executeScript({target: {tabId: target.tabId}, files: ['content.js']});
    const data = await chrome.tabs.sendMessage(target.tabId, {action: 'xiaoxiao-capture', fullPage});
    if (data?.error) throw new Error(data.error);
    if (!data?.text?.trim()) throw new Error('新页面没有读取到正文。');
    await chrome.storage.local.set({article: {...data, id: crypto.randomUUID(),
      requestedAt: Date.now(), sourceTabId: target.tabId}});
    return true;
  } catch (error) {
    // A dead or unreadable clone is closed; the original tab was never touched.
    chrome.tabs.remove(target.tabId).catch(() => {});
    newTab = null;
    throw error;
  }
}

// For sites with pagination or a next-article link, preload the following
// article so the reader can chain it after the current one finishes.
async function loadNext(tab) {
  if (!tab?.id || !/^https?:/.test(tab.url || '')) throw new Error('请先在一个普通网页上操作。');
  await chrome.scripting.executeScript({target: {tabId: tab.id}, files: ['content.js']});
  const link = await chrome.tabs.sendMessage(tab.id, {action: 'xiaoxiao-next-link'});
  if (link?.error) throw new Error(link.error);
  if (!link?.url) throw new Error('没有找到“下一篇”或“下一页”链接。');
  if (!sameOrigin(link.url, tab.url)) throw new Error('下一篇不在同一站点，已拒绝读取。');
  const nextTab = await chrome.tabs.create({url: link.url, active: false});
  try {
    await new Promise(resolve => {
      const until = Date.now() + 15000;
      const check = () => chrome.tabs.get(nextTab.id).then(info => {
        if (info.status === 'complete' || Date.now() > until) resolve();
        else setTimeout(check, 150);
      }).catch(() => resolve());
      check();
    });
    await chrome.scripting.executeScript({target: {tabId: nextTab.id}, files: ['content.js']});
    const data = await chrome.tabs.sendMessage(nextTab.id, {action: 'xiaoxiao-capture'});
    if (data?.error) throw new Error(data.error);
    if (!data?.text?.trim()) throw new Error('后续文章没有读取到正文。');
    await chrome.storage.local.set({article: {...data, id: crypto.randomUUID(), preload: true,
      requestedAt: Date.now(), sourceTabId: nextTab.id}});
  } finally {
    chrome.tabs.remove(nextTab.id).catch(() => {});
  }
  return true;
}
chrome.action.onClicked.addListener(async tab => {
  chrome.sidePanel.open({windowId: tab.windowId}).catch(console.error);
  const {captureScope} = await chrome.storage.local.get('captureScope');
  load(tab, false, captureScope === 'full');
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU) return;
  chrome.sidePanel.open({windowId: tab.windowId}).catch(console.error);
  load(tab, true);
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action === 'startService') {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('reader.html')) {
      sendResponse({ok: false, code: 'FORBIDDEN', error: '仅允许本扩展的朗读侧栏启动本机服务。'});
      return;
    }
    startService().then(sendResponse, error => sendResponse(nativeError(error)));
    return true;
  }
  if (message?.action === 'capture') {
    (async () => {
      const [tab] = await chrome.tabs.query({active: true, lastFocusedWindow: true});
      await load(tab, message.selectionOnly === true, message.fullPage === true);
      sendResponse({ok: true});
    })().catch(error => sendResponse({error: error.message}));
    return true;
  }
  if (message?.action === 'xiaoxiao-set-start') {
    if (!Number.isInteger(message.index) || message.index < 0) { sendResponse({ok: false}); return; }
    chrome.runtime.sendMessage({action: 'xiaoxiao-start-index', index: message.index}).catch(() => {});
    sendResponse({ok: true});
    return;
  }
  if (message?.action === 'readInNewTab') {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('reader.html')) {
      sendResponse({ok: false, error: '仅允许本扩展的朗读侧栏新开页面朗读。'});
      return;
    }
    (async () => {
      const [tab] = await chrome.tabs.query({active: true, lastFocusedWindow: true});
      await loadInNewTab(tab, typeof message.url === 'string' ? message.url : '');
      sendResponse({ok: true});
    })().catch(error => sendResponse({ok: false, error: error.message}));
    return true;
  }
  if (message?.action === 'nextArticle') {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('reader.html')) {
      sendResponse({ok: false, error: '仅允许本扩展的朗读侧栏载入下一篇。'});
      return;
    }
    (async () => {
      const [tab] = await chrome.tabs.query({active: true, lastFocusedWindow: true});
      await loadNext(tab);
      sendResponse({ok: true});
    })().catch(error => sendResponse({ok: false, error: error.message}));
    return true;
  }
  if (message.action === 'highlight' || message.action === 'clearHighlight' || message.action === 'highlightStatus') {
    if (!Number.isInteger(message.tabId)) { sendResponse({error: '没有可高亮的原网页。'}); return; }
    const action = {highlight: 'xiaoxiao-highlight', clearHighlight: 'xiaoxiao-clear', highlightStatus: 'xiaoxiao-status'}[message.action];
    chrome.tabs.sendMessage(message.tabId, {action, documentId: message.documentId, index: message.index, end: message.end, mode: message.mode, follow: message.follow})
      .then(result => sendResponse(result)).catch(error => sendResponse({error: error.message}));
    return true;
  }
});

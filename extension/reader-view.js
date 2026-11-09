(async () => {
  // The background writes the extract right before opening this tab, so the
  // value can land just after our first read — poll briefly before giving up.
  let readerView = null;
  for (let i = 0; i < 25; i++) {
    const data = await chrome.storage.local.get('readerView');
    if (data.readerView && data.readerView.html) { readerView = data.readerView; break; }
    await new Promise(r => setTimeout(r, 200));
  }
  const root = document.getElementById('rv-root');
  const wait = document.getElementById('rv-wait');
  if (!readerView) {
    wait.textContent = '没有可显示的内容。请先在侧栏读取网页，再点“新页面朗读”。';
    return;
  }
  root.innerHTML = readerView.html;
  document.title = readerView.title || '朗读视图';
  root.hidden = false;
  wait.remove();
  window.__xiaoxiaoReaderReady = true;
})();

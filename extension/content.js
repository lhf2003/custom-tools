// content.js — 页面正文采集
// 决策: D2 readability 抽取; D10 密码框整页排除 + 用户黑名单; D11 停留≥10s 才上报, SPA 路由算新页面

(() => {
  const DWELL_THRESHOLD_MS = 10_000;
  const MAX_CONTENT_CHARS = 20_000;
  const MIN_CONTENT_CHARS = 200; // 过短多为 feed/壳页面, 无检索价值 (D11)

  let dwellMs = 0;
  let lastTick = null;
  let reported = false;
  let currentUrl = location.href;

  function isBlacklisted(blacklist) {
    const host = location.hostname;
    return blacklist.some(d => host === d || host.endsWith('.' + d));
  }

  function hasPasswordField() {
    return !!document.querySelector('input[type="password"]');
  }

  /** N2: 提取页面主图 URL（og:image > twitter:image > 大面积 img） */
  function extractMainImageUrl() {
    const meta = document.querySelector('meta[property="og:image"]')
      || document.querySelector('meta[name="twitter:image"]')
      || document.querySelector('meta[name="twitter:image:src"]');
    if (meta?.content) return meta.content;
    // 备选：页面中面积最大的已加载 img（>=200x100 才算「主图」量级）
    let best = null, bestArea = 200 * 100;
    for (const img of document.querySelectorAll('img[src]')) {
      if (!img.complete || !img.naturalWidth) continue;
      const area = img.naturalWidth * img.naturalHeight;
      if (area > bestArea) { bestArea = area; best = img.src; }
    }
    return best;
  }

  function extract() {
    if (reported) return;
    if (hasPasswordField()) return; // D10 不可关闭的出厂底线
    try {
      const article = new Readability(document.cloneNode(true)).parse();
      const content = (article?.textContent || '').replace(/\s+\n/g, '\n').trim();
      if (content.length < MIN_CONTENT_CHARS) return;
      reported = true;
      chrome.runtime.sendMessage({
        kind: 'page',
        url: location.href,
        domain: location.hostname,
        title: article?.title || document.title,
        content: content.slice(0, MAX_CONTENT_CHARS),
        imageUrl: extractMainImageUrl(),
      });
    } catch (e) {
      // 抽取失败静默放弃本页（下个点还有机会）
    }
  }

  function tick() {
    const now = Date.now();
    if (document.visibilityState === 'visible' && lastTick !== null) {
      dwellMs += now - lastTick;
    }
    lastTick = now;
    if (!reported && dwellMs >= DWELL_THRESHOLD_MS) extract();
  }

  function resetForNavigation() {
    if (location.href === currentUrl) return;
    currentUrl = location.href;
    dwellMs = 0;
    reported = false;
    lastTick = Date.now();
  }

  // SPA 路由检测 (D11: 路由跳转算新页面)
  const wrap = (fn) => function (...args) {
    const r = fn.apply(this, args);
    setTimeout(resetForNavigation, 0);
    return r;
  };
  history.pushState = wrap(history.pushState);
  history.replaceState = wrap(history.replaceState);
  window.addEventListener('popstate', () => setTimeout(resetForNavigation, 0));

  chrome.storage.local.get('nervis_blacklist', (data) => {
    if (isBlacklisted(data['nervis_blacklist'] || [])) return;
    lastTick = Date.now();
    setInterval(tick, 1000);
  });
})();

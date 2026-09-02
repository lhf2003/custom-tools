// subtitle.js — B站/YouTube 字幕段级采集
// 决策: D3 一期字幕文本+时间戳, 段级检索跳转 ?t=秒; DOM 捕获（不依赖站点 API, 抗改版）
// 每 30s 或累计 ≥20 段未上报时冲刷一次; 页面隐藏时冲刷

(() => {
  const FLUSH_INTERVAL_MS = 30_000;
  const FLUSH_MIN_SEGMENTS = 5;
  const FLUSH_MAX_SEGMENTS = 20;

  const isBilibili = location.hostname.endsWith('bilibili.com');
  const isYoutube = location.hostname === 'www.youtube.com';

  // 各站字幕渲染节点选择器（DOM 路线, 站点改版时只需维护这里）
  // B站现状（2026-09 实测）: 新字幕引擎 subtitle-x，文本在 .bili-subtitle-x-subtitle-panel-text
  const SUBTITLE_SELECTORS = isBilibili
    ? ['.bili-subtitle-x-subtitle-panel-text']
    : isYoutube
      ? ['.ytp-caption-segment']
      : [];

  let segments = [];       // {start, text}
  let lastText = '';
  let pendingFrom = 0;     // 未上报段起始下标

  function getVideo() {
    return document.querySelector('video');
  }

  function currentSubtitleText() {
    for (const sel of SUBTITLE_SELECTORS) {
      const el = document.querySelector(sel);
      const t = el?.textContent?.trim();
      if (t) return t;
    }
    return '';
  }

  function sample() {
    const text = currentSubtitleText();
    if (!text || text === lastText) return;
    const video = getVideo();
    if (!video) return;
    lastText = text;
    const last = segments[segments.length - 1];
    // 连续重复文本去重: 仅当文本变化才记录新段
    if (last && last.text === text) return;
    segments.push({ start: Math.max(0, Math.floor(video.currentTime)), text });
  }

  // B站 BV 号在路径里（query 全是跟踪参数，可安全丢）；
  // YouTube 视频 id 在 ?v= 里，必须保留，否则跳转链接丢视频身份
  function pageUrl() {
    const u = new URL(location.href);
    const v = u.searchParams.get('v');
    return v ? `${u.origin}${u.pathname}?v=${v}` : `${u.origin}${u.pathname}`;
  }

  function flush(force = false) {
    const pending = segments.length - pendingFrom;
    if (pending < FLUSH_MIN_SEGMENTS) return;
    if (!force && pending < FLUSH_MAX_SEGMENTS) return;
    const batch = segments.slice(pendingFrom);
    pendingFrom = segments.length;
    chrome.runtime.sendMessage({
      kind: 'subtitle',
      url: pageUrl(),
      domain: location.hostname,
      title: document.title.replace(/_哔哩哔哩_bilibili$/, ''),
      segments: batch,
    });
  }

  function resetForNavigation() {
    flush(true);
    segments = [];
    pendingFrom = 0;
    lastText = '';
  }

  const wrap = (fn) => function (...args) {
    const r = fn.apply(this, args);
    setTimeout(resetForNavigation, 500);
    return r;
  };
  history.pushState = wrap(history.pushState);
  window.addEventListener('popstate', () => setTimeout(resetForNavigation, 500));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush(true);
  });

  // 字幕节点出现时机晚于 content script 注入, 用轮询采样兼容所有时序
  setInterval(sample, 500);
  setInterval(() => flush(false), FLUSH_INTERVAL_MS);
})();

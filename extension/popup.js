// popup.js — 2026-09-02 重构: 最近索引为主角的仪表盘（统计卡片/黑名单/清空已移至主程序「记忆设置」）
// 条目整行可点击打开原页; 视频进行中/失败附 ?t= 定位到最后已处理分片
async function send(msg) {
  return chrome.runtime.sendMessage(msg);
}

async function currentTabDomain() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try { return new URL(tab.url).hostname; } catch { return null; }
}

// ---- 最近索引（视频：标题 + 格子进度条 + 段数；文本页：标题 + 块数 · 域名 · 时间） ----
const GRID_CELLS = 36; // 单行固定格数, 长视频按比例压缩（LHF 定案：不多行平铺）
const SEGMENT_SECONDS = 10; // 画面分片 10s/个, ?t= 定位与格子条同源
const SVG_NS = 'http://www.w3.org/2000/svg';

/** ↗ 图标：hover 浮现, 提示整行可点击打开原页（静态 SVG, 无注入面） */
function buildGoIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'go');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('fill', 'none');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M3 9L9 3M9 3H4.5M9 3V7.5');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

/** 条目跳转链接：视频进行中/失败时附 ?t= 到最后已处理分片位置, 其余纯 url */
function entryUrl(it) {
  const job = it.job;
  if (job && (job.status === 'indexing' || job.status === 'failed')) {
    const processed = job.done + job.skipped;
    if (processed > 0) {
      return it.url + (it.url.includes('?') ? '&t=' : '?t=') + processed * SEGMENT_SECONDS;
    }
  }
  return it.url;
}

/** 格子进度条：每格代表 total/36 个 10s 分片, 已处理(done+skipped)点亮 */
function buildGridProgress(job) {
  const gp = document.createElement('div');
  gp.className = 'grid-progress';
  const cells = document.createElement('div');
  cells.className = 'cells';
  const processed = job.done + job.skipped; // skipped 是去重跳过, 也算已处理（否则重跑已索引视频格子不涨像卡住）
  const filled = job.total > 0
    ? Math.min(GRID_CELLS, Math.round(processed / job.total * GRID_CELLS))
    : (processed > 0 ? 1 : 0);
  for (let i = 0; i < GRID_CELLS; i++) {
    const c = document.createElement('i');
    if (i < filled) c.className = 'on';
    cells.appendChild(c);
  }
  gp.appendChild(cells);
  const pct = document.createElement('span');
  pct.className = 'pct';
  pct.textContent = job.total > 0 ? `${processed}/${job.total}` : `${processed} 段`;
  gp.appendChild(pct);
  return gp;
}

/**
 * 渲染最近索引列表；返回是否仍有索引中任务（决定轮询续不续）。
 * 视频条目（有画面/字幕段或有进行中任务）带格子进度条与状态；文本条目只显示块数统计。
 * jobs 快照合入对应条目；进行中任务若不在最近列表（首段未入库）补到最前。
 */
function renderPages(pages, jobs) {
  const box = document.getElementById('pageBox');
  // host 聚合 url 做过尾斜杠归一, jobs key 是提交原样——合并两侧都按归一值对齐
  const norm = (u) => u.replace(/\/+$/, '');
  const jobsByNormUrl = {};
  for (const [url, job] of Object.entries(jobs)) jobsByNormUrl[norm(url)] = job;
  const byUrl = new Map(pages.map(p => [norm(p.url), p]));
  const items = pages.map(p => ({ ...p, job: jobsByNormUrl[norm(p.url)] || null }));
  for (const [url, job] of Object.entries(jobs)) {
    if (!byUrl.has(norm(url)) && job.status === 'indexing') {
      items.unshift({ url, title: null, video_segments: 0, subtitle_segments: 0, text_chunks: 0, job });
    }
  }
  if (!items.length) {
    box.innerHTML = '<div class="empty">暂无（浏览 10 秒以上的页面会自动索引）</div>';
    return false;
  }
  box.innerHTML = '';
  let anyIndexing = false;
  for (const it of items.slice(0, 4)) {
    const row = document.createElement('a'); // 整行可点击: 新标签打开原页, 原生键盘可达
    row.className = 'entry-row';
    row.href = entryUrl(it); // href 属性赋值无注入面
    row.target = '_blank';
    row.rel = 'noreferrer';
    row.title = it.title || it.url;
    row.appendChild(buildGoIcon());

    const title = document.createElement('div');
    title.className = 'v-title';
    title.textContent = it.title || it.url; // textContent: 标题来自页面 document.title
    row.appendChild(title);

    const isVideo = it.video_segments > 0 || it.subtitle_segments > 0 || it.job;
    const job = it.job;
    // 格子条只在进行中/失败时显示（完成态只显示统计数字, LHF 定案）
    if (isVideo && job && (job.status === 'indexing' || job.status === 'failed')) {
      if (job.status === 'indexing') anyIndexing = true;
      row.appendChild(buildGridProgress(job));
    }

    const stats = document.createElement('div');
    stats.className = 'v-stats';
    const seg = document.createElement('span');
    if (isVideo) {
      seg.textContent = `画面 ${it.video_segments} 段 · 字幕 ${it.subtitle_segments} 段`;
    } else {
      let host = '';
      try { host = new URL(it.url).hostname; } catch { /* 非常规 url 省略域名 */ }
      const when = (it.last_indexed || '').slice(5, 16); // "MM-DD HH:MM"
      seg.textContent = `${it.text_chunks} 块 · ${host} · ${when}`;
    }
    stats.appendChild(seg);
    if (isVideo && job && job.status !== 'indexing') {
      const st = document.createElement('span');
      if (job.status === 'done') {
        st.className = 'v-status done';
        st.textContent = '索引完成';
      } else if (job.status === 'failed') {
        st.className = 'v-status failed';
        st.textContent = '索引失败';
        st.title = job.error || '';
      }
      stats.appendChild(st);
    }
    row.appendChild(stats);
    box.appendChild(row);
  }
  return anyIndexing;
}

// popup 打开期间有索引中任务则 2s 轮询（页面销毁定时器随之消失, 无需清理）
let pagePollTimer = null;
async function refreshPages() {
  let resp;
  try {
    resp = await send({ kind: 'getRecentPages' });
  } catch { return; } // SW 重启瞬态, 下轮再试
  if (!resp?.sent) {
    // host 不可达: 保留旧内容; 若仍是初始加载占位则明示未连接
    if (document.getElementById('pageLoading')) {
      document.getElementById('pageBox').innerHTML =
        '<div class="empty">主程序未运行，无法获取索引状态</div>';
    }
    return;
  }
  const { pages = [], jobs = {} } = resp.result || {};
  const anyIndexing = renderPages(pages, jobs);
  if (anyIndexing && !pagePollTimer) {
    pagePollTimer = setInterval(refreshPages, 2000);
  } else if (!anyIndexing && pagePollTimer) {
    clearInterval(pagePollTimer);
    pagePollTimer = null;
  }
}

async function refresh() {
  let state;
  try {
    state = await send({ kind: 'getState' });
  } catch { return; } // SW 重启瞬态: 保留初始「未连接」徽标
  const { stats, blacklist } = state;
  const conn = document.getElementById('conn');
  conn.textContent = stats.connected ? '已连接' : '未连接';
  conn.className = 'badge ' + (stats.connected ? 'on' : 'off');

  const domain = await currentTabDomain();
  const blocked = domain && blacklist.some(d => domain === d || domain.endsWith('.' + d));
  document.getElementById('curDomain').textContent = domain || '（不可索引的页面）';
  const btn = document.getElementById('btnBlock');
  btn.textContent = blocked ? '已加入黑名单' : '不再索引此站点';
  btn.disabled = !domain || blocked;
  btn.title = blocked ? '在主程序「记忆设置」中管理黑名单' : '';
  btn.onclick = async () => {
    if (!domain) return;
    await send({ kind: 'blockDomain', domain });
    refresh();
  };

  refreshPages();
}

// 打开记忆库: 聚焦 Nervis 主窗（检索入口 Alt+Space, host 拉起主 exe 由单例插件聚焦）
const btnOpen = document.getElementById('btnOpenMemory');
if (btnOpen) {
  btnOpen.disabled = false;
  btnOpen.onclick = async () => {
    const r = await send({ kind: 'focusApp' });
    if (!r.focused) {
      btnOpen.textContent = '主程序未运行';
      setTimeout(() => { btnOpen.textContent = '打开记忆库'; }, 2000);
    } else {
      window.close();
    }
  };
}

refresh();

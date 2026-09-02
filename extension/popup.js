// popup.js — D13 仪表盘: 连接状态 / 统计 / 黑名单管理 / 一键清除
async function send(msg) {
  return chrome.runtime.sendMessage(msg);
}

async function currentTabDomain() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try { return new URL(tab.url).hostname; } catch { return null; }
}

// ---- 最近视频（标题 + 画面/字幕段数 + 格子进度条） ----
const GRID_CELLS = 36; // 单行固定格数, 长视频按比例压缩（LHF 定案：不多行平铺）

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
 * 渲染视频列表；返回是否仍有索引中任务（决定轮询续不续）。
 * jobs 快照合入对应条目；进行中任务若不在最近列表（首段未入库）补到最前。
 */
function renderVideos(videos, jobs) {
  const box = document.getElementById('videoBox');
  // host 聚合 url 做过尾斜杠归一, jobs key 是提交原样——合并两侧都按归一值对齐
  const norm = (u) => u.replace(/\/+$/, '');
  const jobsByNormUrl = {};
  for (const [url, job] of Object.entries(jobs)) jobsByNormUrl[norm(url)] = job;
  const byUrl = new Map(videos.map(v => [norm(v.url), v]));
  const items = videos.map(v => ({ ...v, job: jobsByNormUrl[norm(v.url)] || null }));
  for (const [url, job] of Object.entries(jobs)) {
    if (!byUrl.has(norm(url)) && job.status === 'indexing') {
      items.unshift({ url, title: null, video_segments: 0, subtitle_segments: 0, job });
    }
  }
  if (!items.length) {
    box.innerHTML = '<div class="empty">暂无（视频页点「索引画面」开启）</div>';
    return false;
  }
  box.innerHTML = '';
  let anyIndexing = false;
  for (const it of items.slice(0, 4)) {
    const row = document.createElement('div');
    row.className = 'video-row';

    const title = document.createElement('div');
    title.className = 'v-title';
    title.textContent = it.title || it.url; // textContent: 标题来自页面 document.title
    title.title = it.title || it.url;
    row.appendChild(title);

    const job = it.job;
    // 格子条只在进行中/失败时显示（完成态只显示统计数字, LHF 定案）
    if (job && (job.status === 'indexing' || job.status === 'failed')) {
      if (job.status === 'indexing') anyIndexing = true;
      row.appendChild(buildGridProgress(job));
    }

    const stats = document.createElement('div');
    stats.className = 'v-stats';
    const seg = document.createElement('span');
    seg.textContent = `画面 ${it.video_segments} 段 · 字幕 ${it.subtitle_segments} 段`;
    stats.appendChild(seg);
    if (job && job.status !== 'indexing') {
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
let videoPollTimer = null;
async function refreshVideos() {
  let resp;
  try {
    resp = await send({ kind: 'getRecentVideos' });
  } catch { return; } // SW 重启瞬态, 下轮再试
  if (!resp?.sent) return; // host 不可达: 保留旧内容
  const { videos = [], jobs = {} } = resp.result || {};
  const anyIndexing = renderVideos(videos, jobs);
  if (anyIndexing && !videoPollTimer) {
    videoPollTimer = setInterval(refreshVideos, 2000);
  } else if (!anyIndexing && videoPollTimer) {
    clearInterval(videoPollTimer);
    videoPollTimer = null;
  }
}

function renderBlacklist(list) {
  const box = document.getElementById('blacklistBox');
  if (!list.length) {
    box.innerHTML = '<div class="empty">暂无</div>';
    return;
  }
  box.innerHTML = '';
  for (const d of list) {
    const row = document.createElement('div');
    row.className = 'domain-row';
    const span = document.createElement('span');
    span.textContent = d; // textContent: 域名经设置页自由输入入库, 不走 innerHTML
    const actions = document.createElement('div');
    actions.className = 'actions';
    const btn = document.createElement('button');
    btn.textContent = '移除';
    btn.onclick = async () => {
      await send({ kind: 'unblockDomain', domain: d });
      refresh();
    };
    actions.appendChild(btn);
    row.appendChild(span);
    row.appendChild(actions);
    box.appendChild(row);
  }
}

async function refresh() {
  const { stats, blacklist } = await send({ kind: 'getState' });
  document.getElementById('statPages').textContent = stats.pages;
  document.getElementById('statSubs').textContent = stats.subtitleSegments;
  document.getElementById('statQueue').textContent = stats.queue;
  const conn = document.getElementById('conn');
  conn.textContent = stats.connected ? '已连接' : '未连接';
  conn.className = 'badge ' + (stats.connected ? 'on' : 'off');

  const domain = await currentTabDomain();
  const blocked = domain && blacklist.some(d => domain === d || domain.endsWith('.' + d));
  document.getElementById('curDomain').textContent = domain || '（不可索引的页面）';
  const btn = document.getElementById('btnBlock');
  btn.textContent = blocked ? '已加入黑名单' : '不再索引此站点';
  btn.disabled = !domain || blocked;
  btn.onclick = async () => {
    if (!domain) return;
    await send({ kind: 'blockDomain', domain });
    refresh();
  };

  renderBlacklist(blacklist);
  refreshVideos();
}

document.getElementById('btnClear').onclick = async () => {
  if (!confirm('物理删除全部浏览页面与字幕索引，不可恢复。确认？')) return;
  await send({ kind: 'clearBrowsing' });
  refresh();
};

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

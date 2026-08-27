// popup.js — D13 仪表盘: 连接状态 / 统计 / 黑名单管理 / 一键清除
async function send(msg) {
  return chrome.runtime.sendMessage(msg);
}

async function currentTabDomain() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try { return new URL(tab.url).hostname; } catch { return null; }
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
    row.innerHTML = `<span>${d}</span><div class="actions"><button data-d="${d}">移除</button></div>`;
    row.querySelector('button').onclick = async () => {
      await send({ kind: 'unblockDomain', domain: d });
      refresh();
    };
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

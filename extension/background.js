// background.js — service worker: native port 管理 + 队列 + 统计 + 黑名单
// 设计: D6 native messaging 唯一通道; D13 popup 状态仪表盘数据源
// 黑名单: SQLite 单真源（设置页与扩展共享）, chrome.storage.local 只是缓存;
// host 不可达时的增删进 pending_ops, 下次连通先重放再拉全量

const HOST_NAME = 'com.nervis.memory';
const STATS_KEY = 'nervis_stats';
const BLACKLIST_KEY = 'nervis_blacklist';
const PENDING_OPS_KEY = 'nervis_pending_ops';
const MIGRATED_KEY = 'nervis_blacklist_migrated';

let port = null;
let reconnectTimer = null;
let reqSeq = 0;
const pendingCalls = new Map(); // req_id -> {resolve, reject, timer}
const QUEUE_KEY = 'nervis_queue'; // storage.session: SW 被杀后队列不丢（MV3 生命周期）

async function loadQueue() {
  return (await chrome.storage.session.get(QUEUE_KEY))[QUEUE_KEY] || [];
}

async function saveQueue(q) {
  await chrome.storage.session.set({ [QUEUE_KEY]: q });
}

function rejectAllCalls(err) {
  for (const [, c] of pendingCalls) {
    clearTimeout(c.timer);
    c.reject(err);
  }
  pendingCalls.clear();
}

function connect() {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    port = null;
    scheduleReconnect();
    return;
  }
  port.onMessage.addListener((resp) => {
    // 无 req_id 的回包来自入队消息（outcome 无消费方）, 直接忽略
    if (resp && typeof resp.req_id === 'number' && pendingCalls.has(resp.req_id)) {
      const c = pendingCalls.get(resp.req_id);
      pendingCalls.delete(resp.req_id);
      clearTimeout(c.timer);
      if (resp.ok) c.resolve(resp.result);
      else c.reject(new Error(resp.error || 'native error'));
    }
  });
  port.onDisconnect.addListener(() => {
    // 必须读 lastError——否则 SW 控制台刷 "Unchecked runtime.lastError"
    const reason = chrome.runtime.lastError?.message;
    port = null;
    rejectAllCalls(new Error(reason || 'native host disconnected'));
    scheduleReconnect();
  });
  flushQueue();
  syncBlacklist();
}

function scheduleReconnect() {
  updateStats({ connected: false });
  // MV3: setTimeout 不可靠（SW 随时被杀）, 保活重试交给 chrome.alarms
  if (!reconnectTimer) {
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 5000);
  }
}

async function sendNative(msg) {
  const q = await loadQueue();
  q.push(msg);
  await saveQueue(q);
  updateStats({ queue: q.length });
  if (!port) {
    connect();
    return;
  }
  flushQueue();
}

/** 请求-响应调用（不入队, 需即时回包）; host 不可达时 reject */
function callNative(msg, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    if (!port) {
      connect();
      if (!port) return reject(new Error('native host unavailable'));
    }
    const req_id = ++reqSeq;
    const timer = setTimeout(() => {
      pendingCalls.delete(req_id);
      reject(new Error('native call timeout'));
    }, timeoutMs);
    pendingCalls.set(req_id, { resolve, reject, timer });
    try {
      port.postMessage({ ...msg, req_id });
    } catch (e) {
      pendingCalls.delete(req_id);
      clearTimeout(timer);
      reject(e);
    }
  });
}

async function flushQueue() {
  if (!port) return;
  let q = await loadQueue();
  const remaining = [];
  for (const m of q) {
    try { port.postMessage(m); } catch (e) { remaining.push(m); }
  }
  if (remaining.length !== q.length) await saveQueue(remaining);
  updateStats({ queue: remaining.length, connected: !!port });
}

// ---- 统计（D13: 页面/字幕段/队列） ----
async function getStats() {
  const s = (await chrome.storage.local.get(STATS_KEY))[STATS_KEY];
  const today = new Date().toISOString().slice(0, 10);
  const q = await loadQueue();
  if (!s || s.day !== today) {
    return { day: today, pages: 0, subtitleSegments: 0, queue: q.length, connected: !!port };
  }
  return { ...s, queue: q.length, connected: !!port };
}

async function updateStats(patch) {
  const s = await getStats();
  await chrome.storage.local.set({ [STATS_KEY]: { ...s, ...patch } });
}

// ---- 黑名单（SQLite 单真源 + 本地缓存 + 离线操作重放） ----
async function getBlacklist() {
  return (await chrome.storage.local.get(BLACKLIST_KEY))[BLACKLIST_KEY] || [];
}

async function loadPendingOps() {
  return (await chrome.storage.local.get(PENDING_OPS_KEY))[PENDING_OPS_KEY] || [];
}

async function savePendingOps(ops) {
  await chrome.storage.local.set({ [PENDING_OPS_KEY]: ops });
}

/** M2 时代本地黑名单一次性迁移：host 空 + 本地非空时把本地推给 host（否则首次拉取会抹掉存量） */
async function migrateLocalBlacklistOnce() {
  const done = (await chrome.storage.local.get(MIGRATED_KEY))[MIGRATED_KEY];
  if (done) return;
  const local = await getBlacklist();
  if (local.length) {
    const r = await callNative({ type: 'get_blacklist' });
    const hostList = r.blacklist || [];
    for (const d of local) {
      if (!hostList.includes(d)) await callNative({ type: 'block_domain', domain: d });
    }
  }
  await chrome.storage.local.set({ [MIGRATED_KEY]: true }); // 推送中途失败不置标记, 下次同步重试
}

/** 连通时: 先重放离线增删, 再做一次性迁移, 最后拉全量覆盖本地缓存 */
async function syncBlacklist() {
  if (!port) return;
  try {
    for (const op of await loadPendingOps()) {
      const t = op.op === 'block' ? 'block_domain' : 'unblock_domain';
      await callNative({ type: t, domain: op.domain });
    }
    await savePendingOps([]);
    await migrateLocalBlacklistOnce();
    const r = await callNative({ type: 'get_blacklist' });
    await chrome.storage.local.set({ [BLACKLIST_KEY]: r.blacklist || [] });
  } catch (e) { /* host 中途断开: 保留缓存与 pending_ops, 下次连通再同步 */ }
}

/** 增删统一入口: host 可达以其返回为准; 不可达改本地缓存并登记重放 */
async function mutateBlacklist(op, domain) {
  try {
    const r = await callNative({ type: op === 'block' ? 'block_domain' : 'unblock_domain', domain });
    await chrome.storage.local.set({ [BLACKLIST_KEY]: r.blacklist || [] });
  } catch (e) {
    const list = await getBlacklist();
    const next = op === 'block'
      ? (list.includes(domain) ? list : [...list, domain])
      : list.filter(d => d !== domain);
    await chrome.storage.local.set({ [BLACKLIST_KEY]: next });
    const ops = (await loadPendingOps()).filter(o => o.domain !== domain);
    ops.push({ op, domain });
    await savePendingOps(ops);
  }
  return getBlacklist();
}

// ---- N2: 页面主图 fetch → base64（SW 不受页面 CORS 限制） ----
const IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 5MB 上限，过大跳过

async function fetchImageBase64(url) {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return null;
    const blob = await resp.blob();
    if (blob.size > IMAGE_MAX_BYTES) return null;
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return { base64: btoa(binary), mime: blob.type || 'image/jpeg' };
  } catch (e) {
    return null; // 图片 fetch 失败不阻塞正文索引
  }
}

// ---- 消息路由 ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.kind) {
      case 'page': {
        const list = await getBlacklist();
        if (list.some(d => msg.domain === d || msg.domain.endsWith('.' + d))) return { dropped: 'blacklist' };
        // N2: 有主图 URL 时后台 fetch 转 base64（失败/过大则 null，不阻塞正文）
        let image_base64 = null, image_mime = null;
        if (msg.imageUrl) {
          const img = await fetchImageBase64(msg.imageUrl);
          if (img) { image_base64 = img.base64; image_mime = img.mime; }
        }
        sendNative({
          type: 'index',
          source: 'browser',
          url: msg.url,
          domain: msg.domain,
          title: msg.title,
          content: msg.content,
          image_base64,
          image_mime,
          created_at: new Date().toISOString(),
        });
        const s = await getStats();
        await updateStats({ pages: s.pages + 1 });
        return { sent: true };
      }
      case 'subtitle': {
        const list = await getBlacklist();
        if (list.some(d => msg.domain === d || msg.domain.endsWith('.' + d))) return { dropped: 'blacklist' };
        sendNative({
          type: 'index_subtitle',
          url: msg.url,
          domain: msg.domain,
          title: msg.title,
          segments: msg.segments,
          created_at: new Date().toISOString(),
        });
        const s = await getStats();
        await updateStats({ subtitleSegments: s.subtitleSegments + msg.segments.length });
        return { sent: true };
      }
      case 'video_segment': {
        // N3: 视频画面分片（opt-in 录制, ~2.7MB base64）——整视频索引不可用时的兜底路径
        // 用 callNative（请求-响应）而非 sendNative（入队）——embed 失败的错误需要回到 content script
        const list = await getBlacklist();
        if (list.some(d => msg.domain === d || msg.domain.endsWith('.' + d))) return { dropped: 'blacklist' };
        try {
          const r = await callNative({
            type: 'index_video',
            url: msg.url,
            domain: msg.domain,
            title: msg.title,
            start_seconds: msg.startSeconds,
            end_seconds: msg.endSeconds,
            video_base64: msg.video_base64,
            created_at: new Date().toISOString(),
          }, 300_000); // 视频 embed 数秒~数十秒/段（帧预算 640×360×24），留足余量
          return { sent: true, result: r };
        } catch (e) {
          return { sent: false, error: String(e) };
        }
      }
      case 'index_video_full': {
        // 整视频后台索引：host 立即应答 accepted，长任务在 host 后台线程跑
        const list = await getBlacklist();
        if (list.some(d => msg.domain === d || msg.domain.endsWith('.' + d))) return { dropped: 'blacklist' };
        try {
          const r = await callNative({
            type: 'index_video_url',
            url: msg.url,
            domain: msg.domain,
            title: msg.title,
            video_url: msg.video_url,
            duration_secs: msg.duration_secs,
            created_at: new Date().toISOString(),
          }, 10_000);
          return { sent: true, result: r };
        } catch (e) {
          return { sent: false, error: String(e) };
        }
      }
      case 'video_index_progress': {
        try {
          const r = await callNative({ type: 'video_index_progress', url: msg.url }, 3_000);
          return { sent: true, result: r };
        } catch (e) {
          return { sent: false, error: String(e) };
        }
      }
      case 'getRecentVideos': {
        // popup 仪表盘：最近视频段数聚合 + 进行中任务快照（host 一次返回）
        try {
          const r = await callNative({ type: 'recent_videos' }, 5_000);
          return { sent: true, result: r };
        } catch (e) {
          return { sent: false, error: String(e) };
        }
      }
      case 'getState': {
        const stats = await getStats();
        const blacklist = await getBlacklist();
        return { stats, blacklist };
      }
      case 'blockDomain': {
        const list = await mutateBlacklist('block', msg.domain);
        return { blacklist: list }; // host 侧已物理清除该域存量
      }
      case 'unblockDomain': {
        const list = await mutateBlacklist('unblock', msg.domain);
        return { blacklist: list };
      }
      case 'clearBrowsing': {
        sendNative({ type: 'clear_browsing' });
        return { cleared: true };
      }
      case 'focusApp': {
        try {
          await callNative({ type: 'focus_app' });
          return { focused: true };
        } catch (e) {
          return { focused: false, error: String(e) };
        }
      }
      default:
        return { error: 'unknown kind' };
    }
  })().then(sendResponse);
  return true; // async sendResponse
});

// MV3 保活: alarms 是唯一可靠的周期事件源, SW 被杀后由 alarm 唤醒补重连/冲刷
chrome.alarms.create('nervis-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'nervis-keepalive') {
    if (!port) connect();
    else { flushQueue(); syncBlacklist(); } // 设置页改的黑名单 ≤30s 同步到扩展缓存
  }
});

connect();

// playinfo-probe.js — 主世界探针：隔离世界的 content script 读不到 window.__playinfo__，
// 由本脚本（manifest world:MAIN）代为提取并通过 CustomEvent 回传（detail 只能是可克隆值，用 JSON 字符串）
(() => {
  window.addEventListener('nervis:get-playinfo', () => {
    let out = null;
    try {
      const pi = window.__playinfo__;
      const vids = pi?.data?.dash?.video || [];
      // 只取 avc(h264)：解码兼容性最好；按码率升序取最低（索引只需 360p 级，省流量省解码）
      const avc = vids.filter(v => (v.codecs || '').startsWith('avc')).sort((a, b) => a.bandwidth - b.bandwidth);
      const v = avc[0];
      if (v) {
        out = {
          video_url: v.baseUrl || v.base_url,
          duration: Math.round((pi.data.timelength || 0) / 1000),
        };
      }
    } catch { /* out 保持 null，调用方走录制兜底 */ }
    window.dispatchEvent(new CustomEvent('nervis:playinfo', { detail: JSON.stringify(out) }));
  });
})();

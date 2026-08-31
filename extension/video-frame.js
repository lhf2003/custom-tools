// video-frame.js — B站/YouTube 视频画面 opt-in 采集（N3）
// 裁决 CASE-007 Q3：纯 opt-in，用户点按钮才录；Q1：整段 10s webm 直送 WeMM（弃抽帧）
// 采集参数照 Indexed：video → 720p canvas → captureStream(4fps) → MediaRecorder 1.6Mbps → 10s 分片

(() => {
  const SLICE_SECONDS = 10;
  const CANVAS_W = 1280, CANVAS_H = 720;
  const FPS = 4;
  const BITRATE = 1_600_000; // 1.6Mbps
  const MAX_RETRY_MS = 15_000; // 播放器出现的最长等待

  let recorder = null;
  let recordStart = 0;    // 录制起始的 video.currentTime
  let countdownTimer = null;
  let btn = null;

  function getVideo() {
    return document.querySelector('video');
  }

  function playerContainer(video) {
    // B站/YouTube 播放器容器（决定按钮锚点；拿不到的回落 body fixed）
    return video.closest('.bpx-player-container')
      || video.closest('.bilibili-player')
      || video.closest('#movie_player')
      || video.closest('.html5-video-player')
      || null;
  }

  function stopRecording(finished) {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    recorder = null;
    if (btn) {
      btn.textContent = '索引画面';
      btn.classList.remove('nervis-recording');
    }
    if (!finished) return; // 手动停止走 onstop 照常上报已录部分? 不上报——丢弃不足 10s 的片段
  }

  async function startRecording(video) {
    // video → canvas 逐帧绘制（控制 720p 输出 + fps）
    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    const ctx = canvas.getContext('2d');
    let drawing = true;
    function drawFrame() {
      if (!drawing) return;
      if (!video.paused && !video.ended && video.videoWidth > 0) {
        // 等比缩放填充（contain）
        const scale = Math.min(CANVAS_W / video.videoWidth, CANVAS_H / video.videoHeight);
        const w = video.videoWidth * scale, h = video.videoHeight * scale;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
        ctx.drawImage(video, (CANVAS_W - w) / 2, (CANVAS_H - h) / 2, w, h);
      }
      setTimeout(drawFrame, 1000 / FPS);
    }
    drawFrame();

    const stream = canvas.captureStream(FPS);
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : 'video/webm';
    const chunks = [];
    recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: BITRATE });
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = async () => {
      drawing = false;
      stream.getTracks().forEach(t => t.stop());
      const dur = (video.currentTime - recordStart);
      const blob = new Blob(chunks, { type: 'video/webm' });
      console.log('[nervis] recording stopped, dur=', dur.toFixed(1), 's, chunks=', chunks.length, 'blobSize=', blob.size);
      if (dur < SLICE_SECONDS * 0.6) return; // 手动提前停/不足 60% 丢弃
      const buf = await blob.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      const CHUNK = 8192;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      }
      chrome.runtime.sendMessage({
        kind: 'video_segment',
        url: location.href.split('?')[0].split('#')[0],
        domain: location.hostname,
        title: document.title.replace(/_哔哩哔哩_bilibili$/, ''),
        startSeconds: Math.max(0, Math.floor(recordStart)),
        endSeconds: Math.floor(video.currentTime),
        video_base64: btoa(binary),
      }).then(
        (resp) => console.log('[nervis] video_segment sent, resp=', resp),
        (err) => console.warn('[nervis] video_segment send failed:', err)
      );
    };

    recordStart = video.currentTime;
    recorder.start(1000); // 每秒吐一次数据，stop 时聚合
    console.log('[nervis] MediaRecorder started, mime=', mime);

    // 倒计时自动停
    let remain = SLICE_SECONDS;
    if (btn) btn.textContent = `录制中 ${remain}s（再点取消）`;
    countdownTimer = setInterval(() => {
      remain -= 1;
      if (remain <= 0) {
        stopRecording(true);
      } else if (btn) {
        btn.textContent = `录制中 ${remain}s（再点取消）`;
      }
    }, 1000);
  }

  function injectButton(video) {
    if (btn || !video) return;
    btn = document.createElement('button');
    btn.textContent = '索引画面';
    btn.style.cssText = `
      position:absolute; right:12px; bottom:64px; z-index:9999;
      padding:5px 12px; border-radius:8px; border:1px solid rgba(255,255,255,.25);
      background:rgba(20,20,24,.72); color:rgba(255,255,255,.85);
      font-size:12px; cursor:pointer; backdrop-filter:blur(8px);
      transition: background .15s;
    `;
    btn.addEventListener('mouseenter', () => { if (!btn.classList.contains('nervis-recording')) btn.style.background = 'rgba(60,60,70,.85)'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'rgba(20,20,24,.72)'; });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      console.log('[nervis] 索引画面 clicked, paused=', video.paused, 'videoWidth=', video.videoWidth, 'currentTime=', video.currentTime);
      if (recorder) { stopRecording(false); return; }
      if (video.paused) { btn.textContent = '先播放视频再录制'; setTimeout(() => { if (btn && !recorder) btn.textContent = '索引画面'; }, 1500); return; }
      btn.classList.add('nervis-recording');
      startRecording(video);
    });

    const container = playerContainer(video);
    if (container) {
      const cs = getComputedStyle(container);
      if (cs.position === 'static') container.style.position = 'relative';
      container.appendChild(btn);
    } else {
      btn.style.position = 'fixed';
      document.body.appendChild(btn);
    }
  }

  // 播放器出现时机晚于 content script 注入，轮询等待
  const bootTimer = setInterval(() => {
    const video = getVideo();
    if (video) {
      injectButton(video);
      clearInterval(bootTimer);
    }
  }, 1000);
  setTimeout(() => clearInterval(bootTimer), MAX_RETRY_MS);

  // SPA 换视频：按钮随旧容器销毁后重注
  const wrap = (fn) => function (...args) {
    const r = fn.apply(this, args);
    setTimeout(() => {
      stopRecording(false);
      if (btn && !document.contains(btn)) btn = null;
      const video = getVideo();
      if (video && !btn) injectButton(video);
    }, 800);
    return r;
  };
  history.pushState = wrap(history.pushState);
  window.addEventListener('popstate', () => setTimeout(() => {
    stopRecording(false);
    if (btn && !document.contains(btn)) btn = null;
    const video = getVideo();
    if (video && !btn) injectButton(video);
  }, 800));
})();

//! 流式 TTS 播报:MOSS-TTS 1.5 Flash 原始 PCM 流 → rodio 边收边播。
//! 打断模型:interrupt 置 cancel + 取走 sender → 播放端读尽即停,watcher 见 cancel
//! 立刻 drop 流。播报失败(未配 Key/无音频设备/网络错)一律静默——
//! 语音是增强体验,不能反过来打扰他。
//!
//! 设备选择:每次播报按「当前系统默认输出」开新流,播完/被打断即释放。
//! 不能常驻流——WASAPI 流创建时绑死设备,常驻会钉死在启动时的设备上
//! (2026-08-12 bug:系统切扬声器后播报仍走耳机,其他应用都正常)。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use rodio::Source;
use tauri::{AppHandle, Emitter, State};

use super::{load_api_key, API_BASE};
use crate::companion::analyzer;

/// 默认音色(LHF 2026-08-12 选定);settings 表 moss_voice_id 可覆盖
const DEFAULT_VOICE_ID: &str = "91d06f93-c5dc-52a8-92d6-335008306e95";
/// 自动播报总开关(settings 表;缺省开,设 "false" 关)
const ENABLED_SETTING: &str = "moss_tts_enabled";
const VOICE_SETTING: &str = "moss_voice_id";
const SPEED_SETTING: &str = "moss_tts_speed";
/// 收流上限:整段回复播报也就几十秒,异常悬挂的流不能留着
const STREAM_TIMEOUT: Duration = Duration::from_secs(180);

/// 一次播报的控制柄:cancel 请求停止;tx 被 take 则播放端读尽残余即终结
struct PlaybackHandle {
    tx: Mutex<Option<mpsc::Sender<Vec<i16>>>>,
    cancel: AtomicBool,
}

/// 当前播报句柄(新播报替换旧句柄)。音频流不常驻,见文件头注释。
pub struct TtsState {
    current: Mutex<Option<Arc<PlaybackHandle>>>,
}

impl TtsState {
    pub fn new() -> Self {
        Self {
            current: Mutex::new(None),
        }
    }

    /// 打断当前播报:置 cancel + 取走 sender(播放端立刻断粮),广播 done 清前端播放态。
    /// 流的释放在 watcher 任务里做(见 cancel 立即 drop,不等播完)。
    fn interrupt(&self, app_handle: &AppHandle) {
        let handle = self
            .current
            .lock()
            .ok()
            .and_then(|mut guard| guard.take());
        if let Some(handle) = handle {
            handle.cancel.store(true, Ordering::SeqCst);
            if let Ok(mut tx) = handle.tx.lock() {
                tx.take();
            }
            let _ = app_handle.emit("moss:tts:done", ());
        }
    }
}

/// mpsc 驱动的 PCM source:有数据放数据;暂时无数据补静音(生成/网络抖动不判死);
/// 所有 sender drop(Disconnected)且缓冲读尽后置 ended 并返回 None 自然结束。
/// 样本按服务端声明的 channels/sample_rate 解释,i16 LE → f32 归一。
struct PcmStreamSource {
    rx: mpsc::Receiver<Vec<i16>>,
    chunk: std::collections::VecDeque<i16>,
    channels: u16,
    sample_rate: u32,
    ended: Arc<AtomicBool>,
}

impl Iterator for PcmStreamSource {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        loop {
            if let Some(s) = self.chunk.pop_front() {
                return Some(f32::from(s) / 32768.0);
            }
            match self.rx.try_recv() {
                Ok(buf) => self.chunk = buf.into(),
                Err(mpsc::TryRecvError::Empty) => return Some(0.0),
                Err(mpsc::TryRecvError::Disconnected) => {
                    self.ended.store(true, Ordering::SeqCst);
                    return None;
                }
            }
        }
    }
}

impl Source for PcmStreamSource {
    fn current_span_len(&self) -> Option<usize> {
        None
    }

    fn channels(&self) -> u16 {
        self.channels
    }

    fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    fn total_duration(&self) -> Option<Duration> {
        None
    }
}

/// 收流:字节流 → i16 样本(跨 chunk 奇数字节经 leftover 拼接)→ 喂 channel。
/// cancel 或播放端终结(send 失败)即退。
async fn pump_pcm_stream(
    mut resp: reqwest::Response,
    handle: &PlaybackHandle,
) -> Result<(), String> {
    let mut leftover: Vec<u8> = Vec::new();
    loop {
        if handle.cancel.load(Ordering::SeqCst) {
            break;
        }
        let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| format!("读取 PCM 流失败: {e}"))?
        else {
            break;
        };
        let mut buf = std::mem::take(&mut leftover);
        buf.extend_from_slice(&chunk);
        let aligned = buf.len() / 2 * 2;
        leftover = buf.split_off(aligned);
        let samples: Vec<i16> = buf
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]))
            .collect();
        let sent = handle.tx.lock().ok().and_then(|guard| {
            guard.as_ref().map(|tx| tx.send(samples))
        });
        // 播放端已终结(被打断 take 走 sender)则没必要继续收
        if !matches!(sent, Some(Ok(()))) {
            break;
        }
    }
    Ok(())
}

/// 语速设置(settings 表;缺省 1.0,非法值静默回默认,超界 clamp 到契约 0.25–4)
fn load_speed(db_path: &std::path::PathBuf) -> f64 {
    analyzer::load_setting(db_path, SPEED_SETTING)
        .and_then(|v| v.parse::<f64>().ok())
        .map(|s| s.clamp(0.25, 4.0))
        .unwrap_or(1.0)
}

/// 从响应头解析 PCM 格式参数(契约必有;缺失/非法按错误处理)
fn parse_pcm_format(resp: &reqwest::Response) -> Result<(u16, u32), String> {
    let header_u32 = |name: &str| -> Result<u32, String> {
        resp.headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u32>().ok())
            .ok_or_else(|| format!("TTS 响应缺少有效 {name} 头"))
    };
    let sample_rate = header_u32("X-Sample-Rate")?;
    let channels = header_u32("X-Channels")?;
    let bit_depth = header_u32("X-Bit-Depth")?;
    if bit_depth != 16 {
        return Err(format!("暂不支持 {bit_depth} 位深(仅 16bit PCM)"));
    }
    if channels == 0 || channels > u16::MAX as u32 {
        return Err(format!("TTS 声道数非法: {channels}"));
    }
    if sample_rate == 0 {
        return Err("TTS 采样率为 0".to_string());
    }
    Ok((channels as u16, sample_rate))
}

/// 语音播报:文本 → 流式 TTS → 即收即播。
/// 开关/Key/音频设备任一不可用都静默 Ok(()),前端无需判断;新播报自动打断旧播报。
#[tauri::command]
pub async fn moss_tts_speak(
    app_handle: AppHandle,
    db_state: State<'_, crate::db::DatabaseState>,
    tts_state: State<'_, TtsState>,
    text: String,
) -> Result<(), String> {
    // 总开关后端收口:toast/聊天等触发点无脑调,此处统一裁决
    let enabled = analyzer::load_setting(&db_state.0, ENABLED_SETTING)
        .map(|v| v != "false")
        .unwrap_or(true);
    let text = text.trim().to_string();
    if !enabled || text.is_empty() {
        return Ok(());
    }

    let api_key = load_api_key(&app_handle, &db_state.0)?;
    let voice_id = analyzer::load_setting(&db_state.0, VOICE_SETTING)
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_VOICE_ID.to_string());
    let speed = load_speed(&db_state.0);

    let client = crate::http::build_client(STREAM_TIMEOUT)?;
    let resp = client
        .post(format!("{API_BASE}/audio/speech"))
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&serde_json::json!({
            // 原始 PCM 模式:省略 stream_format,格式参数走响应头,免 SSE/base64 解析
            "model": "moss-tts",
            "version": "flash-20260626",
            "input": text,
            "voice_id": voice_id,
            "speed": speed,
            "stream": true,
            "response_format": "pcm",
        }))
        .send()
        .await
        .map_err(|e| format!("TTS 请求失败: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let msg = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| {
                v.pointer("/error/message")
                    .and_then(|m| m.as_str())
                    .map(String::from)
            })
            .unwrap_or_else(|| body.chars().take(200).collect());
        return Err(format!("TTS 失败({status}): {msg}"));
    }

    let (channels, sample_rate) = parse_pcm_format(&resp)?;

    // 每次播报按当前系统默认输出开新流(跟随用户在 Windows 里的设备切换);
    // 打开失败静默跳过(无音频设备不打扰)
    let stream = match rodio::OutputStreamBuilder::open_default_stream() {
        Ok(s) => s,
        Err(e) => {
            log::warn!("[tts] 打开音频输出失败,本次播报跳过: {e}");
            return Ok(());
        }
    };
    let mixer = stream.mixer().clone();

    // 新播报打断旧播报,再挂新 source(播放线程即刻拉取,首包前静音填充)
    tts_state.interrupt(&app_handle);
    let (tx, rx) = mpsc::channel::<Vec<i16>>();
    let ended = Arc::new(AtomicBool::new(false));
    let source = PcmStreamSource {
        rx,
        chunk: std::collections::VecDeque::new(),
        channels,
        sample_rate,
        ended: ended.clone(),
    };
    mixer.add(source);

    let handle = Arc::new(PlaybackHandle {
        tx: Mutex::new(Some(tx)),
        cancel: AtomicBool::new(false),
    });
    if let Ok(mut guard) = tts_state.current.lock() {
        *guard = Some(handle.clone());
    }

    // watcher:收流 → 断粮让播放端收尾 → 等播尽或 cancel → drop 流释放设备。
    // 正常播尽广播 done;被打断时 done 已由 interrupt 广播,此处重复广播无害(幂等清态)。
    let app_handle2 = app_handle.clone();
    tokio::task::spawn(async move {
        if let Err(e) = pump_pcm_stream(resp, &handle).await {
            log::warn!("[tts] PCM 收流异常: {e}");
        }
        // 确保 sender 释放(正常 EOF 路径),播放端读尽残余后置 ended
        if let Ok(mut tx) = handle.tx.lock() {
            tx.take();
        }
        while !ended.load(Ordering::SeqCst) && !handle.cancel.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        drop(stream);
        let _ = app_handle2.emit("moss:tts:done", ());
    });
    Ok(())
}

/// 停止当前播报(toast 关闭/发新消息/取消生成时调用)
#[tauri::command]
pub fn moss_tts_stop(app_handle: AppHandle, tts_state: State<'_, TtsState>) -> Result<(), String> {
    tts_state.interrupt(&app_handle);
    Ok(())
}

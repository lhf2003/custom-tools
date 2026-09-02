//! WeMM Python sidecar 客户端：Rust ⇄ Python 推理进程（D1 stdio JSON 帧）
//!
//! 协议与 Python 侧对称：[u32 LE 长度][JSON] 帧，握手 loading -> ready / error(gpu_required)。
//! 生命周期：按需拉起（首次调用 spawn），watchdog 空闲 30 分钟自动回收（N1 显存/内存约束）。
//! sidecar 源码在仓库 sidecar/wemm/（协议见 server.py 头注释）。

use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 空闲回收阈值（显存 5.1GB 常驻代价高；重新拉起冷启动 ~15s 由下一次查询承担）
const IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// 帧长上限（对齐 Python 侧 64MB：视频 base64 单段 ~2.7MB）
const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;

/// embedding 引擎抽象（bge 实现 N1-5 退役；N4 云端模式新增 ApiEmbedder 实现）
pub trait MemoryEmbedder {
    /// 文档向量化（语料侧，无指令前缀）
    fn embed_documents(&mut self, texts: &[String]) -> Result<Vec<Vec<f32>>>;
    /// 查询向量化（查询侧，引擎内置指令前缀）
    fn embed_query(&mut self, query: &str) -> Result<Vec<f32>>;
}

pub struct SidecarEmbedder {
    python: PathBuf,
    server: PathBuf,
    model_dir: PathBuf,
    state: Arc<Mutex<SidecarState>>,
}

/// embed_video_url 分块响应
pub struct VideoUrlChunk {
    /// (段起始秒, 向量)
    pub segments: Vec<(i64, Vec<f32>)>,
    pub eof: bool,
    pub next_skip: i64,
}

struct SidecarState {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    stdout: Option<BufReader<ChildStdout>>,
    req_id: u64,
    last_used: Instant,
    /// 握手 ready 帧的 device=="proxy"（CASE-009）：代理是 owner 私有通道，watchdog 可安全回收；
    /// 主实例被 TCP 跨线程/进程共享，kill 会砍断进行中的代理任务（21:17 误杀事故），
    /// 其显存回收交给 python 侧全通道空闲自治退出
    is_proxy: bool,
}

impl SidecarEmbedder {
    pub fn new(python: PathBuf, server: PathBuf, model_dir: PathBuf) -> Self {
        Self {
            python,
            server,
            model_dir,
            state: Arc::new(Mutex::new(SidecarState {
                child: None,
                stdin: None,
                stdout: None,
                req_id: 0,
                last_used: Instant::now(),
                is_proxy: false,
            })),
        }
    }

    /// 开发/生产路径解析：
    /// python  —— NERVIS_WEMM_PYTHON > sidecar/wemm/.venv（开发）> {app_data}/wemm-venv（生产 uv sync 落点）> PATH python
    /// server  —— NERVIS_WEMM_SERVER > sidecar/wemm/server.py（开发：相对仓库根；生产：exe 同目录 sidecar/）
    /// model   —— NERVIS_WEMM_MODEL_DIR > sidecar/wemm/models > {app_data}/models/wemm-embedding-2b
    pub fn resolve_default() -> Result<Self> {
        let server = std::env::var("NERVIS_WEMM_SERVER")
            .map(PathBuf::from)
            .unwrap_or_else(|_| resolve_sidecar_dir().join("server.py"));
        let server_dir = server
            .parent()
            .context("server.py 无父目录")?
            .to_path_buf();

        let python = std::env::var("NERVIS_WEMM_PYTHON")
            .map(PathBuf::from)
            .ok()
            .filter(|p| p.exists())
            .or_else(|| {
                let dev_venv = server_dir.join(".venv").join("Scripts").join("python.exe");
                dev_venv.exists().then_some(dev_venv)
            })
            .or_else(|| {
                let prod_venv = dirs::data_dir()?
                    .join("com.flowhub.app")
                    .join("wemm-venv")
                    .join("Scripts")
                    .join("python.exe");
                prod_venv.exists().then_some(prod_venv)
            })
            .unwrap_or_else(|| PathBuf::from("python"));

        let model_dir = std::env::var("NERVIS_WEMM_MODEL_DIR")
            .map(PathBuf::from)
            .ok()
            .filter(|p| p.exists())
            .or_else(|| {
                let local = server_dir.join("models");
                local.exists().then_some(local)
            })
            .or_else(|| {
                let base = dirs::data_dir()?;
                let p = base
                    .join("com.flowhub.app")
                    .join("models")
                    .join("wemm-embedding-2b");
                p.exists().then_some(p)
            })
            .context("WeMM 模型未安装：请到 设置 → 记忆中心 → 本地模型环境 一键安装")?;

        Ok(Self::new(python, server, model_dir))
    }

    /// 子进程健康：存活则复用，死亡则清理现场
    fn child_alive(state: &mut SidecarState) -> bool {
        match state.child.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(None) => true,
                _ => {
                    state.child = None;
                    state.stdin = None;
                    state.stdout = None;
                    false
                }
            },
            None => false,
        }
    }

    fn spawn(&self, state: &mut SidecarState) -> Result<()> {
        let mut child = Command::new(&self.python)
            .arg(&self.server)
            .env("NERVIS_WEMM_MODEL_DIR", &self.model_dir)
            .env("PYTHONIOENCODING", "utf-8")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // sidecar 日志走 stderr，不干扰协议帧；host 场景被浏览器吞掉，安全
            .stderr(Stdio::inherit())
            .spawn()
            .with_context(|| format!("启动 sidecar 失败: {}", self.python.display()))?;

        let stdin = child.stdin.take().context("sidecar stdin 不可用")?;
        let stdout = BufReader::new(child.stdout.take().context("sidecar stdout 不可用")?);
        state.stdin = Some(stdin);
        state.stdout = Some(stdout);

        // 握手：loading* -> ready | error
        loop {
            let frame = read_frame(state.stdout.as_mut().unwrap())
                .context("sidecar 握手阶段连接中断")?;
            match frame.get("type").and_then(Value::as_str) {
                Some("ready") => {
                    state.is_proxy =
                        frame.get("device").and_then(Value::as_str) == Some("proxy");
                    break;
                }
                Some("loading") => continue,
                Some("error") => {
                    let err = frame
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown");
                    let detail = frame.get("detail").and_then(Value::as_str).unwrap_or("");
                    let _ = state.child.as_mut().map(|c| c.kill());
                    state.child = None;
                    anyhow::bail!(match err {
                        "gpu_required" => format!(
                            "本地记忆检索需要 NVIDIA GPU（≥6GB 显存），当前机器不可用: {detail}"
                        ),
                        other => format!("sidecar 启动失败 {other}: {detail}"),
                    });
                }
                other => anyhow::bail!("sidecar 握手收到意外帧: {other:?}"),
            }
        }
        state.child = Some(child);
        Ok(())
    }

    fn call(&mut self, payload: Value) -> Result<Value> {
        let mut state = self.state.lock().expect("sidecar state poisoned");
        if !Self::child_alive(&mut state) {
            self.spawn(&mut state)?;
        }

        state.req_id += 1;
        let req_id = state.req_id;
        let mut req = payload;
        req["req_id"] = json!(req_id);

        let result = (|| {
            write_frame(state.stdin.as_mut().unwrap(), &req)?;
            read_frame(state.stdout.as_mut().unwrap())
        })();

        let resp = match result {
            Ok(resp) => resp,
            Err(e) => {
                // 进程可能已死：清理现场，下一次调用重新拉起
                state.child = None;
                state.stdin = None;
                state.stdout = None;
                return Err(e).context("sidecar 通信失败");
            }
        };

        state.last_used = Instant::now();
        let deadline = state.last_used;
        drop(state); // 必须先放锁：watchdog 线程 30min 后才取锁，但 arm 本身不能再碰锁
        self.arm_watchdog(deadline);

        if resp.get("ok").and_then(Value::as_bool) == Some(true) {
            Ok(resp.get("result").cloned().unwrap_or(Value::Null))
        } else {
            let err = resp
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            anyhow::bail!("sidecar 推理失败: {err}")
        }
    }

    /// 空闲 watchdog：每次调用后重置；超时无调用则回收子进程（释放 5.1GB 显存）
    /// ⚠️ deadline 由调用方在放锁前算好传入——call() 持锁期间本函数绝不能再 lock（std Mutex 不可重入, 曾致首次调用即自死锁）
    /// ⚠️ 只回收代理 child：主实例被 TCP 代理跨线程/进程共享（CASE-009），kill 会拦腰砍断
    ///    进行中的后台任务（2026-08-31 21:17 误杀事故：视频索引第 4 块 TCP 断连全殁）；
    ///    主实例的显存回收由 python 侧全通道空闲自治退出承担
    fn arm_watchdog(&self, deadline: Instant) {
        let state = Arc::clone(&self.state);
        std::thread::spawn(move || {
            std::thread::sleep(IDLE_TIMEOUT);
            let mut state = state.lock().expect("poisoned");
            if state.last_used <= deadline && state.is_proxy {
                if let Some(mut child) = state.child.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                state.stdin = None;
                state.stdout = None;
            }
        });
    }

    /// 连通性测试（不经过模型）
    pub fn ping(&mut self) -> Result<()> {
        let resp = self.call(json!({"type": "ping"}))?;
        if resp.get("pong").and_then(Value::as_bool) == Some(true) {
            Ok(())
        } else {
            anyhow::bail!("pong 缺失: {resp}")
        }
    }

    pub fn embed_image(&mut self, image_base64: &str, mime: &str) -> Result<Vec<f32>> {        let result = self.call(json!({
            "type": "embed_image",
            "image_base64": image_base64,
            "mime": mime,
        }))?;
        parse_vector(&result)
    }

    pub fn embed_video(&mut self, video_base64: &str, mime: &str) -> Result<Vec<f32>> {
        let result = self.call(json!({
            "type": "embed_video",
            "video_base64": video_base64,
            "mime": mime,
        }))?;
        parse_vector(&result)
    }

    /// 整视频后台索引的一块分片结果：sidecar 流式解码 + 分窗 embed，
    /// 分块调用让模型锁在块间释放（前台查询不被长任务饿死）
    pub fn embed_video_url(
        &mut self,
        video_url: &str,
        referer: &str,
        segment_secs: i64,
        skip_segments: i64,
        max_segments: i64,
    ) -> Result<VideoUrlChunk> {
        let result = self.call(json!({
            "type": "embed_video_url",
            "video_url": video_url,
            "referer": referer,
            "segment_secs": segment_secs,
            "skip_segments": skip_segments,
            "max_segments": max_segments,
        }))?;
        let segments = result
            .get("segments")
            .and_then(Value::as_array)
            .context("响应缺 segments")?
            .iter()
            .map(|s| {
                let start = s.get("start").and_then(Value::as_i64).context("段缺 start")?;
                let vector = parse_vector(s)?;
                Ok((start, vector))
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(VideoUrlChunk {
            segments,
            eof: result.get("eof").and_then(Value::as_bool).unwrap_or(true),
            next_skip: result.get("next_skip").and_then(Value::as_i64).unwrap_or(0),
        })
    }
}

impl MemoryEmbedder for SidecarEmbedder {
    fn embed_documents(&mut self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(vec![]);
        }
        let result = self.call(json!({
            "type": "embed_documents",
            "texts": texts,
        }))?;
        result
            .get("vectors")
            .and_then(Value::as_array)
            .context("响应缺 vectors")?
            .iter()
            .map(parse_vector)
            .collect()
    }

    fn embed_query(&mut self, query: &str) -> Result<Vec<f32>> {
        let result = self.call(json!({
            "type": "embed_query",
            "text": query,
        }))?;
        parse_vector(&result)
    }
}

/// sidecar 工程目录解析（server.py/pyproject.toml 所在）：
/// exe 祖先目录逐级找 sidecar/wemm/server.py——开发形态 exe 在 target/<profile>/ 命中仓库根；
/// 生产形态 exe 在安装目录命中 {install}/sidecar/wemm。env NERVIS_WEMM_SERVER 可整体覆盖。
pub fn resolve_sidecar_dir() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        for ancestor in exe.ancestors() {
            let candidate = ancestor.join("sidecar").join("wemm");
            if candidate.join("server.py").exists() {
                return candidate;
            }
        }
    }
    PathBuf::from("sidecar").join("wemm")
}

impl Drop for SidecarEmbedder {
    fn drop(&mut self) {
        let mut state = self.state.lock().expect("poisoned");
        if state.child.is_some() {
            let _ = state.req_id.wrapping_add(1);
            if let Some(stdin) = state.stdin.as_mut() {
                let _ = write_frame(stdin, &json!({"type": "shutdown"}));
            }
            if let Some(mut child) = state.child.take() {
                let _ = child.wait();
            }
        }
    }
}

fn parse_vector(value: &Value) -> Result<Vec<f32>> {
    let arr = value
        .get("vector")
        .and_then(Value::as_array)
        .or_else(|| value.as_array())
        .context("响应缺 vector")?;
    arr.iter()
        .map(|v| {
            v.as_f64()
                .map(|x| x as f32)
                .context("vector 元素非数值")
        })
        .collect()
}

fn write_frame(stdin: &mut ChildStdin, payload: &impl Serialize) -> Result<()> {
    let data = serde_json::to_vec(payload)?;
    stdin.write_all(&(data.len() as u32).to_le_bytes())?;
    stdin.write_all(&data)?;
    stdin.flush()?;
    Ok(())
}

fn read_frame(stdout: &mut BufReader<ChildStdout>) -> Result<Value> {
    let mut header = [0u8; 4];
    stdout.read_exact(&mut header)?;
    let length = u32::from_le_bytes(header) as usize;
    if length > MAX_FRAME_BYTES {
        anyhow::bail!("sidecar 帧超长 {length}");
    }
    let mut body = vec![0u8; length];
    stdout.read_exact(&mut body)?;
    Ok(serde_json::from_slice(&body)?)
}

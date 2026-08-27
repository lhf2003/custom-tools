//! embedding 引擎: bge-small-zh-v1.5 ONNX + ort + tokenizers
//!
//! 移植自 spikes/bge-onnx（M0 验证: top-3 88%, query P95 31ms, embed 34ms/doc）。
//! 关键点: 查询侧加 bge-zh 指令前缀、文档侧不加；CLS 池化 + L2 归一化；512 token 硬截断。

use anyhow::{Context, Result};
use ort::session::Session;
use ort::value::Tensor;
use std::path::{Path, PathBuf};
use tokenizers::{PaddingParams, Tokenizer, TruncationParams};

/// bge-zh 官方建议: 仅查询侧加指令前缀
const QUERY_INSTRUCTION: &str = "为这个句子生成表示以用于检索相关文章：";
/// 模型位置嵌入硬上限
const MAX_TOKENS: usize = 512;
/// 默认 embed 批量
pub const EMBED_BATCH: usize = 16;

/// 初始化 ONNX Runtime（全局一次性，重复调用安全返回首次结果）。
/// 解析顺序: 显式参数 > ORT_DYLIB_PATH > NERVIS_ORT_DLL > 可执行文件同目录/onnxruntime.dll（出货形态）
pub fn init_ort(dll: Option<&Path>) -> Result<()> {
    static ORT_INIT: std::sync::OnceLock<std::result::Result<(), String>> = std::sync::OnceLock::new();
    let result = ORT_INIT.get_or_init(|| {
        let path: Option<PathBuf> = dll
            .map(|p| p.to_path_buf())
            .or_else(|| std::env::var("ORT_DYLIB_PATH").map(PathBuf::from).ok())
            .or_else(|| std::env::var("NERVIS_ORT_DLL").map(PathBuf::from).ok())
            .or_else(|| {
                let exe = std::env::current_exe().ok()?;
                let p = exe.parent()?.join("onnxruntime.dll");
                p.exists().then_some(p)
            });
        let Some(path) = path else {
            return Err("onnxruntime.dll 未找到: 请设 ORT_DYLIB_PATH 或放可执行文件同目录".to_string());
        };
        ort::init_from(&path)
            .map(|b| {
                b.commit();
            })
            .map_err(|e| format!("ort init_from {}: {e}", path.display()))
    });
    match result {
        Ok(()) => Ok(()),
        Err(e) => anyhow::bail!(e.clone()),
    }
}

/// 模型目录解析: 需含 model.onnx + tokenizer.json。
/// 解析顺序: NERVIS_MODEL_DIR > {app_data}/models/bge-small-zh-v1.5
pub fn resolve_model_dir() -> Result<PathBuf> {
    if let Ok(dir) = std::env::var("NERVIS_MODEL_DIR") {
        return Ok(PathBuf::from(dir));
    }
    let base = dirs::data_dir().context("无法定位 app_data 目录")?;
    Ok(base.join("com.flowhub.app").join("models").join("bge-small-zh-v1.5"))
}

pub struct Embedder {
    session: Session,
    tokenizer: Tokenizer,
}

impl Embedder {
    pub fn new(model_dir: &Path) -> Result<Self> {
        let session = Session::builder()
            .map_err(|e| anyhow::anyhow!("ort session builder: {e}"))?
            .commit_from_file(model_dir.join("model.onnx"))
            .map_err(|e| anyhow::anyhow!("加载 model.onnx: {e}"))?;
        let mut tokenizer = Tokenizer::from_file(model_dir.join("tokenizer.json"))
            .map_err(|e| anyhow::anyhow!("加载 tokenizer.json: {e}"))?;
        tokenizer.with_padding(Some(PaddingParams::default()));
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: MAX_TOKENS,
                ..Default::default()
            }))
            .map_err(|e| anyhow::anyhow!("truncation: {e}"))?;
        Ok(Self { session, tokenizer })
    }

    /// 文档向量化（不加指令前缀），批量输入
    pub fn embed_documents(&mut self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        self.embed_batch(texts)
    }

    /// 查询向量化（自动加 bge-zh 指令前缀）
    pub fn embed_query(&mut self, query: &str) -> Result<Vec<f32>> {
        let text = format!("{QUERY_INSTRUCTION}{query}");
        Ok(self.embed_batch(&[text])?.remove(0))
    }

    fn embed_batch(&mut self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(vec![]);
        }
        let encodings = self
            .tokenizer
            .encode_batch(texts.to_vec(), true)
            .map_err(|e| anyhow::anyhow!("tokenize: {e}"))?;
        let b = encodings.len();
        let s = encodings[0].get_ids().len();

        let mut ids = Vec::with_capacity(b * s);
        let mut mask = Vec::with_capacity(b * s);
        let mut types = Vec::with_capacity(b * s);
        for e in &encodings {
            ids.extend(e.get_ids().iter().map(|&x| x as i64));
            mask.extend(e.get_attention_mask().iter().map(|&x| x as i64));
            types.extend(e.get_type_ids().iter().map(|&x| x as i64));
        }

        let inputs = ort::inputs![
            Tensor::from_array(([b, s], ids))?,
            Tensor::from_array(([b, s], mask))?,
            Tensor::from_array(([b, s], types))?,
        ];
        let outputs = self
            .session
            .run(inputs)
            .map_err(|e| anyhow::anyhow!("ort run: {e}"))?;
        let (shape, data) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| anyhow::anyhow!("extract: {e}"))?;
        let seq = shape[1] as usize;
        let hid = shape[2] as usize;

        // bge: CLS 池化 + L2 归一化（归一化后 L2 距离与余弦单调一致，vec0 默认 L2 即可）
        Ok((0..b)
            .map(|i| {
                let mut cls = data[i * seq * hid..i * seq * hid + hid].to_vec();
                let n = cls.iter().map(|x| x * x).sum::<f32>().sqrt();
                if n > 0.0 {
                    cls.iter_mut().for_each(|x| *x /= n);
                }
                cls
            })
            .collect())
    }
}

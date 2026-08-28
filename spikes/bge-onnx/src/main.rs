// M0 spike: bge-base-zh-v1.5 ONNX + ort 中文语义检索验证
// 用法:
//   cargo run --release -- embed    # 语料向量化, 落 cache/embeddings.bin + ids.json
//   cargo run --release -- query    # 交互式/文件查询, 余弦 top-5
use anyhow::{Context, Result};
use ort::session::Session;
use ort::value::Tensor;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::Path;
use std::time::Instant;
use tokenizers::{PaddingParams, Tokenizer, TruncationParams};

const ORT_DLL: &str = r"D:\Python\Lib\site-packages\onnxruntime\capi\onnxruntime.dll";
const MODEL: &str = "models/model.onnx";
const TOKENIZER: &str = "models/tokenizer.json";
const CORPUS: &str = "corpus/corpus.jsonl";
const CACHE_BIN: &str = "cache/embeddings.bin";
const CACHE_IDS: &str = "cache/ids.json";
const QUERIES: &str = "corpus/queries.jsonl";
// bge-zh 官方建议: 查询侧加指令前缀, 文档侧不加
const QUERY_INSTRUCTION: &str = "为这个句子生成表示以用于检索相关文章：";
const BATCH: usize = 16;
const DIM: usize = 768;

#[derive(Debug, Deserialize, Serialize)]
struct Doc {
    id: String,
    source: String,
    text: String,
}

#[derive(Debug, Deserialize)]
struct Query {
    q: String,
    #[serde(default)]
    expect: Option<String>, // 期望命中的 doc id 子串, 用于人工/半自动评测
}

fn l2_normalize(v: &mut [f32]) {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n > 0.0 {
        v.iter_mut().for_each(|x| *x /= n);
    }
}

fn embed_texts(session: &mut Session, tokenizer: &Tokenizer, texts: &[String]) -> Result<Vec<Vec<f32>>> {
    let encodings = tokenizer
        .encode_batch(texts.to_vec(), true)
        .map_err(|e| anyhow::anyhow!("tokenize: {e}"))?;
    let b = encodings.len();
    let s = encodings[0].get_ids().len();

    let mut ids = vec![0i64; b * s];
    let mut mask = vec![0i64; b * s];
    let mut types = vec![0i64; b * s];
    for (i, e) in encodings.iter().enumerate() {
        ids[i * s..(i + 1) * s].copy_from_slice(&e.get_ids().iter().map(|&x| x as i64).collect::<Vec<_>>());
        mask[i * s..(i + 1) * s]
            .copy_from_slice(&e.get_attention_mask().iter().map(|&x| x as i64).collect::<Vec<_>>());
        types[i * s..(i + 1) * s]
            .copy_from_slice(&e.get_type_ids().iter().map(|&x| x as i64).collect::<Vec<_>>());
    }

    let inputs = ort::inputs![
        Tensor::from_array(([b, s], ids))?,
        Tensor::from_array(([b, s], mask))?,
        Tensor::from_array(([b, s], types))?,
    ];
    let outputs = session.run(inputs)?;
    let (shape, data) = outputs[0].try_extract_tensor::<f32>()?;
    let seq_dim = shape[1] as usize;
    let hid = shape[2] as usize;

    // bge: CLS 池化 + L2 归一化
    let mut out = Vec::with_capacity(b);
    for i in 0..b {
        let mut cls = data[i * seq_dim * hid..i * seq_dim * hid + hid].to_vec();
        l2_normalize(&mut cls);
        out.push(cls);
    }
    Ok(out)
}

fn load_docs() -> Result<Vec<Doc>> {
    let raw = fs::read_to_string(CORPUS)?;
    raw.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).context("doc json"))
        .collect()
}

fn cmd_embed(session: &mut Session, tokenizer: &Tokenizer) -> Result<()> {
    let docs = load_docs()?;
    println!("docs: {}", docs.len());
    fs::create_dir_all("cache")?;

    let mut all: Vec<f32> = Vec::with_capacity(docs.len() * DIM);
    let mut total_ms = 0u128;
    let mut n = 0usize;
    for chunk in docs.chunks(BATCH) {
        let texts: Vec<String> = chunk.iter().map(|d| d.text.chars().take(2000).collect()).collect();
        let t = Instant::now();
        let embs = embed_texts(session, tokenizer, &texts)?;
        let ms = t.elapsed().as_millis();
        total_ms += ms;
        n += chunk.len();
        for e in embs {
            all.extend_from_slice(&e);
        }
        print!(".");
        std::io::stdout().flush()?;
    }
    println!("\navg embed: {:.1} ms/doc (batch {})", total_ms as f64 / n as f64, BATCH);

    let bytes: &[u8] = bytemuck_cast(&all);
    fs::write(CACHE_BIN, bytes)?;
    fs::write(CACHE_IDS, serde_json::to_string(&docs)?)?;
    println!("cached -> {} ({} x {})", CACHE_BIN, docs.len(), DIM);
    Ok(())
}

fn bytemuck_cast(v: &[f32]) -> &[u8] {
    unsafe { std::slice::from_raw_parts(v.as_ptr() as *const u8, v.len() * 4) }
}

fn cmd_query(session: &mut Session, tokenizer: &Tokenizer) -> Result<()> {
    if !Path::new(CACHE_BIN).exists() {
        anyhow::bail!("cache missing, run `embed` first");
    }
    let docs: Vec<Doc> = serde_json::from_str(&fs::read_to_string(CACHE_IDS)?)?;
    let raw = fs::read(CACHE_BIN)?;
    let embs: &[f32] = unsafe {
        std::slice::from_raw_parts(raw.as_ptr() as *const f32, raw.len() / 4)
    };
    let dim = embs.len() / docs.len();

    let queries: Vec<Query> = fs::read_to_string(QUERIES)?
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(serde_json::from_str)
        .collect::<std::result::Result<_, _>>()?;
    println!("queries: {}", queries.len());

    let mut lat = Vec::new();
    let mut hit1 = 0;
    let mut hit3 = 0;
    let mut judged = 0;

    for (qi, q) in queries.iter().enumerate() {
        let t = Instant::now();
        let qe = embed_texts(session, tokenizer, &[format!("{QUERY_INSTRUCTION}{}", q.q)])?.remove(0);
        lat.push(t.elapsed().as_millis());

        let mut scores: Vec<(usize, f32)> = docs
            .iter()
            .enumerate()
            .map(|(i, _)| {
                let d = &embs[i * dim..(i + 1) * dim];
                let s: f32 = qe.iter().zip(d).map(|(a, b)| a * b).sum();
                (i, s)
            })
            .collect();
        scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());

        println!("\n[{}] {}", qi + 1, q.q);
        for (rank, (i, s)) in scores.iter().take(3).enumerate() {
            let snippet: String = docs[*i].text.chars().take(60).collect();
            let mark = match &q.expect {
                Some(e) if docs[*i].id.contains(e.as_str()) => " <<< 期望命中",
                _ => "",
            };
            println!("  #{} {:.4} {} | {}{}", rank + 1, s, docs[*i].id, snippet.replace('\n', " "), mark);
        }
        if let Some(e) = &q.expect {
            judged += 1;
            if scores[0].0 < docs.len() && docs[scores[0].0].id.contains(e.as_str()) {
                hit1 += 1;
            }
            if scores.iter().take(3).any(|(i, _)| docs[*i].id.contains(e.as_str())) {
                hit3 += 1;
            }
        }
    }

    lat.sort_unstable();
    println!("\n=== 汇总 ===");
    println!("query 延迟: p50={}ms p95={}ms", lat[lat.len() / 2], lat[lat.len() * 95 / 100]);
    if judged > 0 {
        println!("top-1 命中率: {}/{} = {:.0}%", hit1, judged, hit1 as f64 / judged as f64 * 100.0);
        println!("top-3 命中率: {}/{} = {:.0}%", hit3, judged, hit3 as f64 / judged as f64 * 100.0);
    }
    Ok(())
}

fn main() -> Result<()> {
    ort::init_from(ORT_DLL)?.commit();
    let model = std::env::var("SPIKE_MODEL").unwrap_or_else(|_| MODEL.to_string());
    let mut session = Session::builder()?.commit_from_file(&model)?;
    let tok_path = std::env::var("SPIKE_TOKENIZER").unwrap_or_else(|_| TOKENIZER.to_string());
    let mut tokenizer = Tokenizer::from_file(&tok_path).map_err(|e| anyhow::anyhow!("tokenizer: {e}"))?;
    tokenizer.with_padding(Some(PaddingParams::default()));
    tokenizer.with_truncation(Some(TruncationParams {
        max_length: 512,
        ..Default::default()
    })).map_err(|e| anyhow::anyhow!("trunc: {e}"))?;

    match std::env::args().nth(1).as_deref() {
        Some("embed") => cmd_embed(&mut session, &tokenizer),
        Some("query") => cmd_query(&mut session, &tokenizer),
        _ => {
            eprintln!("usage: bge-spike [embed|query]");
            std::process::exit(2);
        }
    }
}

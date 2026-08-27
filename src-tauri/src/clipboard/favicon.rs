//! 站点 favicon 抓取与磁盘缓存（剪贴板整链条目的类型图标）。
//!
//! 链路：磁盘缓存（7 天 TTL）→ `https://<host>/favicon.ico` → 首页 HTML
//! `<link rel="...icon...">` 解析 → None（前端回退通用链接图标）。
//! 失败结果进会话级负缓存，避免离线/无图标域名每次滚动列表都超时一遍。

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use sha2::{Digest, Sha256};

use crate::APP_DIR_NAME;

/// 磁盘缓存有效期：favicon 极少变动，7 天刷新一次
const CACHE_TTL: Duration = Duration::from_secs(7 * 24 * 3600);
/// 图标/HTML 体积上限，防异常响应撑爆内存
const MAX_ICON_BYTES: usize = 512 * 1024;
const MAX_HTML_BYTES: usize = 256 * 1024;
/// 部分 CDN 按 UA 拦截裸 reqwest，带一个浏览器 UA
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/// 会话级负缓存：抓取失败的域名本次运行内不再重试
static NEGATIVE_CACHE: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn negative_cache() -> &'static Mutex<HashSet<String>> {
    NEGATIVE_CACHE.get_or_init(|| Mutex::new(HashSet::new()))
}

/// 入口：给定页面 URL，返回 favicon 的 data URL；抓不到返回 None。
pub async fn get_favicon_data_url(page_url: &str) -> Option<String> {
    let parsed = url::Url::parse(page_url.trim()).ok()?;
    let host = parsed.host_str()?.to_string();
    if host.is_empty() {
        return None;
    }

    if let Some(data_url) = read_disk_cache(&host) {
        return Some(data_url);
    }
    if negative_cache().lock().ok()?.contains(&host) {
        return None;
    }

    let result = fetch_favicon(&parsed, &host).await;
    match &result {
        Some((bytes, mime)) => {
            write_disk_cache(&host, bytes);
            Some(format!("data:{};base64,{}", mime, BASE64.encode(bytes)))
        }
        None => {
            if let Ok(mut guard) = negative_cache().lock() {
                guard.insert(host);
            }
            None
        }
    }
}

/// 两级抓取：/favicon.ico 优先，失败再解析首页 <link rel=icon>
async fn fetch_favicon(parsed: &url::Url, host: &str) -> Option<(Vec<u8>, &'static str)> {
    let client = crate::http::build_client(Duration::from_secs(8)).ok()?;
    let origin = format!("{}://{}", parsed.scheme(), host);

    let ico_url = format!("{}/favicon.ico", origin);
    if let Some(found) = fetch_icon_at(&client, &ico_url).await {
        return Some(found);
    }

    // 首页 HTML 里找 <link rel="...icon..." href="...">（站点图标常挂在自定义路径）
    let html = fetch_text_capped(&client, &origin, MAX_HTML_BYTES).await?;
    let href = find_icon_href(&html)?;
    let icon_url = url::Url::parse(&origin).ok()?.join(&href).ok()?;
    fetch_icon_at(&client, icon_url.as_str()).await
}

/// 拉取单个图标 URL：2xx + 魔数嗅探通过才接受
async fn fetch_icon_at(client: &reqwest::Client, url: &str) -> Option<(Vec<u8>, &'static str)> {
    let resp = client
        .get(url)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let bytes = resp.bytes().await.ok()?;
    if bytes.is_empty() || bytes.len() > MAX_ICON_BYTES {
        return None;
    }
    let mime = sniff_mime(&bytes)?;
    Some((bytes.to_vec(), mime))
}

/// 拉取文本响应（HTML），截断到上限
async fn fetch_text_capped(client: &reqwest::Client, url: &str, cap: usize) -> Option<String> {
    let resp = client
        .get(url)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let bytes = resp.bytes().await.ok()?;
    let cut = bytes.len().min(cap);
    Some(String::from_utf8_lossy(&bytes[..cut]).into_owned())
}

/// 从 HTML 中找图标链接。手写扫描（不引 regex）：
/// 逐个 <link ...> 标签，rel 属性值含 "icon"（覆盖 icon / shortcut icon /
/// apple-touch-icon）则取其 href。第一个命中即返回。
fn find_icon_href(html: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let mut search_from = 0;

    while let Some(tag_start) = lower[search_from..].find("<link") {
        let tag_start = search_from + tag_start;
        let tag_end = lower[tag_start..].find('>').map(|i| tag_start + i)?;
        let tag = &lower[tag_start..tag_end];

        if let Some(rel) = attr_value(tag, "rel") {
            if rel.contains("icon") {
                if let Some(href) = attr_value(tag, "href") {
                    if !href.is_empty() {
                        // 用原文大小写取 href（attr 值大小写敏感）
                        let raw_tag = &html[tag_start..tag_end];
                        return attr_value(raw_tag, "href").or(Some(href));
                    }
                }
            }
        }
        search_from = tag_end + 1;
    }
    None
}

/// 从标签文本中提取指定属性的值（支持双引号/单引号/无引号三种写法）
fn attr_value(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_lowercase();
    let key = format!("{}=", name);
    let pos = lower.find(&key)? + key.len();
    let rest = &tag[pos..];

    if let Some(stripped) = rest.strip_prefix('"') {
        let end = stripped.find('"')?;
        return Some(stripped[..end].to_string());
    }
    if let Some(stripped) = rest.strip_prefix('\'') {
        let end = stripped.find('\'')?;
        return Some(stripped[..end].to_string());
    }
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '>')
        .unwrap_or(rest.len());
    Some(rest[..end].to_string())
}

/// 魔数嗅探图片 MIME（不信任 Content-Type，favicon 常被错误配置成 text/html 等）
fn sniff_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF8") {
        Some("image/gif")
    } else if bytes.len() > 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(b"\x00\x00\x01\x00") {
        Some("image/x-icon")
    } else {
        // SVG：跳过 BOM/空白后以 < 开头
        let head = &bytes[..bytes.len().min(256)];
        let text = String::from_utf8_lossy(head);
        let trimmed = text.trim_start_matches('\u{feff}').trim_start();
        if trimmed.starts_with("<svg") || trimmed.starts_with("<?xml") {
            Some("image/svg+xml")
        } else {
            None
        }
    }
}

// ─── 磁盘缓存 ────────────────────────────────────────────────────────────────

fn cache_path(host: &str) -> Option<PathBuf> {
    let mut hasher = Sha256::new();
    hasher.update(host.as_bytes());
    let hash = format!("{:x}", hasher.finalize());
    Some(
        dirs::data_dir()?
            .join(APP_DIR_NAME)
            .join("favicons")
            .join(&hash[..16]),
    )
}

/// 命中且未过期则读出并组装 data URL；过期/损坏返回 None（由抓取路径覆盖重写）
fn read_disk_cache(host: &str) -> Option<String> {
    let path = cache_path(host)?;
    let modified = std::fs::metadata(&path).ok()?.modified().ok()?;
    if modified.elapsed().ok()? > CACHE_TTL {
        return None;
    }
    let bytes = std::fs::read(&path).ok()?;
    let mime = sniff_mime(&bytes)?;
    Some(format!("data:{};base64,{}", mime, BASE64.encode(&bytes)))
}

fn write_disk_cache(host: &str, bytes: &[u8]) {
    if let Some(path) = cache_path(host) {
        if let Some(dir) = path.parent() {
            if let Err(e) = std::fs::create_dir_all(dir) {
                log::warn!("[favicon] 创建缓存目录失败: {e}");
                return;
            }
        }
        if let Err(e) = std::fs::write(&path, bytes) {
            log::warn!("[favicon] 写缓存失败 {}: {e}", path.display());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniff_mime_recognizes_common_formats() {
        assert_eq!(sniff_mime(b"\x89PNG\r\n\x1a\nrest"), Some("image/png"));
        assert_eq!(sniff_mime(b"\xff\xd8\xff\xe0rest"), Some("image/jpeg"));
        assert_eq!(sniff_mime(b"GIF89a..."), Some("image/gif"));
        assert_eq!(sniff_mime(b"\x00\x00\x01\x00rest"), Some("image/x-icon"));
        assert_eq!(
            sniff_mime(b"RIFF\x00\x00\x00\x00WEBPdata"),
            Some("image/webp")
        );
        assert_eq!(sniff_mime(b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"), Some("image/svg+xml"));
        assert_eq!(sniff_mime(b"<html><body>404</body></html>"), None);
        assert_eq!(sniff_mime(b""), None);
    }

    #[test]
    fn find_icon_href_parses_link_tags() {
        let html = r#"<html><head>
            <link rel="stylesheet" href="/a.css">
            <link rel="icon" type="image/png" href="/static/favicon-32.png">
            </head><body></body></html>"#;
        assert_eq!(
            find_icon_href(html),
            Some("/static/favicon-32.png".to_string())
        );
    }

    #[test]
    fn find_icon_href_supports_apple_touch_and_single_quotes() {
        let html = r#"<link href='/touch.png' rel='apple-touch-icon'>"#;
        assert_eq!(find_icon_href(html), Some("/touch.png".to_string()));
    }

    #[test]
    fn find_icon_href_returns_none_without_icon_rel() {
        let html = r#"<link rel="stylesheet" href="/a.css"><link rel="preload" href="/b.js">"#;
        assert_eq!(find_icon_href(html), None);
    }

    #[test]
    fn attr_value_handles_unquoted() {
        assert_eq!(
            attr_value(r#"<link rel=icon href=/f.png>"#, "href"),
            Some("/f.png".to_string())
        );
    }
}

//! 统一 HTTP 客户端工厂：应用级「系统代理」开关在此生效。
//!
//! 开启开关后，reqwest 客户端读取 Windows 系统代理（HKCU Internet Settings
//! 的手动代理设置），全部 HTTP(S)/Socks 流量经系统代理发出。
//!
//! 已知限制（v1）：
//! - 仅支持手动代理（ProxyEnable + ProxyServer）；PAC / 自动检测（AutoConfigURL）不支持
//! - 系统设置里「绕过代理服务器用于本地地址」（`<local>`）不忠实复刻——
//!   固定绕过 loopback（localhost/127.0.0.1/::1），LAN 内网地址在代理开启时走代理
//! - 只读 HKCU，不读 HKLM 企业策略代理
//!
//! 生效范围：LLM 调用、模型列表、插件 AI 生成（经 build_client），
//! 以及自动更新检查/下载（commands/updater.rs 经 apply_system_proxy 注入）。
//! websearch 本地 daemon 请求为 loopback，天然不受影响。

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use reqwest::{NoProxy, Proxy};
use tauri::{AppHandle, Manager};

use crate::commands::settings::SettingsState;

/// 进程级 AppHandle：lib.rs setup 中 init；MCP server 模式不经过 setup，
/// 句柄保持未设置 → build_client 退化直连（绝不 unwrap）。
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// client 缓存 key：(代理开关, 代理地址, 超时秒数)
type ClientCacheKey = (bool, String, u64);

/// 进程级 client 缓存：配置/超时变化才重建——LLM 高频调用不丢连接池。
/// 约束：锁内不得跨 .await（本文件所有锁均在表达式结束处释放）。
static CLIENT_CACHE: Mutex<Option<(ClientCacheKey, reqwest::Client)>> = Mutex::new(None);

/// 由 lib.rs setup 调用，供 build_client 读取设置与代理配置
pub fn init(app: AppHandle) {
    let _ = APP_HANDLE.set(app);
}

/// 解析出的代理规格
#[derive(Debug, Clone, PartialEq)]
pub struct ProxySpec {
    /// "http" | "https" | "socks5" | "socks4" | ""（裸段，http+https 都走）
    pub scheme: String,
    /// 不含端口；IPv6 字面量带方括号（[::1]）
    pub host: String,
    pub port: u16,
}

/// 解析 Windows ProxyServer 值（纯函数，可单测）。
/// 格式："host:port" 或 "http=host:port;https=host:port;socks=host:port"
/// - 按 `;` 分段、trim、空段跳过、scheme 大小写不敏感
/// - 无前缀段 → scheme=""（all）；未知前缀（ftp= 等）跳过
/// - 无端口补默认（http/https :80，socks :1080）
/// - 单段解析失败跳过该段，不整体失败
pub fn parse_proxy_server(value: &str) -> Vec<ProxySpec> {
    let mut specs = Vec::new();
    for segment in value.split(';') {
        let segment = segment.trim();
        if segment.is_empty() {
            continue;
        }
        let (scheme, host_port) = match segment.split_once('=') {
            Some((scheme, rest)) => (scheme.trim().to_ascii_lowercase(), rest.trim()),
            None => (String::new(), segment),
        };
        if !matches!(scheme.as_str(), "" | "http" | "https" | "socks" | "socks4" | "socks5") {
            continue;
        }
        if host_port.is_empty() {
            continue;
        }
        let (host, port) = split_host_port(host_port);
        let Some(host) = host else {
            log::warn!("[http] 系统代理段格式非法，跳过: {host_port}");
            continue;
        };
        let port = port.unwrap_or(if matches!(scheme.as_str(), "socks" | "socks4" | "socks5") {
            1080
        } else {
            80
        });
        let scheme = match scheme.as_str() {
            "socks" => "socks5".to_string(),
            other => other.to_string(),
        };
        specs.push(ProxySpec { scheme, host, port });
    }
    specs
}

/// 切分 host 与端口：最后一个 `:` 后全是数字才视为端口（IPv6 含多个冒号）。
/// 返回 (host, 端口或 None)；host 非法（空）返回 (None, _)。
fn split_host_port(s: &str) -> (Option<String>, Option<u16>) {
    let s = s.trim();
    if let Some(idx) = s.rfind(':') {
        let (host, port_str) = (&s[..idx], &s[idx + 1..]);
        if !port_str.is_empty() && port_str.chars().all(|c| c.is_ascii_digit()) {
            let host = host.trim();
            if host.is_empty() {
                return (None, None);
            }
            let port = port_str.parse::<u16>().ok();
            return (Some(host.to_string()), port);
        }
    }
    if s.is_empty() {
        (None, None)
    } else {
        (Some(s.to_string()), None)
    }
}

/// 读取 Windows 系统代理字符串（HKCU Internet Settings）。
/// ProxyEnable=0 / 键缺失 / 值为空 → 返回 None（直连）。
fn read_system_proxy() -> Option<String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        .ok()?;
    let enable: u32 = key.get_value("ProxyEnable").ok()?;
    if enable == 0 {
        return None;
    }
    let server: String = key.get_value("ProxyServer").ok()?;
    if server.trim().is_empty() {
        return None;
    }
    Some(server)
}

/// loopback 直连列表：reqwest 默认不绕代理，Ollama（localhost:11434）等本地服务必须直连。
/// 挂在每个 Proxy 上（ClientBuilder::no_proxy 在 0.12.28 为无参版本，语义是禁用环境变量代理）
const LOOPBACK_NO_PROXY: &str = "localhost,127.0.0.1,::1";

/// 把解析出的代理规格转成 reqwest::Proxy 列表（全部带 loopback 绕过）
fn build_proxies(specs: &[ProxySpec]) -> Vec<Proxy> {
    let mut proxies = Vec::new();
    for spec in specs {
        let url = match spec.scheme.as_str() {
            "http" | "https" => format!("http://{}:{}", spec.host, spec.port),
            "socks5" | "socks4" => format!("{}://{}:{}", spec.scheme, spec.host, spec.port),
            "" => format!("http://{}:{}", spec.host, spec.port),
            _ => continue,
        };
        let proxy = match spec.scheme.as_str() {
            "" | "socks5" | "socks4" => Proxy::all(&url),
            "http" => Proxy::http(&url),
            "https" => Proxy::https(&url),
            _ => continue,
        };
        // 构造失败（url 非法）跳过该段，不整体失败
        if let Ok(p) = proxy {
            proxies.push(p.no_proxy(NoProxy::from_string(LOOPBACK_NO_PROXY)));
        }
    }
    proxies
}

/// 当前代理配置：(开关, 代理字符串)。开关来自设置内存缓存；
/// 代理字符串只在开启时读注册表。句柄未设置（MCP 模式）或读取失败 → 直连。
fn current_proxy_config() -> (bool, String) {
    let handle = APP_HANDLE.get();
    let mut enabled = false;
    if let Some(handle) = handle {
        if let Some(state) = handle.try_state::<SettingsState>() {
            if let Ok(settings) = state.0.lock().map(|m| m.get_settings()) {
                enabled = settings.system_proxy_enabled;
            }
        }
    }
    if enabled {
        (true, read_system_proxy().unwrap_or_default())
    } else {
        (false, String::new())
    }
}

/// 把系统代理附加到 builder（loopback 绕过挂在每个 Proxy 上）；
/// 无可用代理配置时原样返回。关闭时不应调用本函数——不碰环境变量代理语义。
fn apply_proxy(mut builder: reqwest::ClientBuilder, proxy_server: &str) -> reqwest::ClientBuilder {
    let proxies = build_proxies(&parse_proxy_server(proxy_server));
    if proxies.is_empty() {
        return builder;
    }
    for p in &proxies {
        builder = builder.proxy(p.clone());
    }
    log::debug!("[http] 系统代理已启用: {proxy_server}");
    builder
}

/// 供 tauri-plugin-updater 的 configure_client 复用：读取当前设置，
/// 系统代理开关开启时把系统代理附加到 updater 的 client builder（check 每次调用，开关即时生效）
pub fn apply_system_proxy(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    let (enabled, proxy_server) = current_proxy_config();
    if enabled && !proxy_server.is_empty() {
        apply_proxy(builder, &proxy_server)
    } else {
        builder
    }
}

/// 统一 HTTP 客户端工厂。系统代理开关开启时附加系统代理（loopback 固定绕过），
/// 否则直连。始终带 connect_timeout(10s)；失败返回 Err 由调用方按既有模式处理
/// （注册表/解析失败会退化直连，不会因代理异常把请求搞挂）。
pub fn build_client(timeout: Duration) -> Result<reqwest::Client, String> {
    let timeout_secs = timeout.as_secs();
    let (enabled, proxy_server) = current_proxy_config();

    // 连接池缓存：key 不变直接复用
    if let Ok(guard) = CLIENT_CACHE.lock() {
        if let Some((key, client)) = guard.as_ref() {
            if key == &(enabled, proxy_server.clone(), timeout_secs) {
                return Ok(client.clone());
            }
        }
    }

    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(timeout);

    // 仅在「开关开启且有代理配置」时附加代理（loopback 绕过挂在每个 Proxy 上）；
    // 关闭时不碰环境变量代理语义，也不吞用户的 http_proxy 等
    if enabled && !proxy_server.is_empty() {
        builder = apply_proxy(builder, &proxy_server);
    }

    let client = builder
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败: {e}"))?;

    if let Ok(mut guard) = CLIENT_CACHE.lock() {
        *guard = Some(((enabled, proxy_server, timeout_secs), client.clone()));
    }

    Ok(client)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_bare_host_port() {
        let specs = parse_proxy_server("127.0.0.1:7890");
        assert_eq!(specs.len(), 1);
        assert_eq!(
            specs[0],
            ProxySpec { scheme: String::new(), host: "127.0.0.1".into(), port: 7890 }
        );
    }

    #[test]
    fn parse_scheme_mapping() {
        let specs = parse_proxy_server("http=127.0.0.1:7890;https=127.0.0.1:7891");
        assert_eq!(specs.len(), 2);
        assert_eq!(specs[0].scheme, "http");
        assert_eq!(specs[0].port, 7890);
        assert_eq!(specs[1].scheme, "https");
        assert_eq!(specs[1].port, 7891);
    }

    #[test]
    fn parse_mixed_bare_and_prefixed() {
        let specs = parse_proxy_server("127.0.0.1:7890;https=proxy.example.com:443");
        assert_eq!(specs.len(), 2);
        assert_eq!(specs[0].scheme, "");
        assert_eq!(specs[1].scheme, "https");
    }

    #[test]
    fn parse_case_insensitive() {
        let specs = parse_proxy_server("HTTP=127.0.0.1:7890;Socks=127.0.0.1:7891");
        assert_eq!(specs.len(), 2);
        assert_eq!(specs[0].scheme, "http");
        assert_eq!(specs[1].scheme, "socks5"); // socks → socks5
    }

    #[test]
    fn parse_empty_segments_skipped() {
        let specs = parse_proxy_server(" ; 127.0.0.1:7890;;http=proxy.example.com:8080;");
        assert_eq!(specs.len(), 2);
        assert_eq!(specs[0].port, 7890);
        assert_eq!(specs[1].scheme, "http");
    }

    #[test]
    fn parse_default_ports() {
        // 无端口：http/https 补 80，socks 补 1080
        let specs = parse_proxy_server("http=proxy.example.com;socks=proxy.example.com");
        assert_eq!(specs[0].port, 80);
        assert_eq!(specs[1].scheme, "socks5");
        assert_eq!(specs[1].port, 1080);
    }

    #[test]
    fn parse_ipv6_keeps_brackets() {
        let specs = parse_proxy_server("[::1]:7890");
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].host, "[::1]");
        assert_eq!(specs[0].port, 7890);
    }

    #[test]
    fn parse_unknown_scheme_skipped() {
        let specs = parse_proxy_server("ftp=proxy.example.com;http=127.0.0.1:7890");
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].scheme, "http");
    }

    #[test]
    fn parse_socks_variants() {
        let specs = parse_proxy_server("socks4=127.0.0.1:1081;socks5=127.0.0.1:1082");
        assert_eq!(specs.len(), 2);
        assert_eq!(specs[0].scheme, "socks4");
        assert_eq!(specs[0].port, 1081);
        assert_eq!(specs[1].scheme, "socks5");
        assert_eq!(specs[1].port, 1082);
    }

    #[test]
    fn parse_malformed_segment_skipped() {
        // 空 host 的段跳过，其余保留
        let specs = parse_proxy_server("http=:7890;127.0.0.1:7891");
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].port, 7891);
    }

    #[test]
    fn parse_empty_returns_empty() {
        assert!(parse_proxy_server("").is_empty());
        assert!(parse_proxy_server("   ").is_empty());
    }
}

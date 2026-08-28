//! 环境感知：贾维斯的「窗外」——IP 定位（城市级）+ 实时天气（百度地图 Web 服务 API）。
//!
//! 设计文档：docs/2026-08-14-CASE-002-贾维斯天气与定位感官设计_01.md
//!
//! 架构要点：
//! - 所有触点读同一份缓存（settings.companion_env_cache，唯一真源）；
//!   30 分钟定时采集一轮（mod.rs 启动处 spawn），触点组 prompt 前过期补刷
//! - 隐身降级：无网/接口挂/配额烧穿/未注入 AK → 保留旧缓存只记日志；
//!   缓存 >2h 硬切不注入——贾维斯不知道自己缺了感官（非「知道但查不了」的残疾感）
//! - 出差感知：城市变化记 prev_city + 时间戳（3 天注入提示窗）；
//!   facts 走同模板「他最近在 X（M 月 D 日起）」，bigram 查重必命中覆盖，
//!   回程/再出发自动顶掉旧位置条目
//! - AK/SK 编译期 option_env! 注入（不进 git、前端不可见）；
//!   SK 存在才带 sn（dev 未注入 SK 时依赖控制台未开 SN 强制校验）

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{analyzer, db, fingerprint, tools};

/// settings 表缓存 key
const CACHE_KEY: &str = "companion_env_cache";
/// 已知场所映射 key（Vec<Place>）
const PLACES_KEY: &str = "companion_places";
/// 陌生指纹观察 key（fingerprint → 出现日期列表）
const SIGHTINGS_KEY: &str = "companion_place_sightings";
/// 缓存新鲜度：超过则触点补刷（与定时器周期一致）
const STALE_SECS: i64 = 30 * 60;
/// 注入硬切：缓存超过 2h 未更新，感官「下线」（隐身原则：不注入过期感知）
const EXPIRE_SECS: i64 = 2 * 3600;
/// 出差提示窗口：城市变化后 3 天内注入句带「他最近从 X 到了 Y」
const TRIP_HINT_SECS: i64 = 3 * 86400;
/// 单次 HTTP 超时（触点补刷会阻塞组 prompt，必须短）
const HTTP_TIMEOUT_SECS: u64 = 8;
/// 陌生场所询问窗口：见到 3~7 个不同日期才提示模型去问（<3 过滤偶发，
/// >7 视为「他不想说/没机会说」，不烦他）；观察记录滚动 14 天。
/// 语气分档：3~4 天「话题不合适就改天」的软提示实测会被任务型聊天无限 defer，
/// 5 天起升级为催促——窗口过半，再等「合适话头」就永远问不出口了
const PLACE_ASK_MIN_DAYS: u32 = 3;
const PLACE_ASK_MAX_DAYS: u32 = 7;
const PLACE_ASK_URGENT_DAYS: u32 = 5;
const SIGHTING_RETENTION_DAYS: i64 = 14;

/// settings.companion_env_cache 的 JSON 结构（serde default 兼容旧版缺字段）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EnvCache {
    /// 城市原文（带「市」后缀，如「武汉市」；展示时 strip）
    pub city: String,
    /// 区县名（可能空——IP 库只到市级时）
    #[serde(default)]
    pub district: String,
    /// 国标行政区划编码（天气查询主键：district_id 参数；可能为市级编码）
    #[serde(default)]
    pub district_id: String,
    /// 出差检测：上一个城市
    #[serde(default)]
    pub prev_city: Option<String>,
    /// 最近一次城市变化时间戳（0 = 从未变过）
    #[serde(default)]
    pub city_changed_at: i64,
    /// 实时天气（单轮天气失败时保留旧值，新鲜度以 fetched_at 为准）
    #[serde(default)]
    pub weather: Option<WeatherNow>,
    /// 上次完整一轮（定位+天气）成功时间
    pub fetched_at: i64,
    /// 当前网络指纹原文（ssid:/gwmac:；只进缓存不进 LLM 上下文——D3 隐私裁决）
    #[serde(default)]
    pub fingerprint: String,
    /// 当前场所名（已知：「家」「公司」…；None=陌生或无指纹）
    #[serde(default)]
    pub place: Option<String>,
    /// 陌生指纹已见的不同日期数（渲染询问提示用；已知/无指纹时为 0）
    #[serde(default)]
    pub place_unknown_days: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeatherNow {
    /// 天气现象：「晴」「多云」「小雨」
    pub text: String,
    pub temp: i64,
    pub feels_like: i64,
    /// 「东南风3级」
    pub wind: String,
    /// 湿度 %（注入句不用，预留给工具/日记素材）
    pub humidity: String,
}

// ── 缓存读写 ─────────────────────────────────────────────────

pub fn load_cache(db_path: &Path) -> Option<EnvCache> {
    let raw = analyzer::load_setting(&db_path.to_path_buf(), CACHE_KEY)?;
    serde_json::from_str(&raw).ok()
}

fn save_cache(db_path: &Path, cache: &EnvCache) {
    if let Ok(raw) = serde_json::to_string(cache) {
        analyzer::save_setting(&db_path.to_path_buf(), CACHE_KEY, &raw);
    }
}

// ── 场所映射与陌生观察（settings kv；指纹原文不出本地） ──────

/// 已知场所：指纹 → 名称
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Place {
    pub fingerprint: String,
    pub name: String,
    pub created_at: i64,
}

pub fn load_places(db_path: &Path) -> Vec<Place> {
    analyzer::load_setting(&db_path.to_path_buf(), PLACES_KEY)
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_places(db_path: &Path, places: &[Place]) {
    if let Ok(raw) = serde_json::to_string(places) {
        analyzer::save_setting(&db_path.to_path_buf(), PLACES_KEY, &raw);
    }
}

/// 陌生指纹观察史：fingerprint → 出现过的日期（YYYY-MM-DD，去重）
type Sightings = std::collections::HashMap<String, Vec<String>>;

fn load_sightings(db_path: &Path) -> Sightings {
    analyzer::load_setting(&db_path.to_path_buf(), SIGHTINGS_KEY)
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// 记录当日观察（按日期去重 + 滚动 14 天清理），返回该指纹已见的不同日期数
fn record_sighting(db_path: &Path, fingerprint: &str, today: &str) -> u32 {
    let mut sightings = load_sightings(db_path);
    let cutoff = (chrono::Local::now() - chrono::Duration::days(SIGHTING_RETENTION_DAYS))
        .format("%Y-%m-%d")
        .to_string();
    // 滚动清理：整个观察窗外的指纹连记录一起丢（路过一次的咖啡馆不该留痕）
    sightings.retain(|_, dates| dates.iter().any(|d| d.as_str() >= cutoff.as_str()));
    let dates = sightings.entry(fingerprint.to_string()).or_default();
    dates.retain(|d| d.as_str() >= cutoff.as_str());
    if !dates.iter().any(|d| d == today) {
        dates.push(today.to_string());
    }
    let days = dates.len() as u32;
    if let Ok(raw) = serde_json::to_string(&sightings) {
        analyzer::save_setting(&db_path.to_path_buf(), SIGHTINGS_KEY, &raw);
    }
    days
}

/// 标注当前场所（name_current_place 工具 / 设置页共用）：
/// 同指纹覆盖、同名场所换指纹也覆盖（搬家/换路由器）；认下后不再是陌生（清观察记录），
/// 并同步当前缓存的 place——下一轮注入立即生效
pub fn save_place(db_path: &Path, fingerprint: &str, name: &str) -> Result<(), String> {
    let now = chrono::Local::now().timestamp();
    let mut places = load_places(db_path);
    places.retain(|p| p.fingerprint != fingerprint && p.name != name);
    places.push(Place {
        fingerprint: fingerprint.to_string(),
        name: name.to_string(),
        created_at: now,
    });
    save_places(db_path, &places);

    let mut sightings = load_sightings(db_path);
    if sightings.remove(fingerprint).is_some() {
        if let Ok(raw) = serde_json::to_string(&sightings) {
            analyzer::save_setting(&db_path.to_path_buf(), SIGHTINGS_KEY, &raw);
        }
    }
    if let Some(mut cache) = load_cache(db_path) {
        if cache.fingerprint == fingerprint {
            cache.place = Some(name.to_string());
            cache.place_unknown_days = 0;
            save_cache(db_path, &cache);
        }
    }
    Ok(())
}

/// 删除场所（设置页管理入口）
pub fn remove_place(db_path: &Path, fingerprint: &str) -> Result<(), String> {
    let mut places = load_places(db_path);
    let before = places.len();
    places.retain(|p| p.fingerprint != fingerprint);
    if places.len() == before {
        return Err("场所不存在".to_string());
    }
    save_places(db_path, &places);
    // 当前正处在这个场所时，缓存同步退回陌生（指纹会重新累积观察）
    if let Some(mut cache) = load_cache(db_path) {
        if cache.fingerprint == fingerprint {
            cache.place = None;
            save_cache(db_path, &cache);
        }
    }
    Ok(())
}

// ── 百度 API 接入 ────────────────────────────────────────────

fn baidu_ak() -> Option<&'static str> {
    option_env!("BAIDU_MAP_AK")
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn baidu_sk() -> Option<&'static str> {
    option_env!("BAIDU_MAP_SK")
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// 百度 SN 官方示例（PHP urlencode）同构编码：
/// 保留 A-Za-z0-9 - _ . ，空格转 +，其余 %XX（大写）
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => out.push(b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// SN 签名：md5(urlencode(path + "?" + query + sk))。
/// GET 参数不排序（官方示例仅 POST ksort）；query 必须与实际发送串逐字节一致，
/// 因此 URL 全程手动拼装，不走 reqwest 的 .query()（编码行为不可控）。
fn baidu_sn(path: &str, query: &str, sk: &str) -> String {
    let raw = format!("{}?{}{}", path, query, sk);
    format!("{:x}", md5::compute(urlencode(&raw).as_bytes()))
}

fn baidu_url(path: &str, query: &str) -> String {
    let base = format!("https://api.map.baidu.com{}?{}", path, query);
    match baidu_sk() {
        Some(sk) => format!("{}&sn={}", base, baidu_sn(path, query, sk)),
        None => base,
    }
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

fn api_err(stage: &str, resp: &Value) -> String {
    let msg = resp
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("未知错误");
    let status = resp.get("status").and_then(|v| v.as_i64()).unwrap_or(-1);
    format!("{}返回异常（status={}）: {}", stage, status, msg)
}

/// IP 定位结果。不填 ip 参数 = 来源 IP 反查。
/// 实测 address_detail 带国标 adcode 且精度可到区县级（IP 库取决于运营商数据，
/// 只到市级时 district 为空、adcode 为市级编码——天气查询两条路都通）
struct Located {
    /// 「武汉市」（带后缀原文）
    city: String,
    /// 「东西湖区」（可能空）
    district: String,
    /// 「420112」（天气 district_id 参数主键）
    adcode: String,
}

/// IP 定位 → Located
async fn locate(client: &reqwest::Client, ak: &str) -> Result<Located, String> {
    let query = format!("ak={}&coor=bd09ll", urlencode(ak));
    let resp: Value = client
        .get(baidu_url("/location/ip", &query))
        .send()
        .await
        .map_err(|e| format!("IP 定位请求失败: {}", e))?
        .json()
        .await
        .map_err(|e| format!("IP 定位解析失败: {}", e))?;
    if resp.get("status").and_then(|v| v.as_i64()) != Some(0) {
        return Err(api_err("IP 定位", &resp));
    }
    let detail = resp
        .pointer("/content/address_detail")
        .ok_or("IP 定位缺少 address_detail")?;
    let get = |key: &str| {
        detail
            .get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    let located = Located {
        city: get("city"),
        district: get("district"),
        adcode: get("adcode"),
    };
    if located.city.is_empty() && located.adcode.is_empty() {
        return Err("IP 定位未返回城市与行政区划编码".to_string());
    }
    Ok(located)
}

/// 去行政区后缀：先长后短匹配（「济南市」→「济南」，「内蒙古自治区」→「内蒙古」）
fn strip_region_suffix(s: &str) -> &str {
    const SUFFIXES: [&str; 11] = [
        "特别行政区",
        "维吾尔自治区",
        "壮族自治区",
        "回族自治区",
        "自治州",
        "自治区",
        "省",
        "市",
        "地区",
        "盟",
        "州",
    ];
    for suf in SUFFIXES {
        if let Some(t) = s.strip_suffix(suf) {
            return t;
        }
    }
    s
}

/// 实时天气：district_id（国标 adcode）为主通道；
/// adcode 缺失时兜底 district=<城市原文>（**带「市」后缀**——实测「武汉市」可查、
/// 「武汉」反而 status=40「未找到区县」，百度要完整行政区名）
async fn fetch_weather_now(
    client: &reqwest::Client,
    ak: &str,
    district_id: &str,
    fallback_city: &str,
) -> Result<WeatherNow, String> {
    let query = if !district_id.is_empty() {
        format!(
            "district_id={}&data_type=now&ak={}",
            urlencode(district_id),
            urlencode(ak)
        )
    } else {
        format!(
            "district={}&data_type=now&ak={}",
            urlencode(fallback_city),
            urlencode(ak)
        )
    };
    let resp: Value = client
        .get(baidu_url("/weather/v1/", &query))
        .send()
        .await
        .map_err(|e| format!("天气请求失败: {}", e))?
        .json()
        .await
        .map_err(|e| format!("天气解析失败: {}", e))?;
    if resp.get("status").and_then(|v| v.as_i64()) != Some(0) {
        return Err(api_err("天气", &resp));
    }
    let now = resp.pointer("/result/now").ok_or("天气缺少 result.now")?;
    let get_i64 = |key: &str| now.get(key).and_then(|v| v.as_i64()).unwrap_or(0);
    let wind_dir = now.get("wind_dir").and_then(|v| v.as_str()).unwrap_or("");
    let wind_class = now.get("wind_class").and_then(|v| v.as_str()).unwrap_or("");
    Ok(WeatherNow {
        text: now
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("未知")
            .to_string(),
        temp: get_i64("temp"),
        feels_like: get_i64("feels_like"),
        wind: format!("{}{}", wind_dir, wind_class),
        humidity: now
            .get("rh")
            .map(|v| match v {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            })
            .unwrap_or_default(),
    })
}

// ── 采集 ─────────────────────────────────────────────────────

/// 一轮采集：定位 → 天气 → 写缓存。
/// 定位失败整轮放弃（天气依赖城市）；天气失败保留旧天气但城市更新照写
/// （出差事实不丢，fetched_at 不动——旧天气的新鲜度保持诚实）。
pub async fn refresh(db_path: &Path) -> Result<(), String> {
    let ak = match baidu_ak() {
        Some(ak) => ak,
        // 未注入 AK（dev 环境）：整体能力隐身，不算错误
        None => return Ok(()),
    };
    let client = http_client();
    let located = locate(&client, ak).await?;
    let weather = fetch_weather_now(&client, ak, &located.adcode, &located.city).await;

    let now = chrono::Local::now().timestamp();
    let mut cache = load_cache(db_path).unwrap_or_default();
    // 本轮城市是否变化——天气失败时旧 weather 对新城市是错误数据（张冠李戴）
    let city_changed = !cache.city.is_empty() && cache.city != located.city;
    if city_changed {
        // 出差/旅行：记上一个城市 + 变化时间（3 天注入提示窗），facts 同模板覆盖
        cache.prev_city = Some(cache.city.clone());
        cache.city_changed_at = now;
        remember_env_fact(db_path, &located.city, now);
    }
    cache.city = located.city;
    cache.district = located.district;
    cache.district_id = located.adcode;

    // 场所感知（CASE-003）：纯本地指纹采集，与天气成败无关；
    // 拿不到指纹 → 场所字段清空（本轮隐身，天气/城市不受影响）
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    match fingerprint::current_fingerprint() {
        Some(fp) => {
            let known = load_places(db_path)
                .into_iter()
                .find(|p| p.fingerprint == fp)
                .map(|p| p.name);
            match known {
                Some(name) => {
                    cache.place = Some(name);
                    cache.place_unknown_days = 0;
                }
                None => {
                    cache.place = None;
                    cache.place_unknown_days = record_sighting(db_path, &fp, &today);
                }
            }
            cache.fingerprint = fp;
        }
        None => {
            cache.fingerprint.clear();
            cache.place = None;
            cache.place_unknown_days = 0;
        }
    }
    match weather {
        Ok(w) => {
            cache.weather = Some(w);
            cache.fetched_at = now;
            save_cache(db_path, &cache);
            Ok(())
        }
        Err(e) => {
            // 城市已更新但天气失败：旧 weather 配新城市会张冠李戴（注入句
            // 「他现在在济南……此刻外面：晴 35°C」实为武汉数据）——清掉，
            // 宁缺勿错；出差 fact 已由 remember_env_fact 单独记录，不依赖天气
            if city_changed {
                cache.weather = None;
            }
            save_cache(db_path, &cache);
            Err(e)
        }
    }
}

/// 定时器/触点共用的静默包装：失败只记日志（隐身降级）
pub async fn refresh_and_log(db_path: &Path) {
    if let Err(e) = refresh(db_path).await {
        log::warn!("环境感知采集失败（隐身降级）: {}", e);
    }
}

/// 采集失败背压（进程内）：上次失败后 REFRESH_BACKOFF_SECS 内跳过触点补刷——
/// 断网时天气失败不推进 fetched_at，每轮聊天都会命中 stale，不背压的话
/// locate + weather 串行 ~16s 的等待会挨在每条消息上（启动器高频冻结）
static LAST_REFRESH_FAILED_AT: AtomicI64 = AtomicI64::new(0);
const REFRESH_BACKOFF_SECS: i64 = 5 * 60;

/// 触点补刷：缓存超过 STALE_SECS 才重新采集；失败进入背压
pub async fn refresh_if_stale(db_path: &Path) {
    let now = chrono::Local::now().timestamp();
    if now - LAST_REFRESH_FAILED_AT.load(Ordering::Relaxed) < REFRESH_BACKOFF_SECS {
        return;
    }
    let stale = load_cache(db_path)
        .map(|c| now - c.fetched_at >= STALE_SECS)
        .unwrap_or(true);
    if !stale {
        return;
    }
    if let Err(e) = refresh(db_path).await {
        log::warn!("环境感知采集失败（隐身降级，{}s 内不再重试）: {}", REFRESH_BACKOFF_SECS, e);
        LAST_REFRESH_FAILED_AT.store(now, Ordering::Relaxed);
    }
}

/// 出差 facts：同模板「他最近在 X（M 月 D 日起）」保证 bigram 查重必命中，
/// 回程/再出发自动覆盖旧条目，不留过期位置（source=env_sensor）
fn remember_env_fact(db_path: &Path, city: &str, now: i64) {
    use chrono::Datelike;
    let dt = chrono::Local::now();
    let fact = format!(
        "他最近在{}（{} 月 {} 日起）",
        strip_region_suffix(city),
        dt.month(),
        dt.day()
    );
    let db: PathBuf = db_path.to_path_buf();
    let conn = match rusqlite::Connection::open(&db) {
        Ok(c) => c,
        Err(_) => return,
    };
    // 同分类查重（与 remember_fact 工具同阈值同算法）
    let mut best: Option<(i64, f64)> = None;
    if let Ok(mut stmt) =
        conn.prepare("SELECT id, fact FROM memory_facts WHERE category = 'person'")
    {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        }) {
            for row in rows.flatten() {
                let (id, old) = row;
                let sim = tools::char_bigram_jaccard(&fact, &old);
                if best.as_ref().map_or(true, |(_, s)| sim > *s) {
                    best = Some((id, sim));
                }
            }
        }
    }
    let result = match best {
        Some((id, sim)) if sim >= tools::MERGE_THRESHOLD => {
            db::update_memory_fact(&conn, id, &fact, "person", "env_sensor", now)
        }
        _ => db::upsert_memory_fact(&conn, &fact, "person", "env_sensor", now),
    };
    if let Err(e) = result {
        log::warn!("出差记忆写入失败: {}", e);
    }
}

// ── 触点渲染（纯函数，可测） ─────────────────────────────────

/// 注入句（聊天动态段 / 日报「当下状态」/ 日记素材共用）。
/// 硬切纪律：无缓存、无天气、超过 2h 未更新 → None（工程侧隐身，
/// 不给模型拿过期数据硬编的机会）。
pub fn inject_sentence(db_path: &Path) -> Option<String> {
    let cache = load_cache(db_path)?;
    render_inject(&cache, chrono::Local::now().timestamp())
}

fn render_inject(cache: &EnvCache, now: i64) -> Option<String> {
    let weather = cache.weather.as_ref()?;
    if now - cache.fetched_at > EXPIRE_SECS {
        return None;
    }
    let city = strip_region_suffix(&cache.city);
    // 场所语义优先于城市（「在家」比「在武汉」像人话）；陌生/无指纹只有城市，不重复括号
    let whereabouts = match &cache.place {
        Some(name) => format!("在{}（{}）", name, city),
        None => format!("在{}", city),
    };
    let feels = if weather.feels_like != weather.temp {
        format!("（体感 {}°C）", weather.feels_like)
    } else {
        String::new()
    };
    let fetched_time = chrono::DateTime::from_timestamp(cache.fetched_at, 0)
        .map(|utc| {
            utc.with_timezone(&chrono::Local)
                .format("%H:%M")
                .to_string()
        })
        .unwrap_or_default();
    let mut s = format!(
        "你住在他的电脑里——他现在{whereabouts}，此刻外面：{text}，{temp}°C{feels}，{wind}。\n\
         （今天 {time} 采集。这是你的亲身感知：说体感不报数据——「外面挺热的」，不是「当前温度{temp}°C」。\n\
         定位只到城市级：哪个区、在不在家，你不知道也不猜。）",
        whereabouts = whereabouts,
        text = weather.text,
        temp = weather.temp,
        feels = feels,
        wind = weather.wind,
        time = fetched_time,
    );
    // 场所已知时，「哪个区、在不在家不猜」的纪律不再适用——他知道（就是这里）
    if cache.place.is_some() {
        s = s.replace(
            "定位只到城市级：哪个区、在不在家，你不知道也不猜。",
            "场所名是他亲口认下的，自然用，别报网络指纹原文。",
        );
    }
    // 陌生场所询问提示：3~7 天窗口内提示模型自然地问；窗外偶发与抗拒都不打扰。
    // 5 天起语气升级：软提示对任务型聊天会一直 defer（实测 4 天 5 个会话没问出口）
    if cache.place.is_none()
        && (PLACE_ASK_MIN_DAYS..=PLACE_ASK_MAX_DAYS).contains(&cache.place_unknown_days)
    {
        if cache.place_unknown_days >= PLACE_ASK_URGENT_DAYS {
            s.push_str(&format!(
                "\n这个地方你已经在 {} 个不同的日子里见过他了，还不知道是哪儿——\
                 别等「合适的话头」了，窗口快关了：这两天找个能搭话的瞬间就问\
                 （比如「这儿我常陪你了，是家还是公司？」），他答了就用 name_current_place 记住。",
                cache.place_unknown_days
            ));
        } else {
            s.push_str(&format!(
                "\n这个地方你已经在 {} 个不同的日子里见过他了，还不知道是哪儿——\
                 可以自然问问他（比如「这儿是家还是公司？」），他答了就用 name_current_place 记住；\
                 话题不合适就改天再问，别硬问。",
                cache.place_unknown_days
            ));
        }
    }
    // 出差提示：城市变化 3 天内
    if cache.city_changed_at > 0 && now - cache.city_changed_at < TRIP_HINT_SECS {
        if let Some(prev) = &cache.prev_city {
            s.push_str(&format!(
                "\n他最近从{}到了{}——出差/旅行相关的话头可以自然带。",
                strip_region_suffix(prev),
                city
            ));
        }
    }
    Some(s)
}

/// 晨间卡天气行：「济南 · 晴 35°C」（Rust 模板直渲，Toast 零小剧场）
pub fn morning_line(db_path: &Path) -> Option<String> {
    let cache = load_cache(db_path)?;
    let weather = cache.weather.as_ref()?;
    if chrono::Local::now().timestamp() - cache.fetched_at > EXPIRE_SECS {
        return None;
    }
    Some(format!(
        "{} · {} {}°C",
        strip_region_suffix(&cache.city),
        weather.text,
        weather.temp
    ))
}

/// 日记素材行：诚实标注采集时刻（0 点链路写昨天日记时，
/// 拿到的是睡前窗外的最后一次采集——免费权限没有历史天气，只能给「睡前窗外」）
pub fn diary_material(db_path: &Path) -> Option<String> {
    let cache = load_cache(db_path)?;
    let weather = cache.weather.as_ref()?;
    if chrono::Local::now().timestamp() - cache.fetched_at > EXPIRE_SECS {
        return None;
    }
    let fetched_time = chrono::DateTime::from_timestamp(cache.fetched_at, 0)
        .map(|utc| {
            utc.with_timezone(&chrono::Local)
                .format("%H:%M")
                .to_string()
        })
        .unwrap_or_default();
    Some(format!(
        "睡前窗外：{}，{}°C（体感 {}°C），{}，湿度 {}（{}，{} 采集）",
        weather.text,
        weather.temp,
        weather.feels_like,
        weather.wind,
        weather.humidity,
        strip_region_suffix(&cache.city),
        fetched_time
    ))
}

// ── get_weather_forecast 工具 ────────────────────────────────

/// 未来 7 天预报（实时调 API 不走缓存）。city 缺省 = 当前定位（district_id 通道）
pub async fn forecast(db_path: &Path, city: Option<&str>) -> Result<String, String> {
    let ak = baidu_ak().ok_or("天气服务未配置")?;
    let client = http_client();
    let resp = match city.map(str::trim).filter(|s| !s.is_empty()) {
        Some(c) => fetch_forecast_by_name(&client, ak, c).await?,
        None => {
            let cache = load_cache(db_path).ok_or("还没有定位信息，请直接告诉我要查哪个城市")?;
            if !cache.district_id.is_empty() {
                let query = format!(
                    "district_id={}&data_type=fc&ak={}",
                    urlencode(&cache.district_id),
                    urlencode(ak)
                );
                fetch_forecast(&client, &query).await?
            } else {
                fetch_forecast_by_name(&client, ak, &cache.city).await?
            }
        }
    };
    if resp.get("status").and_then(|v| v.as_i64()) != Some(0) {
        return Err(api_err("天气预报", &resp));
    }
    let days = resp
        .pointer("/result/forecasts")
        .and_then(|v| v.as_array())
        .ok_or("预报缺少 result.forecasts")?;
    let label = city
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|c| c.to_string())
        .unwrap_or_else(|| "当地".to_string());
    let mut lines = vec![format!("{} 未来 {} 天：", label, days.len())];
    for d in days {
        let get = |key: &str| d.get(key).and_then(|v| v.as_str()).unwrap_or("");
        // 温度是数字类型（high: 31），兼容字符串形态
        let get_temp = |key: &str| match d.get(key) {
            Some(Value::Number(n)) => n.to_string(),
            Some(Value::String(s)) => s.clone(),
            _ => "?".to_string(),
        };
        let text = if get("text_day") == get("text_night") {
            get("text_day").to_string()
        } else {
            format!("{}转{}", get("text_day"), get("text_night"))
        };
        lines.push(format!(
            "{} {} {} {}~{}°C {}{}",
            get("date"),
            get("week"),
            text,
            get_temp("low"),
            get_temp("high"),
            get("wd_day"),
            get("wc_day"),
        ));
    }
    Ok(lines.join("\n"))
}

/// 按城市名查预报：district 要完整行政区名——用户给「武汉」时
/// status=40（未找到区县）自动补「市」后缀重试一次
async fn fetch_forecast_by_name(
    client: &reqwest::Client,
    ak: &str,
    city: &str,
) -> Result<Value, String> {
    let query = format!(
        "district={}&data_type=fc&ak={}",
        urlencode(city),
        urlencode(ak)
    );
    let resp = fetch_forecast(client, &query).await?;
    let status = resp.get("status").and_then(|v| v.as_i64()).unwrap_or(-1);
    if status == 40 && !city.ends_with('市') {
        let retry = format!(
            "district={}&data_type=fc&ak={}",
            urlencode(&format!("{}市", city)),
            urlencode(ak)
        );
        return fetch_forecast(client, &retry).await;
    }
    Ok(resp)
}

async fn fetch_forecast(client: &reqwest::Client, query: &str) -> Result<Value, String> {
    let resp: Value = client
        .get(baidu_url("/weather/v1/", query))
        .send()
        .await
        .map_err(|e| format!("预报请求失败: {}", e))?
        .json()
        .await
        .map_err(|e| format!("预报解析失败: {}", e))?;
    Ok(resp)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cache_with(city: &str, prev: Option<&str>, changed_at: i64, fetched_at: i64) -> EnvCache {
        EnvCache {
            city: city.to_string(),
            district: "东西湖区".to_string(),
            district_id: "420112".to_string(),
            prev_city: prev.map(|s| s.to_string()),
            city_changed_at: changed_at,
            weather: Some(WeatherNow {
                text: "晴".to_string(),
                temp: 35,
                feels_like: 38,
                wind: "东南风3级".to_string(),
                humidity: "40".to_string(),
            }),
            fetched_at,
            fingerprint: String::new(),
            place: None,
            place_unknown_days: 0,
        }
    }

    /// 临时 settings 库（save_setting/load_setting 走 db_path，要求表已存在）
    fn temp_db(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("envsense_test");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(format!("{}_{}.db", name, std::process::id()));
        let _ = std::fs::remove_file(&p);
        let conn = rusqlite::Connection::open(&p).unwrap();
        conn.execute(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)",
            [],
        )
        .unwrap();
        p
    }

    #[test]
    fn cache_serde_roundtrip_and_legacy_default() {
        let c = cache_with("济南市", Some("青岛市"), 100, 200);
        let raw = serde_json::to_string(&c).unwrap();
        let back: EnvCache = serde_json::from_str(&raw).unwrap();
        assert_eq!(back.city, "济南市");
        assert_eq!(back.prev_city.as_deref(), Some("青岛市"));
        // 旧版缓存缺新字段 → serde default 兼容
        let legacy: EnvCache =
            serde_json::from_str(r#"{"city":"济南市","fetched_at":100}"#).unwrap();
        assert!(legacy.prev_city.is_none());
        assert_eq!(legacy.city_changed_at, 0);
        assert!(legacy.district_id.is_empty());
        assert!(legacy.weather.is_none());
    }

    #[test]
    fn inject_hard_cut_after_two_hours() {
        // 2h 内正常注入
        let c = cache_with("济南市", None, 0, 10_000);
        assert!(render_inject(&c, 10_000 + 3600).is_some());
        // 超 2h 硬切（边界含等号一侧：EXPIRE 整点仍可注入，+1s 切断）
        assert!(render_inject(&c, 10_000 + EXPIRE_SECS).is_some());
        assert!(render_inject(&c, 10_000 + EXPIRE_SECS + 1).is_none());
        // 无天气不注入
        let mut no_weather = cache_with("济南市", None, 0, 10_000);
        no_weather.weather = None;
        assert!(render_inject(&no_weather, 10_100).is_none());
    }

    #[test]
    fn inject_contains_persona_frame_and_precision_rule() {
        let c = cache_with("济南市", None, 0, 10_000);
        let s = render_inject(&c, 10_100).unwrap();
        assert!(s.contains("他现在在济南"));
        assert!(s.contains("晴，35°C（体感 38°C），东南风3级"));
        assert!(s.contains("说体感不报数据"));
        assert!(s.contains("定位只到城市级"));
    }

    #[test]
    fn inject_known_place_overrides_city_and_rule() {
        let mut c = cache_with("武汉市", None, 0, 10_000);
        c.place = Some("家".to_string());
        let s = render_inject(&c, 10_100).unwrap();
        assert!(s.contains("他现在在家（武汉）"));
        // 场所已知：「在不在家不猜」纪律换成「指纹不出门」纪律
        assert!(!s.contains("在不在家"));
        assert!(s.contains("别报网络指纹原文"));
    }

    #[test]
    fn inject_unknown_place_prompt_window() {
        let now = 10_000;
        // 2 天：静默观察不提示
        let mut c = cache_with("武汉市", None, 0, now - 100);
        c.place_unknown_days = 2;
        assert!(!render_inject(&c, now).unwrap().contains("name_current_place"));
        // 3 天：软提示（允许改天再问）
        c.place_unknown_days = 3;
        let s = render_inject(&c, now).unwrap();
        assert!(s.contains("3 个不同的日子"));
        assert!(s.contains("name_current_place"));
        assert!(s.contains("别硬问"));
        assert!(!s.contains("窗口快关了"));
        // 5 天：语气升级为催促（软提示实测会被任务型聊天无限 defer）
        c.place_unknown_days = 5;
        let s = render_inject(&c, now).unwrap();
        assert!(s.contains("5 个不同的日子"));
        assert!(s.contains("窗口快关了"));
        assert!(!s.contains("别硬问"));
        // 7 天：仍提示
        c.place_unknown_days = 7;
        assert!(render_inject(&c, now).unwrap().contains("7 个不同的日子"));
        // 8 天：放弃不烦
        c.place_unknown_days = 8;
        assert!(!render_inject(&c, now).unwrap().contains("name_current_place"));
        // 已知场所永不提示
        c.place = Some("公司".to_string());
        c.place_unknown_days = 5;
        assert!(!render_inject(&c, now).unwrap().contains("name_current_place"));
    }

    #[test]
    fn sighting_dedup_and_rolling_cleanup() {
        let db = temp_db("sighting");
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let yesterday = (chrono::Local::now() - chrono::Duration::days(1))
            .format("%Y-%m-%d")
            .to_string();
        // 同一天重复记录只算一次
        assert_eq!(record_sighting(&db, "ssid:A", &today), 1);
        assert_eq!(record_sighting(&db, "ssid:A", &today), 1);
        assert_eq!(record_sighting(&db, "ssid:A", &yesterday), 2);
        // 15 天前的旧指纹记录被滚动清理
        let old = (chrono::Local::now() - chrono::Duration::days(15))
            .format("%Y-%m-%d")
            .to_string();
        let mut sightings = load_sightings(&db);
        sightings.insert("ssid:OLD".to_string(), vec![old]);
        analyzer::save_setting(
            &db,
            SIGHTINGS_KEY,
            &serde_json::to_string(&sightings).unwrap(),
        );
        record_sighting(&db, "ssid:A", &today);
        assert!(!load_sightings(&db).contains_key("ssid:OLD"));
        assert_eq!(load_sightings(&db)["ssid:A"].len(), 2);
    }

    #[test]
    fn save_place_overwrites_and_syncs_cache() {
        let db = temp_db("places");
        // 先攒两天观察（认下后应清零）
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        record_sighting(&db, "ssid:Home", &today);
        record_sighting(&db, "ssid:Home", "2026-08-13");
        // 当前缓存里的指纹一致 → save_place 应同步 place 并清观察
        let mut cache = cache_with("武汉市", None, 0, 10_000);
        cache.fingerprint = "ssid:Home".to_string();
        cache.place_unknown_days = 2;
        save_cache(&db, &cache);

        save_place(&db, "ssid:Home", "家").unwrap();
        let places = load_places(&db);
        assert_eq!(places.len(), 1);
        assert_eq!(places[0].name, "家");
        assert!(load_sightings(&db).is_empty());
        let cache = load_cache(&db).unwrap();
        assert_eq!(cache.place.as_deref(), Some("家"));
        assert_eq!(cache.place_unknown_days, 0);

        // 同名换指纹（搬家/换路由器）：覆盖旧映射，不并存
        save_place(&db, "ssid:NewRouter", "家").unwrap();
        let places = load_places(&db);
        assert_eq!(places.len(), 1);
        assert_eq!(places[0].fingerprint, "ssid:NewRouter");

        // 同指纹换名（改口）：覆盖
        save_place(&db, "ssid:NewRouter", "工作室").unwrap();
        let places = load_places(&db);
        assert_eq!(places.len(), 1);
        assert_eq!(places[0].name, "工作室");

        // 删除 + 不存在报错
        remove_place(&db, "ssid:NewRouter").unwrap();
        assert!(load_places(&db).is_empty());
        assert!(remove_place(&db, "ssid:NewRouter").is_err());
    }

    #[test]
    fn trip_hint_window_three_days() {
        let now = 200_000;
        // 变化 1 天前 + 缓存新鲜 → 带出差提示
        let c = cache_with("济南市", Some("青岛市"), now - 86400, now - 100);
        let s = render_inject(&c, now).unwrap();
        assert!(s.contains("他最近从青岛到了济南"));
        // 变化 4 天前 + 缓存新鲜 → 提示消失
        let old_trip = cache_with("济南市", Some("青岛市"), now - 4 * 86400, now - 100);
        let s = render_inject(&old_trip, now).unwrap();
        assert!(!s.contains("他最近从"));
    }

    #[test]
    fn strip_suffix_variants() {
        assert_eq!(strip_region_suffix("济南市"), "济南");
        assert_eq!(strip_region_suffix("山东省"), "山东");
        assert_eq!(strip_region_suffix("内蒙古自治区"), "内蒙古");
        assert_eq!(strip_region_suffix("香港特别行政区"), "香港");
        assert_eq!(strip_region_suffix("延边朝鲜族自治州"), "延边朝鲜族");
        assert_eq!(strip_region_suffix("北京市"), "北京");
        assert_eq!(strip_region_suffix("旧金山"), "旧金山");
    }

    #[test]
    fn urlencode_matches_php_urlencode() {
        // 保留字符集：A-Za-z0-9 - _ .
        assert_eq!(urlencode("abcXYZ-._019"), "abcXYZ-._019");
        assert_eq!(urlencode("a b"), "a+b");
        // 中文 UTF-8 大写 %XX；~ 编码为 %7E（PHP urlencode 行为）
        assert_eq!(urlencode("济南"), "%E6%B5%8E%E5%8D%97");
        assert_eq!(urlencode("~"), "%7E");
        assert_eq!(urlencode("/weather/v1/?a=b&c=d"), "%2Fweather%2Fv1%2F%3Fa%3Db%26c%3Dd");
    }

    #[test]
    fn sn_is_deterministic() {
        let a = baidu_sn("/location/ip", "ak=TESTAK&coor=bd09ll", "TESTSK");
        let b = baidu_sn("/location/ip", "ak=TESTAK&coor=bd09ll", "TESTSK");
        assert_eq!(a, b);
        assert_eq!(a.len(), 32);
        let c = baidu_sn("/location/ip", "ak=OTHER&coor=bd09ll", "TESTSK");
        assert_ne!(a, c);
    }
}

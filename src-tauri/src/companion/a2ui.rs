//! A2UI v0.9 消息校验（render_ui 工具的服务端守门）。
//!
//! 模型经 function calling 产出消息数组，这里做结构校验后才允许 emit 给前端：
//! 失败原因以文本返回给模型自我纠正（复用 tool-use 循环，无需独立重试通道）。
//! 校验白名单与前端渲染器能力集保持一致——模型无法产出渲染不了的组件。

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};

/// 基础目录全量 18 个组件（与前端渲染器一一对应）
const ALLOWED_COMPONENTS: [&str; 18] = [
    "Text",
    "Image",
    "Icon",
    "Video",
    "AudioPlayer",
    "Row",
    "Column",
    "List",
    "Card",
    "Tabs",
    "Divider",
    "Modal",
    "Button",
    "CheckBox",
    "TextField",
    "DateTimeInput",
    "ChoicePicker",
    "Slider",
];

/// 防失控上限：单次调用的消息数 / 组件总数 / 序列化体积
const MAX_MESSAGES: usize = 20;
const MAX_COMPONENTS: usize = 100;
const MAX_PAYLOAD_BYTES: usize = 32 * 1024;

/// 单个 surface 的累积状态（同一轮对话内多次 render_ui 调用间保持）
#[derive(Default)]
pub struct SurfaceState {
    pub created: bool,
    pub component_ids: HashSet<String>,
}

/// 校验并应用一批 A2UI 消息到 surface 状态。
/// `surfaces` 跨 render_ui 调用累积；校验通过才变更状态（先验后改，全部通过才提交）。
pub fn validate_and_apply(
    messages: &[Value],
    surface_id: &str,
    surfaces: &mut HashMap<String, SurfaceState>,
) -> Result<(), String> {
    if messages.is_empty() {
        return Err("messages 为空".to_string());
    }
    if messages.len() > MAX_MESSAGES {
        return Err(format!("messages 超过 {} 条上限", MAX_MESSAGES));
    }
    let payload_size = serde_json::to_string(messages)
        .map(|s| s.len())
        .unwrap_or(0);
    if payload_size > MAX_PAYLOAD_BYTES {
        return Err(format!("消息体积超过 {}KB 上限", MAX_PAYLOAD_BYTES / 1024));
    }

    let existing = surfaces.get(surface_id);
    let will_create = messages.iter().any(|m| m.get("createSurface").is_some());
    if existing.map(|s| s.created).unwrap_or(false) && will_create {
        return Err(format!(
            "surface「{}」已存在，重复 createSurface",
            surface_id
        ));
    }
    if existing.is_none() && !will_create {
        return Err("首个 render_ui 调用必须包含 createSurface".to_string());
    }

    // 组件 id 累积快照：先收集本批变更，全部校验通过后才提交到 surfaces
    let mut ids: HashSet<String> = existing
        .map(|s| s.component_ids.clone())
        .unwrap_or_default();
    let mut new_ids: HashSet<String> = HashSet::new();
    let mut component_count = ids.len();
    // (持有者 id, 被引用 id) 延迟到收集完统一检查（允许同批前向引用）
    let mut pending_refs: Vec<(String, String)> = Vec::new();

    for (i, msg) in messages.iter().enumerate() {
        let obj = msg
            .as_object()
            .ok_or_else(|| format!("messages[{}] 不是对象", i))?;
        if obj.get("version").and_then(|v| v.as_str()) != Some("v0.9") {
            return Err(format!("messages[{}] 缺少 version: \"v0.9\"", i));
        }
        let kinds: Vec<&str> = [
            "createSurface",
            "updateComponents",
            "updateDataModel",
            "deleteSurface",
        ]
        .iter()
        .filter(|k| obj.contains_key(**k))
        .copied()
        .collect();
        if kinds.len() != 1 {
            return Err(format!(
                "messages[{}] 必须且只能包含 createSurface/updateComponents/updateDataModel/deleteSurface 之一",
                i
            ));
        }
        let body = &obj[kinds[0]];
        let msg_surface = body
            .get("surfaceId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("messages[{}].{} 缺少 surfaceId", i, kinds[0]))?;
        if msg_surface != surface_id {
            return Err(format!(
                "messages[{}] 的 surfaceId「{}」与参数 surface_id「{}」不一致",
                i, msg_surface, surface_id
            ));
        }

        if kinds[0] == "updateComponents" {
            let components = body
                .get("components")
                .and_then(|v| v.as_array())
                .ok_or_else(|| format!("messages[{}].updateComponents 缺少 components 数组", i))?;
            for c in components {
                let id = c
                    .get("id")
                    .and_then(|v| v.as_str())
                    .ok_or("组件缺少 id".to_string())?;
                let ctype = c
                    .get("component")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| format!("组件「{}」缺少 component", id))?;
                if !ALLOWED_COMPONENTS.contains(&ctype) {
                    return Err(format!(
                        "组件「{}」类型「{}」不在支持列表（{}）",
                        id,
                        ctype,
                        ALLOWED_COMPONENTS.join("/")
                    ));
                }
                if new_ids.insert(id.to_string()) && !ids.contains(id) {
                    component_count += 1;
                    if component_count > MAX_COMPONENTS {
                        return Err(format!("组件总数超过 {} 上限", MAX_COMPONENTS));
                    }
                }
                collect_refs(c, id, &mut pending_refs);
            }
            // 本批全部组件先并入 id 集再查引用（支持同批前向引用）
            for nid in &new_ids {
                ids.insert(nid.clone());
            }
        }
    }

    for (owner, r) in &pending_refs {
        if !ids.contains(r) {
            return Err(format!("组件「{}」引用了不存在的 id「{}」", owner, r));
        }
    }
    if will_create && !ids.contains("root") {
        return Err("新建 surface 必须提供 id 为 \"root\" 的根组件".to_string());
    }

    // 提交状态
    let state = surfaces.entry(surface_id.to_string()).or_default();
    if will_create {
        state.created = true;
    }
    state.component_ids = ids;
    if messages.iter().any(|m| m.get("deleteSurface").is_some()) {
        state.created = false;
        state.component_ids.clear();
    }
    Ok(())
}

/// 收集组件定义里的 id 引用：children/child/tabs[].child/List 模板的 componentId
fn collect_refs(component: &Value, owner: &str, out: &mut Vec<(String, String)>) {
    if let Some(children) = component.get("children") {
        match children {
            Value::Array(arr) => {
                for c in arr {
                    if let Some(s) = c.as_str() {
                        out.push((owner.to_string(), s.to_string()));
                    }
                }
            }
            Value::Object(o) => {
                // List 模板形式：{"path": "/items", "componentId": "tpl"}
                if let Some(tpl) = o.get("componentId").and_then(|v| v.as_str()) {
                    out.push((owner.to_string(), tpl.to_string()));
                }
            }
            _ => {}
        }
    }
    if let Some(child) = component.get("child").and_then(|v| v.as_str()) {
        out.push((owner.to_string(), child.to_string()));
    }
    if let Some(tabs) = component.get("tabs").and_then(|v| v.as_array()) {
        for t in tabs {
            if let Some(child) = t.get("child").and_then(|v| v.as_str()) {
                out.push((owner.to_string(), child.to_string()));
            }
        }
    }
}

/// 从 surface 累积消息提取语义摘要：上下文里替代协议 JSON（占位文本的升级版）。
/// 模型看到摘要就知道卡片里有什么按钮、各 action 的语义、展示的数据——
/// 收到「用户操作」回传时不再失忆，也不会复读占位句式。
pub fn summarize_surface(messages: &[Value]) -> String {
    // 重放：组件表（保序）+ 数据模型（path 写入 best-effort，失败不阻塞摘要）
    let mut order: Vec<String> = Vec::new();
    let mut components: HashMap<String, &Value> = HashMap::new();
    let mut data_model: Option<Value> = None;
    for msg in messages {
        if let Some(uc) = msg.get("updateComponents") {
            if let Some(list) = uc.get("components").and_then(|v| v.as_array()) {
                for c in list {
                    if let Some(id) = c.get("id").and_then(|v| v.as_str()) {
                        if components.insert(id.to_string(), c).is_none() {
                            order.push(id.to_string());
                        }
                    }
                }
            }
        } else if let Some(ud) = msg.get("updateDataModel") {
            let path = ud.get("path").and_then(|v| v.as_str());
            let value = ud.get("value").cloned().unwrap_or(Value::Null);
            match path {
                None | Some("") | Some("/") => data_model = Some(value),
                Some(p) => {
                    let root = data_model.get_or_insert_with(|| json!({}));
                    if let Some(slot) = root.pointer_mut(p) {
                        *slot = value;
                    }
                }
            }
        }
    }

    // 组件语义：标题/正文静态文本、按钮 label+action、表单 label
    let mut headings: Vec<String> = Vec::new();
    let mut texts: Vec<String> = Vec::new();
    let mut buttons: Vec<String> = Vec::new();
    let mut fields: Vec<String> = Vec::new();
    for id in &order {
        let c = components[id];
        match c.get("component").and_then(|v| v.as_str()) {
            Some("Text") => {
                if let Some(t) = c.get("text").and_then(|v| v.as_str()) {
                    let t = truncate_chars(t.trim(), 40);
                    if t.is_empty() {
                        continue;
                    }
                    match c.get("variant").and_then(|v| v.as_str()) {
                        Some("h1") | Some("h2") | Some("h3") | Some("h4") | Some("h5") => {
                            headings.push(t)
                        }
                        _ => texts.push(t),
                    }
                }
            }
            Some("Button") => {
                let label = c
                    .get("child")
                    .and_then(|v| v.as_str())
                    .and_then(|cid| components.get(cid))
                    .and_then(|cc| cc.get("text"))
                    .and_then(|v| v.as_str())
                    .map(|s| truncate_chars(s.trim(), 20));
                let action = c.pointer("/action/event/name").and_then(|v| v.as_str());
                match (label, action) {
                    (Some(l), Some(a)) if !l.is_empty() => {
                        buttons.push(format!("「{}」(action: {})", l, a))
                    }
                    (Some(l), None) if !l.is_empty() => buttons.push(format!("「{}」", l)),
                    (_, Some(a)) => buttons.push(format!("(action: {})", a)),
                    _ => {}
                }
            }
            Some("TextField")
            | Some("CheckBox")
            | Some("Slider")
            | Some("ChoicePicker")
            | Some("DateTimeInput") => {
                if let Some(l) = c.get("label").and_then(|v| v.as_str()) {
                    let l = truncate_chars(l.trim(), 20);
                    if !l.is_empty() {
                        fields.push(l);
                    }
                }
            }
            _ => {}
        }
    }

    let mut parts: Vec<String> = Vec::new();
    if !headings.is_empty() {
        parts.push(format!(
            "标题「{}」",
            headings
                .into_iter()
                .take(2)
                .collect::<Vec<_>>()
                .join("」/「")
        ));
    }
    if !texts.is_empty() {
        parts.push(format!(
            "正文：{}",
            texts.into_iter().take(4).collect::<Vec<_>>().join("；")
        ));
    }
    if !buttons.is_empty() {
        parts.push(format!(
            "按钮：{}",
            buttons.into_iter().take(6).collect::<Vec<_>>().join("、")
        ));
    }
    if !fields.is_empty() {
        parts.push(format!(
            "表单：{}",
            fields.into_iter().take(5).collect::<Vec<_>>().join("、")
        ));
    }
    if let Some(dm) = &data_model {
        if !dm.is_null() {
            parts.push(format!("数据：{}", truncate_chars(&dm.to_string(), 600)));
        }
    }

    if parts.is_empty() {
        "（向用户展示了一张界面卡片）".to_string()
    } else {
        format!("（向用户展示了一张界面卡片——{}）", parts.join("；"))
    }
}

/// 按字符数截断（中文多字节安全），超长补省略号
fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(max).collect::<String>())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_create() -> Vec<Value> {
        vec![
            json!({"version":"v0.9","createSurface":{"surfaceId":"s1","catalogId":"basic"}}),
            json!({"version":"v0.9","updateComponents":{"surfaceId":"s1","components":[
                {"id":"root","component":"Card","child":"col"},
                {"id":"col","component":"Column","children":["t"]},
                {"id":"t","component":"Text","text":{"path":"/title"}}
            ]}}),
            json!({"version":"v0.9","updateDataModel":{"surfaceId":"s1","value":{"title":"hi"}}}),
        ]
    }

    #[test]
    fn accepts_valid_batch() {
        let mut surfaces = HashMap::new();
        assert!(validate_and_apply(&sample_create(), "s1", &mut surfaces).is_ok());
    }

    #[test]
    fn rejects_unknown_component() {
        let mut msgs = sample_create();
        msgs[1]["updateComponents"]["components"][2]["component"] = json!("Iframe");
        let mut surfaces = HashMap::new();
        assert!(validate_and_apply(&msgs, "s1", &mut surfaces).is_err());
    }

    #[test]
    fn rejects_dangling_ref() {
        let mut msgs = sample_create();
        msgs[1]["updateComponents"]["components"][1]["children"] = json!(["t", "ghost"]);
        let mut surfaces = HashMap::new();
        assert!(validate_and_apply(&msgs, "s1", &mut surfaces).is_err());
    }

    #[test]
    fn rejects_missing_create_first() {
        let msgs = vec![sample_create()[1].clone()];
        let mut surfaces = HashMap::new();
        assert!(validate_and_apply(&msgs, "s1", &mut surfaces).is_err());
    }

    #[test]
    fn allows_incremental_update_after_create() {
        let mut surfaces = HashMap::new();
        validate_and_apply(&sample_create(), "s1", &mut surfaces).unwrap();
        let update = vec![
            json!({"version":"v0.9","updateDataModel":{"surfaceId":"s1","path":"/title","value":"bye"}}),
        ];
        assert!(validate_and_apply(&update, "s1", &mut surfaces).is_ok());
    }

    #[test]
    fn summarize_extracts_button_action_and_data() {
        let msgs = vec![
            json!({"version":"v0.9","createSurface":{"surfaceId":"s1","catalogId":"basic"}}),
            json!({"version":"v0.9","updateComponents":{"surfaceId":"s1","components":[
                {"id":"root","component":"Card","child":"col"},
                {"id":"col","component":"Column","children":["t","b","bt"]},
                {"id":"t","component":"Text","text":{"path":"/title"},"variant":"h2"},
                {"id":"b","component":"Button","child":"bt","action":{"event":{"name":"view_details","context":{}}}},
                {"id":"bt","component":"Text","text":"查看详情"}
            ]}}),
            json!({"version":"v0.9","updateDataModel":{"surfaceId":"s1","value":{"title":"今日使用统计"}}}),
        ];
        let s = summarize_surface(&msgs);
        assert!(s.contains("查看详情"), "按钮 label 缺失: {}", s);
        assert!(s.contains("view_details"), "action 名缺失: {}", s);
        assert!(s.contains("今日使用统计"), "数据缺失: {}", s);
    }

    #[test]
    fn summarize_falls_back_when_no_semantics() {
        let msgs = vec![
            json!({"version":"v0.9","createSurface":{"surfaceId":"s1","catalogId":"basic"}}),
            json!({"version":"v0.9","updateComponents":{"surfaceId":"s1","components":[
                {"id":"root","component":"Card","child":"col"},
                {"id":"col","component":"Column","children":[]}
            ]}}),
        ];
        assert_eq!(summarize_surface(&msgs), "（向用户展示了一张界面卡片）");
    }

    #[test]
    fn summarize_applies_incremental_data_update() {
        let mut msgs = vec![
            json!({"version":"v0.9","updateDataModel":{"surfaceId":"s1","value":{"title":"旧标题","count":1}}}),
        ];
        msgs.push(json!({"version":"v0.9","updateDataModel":{"surfaceId":"s1","path":"/count","value":2}}));
        let s = summarize_surface(&msgs);
        assert!(s.contains("旧标题"), "整体数据缺失: {}", s);
        assert!(s.contains("\"count\":2"), "path 增量未生效: {}", s);
    }
}

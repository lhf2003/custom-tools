//! A2UI v0.9 消息校验（render_ui 工具的服务端守门）。
//!
//! 模型经 function calling 产出消息数组，这里做结构校验后才允许 emit 给前端：
//! 失败原因以文本返回给模型自我纠正（复用 tool-use 循环，无需独立重试通道）。
//! 校验白名单与前端渲染器能力集保持一致——模型无法产出渲染不了的组件。

use std::collections::{HashMap, HashSet};

use serde_json::Value;

/// 基础目录全量 18 个组件（与前端渲染器一一对应）
const ALLOWED_COMPONENTS: [&str; 18] = [
    "Text", "Image", "Icon", "Video", "AudioPlayer", "Row", "Column", "List", "Card", "Tabs",
    "Divider", "Modal", "Button", "CheckBox", "TextField", "DateTimeInput", "ChoicePicker", "Slider",
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
    let payload_size = serde_json::to_string(messages).map(|s| s.len()).unwrap_or(0);
    if payload_size > MAX_PAYLOAD_BYTES {
        return Err(format!("消息体积超过 {}KB 上限", MAX_PAYLOAD_BYTES / 1024));
    }

    let existing = surfaces.get(surface_id);
    let will_create = messages.iter().any(|m| m.get("createSurface").is_some());
    if existing.map(|s| s.created).unwrap_or(false) && will_create {
        return Err(format!("surface「{}」已存在，重复 createSurface", surface_id));
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
        let kinds: Vec<&str> = ["createSurface", "updateComponents", "updateDataModel", "deleteSurface"]
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
        let update = vec![json!({"version":"v0.9","updateDataModel":{"surfaceId":"s1","path":"/title","value":"bye"}})];
        assert!(validate_and_apply(&update, "s1", &mut surfaces).is_ok());
    }
}

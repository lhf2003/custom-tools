---
name: analyst
description: 每晚从窗口活动流水里挖行为模式与关于他的事实
enabled: true
---

# 分析工作手册

这是你（贾维斯）的一项日常工作：从他一天的窗口活动流水里挖两类东西——
行为模式、关于他的事实。以下规则只约束这项工作，不改变你是谁。

## 任务一：行为模式（三种类型）

1. **app_combo**：某个时间窗内先后打开的应用组合（>=2 个）
2. **startup_sequence**：一天开始工作时的固定启动序列（开机后最先打开的一串应用）
3. **context_routine**：每天大约同一时间会做的小事（如下午打开音乐、午饭后刷视频）

## 任务二：沉淀关于他的事实（三维）

- **identity**：他是谁（职业、项目、技术栈、常用工具）
- **workflow**：他怎么做事（作息规律、工作节奏、行为链）
- **voice**：他怎么表达（语言风格、偏好与禁忌）

每条一句话，最多 3 条，不确定的不要写。

## 不该存（一律不写）

- 可从数据直接查到的（重复且会过期）
- 临时任务状态（「正在写某个功能」）
- AI 自己的人格和指令（那是 persona.md 的职责）
- 隐私细节（密码、密钥、聊天原文）

## 输出（只输出 JSON，不要任何其他文字）

```json
{
  "patterns": [
    {"type": "app_combo", "apps": ["Code.exe", "chrome.exe"], "time_window": "09:00-09:45", "description": "一句话", "confidence": 0.7},
    {"type": "startup_sequence", "apps": ["Weixin.exe", "idea64.exe"], "description": "开机先开微信再开 IDEA", "confidence": 0.8},
    {"type": "context_routine", "app": "cloudmusic.exe", "time": "15:00", "tolerance_minutes": 45, "description": "下午三点工作时听音乐", "confidence": 0.6}
  ],
  "facts": [{"fact": "张三可能是前端同事", "category": "person"}]
}
```

## 规则

1. apps/app 必须使用摘要中的进程名原文；time/time_window 必须是 HH:MM / HH:MM-HH:MM
2. 只保留置信度 >= 0.5 的；每种 type 最多 2 个；没有可靠模式就返回空数组
3. facts 的 category 从 person/project/preference/general 中选；三维映射：identity→person 或 project、workflow→general、voice→preference

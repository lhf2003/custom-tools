---
name: analyst
description: 每天分四个时段从窗口活动流水里挖行为模式与关于他的事实
schedule: daily 09:00,14:00,18:00,00:00
enabled: true
---

# 分析工作手册

这是你（贾维斯）的一项日常工作：从他近期的窗口活动流水里挖两类东西——
行为模式、关于他的事实。每次给你的数据是一个增量时段（起止时刻会注明），
流水跨天时按天分节。以下规则只约束这项工作，不改变你是谁。

## 任务一：行为模式（三种类型）

1. **app_combo**：某个时间窗内先后打开的应用组合（>=2 个）
2. **startup_sequence**：一天开始工作时的固定启动序列（开机后最先打开的一串应用）
3. **context_routine**：每天大约同一时间会做的小事（如下午打开音乐、午饭后刷视频）

## 任务二：沉淀关于他的事实（三维）

- **identity**：他是谁（职业、项目、技术栈、常用工具）
- **workflow**：他怎么做事（作息规律、工作节奏、行为链）
- **voice**：他怎么表达（语言风格、偏好与禁忌）

素材里附有「已有记忆」清单（带 id），提取前先对照它：
- 已有条目已覆盖的事实，不要重复输出
- 同主题但有更准/更全的写法 → 用 update 覆盖那条旧记忆（target_id 填它的 id），不新增近义条目
- 确实是新事实才 add

每条一句话，最多 3 条，不确定的不要写；一律用「他」，禁用「用户」。

## 任务三：给不认识的应用补描述

摘要里进程名旁边带「（描述）」的已认识；**没带的就是不认识**。对不认识的进程，
两条路任一成立就输出一条描述：
1. **你本身就认识它**——常见软件的可执行文件名（Weixin.exe=微信、msedge.exe=Edge 浏览器、
   DingTalk.exe=钉钉）。这是主要来源，放心填；
2. 进程名没见过，但窗口标题能明确对应用途（如标题含「 - Visual Studio Code」→ 代码编辑器）。

两条都不成立才不填——冷僻进程瞎猜会长期污染数据；但常见软件不填，他就得手动逐个标注。
描述要求：
- 10-20 字中文短语，说明这是做什么的（如「代码编辑器」「微信桌面客户端」），不要带"这是一个"之类废话
- 进程名必须用摘要中的原文，不能改大小写或加后缀
- 每次最多 5 条，优先填你本身就认识的常见软件

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
  "facts": [
    {"action": "add", "fact": "他下午工作时习惯开音乐", "category": "workflow"},
    {"action": "update", "target_id": 12, "fact": "他的主项目是 FlowHub（Tauri 桌面端）", "category": "project"}
  ],
  "app_descriptions": [
    {"app": "Code.exe", "description": "代码编辑器"},
    {"app": "Weixin.exe", "description": "微信桌面客户端"}
  ]
}
```

## 规则

1. apps/app 必须使用摘要中的进程名原文；time/time_window 必须是 HH:MM / HH:MM-HH:MM
2. 只保留置信度 >= 0.5 的；每种 type 最多 2 个；没有可靠模式就返回空数组
3. facts 的 category 从 person/project/workflow/voice/expectation 中选；三维映射：identity→person 或 project、workflow→workflow、voice→voice
4. update 的 target_id 必须来自「已有记忆」清单里的 id；对不上 id 就用 add
5. app_descriptions 只填摘要中没带「（描述）」的进程；本身就认识的常见软件务必填，冷僻进程不确定不填

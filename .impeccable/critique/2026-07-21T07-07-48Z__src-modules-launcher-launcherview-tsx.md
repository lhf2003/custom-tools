---
target: LauncherView
total_score: 27
p0_count: 0
p1_count: 1
timestamp: 2026-07-21T07-07-48Z
slug: src-modules-launcher-launcherview-tsx
---
# Critique: LauncherView（启动器主界面）— 第二轮复评

Method: dual-agent（A: 设计总监源码评审 · B: 检测器 + 浏览器证据，相互隔离）

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | 结果计数、成功/失败 toast 就位；搜索无加载态、图标静默替换、搜索失败伪装成"无结果" |
| 2 | Match System / Real World | 3 | 中文标签自然；「记」语法无征兆 |
| 3 | User Control and Freedom | 3 | Escape 两级返回完整；10–18 条结果无展开入口；Shift+Tab 被劫持 |
| 4 | Consistency and Standards | 2 | 选中态内外两套（indigo-light vs 白色文字）；内置工具 tile 五色违反自家 Zinc Monolith；Tab/Shift+Tab 语义分裂 |
| 5 | Error Prevention | 3 | nav==render+钳制防盲启动、先启动后隐藏；150ms 防抖窗口内回车可命中陈旧结果 |
| 6 | Recognition Rather Than Recall | 2 | 「记」/Shift+Tab/粘贴 JSON 三个魔法语法零 affordance |
| 7 | Flexibility and Efficiency | 3 | 全键盘链路、用量排序；中文工具无英文别名（"clipboard" 搜不到"剪贴板"） |
| 8 | Aesthetic and Minimalist Design | 3 | 头像修复、token 纪律落地；彩色 tile、1.45 行腰斩、600px 空洞、常驻滚动条 |
| 9 | Error Recovery | 3 | 启动失败 toast 带原因；空「记」静默、搜索异常静默清空 |
| 10 | Help and Documentation | 2 | 设置内有操作手册，启动器首屏零引导 |
| **Total** | | **27/40** | **Acceptable（20–27 区间），距 Good（28+）一步之遥** |

上轮 18 → 本轮 27（+9）：#3/#5/#9 因 P0/P1 修复各 +1~2，#8 因头像与对比度 +1。

## 上轮 P0/P1 修复逐条核实（A 独立验证，全部生效）

| 修复项 | 结论 | 证据 |
|---|---|---|
| P0 唤起重置 query | 生效 | Rust 4 路径 emit window:shown（lib.rs:611、shortcuts.rs:525、window.rs:42/68）；App.tsx:323-333 监听重置 |
| P1 盲启动 | 生效 | navItems 导航==渲染（:67-69/:383）+ 钳制（:77-82）+ scrollIntoView（:435-439），路径封死 |
| P1 静默失败 | 生效 | launchApp 抛回（useSearch.ts:49-57）；先启动后隐藏，失败 error toast（:267-283） |
| P1 对比度三连 | 生效 | placeholder #8e8e96（浏览器实测 rgb(142,142,150)，4.6:1）；展开按钮 tertiary；选中 #818cf8（5.0:1） |
| P1 彩虹字母头像 | 生效（但见新 P1） | zinc 底字母 tile（:520-522）；彩虹转移到了内置工具 tile |
| 死代码清除 | 生效 | THEME/RefreshCw/死 props/不可达加载分支全清 |

B 的浏览器交互验证：方向键高亮全程唯一且跟随、搜索输入选中归零、无新增 console 错误类别。

## Anti-Patterns Verdict

**LLM 评估**：非 slop，明显更接近 product register。绝对禁令零命中（18px Ceiling、Flat-At-Rest、System Stack 均合规）。**唯一残留违规**：内置工具图标底色 violet-600/emerald-600/cyan-600/blue-500/amber-500（tools.ts:47-87），违反 Zinc Monolith——这是当前唯一实打实的 anti-reference 触碰。

**确定性扫描**：`detect.mjs` 连续两轮零 finding（exit 0），修复改动无新增静态问题。

**浏览器可视化**（overlay 注入成功）：5 条命中全部判定为假阳性或范围外——low-contrast（透明窗白底假象，真实表面 5.5:1 达标）、flat-type-hierarchy（DESIGN.md 刻意紧凑字阶）、bounce-easing ×2（ChatView 打字点与 Vditor 第三方样式，启动器未挂载）。值得记录的分歧：`ai-color-palette` 紫色检测 B 判"倾向假阳性"，但其源头正是 A 独立标记的内置工具 tile 彩色（tools.ts）——检测器以错误的框架（通用 AI 紫）意外指向了一个真实问题。

## Overall Impression

肌肉记忆链路已经可信任（唤起可预测、Enter 永不盲启动、失败可恢复），token 纪律真落地。峰终定律的峰值与终点都成立。当前拖累集中在三处：内置工具 tile 的五色彩虹（自家规则的最后一个违反者）、折叠态搜索腰斩第二行、以及一批 P2/P3 打磨项。距 Good 区间（28+）只差 1 分，最大的单一机会是工具 tile 收敛 + 搜索态空间修复。

## What's Working

1. **肌肉记忆链路闭环可信任**：window:shown 四路径重置 + nav==render + 钳制 + scrollIntoView，每步可预测——启动器的命根，修得干净
2. **失败路径反转**：先启动后隐藏 + error toast，上轮最伤信任的问题变成可恢复体验
3. **Token 纪律真落地**：placeholder 4.6:1、brand-primary-light 5.0:1、zinc 字母 tile，DESIGN.md 具名规则进了代码而非停在文档

## Priority Issues

- **[P1] 内置工具 tile 五色彩虹**（tools.ts:47/55/63/71/87 → LauncherView.tsx:476）
  - Why: violet-600/emerald-600/cyan-600/blue-500/amber-500 五色并存，首屏最多 5 个高饱和色块，违反 Zinc Monolith 与 One Voice；上轮修的彩虹只是从字母头像转移到了工具 tile
  - Fix: 统一 `bg-app-bg-elevated` + Ink Secondary 图标（辨识度交给字形）；若保留色彩身份，只许收敛到 violet 一族单色系
  - Suggested command: `/impeccable quieter`

- **[P2] 折叠态搜索腰斩第二行 + 10–18 条无展开入口**（:557、window.ts:7）
  - Why: 210px 窗口只露约 1.45 行；expand 阈值 >18，10–18 条区间无展开入口，只能滚轮或盲按
  - Fix: showExpandButton 改为 `allResults.length > ITEMS_PER_ROW`；或折叠高度按两行自适应
  - Suggested command: `/impeccable layout`

- **[P2] 展开态 600px 装 ~170px 内容**（window.ts:9）
  - Why: recents 上限 14 = 两行约 140px，600px 里约 350px 纯空白
  - Fix: 展开高度按行数计算并封顶；或 recents 上限提到 27（3 行）
  - Suggested command: `/impeccable layout`

- **[P2] 键盘焦点不可见 + Shift+Tab 劫持**（index.css:339、:288-291）
  - Why: 全局 outline:none 无替代，所有 Tabbable 元素无焦点环；Shift+Tab 反向遍历被劫持跳 chat；结果区无 listbox/aria 语义
  - Fix: Shift+Tab 换组合键；Tabbable 元素加 Action Blue focus-visible 环；补 listbox 语义
  - Suggested command: `/impeccable audit`

- **[P3] 打磨残留包**：名称无 truncate；选中态 scale-105 多余信号；overflow-y-scroll 常驻滚动条（:403/:574）；「记」空内容静默（:319-339）；.view-container 未接线死 CSS；.search-shadow 未使用（规格与实现漂移）；搜索后端失败伪装成"未找到"（useSearch.ts:30-33）
  - Suggested command: `/impeccable polish`

## Persona Red Flags

**Alex（效率狂热者）**：主链路已顺。红旗：150ms 防抖窗口内回车可命中陈旧结果；中文工具无英文别名（"clipboard" 搜不到"剪贴板"）；切回启动器图标全部重新 pop-in。

**Jordan（首次使用者）**：首屏干净有兜底。红旗：三个魔法语法零提示；输入"记"回车毫无反应会误判为坏了；粘贴 JSON 被静默劫持到格式化视图无解释。

**Sam（键盘-only/无障碍）**：方向键 + scrollIntoView 是基础。红旗：Shift+Tab 反向遍历被劫持；所有 Tabbable 元素无可见焦点环；选中态无 aria 语义；profile 按钮无 aria-label。

## Minor Observations

- toast"已记下 📌"emoji 与克制语气略冲
- useSearch 的 `refreshApps`/`isLoading` 无人消费，API 面冗余
- App.tsx 多个菜单项是 confirm + console.log 假动作（清空历史/导出/恢复默认）——用户点了确定什么都没发生（范围外记录）
- 展开按钮文案 `展开 (${recentItems.length})` 需心算，建议"还有 N 个"
- 搜索态展开后上百条全渲染，每个触发 extract_app_icon，无虚拟化无图标缓存

## Questions to Consider

1. 折叠态 210px 物理上只容得下一行半九宫格——搜索结果是否该换成列表行（图标+名称+路径，Raycast 式）？网格为"最近使用"而生，硬套给搜索结果是不是问题根源？（上轮已拍板维持网格，此项留作开放思考）
2. 「展开」状态解决的真实问题是什么？recents 给得太少还是展开高度太贪？都不成立的话这个状态是否该删掉？
3. 三个隐藏语法若要保留，placeholder 轮换或底部 hint bar 能否承担教学职责——还是接受它们只服务第一用户？

---
target: LauncherView
total_score: 18
p0_count: 1
p1_count: 4
timestamp: 2026-07-21T04-03-58Z
slug: src-modules-launcher-launcherview-tsx
---
# Critique: LauncherView（启动器主界面）

Method: dual-agent（A: 设计总监源码评审 · B: 检测器 + 浏览器证据，相互隔离）

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | 加载态是不可达死代码（useSearch.ts:37 的 isLoading 无人触发）；启动失败仅 console.error；Enter 打在空结果零反馈 |
| 2 | Match System / Real World | 2 | "最近使用"无数据时用全体应用冒充（LauncherView.tsx:89-111）；人形图标按钮实际打开设置 |
| 3 | User Control and Freedom | 3 | Esc 返回/隐藏链路完整；四向方向键 + Enter + 鼠标齐全 |
| 4 | Consistency and Standards | 2 | 选中态语言分裂：内置工具名称用品牌靛蓝（:445），外部应用用白色（:468/:509）；Shift+Tab 劫持焦点惯例跳聊天 |
| 5 | Error Prevention | 1 | 旧 query + 旧选中跨唤起残留，Enter 即误启动（P0）；键盘选中可移出渲染区盲打（P1） |
| 6 | Recognition Rather Than Recall | 2 | 「记」前缀、Shift+Tab 切聊天、粘贴 JSON 三大能力零提示，纯靠回忆 |
| 7 | Flexibility and Efficiency | 2 | 150ms 防抖、点击后乐观置顶是真实加速；但"展开"无快捷键，选中项不滚动跟随 |
| 8 | Aesthetic and Minimalist Design | 2 | 210px 单行布局克制；但被彩虹字母块、常驻滚动条轨道、展开态 600px 装 140px 内容的死空拖累 |
| 9 | Error Recovery | 1 | 启动失败：窗口已隐藏 + 仅 console——"什么都没发生"；搜索失败被吞后谎报"未找到匹配的程序" |
| 10 | Help and Documentation | 1 | 首屏无快捷键提示/页脚/引导，隐藏语法全部无文档 |
| **Total** | | **18/40** | **Poor（12–19 区间）：核心体验有断裂，需重大修复** |

## Anti-Patterns Verdict

**LLM 评估**：60% 像系统工具，40% 露馅。骨架是 Raycast 式（搜索栏 + 图标网格 + 210px 克制窗口），绝对禁令中无渐变文字/侧边色条/hero-metric/eyebrow/编号节标命中。破功点有三：

1. **彩虹字母头像（最大 AI 气味）**：`LauncherView.tsx:479-499`，17 种 Tailwind 500 级饱和色按 `item.name.length % 17` 分配——同长名字必然同色，相邻应用撞色是必然事件，首屏 9 格可出现 6+ 种色相，与 Zinc Monolith 直接冲突。
2. **图标异步 pop-in 无编排**：每个 ItemCard 各自请求图标，唤起的第一秒（本应是 peak）是一场彩虹闪烁后逐格跳图。
3. **死状态与死参数**：不可达的"正在索引程序..."加载分支（:554-561）、死 prop `onLaunch`/`onSelect`、未用 import `THEME`。

**确定性扫描**：`detect.mjs` 对评审范围（src/modules/launcher + src/App.tsx）**零 finding**（exit 0，已用全量 src 对照验证检测器工作正常）。静态规则干净——本报告所有实质问题都是行为/状态类，静态规则天然捕不到。

**浏览器可视化**（overlay 已注入真实渲染页验证，截图证据已归档）：4 条规则命中，3 条判定为假阳性或环境产物——
- `low-contrast` 2.6:1：浏览器缺 Tauri IPC → 窗口效果类未加载 → 白底假象；真实深色玻璃底下不成立（但 A 的实测计算独立确认了**另一组真实的对比度问题**，见 P1）
- `ai-color-palette` 紫色：DESIGN.md 明文品牌色，假阳性
- `bounce-easing` ×2：ChatView 打字指示点带入 bundle 的 Tailwind 工具类，启动器视图未渲染，范围外
- `flat-type-hierarchy`：非假阳性但属有意设计（DESIGN.md 紧凑工具字阶 12/14/18）

## Overall Impression

骨架是对的：克制、系统字体、单焦点、210px。但核心肌肉记忆链路（唤起→输入→回车）上埋着 P0 残留状态，键盘导航埋着 P1 盲启动，失败路径全线静默，锌基调纪律被 17 色彩虹头像一键破功。**最大的单一机会**：修掉 P0+P1 四件套（query 重置、选中钳制、失败反馈、对比度/彩虹），界面即可从"能用的仿品"跨到"值得信任的工具"。

## What's Working

1. **粘贴 JSON 自动路由**（LauncherView.tsx:134-154）：jsonc-parser 识别带注释/尾逗号的 JSON 并自动跳转格式化工具——Raycast 级魔法时刻。唯一问题是没人知道它存在。
2. **点击后乐观置顶最近项**（:221-224）：不等后端立即置顶，启动器瞬间有"学习感"，全程最聪明的交互。
3. **最近项三级兜底链**（:69-124）：真实最近 → 全体应用前 14 → 内置工具，任何状态首屏不空；「记」路径的 toast 成功/失败双反馈是全文件唯一错误处理完整的功能路径。

## Priority Issues

- **[P0] 唤起后旧搜索词残留，肌肉记忆链路断裂**
  - Why: `searchQuery` 存全局 store（appStore.ts:54），窗口隐藏/重开无任何重置。第 N 次唤起时输入框是旧词、结果是旧集、选中是旧 index——敲 "chrome" 是**追加**在旧词后，回车启动错误应用。PRODUCT.md 的成功定义（唤起、输入、回车，肌肉记忆）被直接违反。
  - Fix: 窗口 show 时 `setSearchQuery('')` + `setSelectedIndex(0)`；想保留"继续上次"则唤起时全选输入框文本（输入即替换、方向键即保留）。
  - Suggested command: `/impeccable harden`

- **[P1] 键盘选中可移出渲染区，Enter 盲启动不可见项**
  - Why: 键盘导航取 `getAllResults()` 全量（:252），渲染却 `slice(0, 18)`（:572/:591）。结果 >18 时方向键可推到未渲染的第 19+ 项，Enter 盲启动；且无 scrollIntoView 跟随。
  - Fix: selectedIndex 钳制到当前渲染切片；选中变化时 `scrollIntoView({ block: 'nearest' })`；或折叠态导航集合与渲染集合统一。
  - Suggested command: `/impeccable harden`

- **[P1] 启动失败静默 + 窗口已隐藏**
  - Why: `handleItemClick` 先 `hide_window` 再 `launchApp`（:236-240），catch 只 console.error。失败 = 窗口消失、无事发生、无解释。工具的信任感由失败时刻定义。
  - Fix: launchApp 错误抛回；失败时不隐藏窗口（或重新唤起）+ error toast 给原因（如"应用路径不存在，是否从索引移除？"）。
  - Suggested command: `/impeccable harden`

- **[P1] 对比度三连不达标，违反自己的无障碍承诺**（实测 WCAG 计算，背景 #27272a）
  - Why: placeholder #71717a → **3.08:1**（要求 ≥4.5:1，PRODUCT.md/DESIGN.md 明文承诺）；"展开/收缩"交互文字用 disabled 色 → 3.08:1；内置工具选中名称 #6366f1 → **3.34:1**，选中反而更看不清。浏览器 overlay 的 low-contrast 命中（白底假象）虽是环境产物，但 A 的独立实测确认真实表面上的这三处全部失守。
  - Fix: placeholder/辅助文字升至 #8b8b93 档（≈4.6:1）；交互文字禁用 disabled 色；选中文字提亮至 #818cf8 或改 Ink Primary。
  - Suggested command: `/impeccable audit`

- **[P1] 彩虹字母头像违反 Zinc Monolith，AI 感最大来源**
  - Why: 17 色 500 级饱和色块（:479-499）；DESIGN.md 规定"禁止引入灰阶以外的表面色"，内置工具图标底收敛在 5 个语义色，外部应用兜底却放飞到 17 色。
  - Fix: 向自家范式看齐——bg-zinc-700 底 + Ink Secondary 首字母（与 Markdown/设置内置工具一致），或深灰阶 + 白色 10% 描边素面 tile。
  - Suggested command: `/impeccable quieter`

- **[P2] 一批硌人小问题**：网格项名称无 truncate（7 汉字即溢出换行，节奏崩坏）；鼠标 hover 与键盘选中两套高亮互不相通（onSelect 是死 prop）；折叠态搜索只露 1.8 行结果；死代码（不可达加载分支、死 prop、未用 import）；`overflow-y-scroll` 常驻滚动条轨道；展开态 600px 窗口装 140px 内容。
  - Suggested command: `/impeccable polish`

## Persona Red Flags

**Alex（效率狂热者）**：① 第二次唤起旧 query 残留，Enter 启动错误应用（P0）；② 结果 >18 时方向键滑出渲染区盲启动（P1）；③ "展开 (N)" 只能鼠标点，无快捷键；④ Shift+Tab 劫持焦点后退惯例跳聊天；⑤ 单行折叠态按 ArrowDown 直接跳行尾（步长恒为 9）。高放弃风险。

**Jordan（首次使用者）**：① 首屏"最近使用"展示的是他从未用过的应用（兜底冒充），第一个教他"这个区块在说谎"；② 人形图标预期是账号、实际是设置，与网格里的设置齿轮双入口伪装；③ 搜索无结果是死胡同，不给"试试文件搜索/问 AI"出口；④ 彩色字母块无法与应用建立联系，会以为没加载完；⑤ 三个隐藏能力永远不会被发现。

**Sam（键盘-only/无障碍）**：① placeholder 3.08:1，输入框唯一引导文字看不清；② 全局 `input:focus { outline: none }` 无 focus-visible 替代，Tab 焦点完全不可见；③ 选中即降可读性（靛蓝 3.34:1）且选中信息仅靠颜色+5% 缩放；④ 无 ARIA 结构（无 listbox/option/aria-activedescendant），屏幕阅读器无法播报位置；⑤ animate-spin 与 scale 过渡无 prefers-reduced-motion 降级，违反 PRODUCT.md 条款。

**项目特化 Persona — Windows 键盘流开发者（源自 PRODUCT.md 目标用户）**：全天驻留、全局快捷键唤起、追求"双手不离键盘"。红旗：每次唤起的前 200ms 不可预测（旧状态残留）；展开/收缩必须动鼠标；失败无反馈迫使他反复唤起验证"到底启动没有"——每一个都精准打在他的核心工作流上。

## Minor Observations

- `THEME` 导入未使用（:9）；`onLaunch`/`onSelect` 死 prop（:522-526）
- 搜索栏未使用 `.search-shadow`（index.css:145）——DESIGN.md 说它是全应用唯一主角阴影，规格与实现已漂移
- `.view-container` 300ms 视图过渡系统（index.css:203-215）在 App.tsx 未接线，视图切换是硬切——死 CSS + 未兑现规格
- 「记」只输入"记"按 Enter 静默无响应（:277-297）
- 展开态固定 600px，14 个最近项只占 ~140px
- App.tsx:91 原生 confirm() 对话框（范围外顺带记录）

## Questions to Consider

1. 如果唤起即清空 query 是 Raycast 的正确答案，残留设计在服务谁？为什么不是"唤起时全选文本"这种两种意图都保住的方案？
2. 为什么"选中"和"悬停"是互不相干的两套高亮？统一它们会破坏什么？
3. 9 列网格到底在优化什么？搜索结果态也许应该是 Raycast 式单列列表（带路径/类型元信息，消灭同名歧义，天然滚动友好），网格只留给无 query 的首页？

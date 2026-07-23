---
target: json工具
total_score: 32
p0_count: 0
p1_count: 1
timestamp: 2026-07-22T12-33-46Z
slug: src-modules-json-formatter-jsonformatterview-tsx
---
# Critique #2: JSON 工具模块（复审）

**目标**: `src/modules/json_formatter/`
**日期**: 2026-07-22（第二轮，基线 19/40）
**Method**: dual-agent (A: assessment-a-v2 · B: assessment-b-v2)

## Design Health Score: 32/40(Good — 一轮 19 → 二轮 32,+13)

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | 复制/导出/保存反馈齐全；导出行宽超限静默截断无提示 |
| 2 | Match System / Real World | 4 | 错误全中文（16 枚举映射）、行列号、TypeHint 都是用户语言 |
| 3 | User Control and Freedom | 3 | Esc 分层正确；无格式化快捷键、残留数据无清空入口 |
| 4 | Consistency and Standards | 3 | scrim-white-10 选中统一；行高报错 vs 行宽静默不一致、banner 半角标点 |
| 5 | Error Prevention | 3 | 空态复制/导出 disabled 正确；canvas 高度显式守卫 |
| 6 | Recognition Rather Than Recall | 3 | 视图 toggle 图形化；banner 行列坐标与文本视图无行号列断裂 |
| 7 | Flexibility and Efficiency | 3 | 粘贴即入、树全键盘导航、点击定位；展开/折叠无快捷键 |
| 8 | Aesthetic and Minimalist Design | 4 | 工具栏克制、语法色层次专业、zinc 一体表面干净 |
| 9 | Error Recovery | 4 | 中文+行列+双视图点击定位实测精确；定位后无行高亮 |
| 10 | Help and Documentation | 2 | tools.ts 描述已准确；JSONC 隐性能力（注释/尾逗号）无提示 |

## Anti-Patterns Verdict

**LLM 评估：否（无 slop)。** 无渐变/发光/嵌套卡片/弹跳缓动/AI 腔；violet-400 仅作 boolean 语法色（用户裁决保留）；层级靠字重+灰阶+间距；icon-only 按钮配 tooltip 符合规范。

**确定性扫描：** CLI 文件级 0 findings（连续两轮）。运行时 detect.js：
- 一轮唯一真实命中（空态提示 2.3:1）**已消失**，placeholder 实测 #8e8e96 ≈4.6-5.5:1 ✓
- 新命中 1 条：「复制」按钮白字 on #3b82f6 = **3.68:1**——数值真实，但属 DESIGN.md Action Blue token 自身水位问题（全 app 的 Primary 按钮同此），非本模块引入
- 误报：text-sky-300 cyan 告警（语法高亮语义色，对比度 ≈10:1 无问题）；页面级 5 条归因不足（全局样式）

**可视化覆盖：** detect.js 注入成功，覆盖空态（新形态 textarea 已确认）与填充树两态；visualContrast 扫描无违例。

## 一轮修复验证（6 优先项 + 附带项）

1. P0 Esc 冲突 → **成立**（capture 拦截实测：模态关→模块在→再 Esc 回启动器）
2. P1 吞输入 → **成立**（Enter 换行保留、光标 selStart=2；格式化仅切视图时一次性）
3. P1 树键盘/读屏 → **成立（主路径）**（Tab 直达 treeitem、←折叠 19→1 行、aria 齐备）
4. P1 空态输入框 → **成立**（空屏 autoFocus textarea + 统一 placeholder）
5. P2 错误信息 → **成立**（中文+行列；双视图点击定位光标精确落位）
6. P2 低对比 → **部分成立**（行号/空态达标贴线；zinc-500 3.08:1 仍承载数组下标与 null 值）
7. 附带：canvas 高度超限 toast ✓、宽度自适应 ✓、Primary 归复制 ✓、tools.ts 归真 ✓

**复审当场抓到并修复（不计入 backlog）**：一轮交付物带 2 个类型错误（const enum 运行时访问 TS2748、comment-only 分支 string 赋对象 TS2345），因根 tsconfig `files: []` 使 `npx tsc --noEmit` 零检查而漏网；已修复并验证 `tsc -b` 真绿。教训：本项目类型检查必须 `tsc -b`。

## Overall Impression

模块从「demo 态」跨进「工具态」：错误流闭环（中文→行列→双视图定位）与文本视图架构决策（编辑不重排）是教科书级处理。剩余断裂集中在两处：模态无障碍的最后一块（焦点陷阱），以及文本视图作为编辑面的一等公民化（行号 gutter）。最大机会：把「第 N 行第 M 列」的承诺在文本视图里变成可见的坐标系。

## What's Working

1. **错误流闭环完整**：英文枚举→中文映射→offset 换算行列→双视图点击定位→空态可直接编辑，从出错到修复无断点
2. **文本视图架构决策**：编辑期间绝不实时重排，格式化只在切视图时一次性发生——编辑器可信度优先于功能炫技
3. **canvas 导出与界面同源**：行号/配色/缩进一致、宽度自适应、高度显式守卫；导出失败给替代路径不甩锅

## Priority Issues（新）

- **[P1] 导出模态无焦点陷阱**：aria-modal="true" 但 Tab 逃出 dialog 进入背后 treeitem——读屏用户被告知「模态」却能摸到背后内容。**修复**：焦点困在 dialog 内（首末循环 + 初始 focus），背后内容 inert。**建议命令**：`/impeccable audit`
- **[P2] 文本视图无行号列，与 banner 行列坐标断裂**：banner 说「第 4 行第 1 列」但文本视图没有行号参照，定位后也无行高亮。**修复**：文本视图加只读行号 gutter（与树视图行号样式一致），定位时短暂高亮目标行。**建议命令**：`/impeccable layout`
- **[P2] zinc-500(3.08:1）仍承载内容性文本**：数组下标、null 值是用户要读的数据不是装饰（JsonTreeView.tsx）。**修复**：下标与 null 升档 zinc-400(≈5.8:1)；冒号/逗号可留 zinc-500。**建议命令**：`/impeccable audit`
- **[P3] 重进模块残留上次数据含错误态，无清空入口**：从启动器点选进入撞见上次的坏 JSON+错误 banner。**修复**：点选进入时若有 parseError 则清空，或工具栏加「清空」。**建议命令**：`/impeccable harden`
- **[P3] 行宽超 16384px 静默截断**：与行高显式报错哲学不一致（jsonCanvas.ts clamp）。**修复**：超限时与高度同样 throw（或模态内标注「已截断」)。**建议命令**：`/impeccable harden`

## Persona Red Flags

- **Alex（键盘流）**：模态 Tab 逃逸（P1）；展开/折叠全部无快捷键；就地格式化只能「切出再切回」文本视图
- **Sam（无障碍）**：模态焦点陷阱缺失（P1）；行号 span 无 aria-hidden（读屏每行前被念孤立数字）；树焦点指示仅 white/6 底色、无描边，偏弱
- **Riley（边界）**：一轮交付物带 2 个类型错误通过假绿自检（已当场修复并记录 `tsc -b` 教训）

## Minor Observations

- banner 半角标点粘连，「，点击定位」可改「，点击定位 →」
- parser first-error offset 指向下一个 token（缺 `]` 报在下一行），文案可加「附近」
- 复制按钮 3.68:1 是 DESIGN.md Action Blue token 水位问题，需设计系统级决策
- 导出图永远全展开（与界面折叠态不一致），可在模态注明「导出为完整展开视图」
- canvas 调色板硬编码 hex 与 token 双源（canvas API 限制，有注释对齐，存在漂移风险）
- 行号 span 应加 aria-hidden

## Questions to Consider

1. 文本视图和「编辑器」的距离只差行号与定位高亮——为什么不让它成为一等公民的编辑面，而是树的「降级模式」？
2. 模块把「记住我」（残留数据）和「打扰我」（撞见旧错误）混为一谈——状态生命周期的设计意图是什么？
3. 宽度静默截断、高度显式报错——同一 canvas 两条相反的错误哲学，只修被点到名的那一半算不算完成？

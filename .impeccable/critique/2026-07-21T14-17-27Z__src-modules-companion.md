---
target: 陪伴功能（复审）
total_score: 26
p0_count: 0
p1_count: 2
timestamp: 2026-07-21T14-17-27Z
slug: src-modules-companion
---
# Critique: 陪伴功能（复审 · companion v2）

**目标**: src/modules/companion（Toast 弹窗 + 设置页陪伴标签 + 启动器「记」入口）
**评审基准**: PRODUCT.md / DESIGN.md（product register）
**总分**: 26/40（首轮 23/40）· 开放项 P1×2 · P2×2 · P3 若干

## Design Health Score（Nielsen 10 启发式）

| # | 启发式 | 分数 | 关键发现 |
|---|--------|------|----------|
| 1 | 系统状态可见性 | 2/4 | Toast 细线进度条对比度过低（white/25 on white/5），剩余时间几乎不可感知 |
| 2 | 系统与现实匹配 | 3/4 | 「记 xxx」、日报 agent、休息提醒文案自然 |
| 3 | 用户控制与自由 | 3/4 | Toast 可接受/忽略；清空数据有 confirm |
| 4 | 一致性与标准 | 2/4 | Toast 状态色用 red-400/emerald-400 未对齐 app-status token；容器圆角底色与 SettingCard 体系混用 |
| 5 | 错误预防 | 3/4 | 清空有 confirm；错误堆栈触发有启发式过滤 |
| 6 | 识别而非回忆 | 3/4 | placeholder 轮换 + 单字「记」动作预览教学 |
| 7 | 灵活与效率 | 2/4 | Toast 无 Enter/Esc 键盘操作；列表项无键盘导航策略 |
| 8 | 美学与极简 | 2/4 | 嵌套卡片（bg-white/5 项盒子叠 bg-white/5 容器）违反「层级靠排版不靠边框」 |
| 9 | 错误诊断 | 3/4 | 失败有明确 toast 标题与消息 |
| 10 | 帮助与文档 | 3/4 | 设置页内嵌说明文案到位 |

**总分 26/40 —— Acceptable → Good 下沿（首轮 23 → 本轮 26）**

分数变化：H3/H5/H6/H9/H10 各 +1（上轮 P0/P1 修复生效）；H7 -1（复审对 Toast 无键盘操作扣分更重，属评审口径差异，非代码回退）；H1/H4/H8 持平（本轮新发现集中于此）。

## Anti-Patterns Verdict

**LLM 评估**：整体气质克制，无典型 AI 花哨感。触犯项：① 嵌套卡片泛滥（容器内列表项仍用 bg-white/5 圆角盒，DESIGN.md 明令「嵌套卡片永远错误」）；② 头部渐变 icon 容器（**已裁决**：用户明确选择保留 9 标签页共享词汇、仅收敛色相为品牌 Indigo，见首轮记录）。未发现：侧边色条、渐变文字、hero-metric、编号脚手架、文字溢出、玻璃滥用、雷同网格、Eyebrow。

**确定性扫描**：CLI 4 文件（CompanionToast.tsx / CompanionSettings.tsx / companion-toast.html / LauncherView.tsx）**全部 0 发现**——首轮命中的 ai-color-palette 已消除。浏览器步骤因 dev server 未运行如实跳过。检测器干净 ≠ 无问题：嵌套卡片与进度条对比度为 LLM 独获（检测器无此规则）。

## What's Working

1. **Toast 系统原生感**：zinc-900/95 + 微边框 + backdrop-blur + Modal 阴影，右下角避开任务栏，符合 Windows 通知预期
2. **「记」的反馈设计**：输入「记」显示 NoteActionPreview 动作预览而非「未找到」，教学嵌入场景（LauncherView.tsx:695）
3. **空态文案**：有指导性、有场景、不冷漠

## Priority Issues（综合裁决后）

**[P1] 嵌套卡片泛滥**
- 伤害：DESIGN.md 核心禁令，层级浑浊、密度失控（两轮评审交叉确认；首轮 distill 时曾刻意保留作行分隔，复审独立再判违规）。
- 修法：列表项去 `bg-white/5` 圆角盒，改纯间距/分隔线 + hover 高亮；容器保留作分组边界。
- 位置：CompanionSettings.tsx:360, 388, 408, 453, 479, 505, 518, 539, 553
- 建议命令：/impeccable distill

**[P1] Toast 进度条对比度过低**
- 伤害：bg-white/25 on bg-white/5 几乎不可见 → 自隐剩余时间不可知，反噬「系统状态可见性」。
- 修法：提升至 bg-white/40（保持细线形态，不恢复数字）。
- 位置：CompanionToast.tsx:228-232
- 建议命令：/impeccable polish

**[P2] 「记」placeholder 曝光份额不足**
- 伤害：8s 轮换中「记」只占 1/4 槽位，发现路径依赖偶然。
- 修法选项：提高「记」权重（数组中占 2 槽）/ 首次成功使用前固定 placeholder / 拉长单槽时长。
- 位置：LauncherView.tsx:43-65
- 建议命令：/impeccable onboard

**[P2] SUGGESTION_TYPE_LABEL 映射不全**
- 伤害：建议历史对未映射类型显示英文原始串（agent_insight / context_routine…），中文用户不友好。
- 修法：补全 8 种类型的中文标签。
- 位置：CompanionSettings.tsx:87-91
- 建议命令：/impeccable clarify

**[P3] Toast 状态色未对齐 token**：red-400/emerald-400 是 Tailwind 深色面惯用亮色阶（对比度优于 token 原色 #ef4444/#22c55e），且全代码库惯例如此（Toggle bg-blue-500 同例）——判定为刻意选择；若要对齐，正确做法是给 token 增加深色面变体，而非替换色值。

**[已裁决 · 不再列入]** 头部渐变 icon 容器：用户首轮明确拍板保留 9 标签页共享词汇，仅收敛色相至品牌 Indigo。

**[延期]** Toast Enter/Esc 键盘快捷键：真实缺口（两轮 Persona 均命中），但属新交互，验收期内谨慎引入。

## Persona Red Flags

**Alex（键盘重度）**：Toast 弹出时无 Enter 接受 / Esc 忽略，必须摸鼠标；设置页列表项内完成/忽略/删除按钮无统一键盘导航。

**Jordan（新手）**：首屏三分组+嵌套卡片仍有过载感；「日报 agent」概念门槛高（日报出现在哪里没说）；发现「记」依赖偶然看到 placeholder。

## Minor Observations

- 设置页下拉框用 bg-zinc-700/border-zinc-600，未严格用 app-bg-tertiary/app-border token
- SettingCard 的 bg-white/[0.02] 与数据块的 bg-white/5 两种壳色并存，可统一
- 记忆事实 emoji 分类标签面积小、语义清晰，可接受
- Toggle bg-blue-500 与 Action Blue 一致 ✓

## Questions to Consider

1. 「被无视 = 死亡」——设置页的嵌套卡片噪音本身是否就是一种「错弹」？
2. 毕业制要求信任可预期，但自隐时间几乎不可见——不可知的剩余时间是否削弱信任？
3. 「记」的教学全部发生在用户输入「记」之后——事前发现是否值得一个更小侵入的首次提示？

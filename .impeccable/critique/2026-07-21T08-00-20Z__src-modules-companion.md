---
target: 陪伴功能
total_score: 23
p0_count: 2
p1_count: 2
timestamp: 2026-07-21T08-00-20Z
slug: src-modules-companion
---
# Critique: 陪伴功能（companion）

**目标**: src/modules/companion（Toast 弹窗 + 设置页陪伴标签 + 启动器「记」入口）
**评审基准**: PRODUCT.md / DESIGN.md（product register）
**总分**: 23/40 · P0×2 · P1×2 · P2×1

## Design Health Score（Nielsen 10 启发式）

| # | 启发式 | 分数 | 关键发现 |
|---|--------|------|----------|
| 1 | 系统状态可见性 | 2/4 | 倒计时暴露剩余时间，但 Toast 出现前用户不知道采集/分析进行到哪一步；无后台活动指示 |
| 2 | 系统与现实匹配 | 3/4 | 「记 xxx」「立即分析」贴近认知；「学到的习惯模式」「它记住的你」拟人化稍有不稳 |
| 3 | 用户控制与自由 | 2/4 | Toast 有忽略/X/倒计时三条退出路径，但无「不再询问此类」；危险操作仅原生 confirm() |
| 4 | 一致性与标准 | 2/4 | violet 用量超 DESIGN.md 的 ≤10% 规则；Toast 8 色类型图标自成一套语义色 |
| 5 | 错误预防 | 2/4 | 清空有确认但用原生 confirm()；按钮紧邻常规设置项，有误触风险 |
| 6 | 识别而非回忆 | 2/4 | 「记」在启动器无 discoverability，仅靠设置页一行小字 |
| 7 | 灵活与效率 | 3/4 | 「记 xxx」捕获高效；Toast 无 Enter/Esc 键盘操作 |
| 8 | 美学与极简 | 2/4 | 单页 10+ 容器信息密度过高；顶部渐变破坏 zinc 一体感 |
| 9 | 错误恢复 | 2/4 | 失败有 toast 提示但无撤销；删除记忆/忽略模式不可逆 |
| 10 | 帮助与文档 | 2/4 | 空态文案教学性好；缺 onboarding；「置信度」「毕业制」无解释 |

**总分 23/40 —— Acceptable（需要显著改进）**

## Anti-Patterns Verdict

**LLM 评估**：不到「一眼 AI」的程度——zinc 一体表面基本约束住了语言，无大标题/营销留白。主要 tell 是：① Toast 类型图标的 8 色装饰光谱（red/emerald/blue/violet/amber/pink），像第三方通知广告；② 设置页头部 violet 渐变 icon 容器（明确违反 Anti-references）；③ 设置页 10 容器「卡片列车」；④ Toast 的 blur+shadow-2xl 作为常驻打断式通知偏重。未发现：侧边色条、渐变文字、hero-metric、编号脚手架、文字溢出。

**确定性扫描**：CLI 1 项发现——`ai-color-palette` @ CompanionSettings.tsx:277（violet 渐变），与 LLM 判定一致。浏览器 console：`ai-color-palette`（两页）、`low-contrast` 2.6:1（#a1a1aa on #ffffff）、`flat-type-hierarchy`（12/14/16）、`bounce-easing` ×2（animate-bounce 与 cubic-bezier(0.2,0,0.13,1.5)，位置待查，DESIGN.md 禁止弹性曲线，但来源可能不在陪伴模块内）。

**误报甄别**：① violet 本身是 DESIGN.md 合法的 Secondary Violet（低频允许），detector 的「紫=AI」判定部分属于设计意图误报——但**渐变用法**与**超 10% 的大面积 violet** 仍是真实违规；② low-contrast 测于 Tauri 缺失的断渲染白底，为环境误报（但 Toast 上 text-white/30 倒计时对比度仍值得复核）；③ flat-type-hierarchy 是 product register 刻意的紧字级，设计意图。

**浏览器证据**：dev server（:1420）注入 detect.js 成功，但因缺 `window.__TAURI__` 两个页面均无法渲染真实 UI，无可靠真实界面 overlay；断渲染截图存于 .impeccable/critique/main-settings.png、companion-toast.png。live-server 已停止。

## Overall Impression

骨架是对的：锌色底、克制字级、空态教学、退出路径充足——这是个想「消失进系统」的工具。但陪伴模块在色彩上「自成一派」（violet 渐变 + 8 色图标），设置页把五个数据面全平铺给第一次进入的用户。最大机会：把「记」的存在感前移到启动器，让用户在第一次需要时就知道它存在。

## What's Working

1. **「记」的捕获反馈**：输入回车 → 立即「已记下」toast + 清空搜索框，错误时给教学提示（LauncherView.tsx:320-348）。
2. **空态文案教学型**：「还没有备忘。试试：Alt+Space → 输入「记 …」→ 回车」教下一步动作而非只说「没有」（CompanionSettings.tsx:480-482）。
3. **Toast 退出路径充足**：忽略按钮 + X + 15s 自隐三条路，契合「宁可漏弹不可错弹」信条（CompanionToast.tsx:190-225）。

## Priority Issues

**[P0] Toast 类型图标 8 色光谱违反设计系统**
- 伤害：装饰性色相让 Toast 像第三方通知广告，破坏 zinc 一体感与「状态色仅语义」规则。
- 修法：归为三类——常规建议 zinc/Indigo；error_analysis 用 status-error；auto_executed 用 status-success。移除 pink/amber/violet 装饰色。
- 位置：CompanionToast.tsx:28-77
- 建议命令：/impeccable quieter

**[P0] 设置页头部 violet 渐变容器违反 Anti-references**
- 伤害：页面第一个视觉锚点就是 DESIGN.md 明令禁止的「渐变/AI 花哨感」，直接拉低信任感。
- 修法：改单一 Surface 底色或 Indigo ≤10% 纯色底（bg-app-bg-tertiary 或 bg-app-brand-primary/10）。
- 位置：CompanionSettings.tsx:277
- 建议命令：/impeccable quieter

**[P1] 设置页信息密度过高（10+ 容器单页平铺）**
- 伤害：新用户进入即认知过载；违反「一次一事」「分组 ≤4」；「立即分析」与「立即生成日报」并排易混淆。
- 修法：按「今日 / 学习 / 数据」折叠为 3 个可展开面板或拆二级标签；危险区独立置底加间距。
- 位置：CompanionSettings.tsx:274-579
- 建议命令：/impeccable distill

**[P1] 「记」功能 discoverability 极低**
- 伤害：启动器 placeholder 未提及「记」，新用户无从得知；需先进设置页才能看到唯一提示。
- 修法：placeholder 或空搜索态增加微提示（「输入「记」快速备忘」）。
- 位置：LauncherView.tsx:373、CompanionSettings.tsx:477
- 建议命令：/impeccable onboard

**[P2] Toast 15s 倒计时数字制造轻微焦虑**
- 伤害：打断式弹窗叠加递减数字 = 被催促感，与「长时休息提醒」等需要平静接受的建议冲突。
- 修法：改细线进度条或隐藏倒计时；保留数字则降到 text-white/20。
- 位置：CompanionToast.tsx:190
- 建议命令：/impeccable polish

## Persona Red Flags

**Alex（键盘重度 power user）**
- placeholder 未提示「记」前缀，要先逛设置页才能发现功能（LauncherView.tsx:373）
- Toast 弹出时双手在键盘，无 Enter 接受 / Esc 忽略快捷键，必须摸鼠标
- 设置页密度高，「清空采集数据」难以快速定位

**Jordan（首次使用的新手）**
- 一屏 10 个容器不知从何开始，「它记住的你」引发「应用在偷看我」的不安
- 返回启动器试「记」无即时引导，试错成本高
- 首次 Toast + 15s 倒计时让他慌张，可能直接 X 掉 → 毕业制投票机制失效

## Minor Observations

- Toast countdown text-white/30 与次级按钮 text-white/60 对比度需复核（B 的 low-contrast 虽为断渲染误报，方向上与此吻合）
- CompanionToast 按钮未见 focus-visible 样式；全局焦点环对独立窗口的覆盖需验证
- Toast 无入场动画的 prefers-reduced-motion 降级
- 危险区红色半透明容器在 zinc 表面略突兀
- agent_insight 与 context_routine 图标色（violet/pink）区分度不足
- 浏览器检出 bounce-easing ×2（animate-bounce / 过冲贝塞尔），来源待定位，DESIGN.md 禁止弹性曲线

## Questions to Consider

1. 「被无视 = 死亡」是信条，但 always-on-top + 15s 倒计时的 Toast 是否在制造「被无视」的负反馈循环？全屏会议/游戏时它算错弹吗？
2. 「学到的模式」「它记住的你」直接平铺展示被记录轨迹，是否假定用户愿意检阅？这些数据是否更适合以日报形式被动归还？
3. 陪伴模块大面积 violet 是有意的子品牌色，还是设计系统漂移？若允许子品牌色，DESIGN.md 是否需要显式更新？

---
target: MarkdownView.tsx（Markdown 笔记模块）
total_score: 25
p0_count: 1
p1_count: 3
timestamp: 2026-07-22T06-15-09Z
slug: src-modules-markdown-markdownview-tsx
---
# Markdown 笔记模块设计评审

**目标**：`src/modules/markdown/MarkdownView.tsx`（含 components/hooks 全模块）
**方法**：双轨独立评估——Assessment A（设计总监评审，源码驱动）+ Assessment B（detect.mjs 确定性扫描 + 浏览器叠加层证据），交叉合成。

## Design Health Score：25/40（Acceptable）

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | 保存中/导出中 spinner、字符数齐全；但保存失败完全静默（useNotes.ts:151-153） |
| 2 | Match System / Real World | 4 | 全中文自然文案，「打开文件所在位置」贴合 Windows 约定，无术语泄漏 |
| 3 | User Control and Freedom | 2 | Esc/取消齐全；删除/重命名/移动/排序全部无 undo；标题 blur 即提交改名（MarkdownView.tsx:535） |
| 4 | Consistency and Standards | 2 | 三套选中样式、两套 tooltip、原生 confirm vs 自制 Modal、模态主按钮不符合 button-primary 规范 |
| 5 | Error Prevention | 2 | 自动保存+竞态守卫是强项；创建空输入静默无响应（:49,:699）、删文件夹不提示内含笔记数、无重名预检 |
| 6 | Recognition Rather Than Recall | 3 | 标题可编辑零可见线索（:531-540）；搜索结果只见裸文件名，同名笔记无法区分（:484） |
| 7 | Flexibility and Efficiency | 2 | 拖拽排序/移动优秀；但笔记树完全不可键盘导航（SortableNoteTree.tsx:74,114 为 div+onClick），无 Ctrl+N/Ctrl+F——直接违背 PRODUCT.md 原则 2 |
| 8 | Aesthetic and Minimalist | 3 | 双栏克制无装饰；常驻拖拽手柄、单项导出菜单、空态废话文案是噪声 |
| 9 | Error Recovery | 2 | 导出错误内联红字+重试（:557-570）是模范；但重命名/删除/移动失败把整棵文件树替换成错误屏（:444-454），保存失败无任何 UI |
| 10 | Help and Documentation | 2 | 无文档、无快捷键可见性；tooltip 与空态提示是微弱情境帮助 |
| **Total** | | **25/40** | **Acceptable（20-27）——显著改进后才适合外部用户** |

## Anti-Patterns Verdict

**LLM 评估**：骨架是「赢得的熟悉感」——双栏文件树 + WYSIWYG 编辑器是品类正解，zinc 深色、Flat-At-Rest、18px 字级上限都守住，无营销页 slop。但熟悉 Raycast/Notion 的用户会在五个拼接感细节停顿：原生 confirm 与自制 Modal 并存；三套选中底色（树选中 zinc-600/50、搜索结果蓝字蓝底 #93c5fd + rgba(59,130,246,0.2)、DESIGN.md 规定 Scrim White 10）；两套提示体系（原生 title= vs 自制 Tooltip）；单项导出菜单；30+ 处手写 onMouseEnter/Leave 内联改样式。

**确定性扫描（detect.mjs，退出码 2，共 60 条：54 advisory / 6 warning）**：
- 真实有效（~12 条）：`constants.ts` HIGHLIGHT_COLORS 高亮色板 10 色未登记 DESIGN.md（佐证：已登记的蓝色/紫色档未被标记，比对是准的）；`MarkdownView.tsx:498` 10px 且 #71717a 约 3:1 对比度；`:537` 15px 标题为 off-ramp 字号（体系是 12/14/18）。
- 误报（~48 条）：`utils/export.ts` 31 条全部在离屏导出模板字符串内（含原样复制的 GitHub hljs 色板，不进 App UI）；`vditor.css` 的 blockquote 3px border-left（引用竖线惯例，且用 token 变量）、Fira Code（代码块等宽字体刻意选择）、编辑器 chrome 的 3-5px radius 与预览区标题字号——均属第三方编辑器主题豁免类。
- 浏览器叠加层信号（已逐条复核）：purple/violet 实为 `vditor.css:24` 代码高亮紫 #c084fc（内容层语法高亮，非 UI chrome，可接受）；bounce 缓动实为 `ChatView.tsx:556-564` 打字指示点（非本模块，但违反 no-bounce 规则，记为跨模块观察）；flat type hierarchy 1.3:1 在 product register 下属正常紧比例，误报。

**叠加层可见性**：注入在独立 headless Chromium 实例中成功（console 报 2 anti-patterns），用户浏览器中无常驻叠加层；证据截图存于项目根目录 `markdown-critique.png`（已被 .gitignore 覆盖）。Vditor 编辑器本体因纯浏览器无 Tauri IPC 未能渲染，编辑器内部仅有 CLI 静态证据。

## Overall Impression

工程功底明显（autosave 竞态守卫、拖拽边界处理、ContextMenu 视口钳制），但信任链条的三处断点全在最坏的位置：保存失败静默（数据信任根基）、删除用原生 confirm 且无 undo（最高风险时刻给最糙对待）、操作错误清空整树（惊吓式反馈）。情感旅程上，导出失败是唯一安抚到位的高风险时刻——它证明了这个代码库知道正确做法，让其他三处的缺失更刺眼。修掉这三处，模块从「能用」跳到「可信」。

## What's Working

1. **导出错误恢复范式**（MarkdownView.tsx:557-570）：非阻塞、错误就地显示、重试挨着错误文案、不清除上下文——H9 教科书做法，可惜是全模块孤例。
2. **自动保存的工程品质**（useNotes.ts:129-163）：1s 防抖 + pendingSaveContent 竞态守卫 + 卸载清理，配合 localStorage 恢复上次选中笔记与展开文件夹，回来时零等待零迷路——「速度即体验」真正落地的地方。
3. **拖拽交互的边界思考**（SortableNoteTree.tsx）：禁止文件夹拖入自身后代、拖过折叠文件夹 500ms 自动展开、DragOverlay 用 Elevated 级阴影（状态驱动阴影，合规）。

## Priority Issues

1. **[P0] 保存失败完全静默** — `useNotes.ts:151-153`：autosave catch 只 console.error，spinner 照常消失，用户以为已存，关窗丢内容。修法：加 saveError 状态复用 exportError 模式；标题栏常驻保存状态位（已保存/保存中/失败+重试）；失败保留 dirty 标记并退避自动重试；视图卸载前若有未保存内容兜底再写一次。→ `/impeccable harden`
2. **[P1] 键盘主流程断裂** — 树行是 div+onClick（SortableNoteTree.tsx:74,114），不可聚焦、无方向键导航、无 Enter 打开、无 role=tree/treeitem/aria-expanded；全模块无 Ctrl+N（新建）、Ctrl+F（聚焦搜索）。本产品主用户就是键盘党，PRODUCT.md 原则 2 直接落空。修法：树行改 button 语义 + roving tabindex + 方向键/Enter；挂视图级快捷键；顺手补齐 ARIA。→ `/impeccable harden`
3. **[P1] 错误通道错配：操作失败清空整棵文件树** — create/rename/delete/move/reorder/标题改名六处失败 funnel 进同一个 setError（:69,:97,:114,:129,:144,:224），渲染成整侧栏替换（:444-454）。一次重命名冲突 → 导航消失满屏错误，用户以为笔记全没了。修法：树加载失败保留现有整屏+重试；操作级错误改短暂 toast 或树顶内联条，含操作名与原因，树保持不动。→ `/impeccable harden`
4. **[P1] 删除确认：原生 confirm + 无内容提示 + 无 undo** — `MarkdownView.tsx:101-102`：删文件夹不提示包含多少篇笔记，确认即物理删除。全模块风险最高的时刻用了视觉最异质、信息最少、恢复为零的方案。修法：复用现有 Modal 做危险确认（Error 色主按钮），文件夹文案写明「"X" 及其 N 篇笔记将被删除」；理想方案为后端移入回收目录 + 5 秒撤销 toast。→ `/impeccable harden` + `/impeccable clarify`
5. **[P2] 焦点态缺失 + 可交互图标用禁用墨色（DESIGN.md 硬约束违规）** — 四个输入框 outline-none 且无替代焦点样式（:397,:537,:674,:727）；工具栏与侧栏图标按钮静止色用 TEXT_DISABLED #71717a（:404,:420,:586,:632），违反「Ink Disabled 仅用于真禁用元素」，且 #71717a on #27272a 实测约 3:1 不达标；选中态三套并存。修法：输入框加 focus-visible 描边（Action Blue 或白纱提亮）；图标按钮静止色按 Ghost 规范改 Ink Tertiary；选中态统一 Scrim White 10。→ `/impeccable polish`

## Persona Red Flags

**Alex（键盘 power user，本产品主用户）**：键盘旅程在 Markdown 视图入口即终结——新建要鼠标点 +（:401），树导航无方向键（SortableNoteTree.tsx:74 是 div），搜索框无快捷键聚焦（:392）。唯一的键盘飞地是 Vditor 编辑器内部。理论可用的 dnd-kit 键盘拖拽（空格键排序）因手柄 14px、对比度约 1.9:1、无 focus 样式而实际不可见。模态和菜单有 Esc 是为数不多的慰藉。主流程第 1 步就为 Alex 断裂，高放弃风险。

**Sam（无障碍依赖）**：全模块不可用。Tab 序列：搜索框（无 label）→ + → 文件夹按钮 → 整棵笔记树被跳过（行是 div）；可聚焦的拖拽手柄无 aria-label（屏幕阅读器只报「按钮」）；文件夹无 aria-expanded；Modal 有 role=dialog 和初始聚焦但无 focus trap，Tab 逃逸到遮罩后；ContextMenu 无 role=menu、无方向键支持；四个输入框 outline-none 无焦点替代，Sam 连自己在哪个字段都看不见。

**Riley（边界压力测试）**：五个具体翻车点——右键搜索结果项弹出的是空白区「新建」菜单（:437 容器级 onContextMenu 覆盖）；重名重命名 → 整树变错误屏；清空标题点走 → 静默保持原名无任何反馈；删含 20 篇笔记的文件夹文案不提 20 篇且无 undo；选中笔记被外部删除后重开应用 → localStorage 恢复选择但 read 失败静默，UI 显示 EmptyState 内部却是「已选中」的自相矛盾状态。另：1000+ 笔记场景 dnd-kit 无虚拟化、搜索每次按键全树 flatten，大库会卡。

## Minor Observations

- 导出下拉无 Esc 关闭（:275-286 只监听 mousedown），与 ContextMenu 的 Esc 支持不一致；单项菜单应直接改为按钮即导出。
- 导出菜单与右键菜单表面色用 BG_SECONDARY #2a2a2a（:603，ContextMenu.tsx:99）——按 Zinc Monolith 规则悬浮层应为 Surface Elevated #3f3f46。
- 模态主按钮是 20% 透明蓝 + #60a5fa（:703-704,:756-757），不符合 DESIGN.md button-primary（Action Blue 实心 + 白字）；#60a5fa、#93c5fd 均不在 token 表。
- 拖拽手柄每行常驻（SortableNoteTree.tsx:96-111），视觉噪声且对比度仅 1.9:1——改 hover 显现或提亮，并加 aria-label「拖拽排序」。
- 创建按钮在输入为空时仍可点、点了没反应（:49,:699）——空输入应禁用主按钮。
- theme.ts:76 TEXT_PLACEHOLDER = #71717a 与 index.css:24 --app-text-placeholder: #8e8e96 互相矛盾，DESIGN.md 指定后者（4.6:1）；模块内输入框均未显式设 placeholder 色。
- EmptyState 的「支持 Markdown 格式」（EmptyState.tsx:17-19）是废话文案；空态应教界面。
- handleExportPNG 残留 5 条调试 console.log（:290-293,:306,:308）。
- VditorEditor 初始化失败态无重试按钮（VditorEditor.tsx:180-188）。
- 导出 PNG 固定浅色渲染（VditorEditor.tsx:48,:61-63）——选择合理但用户无预期，菜单项可注明或提供深色选项。
- 拖拽悬停自动展开的 500ms setTimeout 无清理（SortableNoteTree.tsx:352-354），拖走或松手后仍可能触发展开。
- Tooltip 组件无 role=tooltip、未用 aria-describedby 关联触发元素（Tooltip.tsx:148-173）。
- Modal.tsx:46 用硬编码 bg-zinc-800/shadow-2xl，z-50 与导出下拉同层（THEME.Z_INDEX.MODAL=300 未用）。
- constants.ts 高亮色板 10 色未登记进 DESIGN.md（检测器佐证其余已登记色未误标）。
- 右键搜索结果项弹出空白区菜单（:437 容器级 onContextMenu 覆盖了搜索结果区）。
- 选中笔记被外部删除后现场恢复自相矛盾（useNotes.ts:120-122 静默失败）。
- 跨模块：ChatView.tsx:556-564 打字指示用 animate-bounce，违反 no-bounce 规则（非本模块，顺带记录）。

## Questions to Consider

1. 如果树行从一开始就是 button 语义（可聚焦、Enter 触发），键盘导航、焦点可见、屏幕阅读器三个问题会一次解决——当初用 div + onClick 省下的到底是什么？
2. 导出失败能做出「内联红字 + 重试」的模范恢复，为什么更高频、更致命的保存失败反而静默？「已保存/保存中/失败可重试」常驻标题栏会不会让模块信任感直接上一档？
3. 标题栏那个隐形改名输入框：看起来是标题、点进去就是编辑、blur 即提交——误触改名和用户不敢点，哪一个正在发生？

---
target: json工具
total_score: 19
p0_count: 1
p1_count: 3
timestamp: 2026-07-22T06-08-02Z
slug: src-modules-json-formatter-jsonformatterview-tsx
---
# Critique: JSON 工具模块（json_formatter）

**目标**: `src/modules/json_formatter/`（JsonFormatterView / JsonTreeView / JsonExportPreviewModal）
**日期**: 2026-07-22
**评估方式**: Assessment A（设计总监评审，含浏览器实测 5 tab）+ Assessment B（detect.mjs CLI + detect.js 运行时注入 3 轮）

## Design Health Score: 19/40（Poor — 核心体验有断裂）

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | 复制绿勾、错误 banner 常驻、导出有预览；大图导出无进度 |
| 2 | Match System / Real World | 1 | 英文错误枚举 + 字符偏移；tools.ts 描述与功能不符；空态文案不实 |
| 3 | User Control and Freedom | 1 | 无清空按钮；树态只读；模态内 Esc 直接退出整个模块 |
| 4 | Consistency and Standards | 2 | 选中态 bg-zinc-600 偏离 scrim-white-10 规范；展开图标双位置；yellow-400 出格 |
| 5 | Error Prevention | 2 | JSONC 容错（注释/尾逗号）是真预防；大粘贴无防护 |
| 6 | Recognition Rather Than Recall | 3 | 图标 + 文字标签齐全，视图切换可见 |
| 7 | Flexibility and Efficiency | 1 | 模块内零快捷键；树节点 tabIndex=-1 键盘不可达，与「键盘优先」定位正面冲突 |
| 8 | Aesthetic and Minimalist Design | 3 | 工具栏克制、单 Primary、密度合理；四色语法色偏重但服务语义 |
| 9 | Error Recovery | 2 | banner 常驻但无行列、不可点击、无高亮；复制/保存失败仅 console |
| 10 | Help and Documentation | 1 | 无快捷键说明、无 JSONC 支持提示；tooltip 与按钮文字零信息差 |

## Anti-Patterns Verdict

**LLM 评估：轻-中度 slop。视觉层干净，slop 集中在文案承诺、错误信息与交互惯例三处。**

- 文案与功能脱节：`src/constants/tools.ts:57` 承诺「一键压缩或美化、导出为文件」，实际无压缩/美化按钮，「导出」仅是 PNG 图片。
- 空态文案撒谎：`JsonFormatterView.tsx:260` 写「或直接在此处输入」，树态空屏根本没有输入框（实测点击/打字无响应）。
- 开发者视角泄漏：错误提示直接渲染英文枚举 `ValueExpected（偏移 26）`。
- 发明的交互范式：树节点用 ASCII `[-]`/`[+]`，且 root 图标在行首、非 root 在冒号后（JsonTreeView.tsx:176-198），一套数据两套位置规则；主流 chevron 惯例被绕过。
- 调色板外 accent：ExpandIcon hover `text-yellow-400`（JsonTreeView.tsx:125）。
- 非 slop 侧：无渐变/玻璃/大标题；jsonc-parser 保留注释、canvas 导出绕过 WebView2 缺陷是真实工程判断。

**确定性扫描：**

- CLI 文件级扫描（3 个目标文件）：**0 findings**，exit 0。
- 运行时 detect.js（整页 DOM，3 轮注入）真实命中 1 条：`low-contrast` 2.3:1（#52525b on #18181b），即空态提示文字（JsonFormatterView.tsx:258-260）——与 Assessment A 实测的行号对比度 ≈3.2:1（zinc-600 on zinc-900）互相印证：**模块内存在系统性低对比文字**。
- 误报：`ai-color-palette`（cyan/violet ×N）命中的是 JSON 语法高亮语义色，非装饰色；但 violet-400 确落入已否决的 secondary-violet 色域，建议收敛而非忽略。
- 归因不足：`flat-type-hierarchy` / `bounce-easing` / `layout-transition` 来自应用全局 CSS，非本模块特有。

**可视化覆盖：** detect.js 注入成功（页面有 Browser Mode 降级，未白屏），叠加面板在浏览器中可见；覆盖空态 + 填充树两态。JsonExportPreviewModal 因 Tauri invoke 依赖无法在纯浏览器触发，其问题由源码审查 + Assessment A 实测确认。

## Overall Impression

入口体验（启动器粘贴直进、JSONC 容错、树瞬间成形）是产品心脏级别的顺滑；但模块内部存在「只读查看器」的心智与「可编辑工具」的承诺之间的断裂：文本视图吞输入、树视图键盘不可达、错误不可恢复。最大机会：把文本视图修可信 + 键盘打通，模块从 demo 变工具。

## What's Working

1. **粘贴直进**：Launcher 识别 JSONC（含注释/尾逗号，LauncherView.tsx:233-253）自动进模块，`formatJsonc` edits 保留注释——零摩擦入口 + 真功夫细节。
2. **导出预览模态**：`jsonCanvas.ts` 2x 像素渲染、颜色与树态逐一对应、文件名带时间戳、复制图片/另存为双路径，绕开 WebView2 缺陷的决策有据。
3. **状态覆盖完整**：空/错/树/文四态各有渲染分支，错误 banner 不自动消失，复制反馈 2s 绿勾——基础状态纪律在线。

## Priority Issues

- **[P0] 模态 Esc 冲突**：JsonExportPreviewModal 无 Esc 处理，App.tsx:298-311 全局 Esc 无条件回启动器。实测：模态打开时按 Esc → 模态 + 模块一起消失，上下文全丢。**修复**：modal 内捕获 Esc 并 stopPropagation，或 App 级 handler 先检查打开中的模态。**建议命令**：`/impeccable harden`
- **[P1] 文本视图边打边格式化吞输入**：有效 JSON 中间按 Enter，换行被重排抹掉、光标跳文末（实测 caret sel=23 即文末）。编辑器不可信，文本视图名存实亡。**修复**：编辑期间显示 rawText 不重排，格式化收敛为显式动作或仅在粘贴/进视图时执行一次。**建议命令**：`/impeccable harden`
- **[P1] 树键盘与读屏不可达**：ExpandIcon `tabIndex={-1}`，全树纯 div 无 role=tree/treeitem/aria-expanded，无方向键导航。**修复**：role=tree + roving tabindex + ←/→ 折叠展开；chevron 替换 ASCII（一并清零双位置规则与 hover 黄色）。**建议命令**：`/impeccable audit`
- **[P1] 空态承诺不可兑现**：树态空屏无输入框却写着「直接在此处输入」。**修复**：树态空屏渲染同一 textarea，或文案改为「切换到文本视图输入」。**建议命令**：`/impeccable clarify`
- **[P2] 错误信息不可恢复**：英文枚举 + 字符偏移，无行列、不可点击、无高亮。**修复**：错误码中文化、偏移换算「第 N 行第 M 列」、banner 点击跳转文本视图并选中出错位置。**建议命令**：`/impeccable clarify`
- **[P2] 系统性低对比文字**：空态提示 2.3:1（检测器实测 #52525b on #18181b）、行号 ≈3.2:1，均低于 4.5:1。**修复**：提示文字升至 ink-placeholder #8e8e96 档，行号升至 ink-disabled #71717a 或更亮。**建议命令**：`/impeccable audit`

## Persona Red Flags

**Alex（键盘流重度用户）**：① `[-]/[+]` tabIndex=-1，Tab 序列直接跳过，节点展开只能摸鼠标；② 全模块无任何快捷键（复制/导出/切视图都没有）；③ 导出模态里 Esc 把他扔回启动器，刚导出的上下文归零。——与本产品「键盘优先」定位正面冲突，LHF 本人即此 persona。

**Sam（无障碍依赖）**：① 树是 div 汤，读屏只能线性念「左括号减号右括号」；② `[-]` 按钮 accessible name 就是「[-]」且 tabIndex=-1；③ 模态无 role=dialog/aria-modal/焦点陷阱/初始焦点，X 按钮无 aria-label；④ 行号对比度 ≈3.2:1 低于 4.5:1。

**Riley（边界测试者）**：① 10 万行 JSON：flatten 全量渲染无虚拟化，DOM 爆炸；② 导出 canvas 高 = 行数×26×2px，超 WebView2 16384px 纹理上限 → 静默产出空白/截断图且无任何提示；③ `CANVAS_W=800` 固定（jsonCanvas.ts:109），长行导出被裁；④ 递归 flatten 对超深嵌套有栈溢出风险。

## Minor Observations

- Tooltip 与按钮文字完全相同（「展开全部」tip 写「展开全部」），零信息增益。
- 视图 toggle 激活态 bg-zinc-600 实心块，偏离 scrim-white-10 选中规范。
- 全模块用 raw palette（bg-zinc-900/bg-blue-600/text-green-400），未用 tailwind.config 已定义的 app-bg-*/app-text-*/app-status-* 语义 token；text-green-400 ≠ --app-status-success #22c55e，同语义两个色。
- 模态 shadow-2xl 非 token --app-shadow-xl；border-zinc-700 非 30% 灰阶边框变量。
- boolean violet-400 落入被否决的 secondary-violet 色域；TypeHint 计数 amber-400 + 四色彩虹偏「编辑器皮肤」（可辩护为语法语义，建议收敛）。
- 复制/保存失败仅 console.error，用户无感知（静默失败）。
- 保存成功提示 5s 自动消失，长路径不可复制。
- 「导出中...」文案对应同步瞬时渲染，属冗余状态（或应真的异步化）。
- placeholder「在此粘贴 JSON 数据...」（文本视图）与空态文案「在启动器中粘贴...」（树态）两套口径不一致。
- 树态工具栏同屏 6 个控件（视图 toggle×2 + 展开 + 折叠 + 复制 + 导出），超过 ≤4 可见操作上限；唯一 Primary 蓝给了低频「导出图片」，最高频「复制」是灰底次要样式——层级与使用频率倒挂。

## Questions to Consider

1. 如果本模块的主任务是「看懂/带走 JSON」，为什么全屏唯一的 Primary 蓝给了「导出图片」？把 Primary 还给「复制」，层级倒挂是不是立刻消失？
2. 文本视图真的需要边打边格式化吗？若格式化只在粘贴/进视图时发生一次，光标被吞问题是否不药而愈，同时还省掉每键一次的 parse？
3. `[-]/[+]` 换成行首单 chevron（旋转 90°）——root/非 root 双位置规则、ASCII 噪音、hover 黄色三个出格点是否一次清零？
4. 用户带着 5MB JSON 进来时，模块的答案是「卡死 + 导出空白图」。上限策略应该是什么——行数阈值降级为纯文本、虚拟化、还是明确拒绝并给出人话提示？

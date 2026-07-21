---
target: LauncherView
total_score: 28
p0_count: 0
p1_count: 1
timestamp: 2026-07-21T10-02-03Z
slug: src-modules-launcher-launcherview-tsx
---
# Critique: LauncherView（启动器主界面）— 第三轮复评

Method: dual-agent（A: 设计总监源码评审 · B: 检测器 + 浏览器交互验证，相互隔离）

## Design Health Score: 28/40（Good 区间，28–35）

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | 系统状态可见 | 3 | 错误态/toast/图标兜底到位；文本粘贴零反馈、启动无 busy 态 |
| 2 | 贴近现实语言 | 3 | 别名贴近用户词汇；「记 xxx」显示"未找到"与实际动作矛盾 |
| 3 | 用户控制自由 | 3 | Esc 分层、展开/收缩、Enter 冲刷；粘贴被吞、备忘无撤销 |
| 4 | 一致性 | 2 | 选中视觉已统一；非选中文字两档灰、展开门槛两处不一、Enter/Space 分叉、阴影档位错配 |
| 5 | 错误预防 | 3 | navItems==渲染集合+clamp 是硬保障；Enter 冲刷可能换项、全角空格死键 |
| 6 | 识别优于回忆 | 3 | placeholder 轮换教学是零成本发现；每条提示仅 25% 时间可见 |
| 7 | 灵活高效 | 3 | 别名+冲刷+hover 即选中+2D 方向键；工具永远置顶不吃使用频率 |
| 8 | 简约美学 | 3 | zinc 一体、tile 统一；阴影档位越规、双行名时残影消失 |
| 9 | 错误恢复 | 3 | 启动失败留窗+toast、搜索失败分态；错误信息透传后端原文 |
| 10 | 帮助文档 | 2 | 设置内手册+轮换提示；无快捷键速查 |
| **Total** | | **28/40** | 18 → 27 → 28 |

差异来源：焦点可见、错误态诚实化、别名、placeholder 教学、aria 结构（+4 量级）抵消文本粘贴沉默、Enter/Space 分叉、阴影错配、「记」空态矛盾（-3 量级），净 +1。

## 上轮修复核实（A 独立验证）

第二轮 P1/P2/P3 全部生效（aria listbox 部分生效：结构有了，缺 aria-activedescendant，读屏听不到选择变化）。唯一错配：search-shadow 接线了但用错阴影档（--app-shadow-lg，应为 --app-shadow-md，DESIGN.md 搜索栏专用影）。

B 的浏览器交互验证六项全过：placeholder 8s 轮换实测确认、"clip" 别名搜出剪贴板、hover 即选中生效、选中文字 #818cf8、focus-visible 焦点环生效、无新增 console 错误。

**确定性扫描**：detect.mjs 连续三轮零 finding。

## Anti-Patterns Verdict

通过，无违禁项。字母兜底 tile 用 bg-app-bg-elevated，注释自觉引用 Zinc Monolith——设计系统纪律已内化。Raycast/Linear 用户信任度：核心链路已达"可信"线，但文本粘贴沉默（P1-1）和 Enter/焦点分叉（P2-1）是他们第一天就会撞见的问题。

## What's Working

1. **防盲启架构**：导航集合与渲染集合强制一致 + clamp，Enter 物理上不可能命中未渲染项——资深级防御性 UX
2. **回车冲刷防抖**：同类产品基本不处理的经典病，这里处理了
3. **错误是一等公民**：searchError 分态、启动失败留窗、launchApp 主动 rethrow——统一的错误哲学

## Priority Issues（新一轮）

- **[P1-1] 文本粘贴被静默吞掉**（LV:197-248）
  - Why: 非 JSON 粘贴走无条件 preventDefault，随后 case 'text' 只 console.log、'none' 只处理 file——纯文本 Ctrl+V 在搜索框什么都不发生；placeholder 第一条还在宣传"粘贴文件或图片"
  - Fix: preventDefault 推迟到后端确认 file/image 之后；'text'/'none' 不拦截默认插入
  - Suggested command: `/impeccable harden`

- **[P2-1] Enter 与焦点分叉**（LV:312-389）
  - Why: 卡片是 button 可 Tab 聚焦；Enter 冒泡被容器 preventDefault 启动 selectedIndex 项，Space 启动焦点项——焦点环在撒谎
  - Fix: ItemCard 一律 tabIndex={-1}，selectedIndex 成唯一选择模型（Raycast 模型），焦点只活在 input/profile/展开按钮
  - Suggested command: `/impeccable harden`

- **[P2-2] 「记」前缀的空态矛盾**（LV:342-372 vs 616-631）
  - Why: 输入"记 明天交周报"结果区显示"未找到匹配的程序"，回车却成功保存——界面在否定用户的动作；全角空格（"记　内容"）落到搜索且 Enter 死键
  - Fix: query 匹配 /^记[\s　]/ 时结果区改渲染动作预览（"回车记下：明天交周报"），一并解全角空格
  - Suggested command: `/impeccable clarify`

- **[P2-3] hover 即选中与 scrollIntoView 互搏**（LV:485-489 + 520）
  - Why: 键盘导航触发 scrollIntoView，浏览器在内容滚到静止鼠标下方时合成 mouseover → onHover 把选择"吸回"鼠标位置；Alex 展开态方向键导航时选择莫名跳走
  - Fix: 记录最后真实 mousemove 坐标，mouseenter 比对位移阈值；或方向键后 150-200ms 屏蔽 hover 选中
  - Suggested command: `/impeccable harden`

- **[P3] 打磨包**：search-shadow 档位错（lg→md）；最近使用展开按钮无门槛（≤9 项时仍在）；非选中文字两档灰（内置 secondary vs 外部 tertiary，统一为 tertiary）；FileResult 死导出（US:10-15）；容器空 tabIndex（LV:393-395）；console.log 残留（LV:229/233）；useSearch 初始与防抖 effect 重复 searchApps('')；searchApps 无竞态序列化；卡片 transition-all 应收敛 transition-colors；aliases 单字母噪音（<2 字符跳过别名匹配）

## Persona Red Flags

- **Alex**：P2-3 滚动吸回打断键盘流；工具永远置顶不吃使用频率（recordAppUsage 数据零权重）
- **Jordan**：P1-1 粘贴没反应会怀疑自己；P2-2 按教程打「记」却看到"未找到"；提示轮换使基础说明 75% 时间不可见
- **Sam**：P2-1 Enter 不听焦点；18+ 卡片全是 Tab 停靠点遍历冗长；listbox 无 aria-activedescendant 选择变化读屏不可见；容器空停靠点

## Questions to Consider

1. 选择模型已是单一 selectedIndex（Raycast 式），为什么 DOM 还保留第二套选择系统（可聚焦 button 卡）？
2. 「记」是命令还是搜索？如果是命令，反馈不该走搜索结果区——要不要引入"动作行"（结果区第一行"回车记下：xxx"）？
3. 工具永远排应用之前是静态假设——recordAppUsage 在积累数据，排序什么时候第一次允许"应用压过工具"？

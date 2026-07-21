---
name: FlowHub
description: Windows 桌面效率中枢——启动器、剪贴板、密码本、笔记与陪伴，唤起即用。
colors:
  signal-indigo: "#6366f1"
  signal-indigo-light: "#818cf8"
  secondary-violet: "#a855f7"
  action-blue: "#3b82f6"
  action-blue-deep: "#2563eb"
  surface-base: "#27272a"
  surface-sidebar: "#2a2a2a"
  surface-card: "#2d2d2d"
  surface-elevated: "#3f3f46"
  surface-pressed: "#52525b"
  ink-primary: "#f4f4f5"
  ink-secondary: "#d4d4d8"
  ink-tertiary: "#a1a1aa"
  ink-disabled: "#71717a"
  ink-placeholder: "#8e8e96"
  status-success: "#22c55e"
  status-warning: "#f59e0b"
  status-error: "#ef4444"
  status-info: "#3b82f6"
  scrim-white-5: "#ffffff0d"
  scrim-white-10: "#ffffff1a"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif"
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.4
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.3
rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.action-blue}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-primary-hover:
    backgroundColor: "{colors.action-blue-deep}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-tertiary}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
  button-ghost-hover:
    backgroundColor: "{colors.scrim-white-10}"
    textColor: "{colors.ink-primary}"
  input-search:
    backgroundColor: "transparent"
    textColor: "{colors.ink-primary}"
    typography: "{typography.display}"
  list-item:
    rounded: "{rounded.md}"
    padding: "12px"
  list-item-selected:
    backgroundColor: "{colors.scrim-white-10}"
  tooltip:
    backgroundColor: "{colors.surface-elevated}"
    textColor: "{colors.ink-secondary}"
    rounded: "5px"
    padding: "4px 8px"
  panel-glass:
    backgroundColor: "#27272ab3"
    rounded: "{rounded.lg}"
---

# Design System: FlowHub

## 1. Overview

**Creative North Star: "The System Native"**

FlowHub 的设计目标是让用户忘记它是一个第三方应用。它驻留在 Windows 桌面，靠全局快捷键唤起，窗口材质、动效、字体渲染都向 Windows 11 Fluent 与 macOS 的系统级质感看齐——Mica/Acrylic 材质是界面的一部分，而不是一层装饰皮肤。设计服务于"唤起 → 输入 → 回车 → 完成"这条肌肉记忆链路，任何减慢这条链路的视觉决策都是错的。

这套系统是深色单色的：zinc 灰阶构成连续的表面，品牌色只做点睛。它明确拒绝 SaaS 营销风的大标题大圆角、AI 花哨感的渐变与霓虹、企业后台感的控件堆叠，以及卡片套卡片的层级滥用。层级靠字重、字号、间距与灰阶建立；边框和阴影是最后手段。

**Key Characteristics:**
- 深色一体表面（zinc-800 基座），面板从背景中浮出而非贴上
- OS 窗口材质（Mica/Acrylic/Blur）即分层的第一手段
- Signal Indigo 点睛，面积 ≤10%
- 无营销级大字号；最大字级是 18px 搜索框
- 状态驱动阴影：静止时平坦，阴影只响应 hover/激活/模态
- 键盘优先，所有反馈 ≤200ms

## 2. Colors

一套以 zinc 灰阶为体、Signal Indigo 为睛的克制深色方案。

### Primary
- **Signal Indigo** (#6366f1): 品牌点睛色。只用于品牌时刻——启动器选中项文字、品牌标识、关键强调。不出现在大色块、背景或渐变中。
- **Signal Indigo Light** (#818cf8): Signal Indigo 的深色表面安全变体（实测 5.0:1）。深色背景上需要靛蓝文字（如选中态名称）时永远用它，不用原色（原色文字仅 3.34:1，不达标）。
- **Secondary Violet** (#a855f7): Signal Indigo 的辅助色，仅用于需要第二品牌色相的场合（如内置工具图标底）。使用频率低于 Indigo。

### Secondary
- **Action Blue** (#3b82f6): 系统级操作色。主按钮、选中态、链接、info 状态。语义是"这是一个可执行的操作"，与 Indigo 的"这是品牌"分工明确。Hover 加深至 Action Blue Deep (#2563eb)。

### Neutral
- **Surface Base** (#27272a): 应用主背景，一切表面的基座。
- **Surface Sidebar** (#2a2a2a): 侧边栏背景，与主背景仅一档之差，靠 1px 灰阶差暗示分区。
- **Surface Card** (#2d2d2d): 卡片、输入框、内嵌容器。
- **Surface Elevated** (#3f3f46): 悬浮层——下拉、tooltip、浮起按钮。
- **Surface Pressed** (#52525b): 按压/选中态表面。
- **Ink Primary** (#f4f4f5): 主文字，深色表面上的最高对比。
- **Ink Secondary** (#d4d4d8): 次要文字、正文。
- **Ink Tertiary** (#a1a1aa): 辅助说明、图标默认色。
- **Ink Disabled** (#71717a): 禁用态文字。仅用于真正的禁用元素（WCAG 豁免）；可交互文字禁用此色。
- **Ink Placeholder** (#8e8e96): 输入框 placeholder 专用（实测 4.6:1 on Surface Base）。介于 disabled 与 tertiary 之间，既满足 4.5:1 又保持"提示非正文"的质感。
- **Scrim White 5/10** (#ffffff0d / #ffffff1a): 白色透明度纱层，用于列表选中、hover 底色——玻璃体系里"提亮"的唯一方式。

### 状态色
- Success (#22c55e) / Warning (#f59e0b) / Error (#ef4444) / Info (#3b82f6)：仅用于语义状态，不做装饰。

### Named Rules
**The One Voice Rule.** Signal Indigo 在任何单屏面积 ≤10%。它的稀缺性就是它的意义——满屏靛蓝等于没有品牌。

**The Zinc Monolith Rule.** 背景分层只允许在 zinc 灰阶内上下浮动一档（base → sidebar → card → elevated）。禁止引入灰阶以外的表面色；需要"更亮"时用白色纱层（Scrim White 5/10），不是新颜色。

## 3. Typography

**Display Font:** 系统字体栈（-apple-system / Segoe UI / PingFang SC / Microsoft YaHei）
**Body Font:** 同一系统字体栈
**Label/Mono Font:** 无独立等宽字体（代码场景由 Markdown 编辑器内部处理）

**Character:** 单一字族、字重与字号拉开层级。这是刻意的：唤起速度高于一切，不加载任何 Web 字体；中文渲染依赖 PingFang SC / Microsoft YaHei 回退链，保证跨机器一致。

### Hierarchy
- **Display** (400, 18px, 1.4): 唯一职责是启动器搜索框。它是全应用最大的字级——这是工具，不是落地页。
- **Title** (600, 14px, 1.4): 区块标题（如"最近使用"），配 Ink Tertiary 降低存在感，让内容成为主角。
- **Body** (400, 14px, 1.6): 正文、按钮文字、列表主行。
- **Label** (400, 12px, 1.3): 辅助标签、网格项名称、次级操作。最小用到 10px 仅限聊天 mode 标签等微标识，且必须配 600 字重。

### Named Rules
**The System Stack Rule.** 禁止引入 Web 字体。系统字体栈是唤起速度与中文字形一致性的保证；任何"更有设计感"的字体都要用启动延迟来换，不值。

**The 18px Ceiling Rule.** 界面文字上限 18px。需要更强层级时，用字重（400→600）与灰阶（Tertiary→Primary）解决，不是放大字号。

## 4. Elevation

本系统是"材质优先"的混合方案：OS 窗口材质（Mica/Acrylic/Blur）负责窗口与桌面的分层；CSS 阴影只负责元素的状态反馈。表面静止时是平坦的——没有常驻投影的卡片。

### Shadow Vocabulary
- **Resting** (`0 2px 8px rgba(0,0,0,0.2)`): 极少量用于需要微弱浮起的静态元素，如 tooltip（`0 4px 12px rgba(0,0,0,0.2)`）。
- **Search Bar** (`0 4px 24px rgba(0,0,0,0.2)` + 1px 白色 5% 描边): 启动器搜索栏专用，应用唯一的"主角"阴影。
- **Elevated** (`0 8px 32px rgba(0,0,0,0.3)`): 下拉菜单、弹出层。
- **Modal** (`0 25px 60px rgba(0,0,0,0.6)`): 模态与玻璃覆盖层，全应用最重阴影，只许出现在模态。

### Named Rules
**The Flat-At-Rest Rule.** 表面静止时平坦。阴影是对状态（hover、浮起、模态）的响应，不是装饰。如果你给一个静止元素加阴影"让它更立体"，方向就错了——用灰阶抬升表面色。

**The Material-First Rule.** 分层的第一手段是窗口材质与灰阶差，不是 box-shadow。阴影词表只有四档，超出即违规。

## 5. Components

组件整体手感：**精致而克制**。反馈明确（hover 必有响应、时长 ≤200ms），但绝不炫技——没有弹性曲线、没有炫目粒子，细节打磨体现在圆角一致、焦点可见、字距得当。

### Buttons
- **Shape:** 统一 8px 圆角（rounded-md）；图标按钮同形等边（w-7~w-9 方形或圆形 profile 按钮）。
- **Primary:** Action Blue 底 + 白字，padding 8px 16px，hover 加深至 Action Blue Deep。每屏至多一个 Primary。
- **Ghost:** 透明底 + Ink Tertiary 字，hover 铺 Scrim White 10 底并提亮至 Ink Primary。工具栏、次级操作的默认形态。
- **Hover / Focus:** 全部 200ms 内完成的色彩过渡；键盘焦点必须有可见焦点态，不得依赖 outline: none 后无替代。

### Chips / Tags
- 6px 圆角小标签（rounded-sm），10–12px 字号，语义色 10–20% 透明度底 + 同色相亮字。只承载分类/状态信息，不做装饰。

### Cards / Containers
- **Corner Style:** 12px 圆角（panel-glass）；内嵌卡片 8–12px。
- **Background:** Surface Card 或玻璃面板（70% Surface Base + backdrop blur）。
- **Shadow Strategy:** 遵守 Flat-At-Rest——静止无阴影。
- **Border:** 1px 白色 5%（玻璃面板）或 30% 灰阶边框（实体容器），二选一，不叠加。
- **Internal Padding:** 12–16px。

### Inputs / Fields
- 搜索框是无框的：透明底、18px Display 字级、placeholder 用 Ink Disabled，焦点靠存在本身而非边框发光。
- 表单输入框：Surface Card 底 + 1px 灰阶边框，focus 时边框提亮至 50% 灰阶或 Action Blue；Error 态用 Error 红边框 + 红字说明。

### Navigation
- 应用内导航当前为即时切换；视图过渡的目标形态是 300ms 透明度 + 0.98→1 缩放（Fluent 连贯感），尚未接线实现。
- 侧边栏项：Ghost 按钮形态，选中铺 Scrim White 10；图标默认 Ink Tertiary，hover/选中提亮。

### Lists
- 列表项 8px 圆角、12px 内边距；选中铺 Scrim White 10，不用边框或左侧色条标示选中。
- hover 必有响应（底色或图标提亮），150–200ms 过渡。

### Tooltip
- Surface Elevated 底、5px 圆角、4px 8px 内边距、12px 字号、8px 背景模糊。单行不换行，纯信息不交互。

### Toast / 陪伴弹窗
- 独立小窗：zinc-900 95% 底 + backdrop blur、12px 圆角、1px 白色 10% 描边、Modal 级阴影。动作按钮遵循 Primary/Ghost 分工。

## 6. Do's and Don'ts

### Do:
- **Do** 用字重与灰阶建立层级；Ink Tertiary 的 14px 600 比 20px 大标题更符合本系统。
- **Do** 让选中态统一用 Scrim White 10 铺底——列表、侧边栏、网格项共用同一种"被选中的样子"。
- **Do** 把品牌时刻留给 Signal Indigo：选中项文字、关键确认、品牌标识。一屏一处。
- **Do** 动画控制在 150–300ms、ease-out 或 cubic-bezier(0.4,0,0.2,1)；`prefers-reduced-motion` 下降级为交叉淡入或即时切换。
- **Do** 保持 placeholder 与次要文字对比度 ≥4.5:1；深色玻璃背景上先验证再提交。
- **Do** 优先使用 Tailwind 语义 token（app-bg / app-text / app-border / app-brand），与 index.css 的 CSS 变量保持一致。

### Don't:
- **Don't** 引入 SaaS 营销风：大标题、大圆角（>16px）、大面积留白构图、hero 区。这是工具，不是落地页。
- **Don't** 制造 AI 花哨感：渐变文字（background-clip: text）、满屏渐变、霓虹色、无目的玻璃拟态、装饰性粒子。
- **Don't** 滑向企业后台感：密不透风的表格控件堆叠、无边距的表单墙、12 列栅格式仪表盘。
- **Don't** 卡片套卡片。容器内需要分区时用间距与灰阶差，嵌套卡片永远错误。
- **Don't** 用侧边色条（border-left/right >1px 的彩色条纹）标示选中或分类。
- **Don't** 给静止元素加常驻阴影；违反 Flat-At-Rest Rule。
- **Don't** 超过 18px 字级；违反 18px Ceiling Rule。
- **Don't** 引入 Web 字体；违反 System Stack Rule。

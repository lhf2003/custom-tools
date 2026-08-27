# 笔记编辑器 Vditor → CodeMirror 6 迁移

**创建日期**: 2026-08-27
**作者**: LHF + Claude
**版本**: v1.0
**状态**: 已批准

## 背景

笔记模块 Vditor IR 模式代码块三大顽疾：代码块内 Enter 被拦截不换行、每次输入整段 DOM 重排（Lute 重解析 + hljs 重跑 + 复制按钮重注入）、展示 UI 需优化。IR 模式重排是内核机制，无法根治。

**裁决（LHF 确认）**：编辑器整体替换为 CodeMirror 6，形态为单栏即时渲染（类 Obsidian Live Preview）。

## 方案

### 架构

```
src/modules/markdown/
├── components/
│   ├── CodeMirrorEditor.tsx   # React 包装，契约同旧 VditorEditor（value/onChange/placeholder）
│   └── EditorToolbar.tsx      # 工具栏（ActionMenu 标题下拉 + 28px 图标按钮，mousedown 保焦）
├── editor/
│   ├── extensions.ts          # 扩展组装（history/search/markdown/嵌套语言高亮/keymap）
│   ├── theme.ts               # HighlightStyle，颜色全部 var(--cm-*)，切主题零 JS
│   ├── codeBlockPlugin.ts     # 代码块折叠/展开 StateField（核心）
│   ├── livePreview.ts         # 标题/引用/任务框/分隔线/行内代码装饰 StateField
│   └── commands.ts            # 格式化命令（changeByRange 纯文本变换）
└── styles/editor.css          # 替代 vditor.css，token 移植改名 --cm-*
```

### 关键机制

1. **代码块 Variant A**：光标（任一 selection range）与 FencedCode 节点相交 → 仅加行背景，源码全可见，Enter/Tab/IME 全原生；光标在块外 → 开 fence 行 `Decoration.replace` 为头部 widget（语言 chip + 复制按钮），闭 fence 行替换为零高 footer，块体行等宽 scrim 背景。嵌套语法高亮由 `lang-markdown codeLanguages`（@codemirror/language-data 懒加载）免费获得。降级开关 `COLLAPSE_FENCES = false` → Variant B。
2. **块级装饰必须 StateField**：CM6 禁止 ViewPlugin 提供块级装饰（block widget/replace），抛 `Block decorations may not be specified via plugins`。两个装饰插件均为 `StateField<DecorationSet>` + `EditorView.decorations.from`，后台解析推进以 transaction 形式经过 update。
3. **widget `eq()`**：比较 lang + 代码文本，文档他处敲键不重挂载本块 DOM —— "不再每次修改刷新排版"的结构保证。
4. **复制按钮**：`mousedown + preventDefault + stopPropagation`，widget `ignoreEvent()` 返回 true，复制绝不把焦点带进块内。
5. **外部 value 同步**：仅当 prop 与 `doc.toString()` 真正不同才全量 dispatch，本地输入（含 IME 组词）永不触发回写。
6. **主题零 JS**：HighlightStyle 颜色值全是 `var(--cm-*)`，paint 时解析；旧的 setTheme 三件套机制整段删除。
7. **导出**：`Vditor.preview` → `renderToStaticMarkup(ReactMarkdown + remarkGfm + rehypeHighlight)`，`.vditor-reset` → `.markdown-export`，深色 hljs 补丁补写（旧版依赖外部 github-dark CSS）；等待逻辑改 `document.fonts.ready` + rAF；两处字体栈同步点保留并加注释。

## 删除

vditor 包、`public/vditor/`（23MB）、VditorEditor.tsx、vditor.css、.gitignore 的 `!public/vditor/dist/`、index.css 的 `.w-md-editor` 死规则（990-1125 行）。eslint.config.js 的 `public/vditor` ignore 因 config-protection hook 拦截未删（目录已不存在，无实际影响）。

## 验证（vite 临时测试页 + Playwright 实测）

| 场景 | 结果 |
|---|---|
| 代码块内 Enter 换行 + 输入 | ✅ 新行落在闭合 fence 之前，原生行为 |
| 点击块外折叠、点击块体展开 | ✅ |
| 复制按钮内容 | ✅ 精确为块体文本 |
| 任务列表 checkbox 回写 `[x]` | ✅ |
| Ctrl+B 加粗（无选区插 `****` 光标居中） | ✅ |
| Ctrl+F 搜索面板 | ✅ |
| 浅/深主题翻转（纯 CSS） | ✅ |
| `npm run build` / 新文件 lint | ✅ 零错误 |

## 追加优化（2026-08-27 第三轮，LHF 反馈）

**bug：夹在两个代码块之间的文字行光标点不准。**

根因（两层叠加）：
1. 折叠态用块级 widget 替换 fence 行，两态高度不同，点击手势 mousedown 定位、mouseup 落定的间隙布局跳行 → 改为**内联替换**：fence 行始终占位同一行高，折叠时开 fence 行内容内联替换为 header 行（语言 chip + 复制按钮）、闭 fence 行内容内联隐藏，两态几何完全一致。
2. **更本质的坑：行装饰/小部件上的纵向 margin 对 CM6 高度图不可见**（高度图只量 border-box，margin 忽略），每处 margin 累积成整行点击偏移——实测 6+10+10=26px 误差精确吻合三块 margin（标题行 margin-top 6px、代码块首行 margin-top 10px、末行 margin-bottom 10px）。全部清除：间距一律改 padding 或透明 border（hr 组件 margin 10px 0 → padding 10px 0 + ::before 画线）。editor.css 已写入铁律注释。

排障方法论：dev 注入 `window.__cmView`（import.meta.env.DEV 门控），用 `posAtCoords` / `lineBlockAt` / `elementAtHeight` 对比 DOM getBoundingClientRect 逐行定位高度图漂移。

实测（Playwright）：点击中间文字行打字落在该行 ✅；首次点击折叠块体光标精确 ✅；展开后点外部折叠且光标不跳 ✅；复制按钮 ✅。首轮记录的「首次点击折叠代码块光标偏一行」瑕疵一并根治（同属 margin 漂移）。

## 已知事项

- **首次点击折叠代码块光标可能偏一行**：展开瞬间布局上移（fence 行出现），CM6 手势终点按新坐标落位。仅首次点击发生，第二次点击精确。如需根治可改 Variant B。
- **嵌套语言自动缩进**：代码块内 Enter 会按子语言缩进服务补缩进（如 Python `def` 后 +4 空格），属预期增益。
- **MarkdownView chunk 1.13MB**：language-data 全语言注册 + react-markdown/rehype-highlight 进入该 chunk；语言包本身懒加载（首屏不受影响），后续可按需收窄语言集。
- 无 Tauri 后端的纯前端验证模式：vite 根目录临时 `editor-test.html` + 挂载组件的 tsx + Playwright，验证完即删。

## 追加优化（2026-08-27 第二轮，LHF 反馈）

1. **标题标记即时隐藏**：光标不在标题行时，`Decoration.replace` 把 `#` 连同其后一个空格隐藏（Obsidian 同款），光标进入行即恢复源码。覆盖 ATX 一至六级。
2. **代码块语言名可改**：header 栏（含语言 chip）点击 → `view.dispatch` 把光标投递到源码语言名末尾（无语言名时落到 ``` 之后），块自动展开直接编辑；chip 悬停有反馈、带「点击修改语言」提示。widget `eq()` 增加 codeInfoEnd 位置比较，防块前编辑导致的位置过期。
3. **header 与块体视觉统一**：折叠态块体首行不再加盖（顶边/上圆角是 header 职责），header 与块体同底色 + 连续侧边框 + 无缝贴合（实测两盒模型 left/right/接缝坐标完全一致），一张卡而非两张叠卡。

以上均经 Playwright 实测：chip 点击展开 → Backspace+输入改 `typescript` 为 `rust` → 折叠后 chip 同步；标题标记隐藏/恢复双向正确。

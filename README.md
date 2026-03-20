# Custom Tools

<p align="center">
  <img src="src-tauri/icons/icon.png" width="128" alt="Custom Tools Logo">
</p>

<p align="center">
  <a href="https://tauri.app"><img src="https://img.shields.io/badge/Built%20with-Tauri-FFC131?style=flat-square&logo=tauri" alt="Built with Tauri"></a>
  <a href="https://react.dev"><img src="https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react" alt="React 18"></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/Rust-1.77+-DEA584?style=flat-square&logo=rust" alt="Rust 1.77+"></a>
</p>

<p align="center">
  <b>一个现代化的 Windows 生产力工具箱，类似 uTools</b>
</p>

<p align="center">
  <a href="#功能特性">功能特性</a> •
  <a href="#安装">安装</a> •
  <a href="#快速开始">快速开始</a> •
  <a href="#使用指南">使用指南</a> •
  <a href="#开发">开发</a> •
  <a href="#技术栈">技术栈</a>
</p>

---

## 功能特性

### 🚀 应用启动器 (Launcher)
- **模糊搜索**：支持拼音首字母、缩写匹配（如输入 `wx` 匹配 `微信`，`vsc` 匹配 `Visual Studio Code`）
- **智能排序**：基于使用频率和最近使用时间自适应排序
- **实时索引**：监控 Start Menu 和 Desktop，自动检测应用安装/卸载
- **Everything 集成**：可选集成 Everything，实现极速文件搜索

### 📋 剪贴板历史 (Clipboard)
- **历史记录**：自动记录剪贴板内容，支持文本、图片
- **去重机制**：基于内容哈希的智能去重
- **快捷粘贴**：搜索历史记录，一键粘贴
- **隐私保护**：可配置历史记录保存时长

### 🔐 密码管理器 (Password)
- **AES-GCM 加密**：军工级加密保护您的密码
- **主密码保护**：需要主密码解锁才能访问
- **密码生成器**：生成高强度随机密码
- **分类管理**：支持自定义分组管理密码

### 📝 Markdown 笔记 (Notes)
- **实时预览**：支持 Markdown 实时预览编辑
- **文件存储**：笔记以文件形式存储，方便备份和同步
- **快速搜索**：全文搜索笔记内容
- **标签管理**：支持标签分类管理

### ⚙️ 设置 (Settings)
- **全局快捷键**：支持自定义唤起快捷键（默认 `Alt+Space`）
- **开机启动**：可选开机自动启动
- **窗口行为**：可配置失焦自动隐藏、置顶等
- **自动更新**：内置自动更新功能

---

## 安装

### 系统要求

- **操作系统**：Windows 10/11 (64位)
- **运行时**：WebView2 Runtime（Windows 10/11 已内置）

### 下载安装

1. 访问 [Releases](https://github.com/lhf2003/custom-tools/releases) 页面
2. 下载最新版本的 `.msi` 或 `.exe` 安装包
3. 运行安装程序，按提示完成安装

---

## 快速开始

### 唤起应用

- **默认快捷键**：`Ctrl + Shift + Space`
- **托盘图标**：点击系统托盘图标

### 基本操作

| 操作 | 说明 |
|------|------|
| `↑` / `↓` | 在搜索结果中上下移动 |
| `Enter` | 打开选中的应用/功能 |
| `Esc` | 隐藏窗口 |
| `Ctrl + ,` | 打开设置 |

### 功能切换

在搜索框输入以下关键词快速切换功能：

- `cb` 或 `剪贴板` - 切换到剪贴板历史
- `pwd` 或 `密码` - 切换到密码管理器
- `note` 或 `笔记` - 切换到 Markdown 笔记
- `set` 或 `设置` - 打开设置

---

## 使用指南

### 应用启动器

1. 唤起应用后，直接输入应用名称（如 `chrome`）
2. 使用方向键选择要打开的应用
3. 按 `Enter` 启动

**高级技巧**：
- 输入 `vsc` 可匹配 `Visual Studio Code`
- 常用应用会自动排在搜索结果前面
- 配合 Everything 可搜索任意文件

### 剪贴板历史

1. 唤起应用，输入 `cb` 进入剪贴板模式
2. 搜索历史记录中的内容
3. 选中后按 `Enter` 自动粘贴到当前窗口

### 密码管理器

1. 首次使用需要设置主密码
2. 添加密码条目，填写网站/用户名/密码
3. 需要时搜索并复制密码到剪贴板

### Markdown 笔记

1. 输入 `note` 进入笔记模式
2. 点击新建按钮创建笔记
3. 使用 Markdown 语法编辑，实时预览效果

---

## 开发

### 环境要求

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://www.rust-lang.org/tools/install) 1.77+
- [npm](https://www.npmjs.com/) 或 [pnpm](https://pnpm.io/)

### 克隆仓库

```bash
git clone https://github.com/lhf2003/custom-tools.git
cd custom-tools
```

### 安装依赖

```bash
npm install
```

### 启动开发服务器

```bash
# 同时启动前端和后端（推荐）
npm run tauri:dev

# 仅启动前端开发服务器
npm run dev
```

### 构建生产版本

```bash
# 构建 Windows 安装包
npm run tauri:build
```

构建产物位于 `src-tauri/target/release/bundle/` 目录。

### 项目结构

```
├── src/                          # 前端代码 (React + TypeScript)
│   ├── modules/                  # 功能模块
│   │   ├── launcher/            # 应用启动器
│   │   ├── clipboard/           # 剪贴板历史
│   │   ├── password/            # 密码管理器
│   │   ├── markdown/            # Markdown 笔记
│   │   └── settings/            # 设置
│   ├── stores/                  # Zustand 状态管理
│   └── hooks/                   # React Hooks
│
├── src-tauri/                   # 后端代码 (Rust)
│   └── src/
│       ├── lib.rs               # 应用入口
│       ├── clipboard/           # 剪贴板监听
│       ├── password/            # 密码加密
│       ├── search/              # 应用搜索
│       ├── db/                  # SQLite 数据库
│       └── commands/            # Tauri 命令
│
└── docs/                        # 文档
```

---

## 技术栈

### 前端

- **框架**: [React 18](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/)
- **构建**: [Vite](https://vitejs.dev/)
- **样式**: [Tailwind CSS](https://tailwindcss.com/)
- **状态管理**: [Zustand](https://github.com/pmndrs/zustand)
- **图标**: [Lucide React](https://lucide.dev/)

### 后端

- **框架**: [Tauri 2.0](https://tauri.app/)
- **语言**: [Rust](https://www.rust-lang.org/)
- **异步运行时**: [Tokio](https://tokio.rs/)

### 核心技术

- **模糊搜索**: [nucleo](https://docs.rs/nucleo)
- **数据库**: [SQLite](https://www.sqlite.org/) (rusqlite)
- **加密**: AES-GCM + PBKDF2
- **文件监控**: [notify](https://docs.rs/notify)

---

## 路线图

- [x] 模糊搜索算法（nucleo 集成）
- [x] 使用频率追踪 + 自适应排序
- [x] 持久化缓存 + 文件监控
- [x] Everything 集成
- [x] 自动更新
- [ ] UWP 应用支持
- [ ] 自定义索引目录
- [ ] 插件系统
- [ ] 更多工具模块

查看完整路线图：[docs/roadmap.md](docs/roadmap.md)

---

## 贡献

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建功能分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 打开 Pull Request

---

## 许可证

本项目基于 [MIT](LICENSE) 许可证开源。

---

## 致谢

- [Tauri](https://tauri.app/) - 构建跨平台桌面应用的框架
- [uTools](https://u.tools/) - 灵感来源
- [PowerToys](https://github.com/microsoft/PowerToys) - 优秀的设计参考
- [Flow Launcher](https://github.com/Flow-Launcher/Flow.Launcher) - 搜索功能参考

---

<p align="center">
  Made with ❤️ by <a href="https://github.com/lhf2003">lhf2003</a>
</p>

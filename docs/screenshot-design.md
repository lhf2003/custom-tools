# 截图功能技术设计方案（微信风格）

> 基于 Tauri 2.0 + React + Canvas 的微信风格截图工具实现方案

## 1. 架构概述

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              前端 (React)                                │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │              截图遮罩窗口（每个显示器一个，复用）                     │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐ │  │
│  │  │  遮罩层渲染   │  │  窗口检测高亮 │  │      工具栏 (底部)        │ │  │
│  │  │  - 半透明遮罩 │  │  - 窗口边框   │  │  - 矩形/箭头/文字/马赛克  │ │  │
│  │  │  - 镂空选区   │  │  - 悬停高亮   │  │  - 保存/复制/取消         │ │  │
│  │  │  - 尺寸提示   │  │  - 点击选中   │  │  - OCR 识别              │ │  │
│  │  └──────────────┘  └──────────────┘  └──────────────────────────┘ │  │
│  │                           │                                        │  │
│  │                           ▼                                        │  │
│  │                  ┌─────────────────┐                              │  │
│  │                  │   选区交互逻辑   │                              │  │
│  │                  │  - 窗口自动检测  │                              │  │
│  │                  │  - 拖拽自定义区  │                              │  │
│  │                  │  - 选区调整     │                              │  │
│  │                  └─────────────────┘                              │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                   │                                     │
│                    ┌──────────────▼──────────────┐                     │
│                    │      截图状态管理          │  ← Zustand Store    │
│                    │    (screenshotStore)       │                     │
│                    └──────────────┬──────────────┘                     │
└───────────────────────────────────┼───────────────────────────────────┘
                                    │
┌───────────────────────────────────▼───────────────────────────────────┐
│                              后端 (Rust)                               │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │                        截图核心模块                                │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐│ │
│  │  │    xcap     │  │   窗口检测   │  │      图像处理工具         ││ │
│  │  │  - 屏幕捕获  │  │  - 窗口枚举  │  │  - 裁剪/压缩/base64编码   ││ │
│  │  │  - 窗口捕获  │  │  - 边界计算  │  │  - 保存到剪贴板目录       ││ │
│  │  └──────────────┘  └──────────────┘  └──────────────────────────┘│ │
│  └──────────────────────────────────────────────────────────────────┘ │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │                        OCR 模块 (复用 LLM)                        │ │
│  │  - 调用 Ollama 视觉模型 (llama3.2-vision/minicpm-v)              │ │
│  └──────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────┘
```

### 1.1 多显示器窗口模型

- **每个显示器预创建一个独立的遮罩窗口**（`screenshot-overlay-{monitor_id}`），初始状态为隐藏（`visible(false)`）
- 快捷键触发时，根据**鼠标当前所在显示器**，定位并显示对应的遮罩窗口
- 其余显示器的遮罩窗口保持隐藏
- 遮罩窗口关闭时不销毁（`hide()`），下次触发时直接复用，避免 Webview 初始化延迟

## 2. 交互流程（微信风格）

```
快捷键触发 (Ctrl+Shift+X)
        │
        ▼
┌─────────────────────────────┐
│  定位鼠标所在显示器           │
│  显示对应遮罩窗口             │  ← 预创建窗口，直接 show()
└───────────┬─────────────────┘
            │
            ▼
┌─────────────────────────────┐
│  异步捕获该显示器背景图       │  ← 后台 spawn，不阻塞窗口显示
│  捕获完成后推送到前端渲染     │
└───────────┬─────────────────┘
            │
            ▼
┌─────────────────────────────┐
│  鼠标移动检测窗口             │
│  实时计算鼠标位置下的窗口      │
│                             │
│  ┌─────────┐                │
│  │ 命中窗口? │                │
│  └────┬────┘                │
│     是/否                   │
│    /    \                  │
│   ▼      ▼                  │
│ 绘制高亮  无高亮             │  ← 显示窗口边框（蓝色/绿色）
│ 边框     边框               │
└───────────┬─────────────────┘
            │
            ▼
┌─────────────────────────────┐
│           用户操作           │
│                             │
│  ┌─────────┐                │
│  │ 点击窗口? │ ──> 选中该窗口区域 │
│  └────┬────┘                │
│     是/否                   │
│    /    \                  │
│   ▼      ▼                  │
│ 窗口截图  继续检测/拖拽       │
└───────────┬─────────────────┘
            │
            ▼
┌─────────────────────────────┐
│         拖拽选区?            │ ──> 自定义区域截图
│                             │
│  显示选区边框 + 尺寸提示      │
│  支持调整大小/位置            │
└───────────┬─────────────────┘
            │
            ▼
┌─────────────────────────────┐
│          选中区域后          │
│                             │
│  ┌─────────┐                │
│  │ 显示工具栏 │                │  ← 底部悬浮工具栏
│  └────┬────┘                │
│       │                     │
│   保存/复制                  │
│   标注/OCR                  │
│   取消/退出                 │
└───────────┬─────────────────┘
            │
            ▼
┌─────────────────────────────┐
│    保存/复制（Enter/Ctrl+C） │
│                             │
│  1. 前端立即隐藏遮罩窗口      │  ← 提升感知性能
│  2. 立即显示成功 Toast        │
│  3. 后端异步完成：            │
│     - 从临时背景图裁剪        │  ← 避免重新调用 xcap
│     - 保存到文件              │
│     - 复制到剪贴板            │
│     - 清理临时背景图文件      │
└─────────────────────────────┘
```

## 3. 技术选型

| 组件 | 技术方案 | 选型理由 |
|------|---------|---------|
| **后端截图** | `xcap` | 跨平台屏幕/窗口捕获；作为无背景图时的回退方案 |
| **窗口检测** | Rust xcap + 实时边界计算 | 获取所有窗口位置，前端计算命中 |
| **遮罩窗口** | Tauri 透明窗口 + HTML5 Canvas | 每个显示器一个独立窗口，灵活绘制，响应鼠标事件 |
| **高亮边框** | Canvas 2D 绘制 | 实时渲染，性能可控 |
| **标注编辑** | Canvas 2D | 矩形/箭头/文字绘制 |
| **全局快捷键** | `tauri-plugin-global-shortcut` | 已集成，截图专用快捷键 Ctrl+Shift+X |
| **图像处理** | Rust `image` crate | 已在项目依赖中，支持裁剪和格式转换 |

## 4. 数据模型

### 4.1 窗口信息结构

```rust
/// 窗口边界信息（用于前端检测和高亮）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowBounds {
    pub id: u64,              // 窗口 ID
    pub title: String,        // 窗口标题
    pub app_name: String,     // 应用名称
    pub x: i32,               // 左上角 X
    pub y: i32,               // 左上角 Y
    pub width: u32,           // 宽度
    pub height: u32,          // 高度
    pub is_minimized: bool,   // 是否最小化
}

/// 选区信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Selection {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub source: SelectionSource,  // 选区来源
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SelectionSource {
    Window { window_id: u64, title: String },  // 点击窗口选中
    Region,                                     // 拖拽自定义区域
}
```

### 4.2 截图结果

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenshotResult {
    pub filename: String,
    pub filepath: String,
    pub width: u32,
    pub height: u32,
    pub mode: ScreenshotMode,
}
```

### 4.3 TypeScript 类型

```typescript
interface WindowBounds {
  id: number;
  title: string;
  appName: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Selection {
  x: number;
  y: number;
  width: number;
  height: number;
  source: { type: 'window'; windowId: number; title: string } | { type: 'region' };
}

interface ScreenshotResult {
  filename: string;
  filepath: string;
  width: number;
  height: number;
}
```

## 5. API 接口

### 5.1 窗口检测

| 命令 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `get_all_windows` | - | `Vec<WindowBounds>` | 获取所有可见窗口边界 |
| `get_window_at_point` | `x: i32, y: i32` | `Option<WindowBounds>` | 获取指定坐标下的最顶层窗口 |

### 5.2 截图命令

| 命令 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `capture_region` | `x, y, width, height, background_image_path?, monitor_x?, monitor_y?` | `ScreenshotResult` | 捕获指定区域；若提供 `background_image_path` 则优先从临时背景图裁剪，避免重新调用 xcap |
| `save_and_copy_screenshot` | `x, y, width, height, background_image_path?, monitor_x?, monitor_y?, cleanup_background?` | `ScreenshotResult` | 合并命令：裁剪 → 保存 → 复制到剪贴板 → 清理临时文件；减少 IPC 往返 |
| `capture_window` | `window_id: u64` | `ScreenshotResult` | 捕获指定窗口（备用） |
| `capture_full_screen` | - | `ScreenshotResult` | 全屏截图（备用） |

### 5.3 辅助命令

| 命令 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `screenshot_to_base64` | `filepath: String` | `String` | 图片转 base64 |
| `ocr_screenshot` | `filepath: String, prompt?, model?` | `String` | OCR 文字识别 |
| `cleanup_overlay_background` | `filepath: String` | `()` | 清理遮罩层临时背景图文件 |

### 5.4 遮罩窗口事件

| 事件名 | Payload | 说明 |
|--------|---------|------|
| `screenshot-overlay-monitor` | `{ x, y, width, height, scaleFactor }` | 窗口显示时触发，通知前端显示器信息 |
| `screenshot-overlay-background` | `String`（文件路径） | 异步背景图捕获完成后触发 |

## 6. 前端状态管理

```typescript
interface ScreenshotOverlayState {
  // 窗口状态
  isVisible: boolean;
  allWindows: WindowBounds[];
  hoveredWindow: WindowBounds | null;
  selectedRegion: Selection | null;

  // 显示器信息
  monitorOffset: { x: number; y: number };
  scaleFactor: number;
  backgroundImage: HTMLImageElement | null;

  // 交互状态
  isDragging: boolean;
  dragStart: { x: number; y: number } | null;
  dragCurrent: { x: number; y: number } | null;

  // 编辑状态
  editMode: 'none' | 'rect' | 'arrow' | 'text' | 'mosaic';
  drawElements: DrawElement[];

  // 操作方法
  hideOverlay: () => Promise<void>;
  closeOverlay: () => Promise<void>;
  captureSelection: () => Promise<void>;
}
```

## 7. 用户界面设计

### 7.1 遮罩层视觉效果

```
┌─────────────────────────────────────────────────────────────────┐
│  ┌─────────────────────────────────────────────────────────┐   │
│  │█████████████████████████████████████████████████████████│   │
│  │█████████████████████████████████████████████████████████│   │
│  │█████████████████┌───────────────────┐███████████████████│   │
│  │█████████████████│                   │███████████████████│   │
│  │█████████████████│   窗口区域（透明）  │███████████████████│   │
│  │█████████████████│   ┌───────────┐   │███████████████████│   │
│  │█████████████████│   │ 尺寸提示   │   │███████████████████│   │
│  │█████████████████│   │ 800 x 600 │   │███████████████████│   │
│  │█████████████████│   └───────────┘   │███████████████████│   │
│  │█████████████████│                   │███████████████████│   │
│  │█████████████████└───────────────────┘███████████████████│   │
│  │█████████████████  ↑ 高亮边框（蓝色） ████████████████████│   │
│  │█████████████████████████████████████████████████████████│   │
│  │█████████████████████████████████████████████████████████│   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                │
│         ┌────┬────┬────┬────┬────┬────┬────┐                  │
│         │ ✓  │ ▭  │ →  │ T  │ ▦  │ 👁  │ ✕  │                  │
│         │保存│矩形│箭头│文字│马赛克│聚光灯│取消│                  │
│         └────┴────┴────┴────┴────┴────┴────┘                  │
│                     ↑ 底部工具栏                                │
└─────────────────────────────────────────────────────────────────┘
        ↑ 半透明遮罩（rgba(0,0,0,0.5)）
```

### 7.2 状态样式

| 状态 | 边框颜色 | 遮罩透明度 | 说明 |
|-----|---------|-----------|------|
| 空闲 | - | 50% | 仅半透明遮罩 |
| 悬停窗口 | `#00D26A` (绿色) | 50% | 显示窗口边框 |
| 选中窗口 | `#0099FF` (蓝色) | 50% | 固定显示选中区域 |
| 拖拽选区 | `#FF9500` (橙色) | 50% | 实时显示拖拽区域 |
| 选中区域 | `#0099FF` (蓝色) | 50% | 固定显示选区，显示工具栏 |

## 8. 组件设计

### 8.1 组件结构

```
src/modules/screenshot/
├── index.tsx                    # 模块入口
├── overlay/
│   ├── index.tsx                # 遮罩窗口 React 挂载点（独立 HTML entry）
│   ├── ScreenshotOverlay.tsx    # 主遮罩组件（含 Canvas、交互、工具栏）
│   └── overlay.css              # 遮罩层专用样式
├── hooks/
│   └── (内部 hooks)              # 窗口检测、选区交互、Canvas 绘制
└── stores/
    └── screenshotStore.ts       # 截图状态管理（Zustand）
```

### 8.2 ScreenshotOverlay 核心逻辑

```typescript
// 事件驱动的初始化（窗口复用时重置状态）
useEffect(() => {
  const unlistenMonitor = listen('screenshot-overlay-monitor', (event) => {
    resetState();
    setMonitorOffset({ x: event.payload.x, y: event.payload.y });
    setScaleFactor(event.payload.scaleFactor);

    // 并行获取窗口列表
    invoke('get_all_windows').then(setWindows);
  });

  const unlistenBackground = listen('screenshot-overlay-background', (event) => {
    const img = new Image();
    img.onload = () => setBackgroundImage(img);
    img.src = `file://${event.payload}`;
  });

  return () => {
    unlistenMonitor.then((f) => f());
    unlistenBackground.then((f) => f());
  };
}, [resetState]);
```

## 9. 快捷键设计

| 快捷键 | 功能 | 说明 |
|-------|-----|------|
| `Ctrl+Shift+X` | 唤起截图 | 全局快捷键，定位到鼠标所在显示器 |
| `Esc` | 取消/退出 | 隐藏遮罩窗口，保留预创建实例 |
| `Enter` | 确认截图 | 选中区域后确认，立即保存并隐藏窗口 |
| `Ctrl + S` | 保存 | 保存到文件（同 Enter） |
| `Ctrl + C` | 复制 | 复制到剪贴板 |
| `Ctrl + Z` | 撤销 | 撤销上一步标注 |

## 10. 性能优化设计

### 10.1 启动优化（A+B+C 方案）

| 优化项 | 方案 | 效果 |
|--------|------|------|
| **预创建窗口** | 应用启动时预创建遮罩窗口并隐藏 | 避免快捷键触发时初始化 Webview 的延迟 |
| **异步背景捕获** | 先 `show()` 窗口，再后台 `spawn` 捕获屏幕 | 用户几乎瞬间看到遮罩层 |
| **窗口复用** | 关闭时用 `hide()` 而非 `close()` | 下次触发直接复用 |
| **延迟获取窗口列表** | `get_all_windows` 与窗口显示并行执行 | 不阻塞首帧渲染 |
| **序列号防竞态** | `OVERLAY_BG_SEQ` 原子计数器 | 快速连按快捷键时丢弃过期的背景图结果 |

### 10.2 保存优化

| 优化项 | 方案 | 效果 |
|--------|------|------|
| **复用临时背景图** | `capture_region` 接收 `background_image_path`，优先从本地 PNG 裁剪 | 跳过 `xcap` 重新捕获（省 100~300ms） |
| **合并命令** | `save_and_copy_screenshot` 合并保存+剪贴板复制 | 减少一次 IPC 往返 |
| **异步剪贴板** | `copy_file_to_clipboard` 放入 `tokio::task::spawn_blocking` | 避免阻塞 async runtime |
| **先隐藏后保存** | 前端立即 `hideOverlay()` + Toast，后端异步完成保存 | 用户感知延迟 < 50ms |

## 11. 实施计划

### 阶段 1：基础遮罩和窗口检测
- [x] 预创建遮罩窗口（隐藏），支持窗口复用
- [x] 实现异步背景捕获 + 事件驱动渲染
- [x] 创建 `ScreenshotOverlay` 遮罩组件
- [x] 实现窗口检测逻辑（鼠标位置 → 窗口命中）
- [x] Canvas 绘制半透明遮罩 + 窗口高亮边框
- [x] 添加快捷键绑定（Ctrl+Shift+X）
- [x] ESC 键隐藏遮罩窗口

### 阶段 2：选区交互
- [x] 实现点击窗口选中
- [x] 实现拖拽自定义选区
- [x] 选区尺寸实时提示
- [x] 支持选区调整和取消

### 阶段 3：截图和保存（已优化）
- [x] `capture_region` 支持 `background_image_path` 快速裁剪
- [x] 新增 `save_and_copy_screenshot` 合并命令
- [x] 前端"先隐藏后异步保存"交互模式
- [x] 保存到剪贴板图片目录
- [x] 复制到系统剪贴板
- [] 截图成功提示 (Toast 通知)

### 阶段 4：标注工具
- [x] 底部工具栏 UI (保存/复制/矩形/箭头/文字/OCR/取消)
- [x] 矩形标注绘制
- [x] 箭头标注绘制
- [ ] 文字标注输入框交互优化 (待完善)
- [ ] 马赛克/聚光灯效果 (待实现)
- [ ] 撤销/重做功能 (待实现)

### 阶段 5：OCR 集成
- [x] 截图后 OCR 识别
- [x] 识别结果弹窗
- [x] 复制识别文字到剪贴板

### 阶段 6：多显示器支持
- [ ] 为每个显示器预创建独立遮罩窗口
- [ ] 鼠标跨显示器移动时自动切换活跃遮罩窗口
- [ ] 支持跨显示器拖拽选区

## 12. 关键代码示例

### 12.1 窗口检测算法

```rust
/// 获取鼠标位置下的最顶层窗口
#[tauri::command]
pub fn get_window_at_point(x: i32, y: i32) -> Option<WindowBounds> {
    let windows = get_all_windows_internal().ok()?;

    windows
        .into_iter()
        .filter(|w| !w.is_minimized)
        .find(|w| {
            x >= w.x
                && x < w.x + w.width as i32
                && y >= w.y
                && y < w.y + w.height as i32
        })
}
```

### 12.2 复用临时背景图裁剪

```rust
pub async fn capture_region(
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    background_image_path: Option<String>,
    monitor_x: Option<i32>,
    monitor_y: Option<i32>,
    app_handle: tauri::AppHandle,
) -> Result<ScreenshotResult, String> {
    let cropped_image = if let Some(bg_path) = background_image_path {
        let img = image::open(&bg_path)?;
        let base_x = monitor_x.unwrap_or(0);
        let base_y = monitor_y.unwrap_or(0);
        let relative_x = (x - base_x).max(0) as u32;
        let relative_y = (y - base_y).max(0) as u32;
        image::DynamicImage::ImageRgba8(
            img.into_rgba8()
                .view(relative_x, relative_y, width, height)
                .to_image()
        )
    } else {
        // 回退：使用 xcap 重新捕获
        capture_monitor_and_crop(x, y, width, height).await?
    };
    // ... 保存并返回结果
}
```

### 12.3 前端异步保存模式

```typescript
const captureSelection = async () => {
  const region = stateRef.current.selectedRegion;
  if (!region) return;

  // 立即隐藏窗口并反馈成功
  hideOverlay();
  addToast({ type: 'success', title: '截图已保存', duration: 3000 });

  try {
    await invoke('save_and_copy_screenshot', {
      x: region.x,
      y: region.y,
      width: region.width,
      height: region.height,
      backgroundImagePath: backgroundPathRef.current || undefined,
      monitorX: monitorOffset.x,
      monitorY: monitorOffset.y,
      cleanupBackground: !!backgroundPathRef.current,
    });
  } catch (error) {
    addToast({ type: 'error', title: '截图保存失败', message: String(error) });
  }
};
```

## 13. 注意事项

1. **多显示器支持**：当前每个快捷键触发只显示鼠标所在显示器的遮罩窗口；未来计划为每个显示器预创建独立窗口
2. **DPI 缩放**：Windows DPI 缩放通过 `scaleFactor` 处理，Canvas 绘制时进行坐标转换
3. **性能优化**：窗口检测在 `mousemove` 中实时计算，已通过 React state 最小化更新
4. **Z 序问题**：某些窗口可能无法被 xcap 检测到，需要测试兼容性
5. **快捷键冲突**：避免与系统或其他应用快捷键冲突
6. **临时文件管理**：`save_and_copy_screenshot` 内部负责清理临时背景图，防止文件堆积

## 14. 已知问题与待完善

### 当前阶段已知问题
- [ ] 某些窗口（如 UWP 应用）可能无法被正确检测

### 待完善功能
- [ ] 文字标注输入框交互优化
- [ ] 马赛克/聚光灯效果
- [ ] 撤销/重做功能
- [ ] 截图历史记录
- [ ] 双击截全屏
- [ ] 右键取消选区
- [ ] 多显示器独立遮罩窗口完整实现

---

**文档版本**: 2.3  
**更新日期**: 2026-04-15  
**变更说明**: 
- 更新为每个显示器一个独立遮罩窗口的架构设计（预创建、复用）
- 补充异步背景捕获、事件驱动渲染、序列号防竞态等性能优化细节
- 更新 `capture_region` 和 `save_and_copy_screenshot` API 设计
- 补充前端"先隐藏后异步保存"的交互模式说明
- 拆分阶段 6 "多显示器支持"作为后续升级方向

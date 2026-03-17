# 搜索功能实现文档

## 架构概览

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   React Frontend│◄───►│  Tauri Commands  │◄───►│  Rust Backend   │
│                 │     │  (IPC Bridge)    │     │                 │
└─────────────────┘     └──────────────────┘     │  - Indexer      │
                                                 │  - Search       │
                                                 │  - File Watcher │
                                                 └─────────────────┘
```

## 当前实现

### 前端层

#### useSearch Hook (`src/hooks/useSearch.ts`)
```typescript
interface UseSearchReturn {
  apps: AppItem[];           // 搜索结果
  isLoading: boolean;        // 索引加载状态
  searchApps: (query: string) => Promise<void>;
  refreshApps: () => Promise<void>;
  launchApp: (path: string) => Promise<void>;
}
```

**防抖策略**: 150ms
```typescript
useEffect(() => {
  const timer = setTimeout(() => {
    searchApps(searchQuery);
  }, 150);
  return () => clearTimeout(timer);
}, [searchQuery, searchApps]);
```

### 后端层

#### SearchIndex (`src-tauri/src/search/mod.rs`)

**索引来源**:
| 位置 | 路径 | 优先级 |
|------|------|--------|
| 系统开始菜单 | `C:\ProgramData\Microsoft\Windows\Start Menu\Programs` | P0 |
| 用户开始菜单 | `%USERPROFILE%\AppData\Roaming\Microsoft\Windows\Start Menu\Programs` | P0 |
| 桌面快捷方式 | `%USERPROFILE%\Desktop` | P0 |
| Registry (待实现) | `HKEY_*\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall` | P4 |
| UWP 应用 (待实现) | `PackageManager` API | P4 |

**模糊匹配实现**:
```rust
use nucleo::pattern::{CaseMatching, Normalization, Pattern};

pub fn search(&self, query: &str) -> Vec<AppItem> {
    let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);
    let mut matcher = nucleo::Matcher::new(nucleo::Config::DEFAULT);

    // 匹配并排序...
}
```

## 算法说明

### nucleo 匹配特性

1. **CaseMatching::Smart**
   - 输入全小写: 不区分大小写匹配
   - 输入含大写: 严格大小写匹配

2. **Normalization::Smart**
   - 智能处理 Unicode 规范化
   - 适合多语言环境

3. **评分机制**
   - 连续字符匹配分数更高
   - 词首匹配分数更高
   - 完全匹配分数最高

### 示例匹配

| 输入 | 匹配结果 | 分数 |
|------|----------|------|
| `vsc` | Visual Studio Code | 高 |
| `vsc` | VS Code | 高 |
| `vscode` | Visual Studio Code | 最高 |
| `code` | Visual Studio Code | 中 |
| `wx` | 微信 | 低（需拼音支持）|

## API 接口

### Commands

#### `search_apps`
```rust
#[tauri::command]
pub fn search_apps(
    query: String,
    state: tauri::State<'_, SearchState>
) -> Result<Vec<AppItem>, String>
```

**参数**:
- `query`: 搜索关键词，空字符串返回全部

**返回**:
- 匹配的应用列表，按匹配分数降序

#### `refresh_apps`
```rust
#[tauri::command]
pub fn refresh_apps(
    state: tauri::State<'_, SearchState>
) -> Result<(), String>
```

**说明**: 强制重新扫描目录，重建索引

#### `launch_app`
```rust
#[tauri::command]
pub fn launch_app(path: String) -> Result<(), String>
```

**参数**:
- `path`: 快捷方式(.lnk)的完整路径

**实现**:
```rust
Command::new("cmd")
    .args(["/c", "start", "", path])
    .spawn()?;
```

#### `extract_app_icon`
```rust
#[tauri::command]
pub async fn extract_app_icon(path: String) -> Result<Option<String>, String>
```

**返回**: Base64 编码的图标 PNG 数据

## 性能指标

### 当前基准

| 指标 | 当前值 | 目标值 |
|------|--------|--------|
| 索引 1000 个应用 | ~500ms | ~200ms |
| 搜索响应 | ~10ms | ~5ms |
| 内存占用 | ~30MB | ~50MB |
| 冷启动恢复 | N/A (无缓存) | ~100ms |

### 优化方向

1. **并行扫描**: 使用 `rayon` crate
2. **缓存持久化**: SQLite + bincode
3. **图标懒加载**: 按需提取和缓存

## 调试技巧

### 查看索引日志
```rust
log::info!("Indexed {} applications", self.apps.len());
```

### 测试搜索算法
```rust
#[test]
fn test_fuzzy_search() {
    let index = SearchIndex::new();
    // ... 添加测试数据
    let results = index.search("vsc");
    assert!(results.iter().any(|a| a.name.contains("Visual Studio")));
}
```

### 性能分析
```bash
# 编译时优化
cargo build --release

# 查看二进制大小
cargo bloat --release
```

## 常见问题

### Q: 为什么有些应用搜索不到？
A: 检查以下几点：
1. 是否在 Start Menu 或 Desktop 目录
2. 是否为 `.lnk` 快捷方式
3. 是否被去重逻辑过滤（同名同路径）

### Q: 如何添加自定义搜索路径？
A: 当前版本需修改源码。P4 阶段将支持用户配置。

### Q: 搜索结果显示太慢？
A: 检查：
1. 索引是否完成（首次启动需要扫描）
2. 是否有大量应用（>5000）
3. 是否启用图标提取（可禁用）

## 更新日志

### 2024-03-16
- ✅ 集成 nucleo 模糊匹配
- ✅ 实现智能大小写匹配
- ✅ 按匹配分数排序

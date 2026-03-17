# 图标提取优化验证指南

## 方法 1：快速验证（命令行）

### 1. 构建项目
```bash
cd D:/workspace/custom-tools
npm run build
```

### 2. 检查编译输出
确认没有错误，只有警告（如未使用变量等）。

---

## 方法 2：运行时验证

### 1. 启动应用
```bash
cd D:/workspace/custom-tools/src-tauri
cargo run
```

### 2. 观察图标加载
- 打开启动器（Ctrl+Shift+Space）
- 查看最近使用中的应用图标
- 应该能看到清晰的 48x48 图标

### 3. 验证缓存生成
```powershell
# 查看磁盘缓存目录
ls "$env:LOCALAPPDATA\custom-tools\icon-cache"

# 应该能看到 .png 文件生成
# 文件名格式：{xxhash3}.png
```

---

## 方法 3：日志验证（推荐）

### 1. 修改日志级别
在 `src-tauri/src/main.rs` 中：
```rust
// 修改日志级别为 Debug
.level(log::LevelFilter::Debug)
```

### 2. 重新运行
```bash
cargo run 2>&1 | grep -i "icon\|cache"
```

### 3. 预期日志输出
```
[INFO] Indexed 150 applications
[DEBUG] Extracting icon: C:\...\Chrome.lnk
[DEBUG] Icon disk cache hit: C:\...\Chrome.lnk
[DEBUG] Icon memory cache hit: C:\...\Chrome.lnk
```

---

## 方法 4：性能对比测试

### 测试脚本
```rust
// 在 src-tauri/src/search/icon.rs 底部添加测试
#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn test_icon_performance() {
        let test_path = r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Chrome.lnk";

        // 第一次：冷缓存
        let start = Instant::now();
        let _ = extract_icon(test_path).unwrap();
        let cold_time = start.elapsed();
        println!("Cold cache: {:?}", cold_time);

        // 第二次：热缓存
        let start = Instant::now();
        let _ = extract_icon(test_path).unwrap();
        let hot_time = start.elapsed();
        println!("Hot cache: {:?}", hot_time);

        // 热缓存应该快 10 倍以上
        assert!(hot_time < cold_time / 10);
    }
}
```

运行测试：
```bash
cargo test test_icon_performance -- --nocapture
```

---

## 方法 5：缓存统计验证

### 添加调试命令
在 `src-tauri/src/commands/search.rs` 中添加：

```rust
#[tauri::command]
pub fn get_icon_cache_stats() -> Result<CacheStats, String> {
    crate::search::icon::get_cache_stats()
        .map_err(|e| e.to_string())
}
```

在 `lib.rs` 中注册命令：
```rust
commands::search::get_icon_cache_stats,
```

前端调用测试：
```typescript
// 在浏览器控制台或 React 组件中
import { invoke } from '@tauri-apps/api/core';

const stats = await invoke('get_icon_cache_stats');
console.log('Icon cache stats:', stats);
// 输出: { disk_file_count: 45, disk_total_size_bytes: 51200, memory_cached_count: 12 }
```

---

## 验证清单

### 功能验证
- [ ] 应用启动后能看到应用图标
- [ ] 图标清晰无锯齿（48x48）
- [ ] 磁盘缓存目录有 .png 文件生成
- [ ] 重启应用后图标加载更快

### 性能验证
- [ ] 冷加载（首次）< 10ms
- [ ] 内存缓存命中 < 0.1ms
- [ ] 磁盘缓存命中 < 2ms

### 缓存验证
- [ ] 缓存文件生成在 `%LOCALAPPDATA%/custom-tools/icon-cache/`
- [ ] 缓存文件名是 16 位十六进制（xxhash3）
- [ ] 7 天后缓存自动过期

---

## 常见问题排查

### 图标不显示
1. 检查日志是否有 `Extracting icon` 输出
2. 确认目标路径存在：`ls "C:\...\App.lnk"`
3. 检查缓存目录权限

### 缓存不命中
1. 确认文件修改时间稳定
2. 检查路径哈希计算是否正确
3. 查看日志是否有 `cache hit`

### 性能无提升
1. 确保是第二次加载才测试
2. 检查是否每次路径都变化
3. 确认内存缓存未溢出（LRU 100 条）

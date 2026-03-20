# 应用搜索优化路线图

## 已完成

### P0: 模糊搜索算法升级 ✅
- **状态**: 已完成
- **实现**: 集成 `nucleo` 模糊匹配库
- **特性**:
  - 模糊匹配（如 `vsc` 匹配 `Visual Studio Code`）
  - 智能大小写处理
  - 按匹配质量分数排序

---

## 待实施阶段

### P5: 性能优化
**优先级**: 低
**预估工作量**: 1 天

#### 目标
优化大规模索引下的内存和性能。

#### 技术方案
1. **内存优化**
   - 图标懒加载
   - 应用列表分页
   - 大索引压缩存储

2. **索引优化**
   - 使用 `rayon` 并行扫描
   - 排除目录配置（如 `node_modules`, `.git`）
   - 索引压缩（`rkyv` 零拷贝序列化）

3. **构建优化**
   - Release 模式启用 LTO
   - 优化包大小

#### 验收标准
- [ ] 10,000 个应用索引内存 < 100MB
- [ ] 索引 10,000 个应用时间 < 2 秒
- [ ] Release 构建大小 < 20MB

---

## 已完成

### P4: 索引范围扩展 ✅
**状态**: 已完成
**实现**: winreg 注册表扫描 + PowerShell Get-StartApps UWP 枚举 + 自定义目录配置

**特性**:
- 注册表扫描三个 Uninstall hive（HKLM 64/32位 + HKCU），过滤系统组件和更新包
- UWP 应用通过 Get-StartApps 枚举，explorer.exe 启动
- 用户可在设置 → 搜索 Tab 中添加/删除自定义扫描目录
- 三个来源均与现有 Start Menu 扫描去重合并，统一参与 nucleo 模糊搜索

**实现时间**: 2026-03-20

---

### P3: Everything 集成 ✅
**状态**: 已完成
**实现**: 调用 `es.exe` CLI，CSV 输出解析，无窗口进程

**特性**:
- Everything 运行时自动启用，未安装时不影响现有功能
- 文件搜索响应 < 50ms
- 支持 bundled 安装目录及多系统路径检测
- 文件类型过滤（排除 .lnk/.exe，由应用启动器处理）

**实现时间**: 2026-03-20

---

### P2: 持久化缓存 + 文件监控 ✅
**状态**: 已完成
**实现**: SQLite 普通表持久化（替代 FTS5）+ `notify` crate 文件监控

**特性**:
- 冷启动从 `app_cache` 表恢复索引，无需重新扫描磁盘
- `notify` crate 监控 Start Menu 和 Desktop 目录
- 500ms 防抖批量处理，增量更新（非全量重建）
- 卸载软件后自动从索引移除（软删除 + 内存同步）

> 注：原方案为 FTS5 虚拟表，实际采用普通表 + 内存 nucleo 搜索，目标等价

**实现时间**: 2026-03-20

---

### P1: 使用频率追踪 + 自适应排序 ✅
**状态**: 已完成
**实现**: `app_usage` 表记录启动/搜索次数，`search_with_frequency()` 加权排序

**特性**:
- 启动应用后排名提升（`launch_count` + 指数衰减时间加成）
- 空查询时按最近使用排序
- 排序权重：模糊匹配分 × 0.7 + 频率加成 × 0.3
- 数据持久化到 SQLite，`search_count` 独立追踪

**实现时间**: 2026-03-20

---

### 中文拼音搜索 ✅
**状态**: 已实现
**实现**: 集成 `rust-pinyin` crate 进行首字母转换

**特性**:
- 支持拼音首字母搜索（如 `wx` 匹配 `微信`）
- 索引时预计算拼音，搜索时零开销
- 与 nucleo 模糊匹配完美结合
- 同时支持中文拼音和英文缩写混合搜索

**实现时间**: 2026-03-19

---

## 参考资源

- [nucleo 文档](https://docs.rs/nucleo)
- [notify 文档](https://docs.rs/notify)
- [Everything SDK](https://www.voidtools.com/support/everything/sdk/)
- [Flow Launcher 源码](https://github.com/Flow-Launcher/Flow.Launcher)
- [PowerToys Run 源码](https://github.com/microsoft/PowerToys)

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

### P1: 使用频率追踪 + 自适应排序
**优先级**: 高
**预估工作量**: 1-2 天

#### 目标
根据用户的使用频率和最近使用情况，动态调整搜索结果排序。

#### 技术方案
1. **数据库表设计**
   ```sql
   CREATE TABLE app_usage (
       path TEXT PRIMARY KEY,
       launch_count INTEGER DEFAULT 0,
       last_launch INTEGER,  -- timestamp
       search_count INTEGER DEFAULT 0
   );
   ```

2. **Hook 点**
   - 在 `launch_app()` 成功时 +1 `launch_count`
   - 更新 `last_launch` 时间戳
   - 在 `search_apps()` 被调用时 +1 `search_count`

3. **排序算法**
   ```rust
   total_score = base_match_score * 0.6 + frequency_bonus * 0.3 + recency_bonus * 0.1
   ```

4. **接口已就绪**
   - `search_with_frequency()` 方法已在代码中预留

#### 验收标准
- [x] 启动应用后，该应用在搜索结果中的排名提升
- [x] 最近使用的应用获得额外加成
- [x] 数据持久化到 SQLite
- [x] 搜索次数追踪（search_count）

---

### P2: 持久化缓存 + 文件监控
**优先级**: 中
**预估工作量**: 2-3 天

#### 目标
- 减少启动时的索引时间
- 实时检测应用安装/卸载

#### 技术方案
1. **SQLite + FTS5 全文索引**
   ```sql
   CREATE VIRTUAL TABLE apps USING fts5(
       name,
       path,
       tokenize='porter'
   );
   ```

2. **文件监控 (`notify` crate)**
   - 监控 Start Menu 和 Desktop 目录
   - 300-500ms 防抖批量处理变更
   - 增量更新索引（非全量重建）

3. **双索引策略**
   - 内存索引：用于快速搜索
   - 磁盘缓存：用于快速启动恢复

#### 验收标准
- [ ] 冷启动时从缓存恢复索引 < 200ms
- [ ] 安装新软件后 1 秒内自动出现在搜索结果
- [ ] 卸载软件后自动从索引移除

---

### P3: Everything 集成
**优先级**: 低
**预估工作量**: 1 天

#### 目标
为已安装 Everything 的用户提供极速文件搜索能力。

#### 技术方案
1. **检测 Everything 是否运行**
   - 检查 `Everything.exe` 进程
   - 尝试连接 Everything SDK

2. **集成方式**
   - 方案 A: 调用 `es.exe` CLI
   - 方案 B: 使用 Everything SDK DLL (via FFI)

3. **搜索范围扩展**
   - 不仅搜索应用，还可搜索任意文件
   - 需添加文件类型过滤

#### 验收标准
- [ ] Everything 运行时自动启用
- [ ] 文件搜索响应 < 50ms
- [ ] 无 Everything 时不影响现有功能

---

### P4: 索引范围扩展
**优先级**: 中
**预估工作量**: 2 天

#### 目标
支持更多类型的应用程序。

#### 技术方案
1. **Registry 扫描**
   - 读取 `HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`
   - 读取 `HKEY_CURRENT_USER` 对应路径
   - 解析 `DisplayName` 和 `InstallLocation`

2. **UWP 应用支持**
   - 使用 Windows `PackageManager` API
   - 解析 `AppxManifest.xml`
   - 提取应用名称和图标

3. **自定义目录**
   - 允许用户配置额外的扫描路径
   - 设置界面添加路径管理

#### 验收标准
- [ ] 能搜索到 UWP 应用（如 Microsoft Store 应用）
- [ ] 能搜索到注册表中记录的绿色软件
- [ ] 用户可自定义扫描目录

---

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

## 决策待定

### 中文拼音搜索
**问题**: 是否支持拼音首字母搜索（如 `wx` 匹配 `微信`）？

**选项**:
- A: 集成 `pinyin` crate 进行转换
- B: 使用预计算的拼音索引
- C: 暂不支持，观察用户反馈

**建议**: 暂缓，P1-P3 完成后再评估。

---

## 参考资源

- [nucleo 文档](https://docs.rs/nucleo)
- [notify 文档](https://docs.rs/notify)
- [Everything SDK](https://www.voidtools.com/support/everything/sdk/)
- [Flow Launcher 源码](https://github.com/Flow-Launcher/Flow.Launcher)
- [PowerToys Run 源码](https://github.com/microsoft/PowerToys)

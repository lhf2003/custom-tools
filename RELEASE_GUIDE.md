# 自动发布指南

## 配置 GitHub Secrets

在使用自动发布前，需要先配置私钥到 GitHub Secrets：

### 1. 获取私钥内容

在 PowerShell 中运行：

```powershell
Get-Content "C:\Users\23851\.tauri\custom-tools" -Raw
```

复制输出的内容（以 `dW50cnVzdGVkIGNvbW1lbnQ6` 开头的那一长串）。

### 2. 添加到 GitHub Secrets

1. 打开 GitHub 仓库页面：https://github.com/lhf2003/custom-tools
2. 点击 **Settings** → **Secrets and variables** → **Actions**
3. 点击 **New repository secret**
4. 添加以下 Secret：

| Name | Value |
|------|-------|
| `TAURI_SIGNING_PRIVATE_KEY` | 粘贴刚才复制的私钥内容 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 留空（如果没有密码） |

### 3. 发布新版本

配置完成后，发布新版本只需两步：

```bash
# 1. 提交代码
git add .
git commit -m "feat: xxx 功能"
git push

# 2. 打标签触发自动构建
git tag v0.1.1
git push origin v0.1.1
```

然后等待 GitHub Actions 自动完成：
- 构建应用
- 签名安装包
- 生成 latest.json
- 创建 Release 并上传文件

### 4. 检查发布状态

1. 打开 https://github.com/lhf2003/custom-tools/actions
2. 查看工作流运行状态
3. 成功后打开 https://github.com/lhf2003/custom-tools/releases 查看发布的版本

### 5. 发布 Draft

GitHub Actions 创建的是 Draft Release（草稿），你需要：
1. 打开 Release 页面
2. 编辑 Release 添加更新说明
3. 点击 **Publish release** 正式发布

发布后，已安装旧版本的用户会自动收到更新提示！

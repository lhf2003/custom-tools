import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { RefreshCw } from 'lucide-react';
import { useUpdater } from '@/hooks/useUpdater';
import { useToastStore } from '@/stores/toastStore';
import { SettingGroup, SettingRow } from '../components/SettingsPrimitives';
import { ChangelogModal } from '../components/ChangelogModal';

const TECH_STACK = ['Tauri 2.0', 'Rust', 'React 18', 'TypeScript', 'Vite', 'Tailwind CSS', 'SQLite', 'nucleo'];

export function AboutSettings() {
  const [version, setVersion] = useState('');
  const [showChangelog, setShowChangelog] = useState(false);
  const { addToast } = useToastStore();
  const {
    updateInfo,
    isChecking,
    isDownloading,
    downloadProgress,
    checkForUpdate,
    downloadAndInstall,
  } = useUpdater();

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(''));
  }, []);

  // 已是最新/失败用 toast 反馈；发现更新则由行内状态切换为「立即更新」
  const handleCheckUpdate = async () => {
    try {
      const result = await checkForUpdate();
      if (!result) {
        addToast({ type: 'success', title: '已是最新版本', duration: 3000 });
      }
    } catch {
      addToast({
        type: 'error',
        title: '检查更新失败',
        message: '网络连接错误或更新服务不可用，请稍后重试',
        duration: 4000,
      });
    }
  };

  return (
    <>
      {/* 品牌区：居中 logo + 名称 + 版本 + 定位（对齐 Raycast About） */}
      <div className="flex flex-col items-center px-3 pt-3 pb-6">
        <img src="/favicon.svg" alt="FlowHub Logo" className="w-16 h-16 rounded-2xl mb-3" />
        <h3 className="text-app-text-primary text-lg font-semibold">FlowHub</h3>
        <p className="text-app-text-tertiary text-xs mt-1">
          {version ? `版本 ${version}` : '版本读取中…'}
        </p>
        <p className="text-app-text-disabled text-xs mt-0.5">Windows 效率启动器</p>
      </div>

      <SettingGroup title="更新">
        <SettingRow
          title="应用更新"
          description={version ? `当前版本 v${version}` : '正在读取版本…'}
        >
          {isDownloading ? (
            <span className="flex items-center gap-1.5 text-xs text-app-text-tertiary">
              <RefreshCw size={12} className="animate-spin" />
              下载中 {downloadProgress}%
            </span>
          ) : updateInfo ? (
            <>
              <span className="text-xs text-app-status-success">
                发现新版本 v{updateInfo.version}
              </span>
              <button
                onClick={downloadAndInstall}
                className="px-3 py-1.5 rounded-lg text-xs text-white bg-app-status-info hover:bg-blue-700 transition-colors cursor-pointer"
              >
                立即更新
              </button>
            </>
          ) : (
            <button
              onClick={handleCheckUpdate}
              disabled={isChecking}
              className="px-3 py-1.5 rounded-lg text-xs text-app-text-tertiary hover:bg-white/10 hover:text-app-text-primary transition-colors cursor-pointer disabled:opacity-50 disabled:hover:bg-transparent"
            >
              {isChecking ? '检查中…' : '检查更新'}
            </button>
          )}
        </SettingRow>
        <SettingRow title="更新日志" description="查看历史版本的功能与修复记录">
          <button
            onClick={() => setShowChangelog(true)}
            className="px-3 py-1.5 rounded-lg text-xs text-app-text-tertiary hover:bg-white/10 hover:text-app-text-primary transition-colors cursor-pointer"
          >
            查看
          </button>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="关于本应用">
        <p className="px-3 py-3 text-app-text-tertiary text-xs leading-relaxed">
          FlowHub 是一款面向 Windows 的效率工具启动器，提供应用模糊搜索、剪贴板历史、
          密码管理、Markdown 笔记、文件搜索、JSON 格式化和 AI 对话等功能，旨在让日常操作更快捷流畅。
        </p>
      </SettingGroup>

      <SettingGroup title="技术栈">
        <div className="px-3 py-3 flex flex-wrap gap-2">
          {TECH_STACK.map((tech) => (
            <span
              key={tech}
              className="px-2.5 py-1 text-xs rounded-md bg-white/5 text-app-text-tertiary"
            >
              {tech}
            </span>
          ))}
        </div>
      </SettingGroup>

      <SettingGroup title="隐私声明">
        <p className="px-3 py-3 text-app-text-tertiary text-xs leading-relaxed">
          本应用所有数据（剪贴板历史、密码、笔记、AI 配置）均仅存储在本地，不会上传至任何服务器。
          AI 功能需要用户自行配置第三方大模型接口密钥。
        </p>
      </SettingGroup>

      <ChangelogModal isOpen={showChangelog} onClose={() => setShowChangelog(false)} />
    </>
  );
}

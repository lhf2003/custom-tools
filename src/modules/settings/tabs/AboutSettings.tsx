import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { SettingGroup } from '../components/SettingsPrimitives';

const TECH_STACK = ['Tauri 2.0', 'Rust', 'React 18', 'TypeScript', 'Vite', 'Tailwind CSS', 'SQLite', 'nucleo'];

export function AboutSettings() {
  const [version, setVersion] = useState('');

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(''));
  }, []);

  return (
    <>
      {/* 应用信息 */}
      <div className="flex items-center gap-4 px-3 mb-6">
        <div className="w-14 h-14 rounded-2xl flex items-center justify-center flex-shrink-0 overflow-hidden">
          <img src="/favicon.svg" alt="FlowHub Logo" className="w-full h-full" />
        </div>
        <div>
          <h3 className="text-app-text-primary text-base font-semibold">FlowHub</h3>
          <p className="text-app-text-tertiary text-xs mt-0.5">
            {version ? `版本 ${version}` : '版本读取中…'}
          </p>
          <p className="text-app-text-disabled text-xs mt-1">Windows 效率启动器</p>
        </div>
      </div>

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
    </>
  );
}

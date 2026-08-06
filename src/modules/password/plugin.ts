import { Folder, Lock, Plus } from 'lucide-react';
import type { MenuItem } from '@/types';
import type { ViewPlugin } from '@/plugins/types';

function usePasswordMenuItems(): MenuItem[] {
  return [
    {
      id: 'new-entry',
      label: '新增密码',
      icon: Plus,
      onClick: () => {
        window.dispatchEvent(new CustomEvent('password:new-entry'));
      },
    },
    {
      id: 'new-category',
      label: '新建分类',
      icon: Folder,
      onClick: () => {
        window.dispatchEvent(new CustomEvent('password:new-category'));
      },
    },
    {
      id: 'lock',
      label: '锁定保险库',
      icon: Lock,
      separator: true,
      onClick: () => {
        window.dispatchEvent(new CustomEvent('password:lock'));
      },
    },
  ];
}

const passwordPlugin: ViewPlugin = {
  kind: 'view',
  id: 'password',
  name: '密码管理',
  icon: Lock,
  aliases: ['password', 'pwd', 'vault'],
  description:
    '安全存储账号密码，使用AES-GCM加密保护。支持分类管理、快速复制，一键填充网站登录信息。',
  order: 5,
  shortcutModuleId: 'passwords',
  load: () => import('./PasswordView').then((m) => ({ default: m.PasswordView })),
  nav: {
    title: '密码保险库',
    useMenuItems: usePasswordMenuItems,
  },
};

export default passwordPlugin;

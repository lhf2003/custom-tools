import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from '@/stores/settingsStore';
import { SettingGroup, SettingRow, Toggle } from '../components/SettingsPrimitives';
import { CustomSelect } from '../components/CustomSelect';
import { DEFAULT_TARGET_LANG, TARGET_LANG_KEY, TARGET_LANG_OPTIONS } from '@/modules/translate/constants';

const clipboardKeepDaysOptions = [
  { value: '7', label: '7天' },
  { value: '30', label: '30天' },
  { value: '90', label: '90天' },
  { value: '0', label: '永久' },
];

/* ==================== 内置功能设置页 ==================== */

export function BuiltinSettings() {
  const {
    clipboard_keep_days,
    clipboard_auto_paste,
    setClipboardKeepDays,
    toggleClipboardAutoPaste,
  } = useSettingsStore();

  // 划词翻译目标语言（默认值；翻译视图下拉与其共用同一 KV）
  const [targetLang, setTargetLang] = useState(DEFAULT_TARGET_LANG);
  useEffect(() => {
    invoke<string | null>('get_setting', { key: TARGET_LANG_KEY })
      .then((v) => {
        if (v) setTargetLang(v);
      })
      .catch(() => {});
  }, []);

  return (
    <>
      <SettingGroup title="剪贴板">
        <SettingRow
          title="双击自动粘贴"
          description="双击剪贴板历史项后自动粘贴到光标所在位置"
        >
          <Toggle enabled={clipboard_auto_paste} onToggle={toggleClipboardAutoPaste} />
        </SettingRow>
        <SettingRow title="历史保存天数" description="超过此天数的历史将被自动清理（0=永久保存）">
          <CustomSelect
            value={String(clipboard_keep_days)}
            onChange={(v) => setClipboardKeepDays(Number(v))}
            options={clipboardKeepDaysOptions}
            className="min-w-[100px]"
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="翻译">
        <SettingRow title="目标语言" description="划词翻译的默认目标语言（翻译视图下拉可临时切换）">
          <CustomSelect
            value={targetLang}
            options={TARGET_LANG_OPTIONS.map((lang) => ({ value: lang, label: lang }))}
            onChange={(value) => {
              setTargetLang(value);
              invoke('set_setting', { key: TARGET_LANG_KEY, value }).catch((e: unknown) => {
                alert(`设置目标语言失败: ${e}`);
              });
            }}
            placeholder="目标语言"
            className="w-24"
            menuClassName="w-28"
          />
        </SettingRow>
      </SettingGroup>
    </>
  );
}

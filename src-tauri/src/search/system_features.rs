//! Windows 系统功能（ms-settings 设置页）静态清单。
//!
//! 与文件系统/注册表/UWP 来源不同，设置页不是"枚举"出来的——微软维护一份
//! 公开的 ms-settings URI 列表（约 150+ 条），启动器维护精选常用子集即可。
//! 同 PowerToys Run 的 WindowsSettings 插件思路，但作为启动器内置能力整合进
//! 索引，不依赖插件系统。
//!
//! 关键集成约定：
//! - 条目不写入 app_cache（静态清单无缓存意义），每次索引就绪后由
//!   SearchIndex::merge_system_features 合入内存；
//! - 唤起校验（verify_apps_on_disk）必须跳过 ms-settings: 前缀——
//!   `Path::new("ms-settings:display").exists()` 恒为 false，不跳过会被误删；
//! - 启动复用 launch_app 的 explorer.exe 通道（explorer 会激活设置应用）。

#[derive(Debug, Clone)]
pub struct SystemFeature {
    /// 显示名（中文，与系统 UI 语言一致）
    pub name: &'static str,
    /// ms-settings URI，如 "ms-settings:display"
    pub uri: &'static str,
}

/// 精选常用设置页（覆盖系统/网络/个性化/账户/应用/游戏/辅助功能/隐私/更新）。
/// URI 均为 Windows 11 官方 ms-settings 协议（Microsoft docs 公开列表）。
const SYSTEM_FEATURES: &[SystemFeature] = &[
    // ── 系统 ──
    SystemFeature { name: "显示设置", uri: "ms-settings:display" },
    SystemFeature { name: "声音设置", uri: "ms-settings:sound" },
    SystemFeature { name: "通知和操作", uri: "ms-settings:notifications" },
    SystemFeature { name: "专注助手", uri: "ms-settings:quiethours" },
    SystemFeature { name: "电源和睡眠", uri: "ms-settings:powersleep" },
    SystemFeature { name: "存储感知", uri: "ms-settings:storagesense" },
    SystemFeature { name: "剪贴板", uri: "ms-settings:clipboard" },
    SystemFeature { name: "手机连接", uri: "ms-settings:mobile-devices" },
    // ── 蓝牙和其他设备 ──
    SystemFeature { name: "蓝牙和其他设备", uri: "ms-settings:bluetooth" },
    SystemFeature { name: "打印机和扫描仪", uri: "ms-settings:printers" },
    SystemFeature { name: "鼠标", uri: "ms-settings:mousetouchpad" },
    SystemFeature { name: "触摸板", uri: "ms-settings:devices-touchpad" },
    SystemFeature { name: "输入法设置", uri: "ms-settings:typing" },
    SystemFeature { name: "USB 设置", uri: "ms-settings:usb" },
    // ── 网络和 Internet ──
    SystemFeature { name: "Wi-Fi 设置", uri: "ms-settings:network-wifi" },
    SystemFeature { name: "以太网设置", uri: "ms-settings:network-ethernet" },
    SystemFeature { name: "移动热点", uri: "ms-settings:network-mobilehotspot" },
    SystemFeature { name: "飞行模式", uri: "ms-settings:network-airplanemode" },
    SystemFeature { name: "VPN 设置", uri: "ms-settings:network-vpn" },
    SystemFeature { name: "代理设置", uri: "ms-settings:network-proxy" },
    // ── 个性化 ──
    SystemFeature { name: "个性化设置", uri: "ms-settings:personalization" },
    SystemFeature { name: "背景设置", uri: "ms-settings:personalization-background" },
    SystemFeature { name: "颜色设置", uri: "ms-settings:personalization-colors" },
    SystemFeature { name: "主题设置", uri: "ms-settings:themes" },
    SystemFeature { name: "锁屏设置", uri: "ms-settings:lockscreen" },
    SystemFeature { name: "任务栏设置", uri: "ms-settings:taskbar" },
    SystemFeature { name: "开始菜单设置", uri: "ms-settings:personalization-start" },
    // ── 账户 ──
    SystemFeature { name: "账户信息", uri: "ms-settings:yourinfo" },
    SystemFeature { name: "登录选项", uri: "ms-settings:signinoptions" },
    SystemFeature { name: "Windows Hello", uri: "ms-settings:signinoptions-windowshello" },
    SystemFeature { name: "同步设置", uri: "ms-settings:sync" },
    // ── 应用 ──
    SystemFeature { name: "已安装的应用", uri: "ms-settings:appsfeatures" },
    SystemFeature { name: "卸载应用", uri: "ms-settings:appsfeatures" },
    SystemFeature { name: "默认应用", uri: "ms-settings:defaultapps" },
    SystemFeature { name: "启动应用", uri: "ms-settings:startupapps" },
    SystemFeature { name: "可选功能", uri: "ms-settings:optionalfeatures" },
    // ── 游戏 ──
    SystemFeature { name: "游戏设置", uri: "ms-settings:gaming-gamebar" },
    SystemFeature { name: "游戏模式", uri: "ms-settings:gaming-gamemode" },
    // ── 时间和语言 ──
    SystemFeature { name: "日期和时间", uri: "ms-settings:dateandtime" },
    SystemFeature { name: "语言和区域", uri: "ms-settings:regionlanguage" },
    // ── 辅助功能 ──
    SystemFeature { name: "辅助功能", uri: "ms-settings:easeofaccess" },
    // ── 隐私和安全 ──
    SystemFeature { name: "隐私设置", uri: "ms-settings:privacy" },
    SystemFeature { name: "位置隐私", uri: "ms-settings:privacy-location" },
    SystemFeature { name: "相机隐私", uri: "ms-settings:privacy-webcam" },
    SystemFeature { name: "麦克风隐私", uri: "ms-settings:privacy-microphone" },
    SystemFeature { name: "Windows 安全中心", uri: "ms-settings:windowsdefender" },
    SystemFeature { name: "Windows 更新", uri: "ms-settings:windowsupdate" },
];

/// 返回设置页条目列表
pub fn scan() -> Vec<SystemFeature> {
    SYSTEM_FEATURES.to_vec()
}

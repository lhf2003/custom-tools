//! 网络环境指纹：场所感知（CASE-003）的底层识别。
//!
//! 指纹形如 "ssid:<SSID>"（Wi-Fi 连接时）或 "gwmac:<网关MAC>"（插网线/
//! 无无线网卡时兜底——家里与公司的路由器 MAC 天然不同）。
//! 原文只存本地 settings，按 D3 隐私裁决不进 LLM 上下文。

/// 当前网络环境指纹；都拿不到 → None（场所功能整体隐身，与天气降级同哲学）
pub fn current_fingerprint() -> Option<String> {
    wifi_ssid()
        .map(|s| format!("ssid:{}", s))
        .or_else(|| gateway_mac().map(|m| format!("gwmac:{}", m)))
}

#[cfg(windows)]
fn wifi_ssid() -> Option<String> {
    use windows::Win32::NetworkManagement::WiFi::{
        WlanCloseHandle, WlanEnumInterfaces, WlanFreeMemory, WlanOpenHandle, WlanQueryInterface,
        WLAN_CONNECTION_ATTRIBUTES, WLAN_INTERFACE_INFO_LIST,
    };

    unsafe {
        let mut negotiated = 0u32;
        let mut handle = std::mem::zeroed();
        // dwClientVersion=2（Vista+）；无无线网卡/服务未启动 → 非 0，落兜底
        if WlanOpenHandle(2, None, &mut negotiated, &mut handle) != 0 {
            return None;
        }
        let result = (|| {
            let mut list_ptr: *mut WLAN_INTERFACE_INFO_LIST = std::ptr::null_mut();
            if WlanEnumInterfaces(handle, None, &mut list_ptr) != 0 || list_ptr.is_null() {
                return None;
            }
            let list = &*list_ptr;
            let items = std::slice::from_raw_parts(
                list.InterfaceInfo.as_ptr(),
                list.dwNumberOfItems as usize,
            );
            let mut found = None;
            for info in items {
                let mut data_size = 0u32;
                let mut data_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
                if WlanQueryInterface(
                    handle,
                    &info.InterfaceGuid,
                    windows::Win32::NetworkManagement::WiFi::wlan_intf_opcode_current_connection,
                    None,
                    &mut data_size,
                    &mut data_ptr,
                    None,
                ) != 0
                    || data_ptr.is_null()
                {
                    continue;
                }
                let attrs = &*(data_ptr as *const WLAN_CONNECTION_ATTRIBUTES);
                let ssid = &attrs.wlanAssociationAttributes.dot11Ssid;
                let bytes = &ssid.ucSSID[..ssid.uSSIDLength as usize];
                if !bytes.is_empty() {
                    found = Some(String::from_utf8_lossy(bytes).to_string());
                }
                WlanFreeMemory(data_ptr);
                if found.is_some() {
                    break;
                }
            }
            WlanFreeMemory(list_ptr as *const _ as *mut _);
            found
        })();
        let _ = WlanCloseHandle(handle, None);
        result
    }
}

#[cfg(not(windows))]
fn wifi_ssid() -> Option<String> {
    None
}

/// 默认网关 MAC：GetIpForwardTable 找默认路由（0.0.0.0/0，metric 最小者）的下一跳，
/// GetIpNetTable 查对应 ARP 条目的物理地址（纯本地查询，不发包）
#[cfg(windows)]
fn gateway_mac() -> Option<String> {
    use windows::Win32::NetworkManagement::IpHelper::{
        GetIpForwardTable, GetIpNetTable, MIB_IPFORWARDTABLE, MIB_IPNETTABLE,
    };

    unsafe {
        let mut size = 0u32;
        let _ = GetIpForwardTable(None, &mut size, false);
        if size == 0 {
            return None;
        }
        let mut buf = vec![0u8; size as usize];
        let table = buf.as_mut_ptr() as *mut MIB_IPFORWARDTABLE;
        if GetIpForwardTable(Some(table), &mut size, false) != 0 {
            return None;
        }
        let t = &*table;
        let rows = std::slice::from_raw_parts(t.table.as_ptr(), t.dwNumEntries as usize);
        let gateway = rows
            .iter()
            .filter(|r| r.dwForwardDest == 0 && r.dwForwardMask == 0)
            .min_by_key(|r| r.dwForwardMetric1)
            .map(|r| r.dwForwardNextHop)?;
        if gateway == 0 {
            return None;
        }

        // 先查 ARP 表尺寸再分配
        let mut size = 0u32;
        let _ = GetIpNetTable(None, &mut size, false);
        if size == 0 {
            return None;
        }
        let mut buf = vec![0u8; size as usize];
        let table = buf.as_mut_ptr() as *mut MIB_IPNETTABLE;
        if GetIpNetTable(Some(table), &mut size, false) != 0 {
            return None;
        }
        let t = &*table;
        let rows =
            std::slice::from_raw_parts(t.table.as_ptr(), t.dwNumEntries as usize);
        rows.iter()
            .find(|r| r.dwAddr == gateway)
            .filter(|r| r.dwPhysAddrLen > 0)
            .map(|r| {
                r.bPhysAddr[..r.dwPhysAddrLen as usize]
                    .iter()
                    .map(|b| format!("{:02X}", b))
                    .collect::<Vec<_>>()
                    .join("-")
            })
    }
}

#[cfg(not(windows))]
fn gateway_mac() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    #[test]
    fn fingerprint_smoke() {
        // 开发机必有一种网络形态；CI 无网卡时允许 None——只验证不 panic
        let fp = super::current_fingerprint();
        if let Some(f) = &fp {
            assert!(f.starts_with("ssid:") || f.starts_with("gwmac:"));
        }
    }
}

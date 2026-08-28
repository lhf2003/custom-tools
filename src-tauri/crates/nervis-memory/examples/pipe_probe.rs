//! 管道逐字节探针：绕过 SidecarEmbedder/BufReader，裸 spawn + 裸 read 定位帧卡死
//! cargo run -p nervis-memory --example pipe_probe

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::Instant;

fn main() {
    let mut child = Command::new("python")
        .arg(r"D:\workspace\custom-tools\sidecar\wemm\server.py")
        .env("NERVIS_WEMM_MODEL_DIR", r"D:\workspace\custom-tools\spikes\wemm-local\models")
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn");
    let mut stdin = child.stdin.take().unwrap();
    // 关键变量：用 BufReader 包 stdout（与 SidecarEmbedder 一致）
    let mut stdout = std::io::BufReader::new(child.stdout.take().unwrap());

    // 裸读握手：loading + ready 两帧
    let mut handshake = Vec::new();
    let t0 = Instant::now();
    while handshake.len() < 77 {
        // loading 帧约 23B + ready 帧约 58B，读到两帧齐了为止
        let mut b = [0u8; 1];
        match stdout.read(&mut b) {
            Ok(0) => {
                eprintln!("[probe] EOF at {} bytes", handshake.len());
                break;
            }
            Ok(_) => handshake.push(b[0]),
            Err(e) => {
                eprintln!("[probe] read err: {e}");
                break;
            }
        }
        if t0.elapsed().as_secs() > 60 {
            eprintln!("[probe] handshake timeout, got {} bytes", handshake.len());
            break;
        }
    }
    eprintln!("[probe] handshake got {} bytes in {:?}", handshake.len(), t0.elapsed());

    // 发 ping
    let body = br#"{"type":"ping","req_id":1}"#;
    stdin.write_all(&(body.len() as u32).to_le_bytes()).unwrap();
    stdin.write_all(body).unwrap();
    stdin.flush().unwrap();
    eprintln!("[probe] ping sent, waiting resp...");

    // 逐字节读响应，超时 20s
    let t0 = Instant::now();
    let mut got = 0usize;
    let mut expected = usize::MAX;
    while t0.elapsed().as_secs() < 20 {
        let mut b = [0u8; 1];
        match stdout.read(&mut b) {
            Ok(0) => {
                eprintln!("[probe] EOF after {got} bytes");
                break;
            }
            Ok(_) => {
                got += 1;
                if got == 4 {
                    // 凑齐长度头
                    // （简化：直接按序读，响应 55B 左右）
                }
                if got >= 55 {
                    eprintln!("[probe] got {got} bytes, enough");
                    break;
                }
            }
            Err(e) => {
                eprintln!("[probe] resp read err after {got} bytes: {e}");
                break;
            }
        }
    }
    eprintln!("[probe] resp bytes={got} expected_overrun={}", expected == usize::MAX);
    let _ = child.kill();
}

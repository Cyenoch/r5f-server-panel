use super::{ROOT_ENV, data_root, profile};
use solid_gpui::RuntimeAdapter;
use solid_gpui::runtime::embedded::EmbeddedBunAdapter;
use std::sync::Arc;

fn start(entry: &str) -> Arc<EmbeddedBunAdapter> {
    EmbeddedBunAdapter::start_packaged(entry).unwrap_or_else(|error| {
        eprintln!("无法启动内嵌运行时：{error}");
        std::process::exit(1);
    })
}

/// Called by the final executable before any application threads are started.
pub fn run_packaged(app_entry: &str, worker_entry: &str) {
    let exe = std::env::current_exe().expect("application executable path");
    let root = exe.parent().expect("application directory");
    let args: Vec<String> = std::env::args().skip(1).collect();
    let worker_args = match args.first().map(String::as_str) {
        None => None,
        Some("--worker") => Some(&args[1..]),
        _ => {
            eprintln!("此程序是图形面板，请直接打开，不接受命令行操作。");
            std::process::exit(2);
        }
    };
    let data = data_root(root);
    let prefix = [exe.to_string_lossy().into_owned(), "--worker".to_owned()];
    // No Bun/GPUI owner thread exists yet; environment mutation is confined to startup.
    unsafe {
        std::env::set_var(ROOT_ENV, data);
        std::env::set_var("R5_SERVER_APP_ROOT", root);
        std::env::set_var("R5_SERVER_PACKAGED", "1");
        std::env::set_var(
            "R5_SERVER_DAEMON",
            serde_json::to_string(&prefix).expect("worker argv"),
        );
        match worker_args {
            Some(args) => std::env::set_var(
                "R5_SERVER_WORKER_ARGS",
                serde_json::to_string(args).expect("worker arguments"),
            ),
            None => std::env::remove_var("R5_SERVER_WORKER_ARGS"),
        }
    }
    if worker_args.is_some() {
        std::process::exit(run_worker(start(worker_entry)));
    }
    solid_gpui::run_application_with_profile(profile, start(app_entry));
}

/// Worker completion carries a full Windows exit code; Bun VM statuses alone are only u8.
fn run_worker(runtime: Arc<EmbeddedBunAdapter>) -> i32 {
    let mut result = None;
    loop {
        match runtime.recv_commit() {
            Ok(Some(payload)) => {
                if payload.len() != 8 || &payload[..4] != b"R5WX" || result.is_some() {
                    eprintln!("后台进程返回了无效的完成消息。");
                    let _ = runtime.shutdown();
                    return 1;
                }
                let code = u32::from_le_bytes(payload[4..].try_into().expect("exit code bytes"));
                match i32::try_from(code) {
                    Ok(code) => result = Some(code),
                    Err(_) => {
                        let _ = runtime.shutdown();
                        return 1;
                    }
                }
            }
            Ok(None) => break,
            Err(error) => {
                if result.is_none() {
                    eprintln!("后台进程运行失败：{error}");
                }
                break;
            }
        }
    }
    match (result, runtime.runtime_status()) {
        (Some(code), Some(status)) if status == i32::from(code != 0) => code,
        _ => {
            eprintln!("后台进程未正常完成。");
            1
        }
    }
}

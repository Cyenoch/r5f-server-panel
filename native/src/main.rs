//! R5Flowstate 服务端管理面板的原生宿主（solid-gpui）。
//!
//! 宿主只做三件事：开窗、选运行时、把**实例根目录**和 **CLI 入口**交给子进程。
//! 业务逻辑全在 Bun 里跑的 TS（`src/`），这里不注册任何 native module。
//!
//! 为什么用环境变量而不是 cwd：子进程的 cwd 由 Vite（开发）或启动方式（发布）决定，
//! 不能用来定位 `r5-server.json`；而 `r5-server.json` 是所有状态与版本目录的锚点。
//!
//! 平台差异（应用线程与栈、Windows 系统字族）由上游宿主入口负责：
//! `run_application_with_profile` 在应用线程上调用 profile 工厂，Windows 由
//! `host/launch.rs` 预留应用线程栈（默认 16 MiB，`SOLID_GPUI_APP_STACK_BYTES` 可覆盖），
//! 其余平台在主线程原地执行；`.SystemUIFont` 由平台文本系统解析，Windows 上取
//! `lfMessageFont`。这里不自己开线程、不改字体。

use solid_gpui::components::host::ComponentHost;
use solid_gpui::gpui::*;
use solid_gpui::{ProcessAdapter, RuntimeAdapter};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

/// 开发时这个 crate 在 `native/`，Vite 与实例根目录都在仓库根。
const DEV_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/..");
/// 发布时与宿主同级的 JS 包（`vite build` 的产物改名而来）。
const BUNDLE: &str = "r5-server-gui.js";
/// 与宿主同级的 CLI：日志守护（`__logd`）与脚本入口都由它承担。
#[cfg(windows)]
const CLI: &str = "r5-server.exe";

/// 子进程读取的实例根目录。
const ROOT_ENV: &str = "R5_SERVER_ROOT";
/// 子进程重新进入 CLI 的 argv 前缀（JSON 数组，含 bun 时的 `run <cli.tsx>` 也在里面）。
const DAEMON_ENV: &str = "R5_SERVER_DAEMON";

fn main() {
    let production = std::env::args().any(|arg| arg == "--production");
    let root = if production {
        std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(Path::to_path_buf))
            .unwrap_or_else(|| PathBuf::from("."))
    } else {
        PathBuf::from(DEV_ROOT)
    };

    // 与上游 `run_with_profile` 对齐：导出渲染端要用的原生契约（含 catalog digest），
    // 用来核对 JS 侧的 `components.ts` 是不是这个宿主编译出来的。
    // 只在这里把工厂求值一次，不起窗口、不起 runtime；参数判定用 `any` 而不是"恰好一个"，
    // 因为 Vite 插件把 `host.args` 放在 `--export-native` 之前。
    if std::env::args().any(|arg| arg == "--export-native") {
        use solid_gpui::host::HostProfile;
        print!("{}", profile().native_bindings().expect("native contract"));
        return;
    }

    let runtime = if production {
        production_runtime(&root)
    } else {
        development_runtime(&root)
    };
    // 应用线程、平台栈、panic hook、关闭与 runtime 收尾都由上游宿主接管。
    solid_gpui::run_application_with_profile(profile, runtime);
}

/// 宿主的 profile：组件目录 + 窗口尺寸 + 首帧之前必须落地的产品策略。
///
/// 这里必须是**工厂**（`FnOnce() -> ComponentHost + Send + 'static`）：profile 里有
/// `Rc`（native module 表、窗口选项闭包、初始化钩子），不是 `Send`；上游在应用线程上
/// 调用工厂，所以不能预先构造好再传进去，也不要包一层 `HostProfile` 转发。
fn profile() -> ComponentHost {
    ComponentHost::new(vec![solid_gpui::components::native_module()])
        .with_window_options(|_, cx| {
            let mut options = gpui_component::TitleBar::window_options();
            options.window_bounds = Some(WindowBounds::Windowed(Bounds::centered(
                None,
                size(px(1280.), px(820.)),
                cx,
            )));
            options.window_min_size = Some(size(px(1024.), px(680.)));
            options
        })
        // 性能监视器在所有构建里都默认关闭；显式写出来是为了说明这是产品策略，不是漏配。
        .with_performance_monitor(false)
        // 首帧之前必须设好的东西只能放在这个钩子里（它在组件主题初始化之后、开窗之前跑）。
        // JS 侧的 `setApplicationTheme` 是渲染之后的命令，救不了首帧。
        .with_initialize(|cx| {
            // 关掉装饰性动画：这是**产品决定** —— 运维面板上没有任何一处非动画不可。
            // `Reduced` 最终调用 `App::set_reduce_motion(true)`，动画直接跳过。
            // 注意：动效不是栈溢出的解法（上游 `docs/rust-bridge.md` 明确说明），
            // Windows 的栈由宿主入口负责，不要再把它当成栈的保护措施。
            let _ = solid_gpui::motion::set(solid_gpui::motion::MotionMode::Reduced, cx);
        })
}

/// 发布：`bun --conditions=browser r5-server-gui.js`。
fn production_runtime(root: &Path) -> Arc<dyn RuntimeAdapter> {
    let mut command = Command::new(bun_executable(root));
    command
        .arg("--conditions=browser")
        .arg(root.join(BUNDLE))
        .current_dir(root);
    export_instance_env(&mut command, root);
    ProcessAdapter::spawn(command).unwrap_or_else(|error| {
        eprintln!("无法启动 Bun 运行时（{}）：{error}", root.display());
        std::process::exit(1);
    })
}

/// 开发：交给 Vite 的模块通道；Vite 已经启动时这个 helper 会附加上去，不会再起一个服务。
fn development_runtime(root: &Path) -> Arc<dyn RuntimeAdapter> {
    let command = solid_gpui::runtime::vite::Vite::new(DEV_ROOT).command();
    let mut command = command.unwrap_or_else(|error| {
        eprintln!("无法准备 Vite 运行时：{error}");
        std::process::exit(1);
    });
    export_instance_env(&mut command, root);
    ProcessAdapter::spawn(command).unwrap_or_else(|error| {
        eprintln!("无法启动 Vite 运行时：{error}");
        std::process::exit(1);
    })
}

fn export_instance_env(command: &mut Command, root: &Path) {
    command
        .env(ROOT_ENV, root)
        // 括号是 JSON 数组而不是空格分隔：Windows 路径带空格，任何"自己拆"的方案都会错。
        .env(DAEMON_ENV, json_array(&daemon_prefix(root)));
}

/// Windows 发布包优先用编译 CLI；macOS 与模拟开发始终使用源码入口。
fn daemon_prefix(root: &Path) -> Vec<String> {
    #[cfg(windows)]
    if std::env::var("R5F_DEV").as_deref() != Ok("1") {
        let cli = root.join(CLI);
        if cli.is_file() {
            return vec![cli.to_string_lossy().into_owned()];
        }
    }
    vec![
        bun_executable(root),
        "run".to_owned(),
        root.join("src")
            .join("cli.tsx")
            .to_string_lossy()
            .into_owned(),
    ]
}

/// 先看宿主旁边有没有本平台的 Bun（便携部署），再退回 PATH。
fn bun_executable(root: &Path) -> String {
    let beside = root.join(if cfg!(windows) { "bun.exe" } else { "bun" });
    if beside.is_file() {
        return beside.to_string_lossy().into_owned();
    }
    "bun".to_owned()
}

fn json_array(values: &[String]) -> String {
    let mut out = String::from("[");
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push('"');
        for ch in value.chars() {
            match ch {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                ch if (ch as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", ch as u32)),
                ch => out.push(ch),
            }
        }
        out.push('"');
    }
    out.push(']');
    out
}

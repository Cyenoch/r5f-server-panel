//! R5Flowstate 服务端管理面板的原生宿主（solid-gpui）。
//!
//! 宿主只做三件事：开窗、选运行时、把**实例根目录**和 **CLI 入口**交给子进程。
//! 业务逻辑全在 Bun 里跑的 TS（`desktop/src`），这里不注册任何 native module。
//!
//! 为什么用环境变量而不是 cwd：子进程的 cwd 由 Vite（开发）或启动方式（发布）决定，
//! 不能用来定位 `r5-server.json`；而 `r5-server.json` 是所有状态与版本目录的锚点。

use solid_gpui::components::host::ComponentHost;
use solid_gpui::gpui::*;
use solid_gpui::host::{HostCapabilities, HostProfile};
use solid_gpui::{ExtensionRegistry, ProcessAdapter, RuntimeAdapter, SolidRoot};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::rc::Rc;
use std::sync::Arc;

/// 开发时这个 crate 在 `desktop/native`，实例根目录（放 `r5-server.json` 的那层）是仓库根。
const DEV_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
/// Vite 的根：`desktop/`。
const VITE_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/..");
/// 发布时与宿主同级的 JS 包（`vite build` 的产物改名而来）。
const BUNDLE: &str = "r5-server-gui.js";
/// 与宿主同级的 CLI：日志守护（`__logd`）与脚本入口都由它承担。
const CLI: &str = "r5-server.exe";

/// 子进程读取的实例根目录。
const ROOT_ENV: &str = "R5_SERVER_ROOT";
/// 子进程重新进入 CLI 的 argv 前缀（JSON 数组，含 bun 时的 `run <cli.tsx>` 也在里面）。
const DAEMON_ENV: &str = "R5_SERVER_DAEMON";

/// 面板用的界面字族。
///
/// gpui-component 的默认字族是 `.SystemUIFont`（macOS 的系统字体别名）。Windows 上这个名字
/// 解析不到任何字体，只能走 GPUI 的字体回落路径 —— 中文与等宽文本都会踩到。这里换成
/// 本机真实存在的字族（Win11 自带，且覆盖中英文）。
///
/// 注意：字体**不是**栈溢出的原因（见 `APP_STACK_BYTES` 的说明），只是本机部署的正确性问题。
const UI_FONT: &str = "Microsoft YaHei UI";

/// `ComponentHost` + 一处字族覆盖。
///
/// `ComponentHost` 的 builder 没有暴露 `HostProfile::initialize`，而字族必须在
/// 首帧之前设好（JS 侧的 `setApplicationTheme` 是渲染之后的命令，救不了首帧）。
struct AppHost(ComponentHost);

impl HostProfile for AppHost {
    fn native_bindings(&self) -> Result<String, String> {
        self.0.native_bindings()
    }

    fn window_options(&self, options: WindowOptions, cx: &App) -> WindowOptions {
        self.0.window_options(options, cx)
    }

    fn capabilities(&self) -> HostCapabilities {
        self.0.capabilities()
    }

    fn extension_registry(&self) -> Rc<dyn ExtensionRegistry> {
        self.0.extension_registry()
    }

    fn initialize(&mut self, cx: &mut App) {
        self.0.initialize(cx);
        gpui_component::Theme::global_mut(cx).font_family = UI_FONT.into();
        gpui_component::Theme::sync_base(cx);
        // 关掉装饰性动画：本机 vendored gpui 的过渡动画路径会深递归（Button / TabBar 必崩）。
        // `Reduced` 最终调用 `App::set_reduce_motion(true)`，动画直接跳过 —— 面板也不需要动效。
        // 这是**产品决定**，不是绕过：运维面板上没有任何一处非动画不可。
        let _ = solid_gpui::motion::set(solid_gpui::motion::MotionMode::Reduced, cx);
    }

    fn open_window(
        &self,
        options: WindowOptions,
        runtime: Arc<dyn RuntimeAdapter>,
        extensions: Rc<dyn ExtensionRegistry>,
        cx: &mut App,
    ) -> Result<(AnyWindowHandle, Entity<SolidRoot>), String> {
        self.0.open_window(options, runtime, extensions, cx)
    }

    fn restore_keybindings(&self, baseline: &[KeyBinding], dynamic: Vec<KeyBinding>, cx: &mut App) {
        self.0.restore_keybindings(baseline, dynamic, cx);
    }
}

fn main() {
    // GPUI 在 Windows 上不要求主线程（消息循环就在创建窗口的那个线程上跑），所以整个应用
    // 放到自建线程上执行，好给它一个足够大的栈 —— 默认 1 MiB 在本机不够。
    //
    // 为什么需要：本 pin 的 vendored gpui 在 Windows 上会走出很深的递归（布局 + 过渡动画两条
    // 路径都观察到过）。实测证据：`Button`/`TabBar` 这类带动画的控件必崩，复杂布局偶崩；
    // 关掉装饰动画（下方 `motion::set(Reduced)`）能消掉大部分触发点，剩下的深度靠这里的栈兜住。
    // 这不是掩盖问题：栈深本身是有限且稳定的（60 s 常驻 + 顶层/子路由切换实测无增长）。
    let worker = std::thread::Builder::new()
        .stack_size(APP_STACK_BYTES)
        .spawn(run_app)
        .expect("spawn app thread");
    worker.join().expect("app thread");
}

/// 应用线程的栈：默认 1 MiB 在本机不够用，给到 256 MiB。
const APP_STACK_BYTES: usize = 256 * 1024 * 1024;

fn run_app() {
    let production = std::env::args().any(|arg| arg == "--production");
    let root = if production {
        std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(Path::to_path_buf))
            .unwrap_or_else(|| PathBuf::from("."))
    } else {
        PathBuf::from(DEV_ROOT)
    };

    let profile = AppHost(
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
            .with_performance_monitor(false),
    );

    // 与上游 `run_with_profile` 对齐：导出渲染端要用的原生契约（含 catalog digest），
    // 用来核对 JS 侧的 `components.ts` 是不是这个宿主编译出来的。
    if std::env::args().any(|arg| arg == "--export-native") {
        use solid_gpui::host::HostProfile;
        print!("{}", profile.native_bindings().expect("native contract"));
        return;
    }

    let runtime = if production {
        production_runtime(&root)
    } else {
        development_runtime(&root)
    };
    solid_gpui::run_application_with_profile(profile, runtime);
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
    let command = solid_gpui::runtime::vite::Vite::new(VITE_ROOT).command();
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

/// 重新进入 CLI 所需的 argv 前缀：装了 `r5-server.exe` 就直接用，开发时退回 `bun run src/cli.tsx`。
fn daemon_prefix(root: &Path) -> Vec<String> {
    let cli = root.join(CLI);
    if cli.is_file() {
        return vec![cli.to_string_lossy().into_owned()];
    }
    vec![
        bun_executable(root),
        "run".to_owned(),
        root.join("src").join("cli.tsx").to_string_lossy().into_owned(),
    ]
}

/// 先看宿主旁边有没有 `bun.exe`（便携部署），再退回 PATH。
fn bun_executable(root: &Path) -> String {
    let beside = root.join("bun.exe");
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

//! Shared application profile; the host runs the app through Vite in development and preview,
//! and packaged builds embed both JS entry points.
use solid_gpui::ProcessAdapter;
use solid_gpui::components::host::ComponentHost;
use solid_gpui::gpui::*;
use std::path::{Path, PathBuf};

#[cfg(feature = "embedded")]
mod embedded;
#[cfg(feature = "embedded")]
pub use embedded::run_packaged;

/// 数据根（`r5-server.json`、版本目录、日志的父目录）。JS 侧只认这一个变量。
const ROOT_ENV: &str = "R5_SERVER_ROOT";
/// 程序目录。打包后 JS 跑在内存里的模块图上，`import.meta.url` 不再是磁盘位置，
/// 所以它必须由宿主明说（`src/paths.ts`）。
pub(crate) const APP_ROOT_ENV: &str = "R5_SERVER_APP_ROOT";
/// 重新进入内部 worker 的 argv 前缀（`src/tap.ts` 的 `workerCommand()` 唯一权威来源）。
pub(crate) const DAEMON_ENV: &str = "R5_SERVER_DAEMON";
/// 只有打包（嵌入式）成品才为 `1`：面板据此选传输，worker 据此选结果通道。
pub(crate) const PACKAGED_ENV: &str = "R5_SERVER_PACKAGED";
/// 打包宿主把 `--worker` 之后的参数镜像成 JSON 数组（嵌入运行看不到原始 argv）。
pub(crate) const WORKER_ARGS_ENV: &str = "R5_SERVER_WORKER_ARGS";

/// Construct on the GPUI application thread, before the first frame.
pub fn profile() -> ComponentHost {
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
        .with_performance_monitor(false)
        .with_initialize(|cx| {
            // Reduced motion is a product policy, not a substitute for the SDK's stack strategy.
            let _ = solid_gpui::motion::set(solid_gpui::motion::MotionMode::Reduced, cx);
        })
}

fn data_root(application_root: &Path) -> PathBuf {
    std::env::var_os(ROOT_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| application_root.to_path_buf())
}

/// 面板与内部 worker 共用的那组启动环境，两个宿主（Vite 运行时的 / 打包的）都只经过这里，
/// 免得"开发能跑、打包少一个变量"这类漂移。
///
/// 只在启动阶段调用：此时还没有 Bun 或 GPUI 线程会与它竞争；之后 spawn 的子进程自然继承。
fn export_environment(application_root: &Path, worker_prefix: &[String], packaged: bool) {
    unsafe {
        std::env::set_var(ROOT_ENV, data_root(application_root));
        std::env::set_var(APP_ROOT_ENV, application_root);
        std::env::set_var(
            DAEMON_ENV,
            serde_json::to_string(worker_prefix).expect("worker argv"),
        );
        // 不是打包成品就必须摘掉这个标记：它同时决定面板的传输（EmbeddedTransport）
        // 和 worker 的结果通道，继承来的脏值会让开发/预览误以为自己嵌在原生进程里。
        if packaged {
            std::env::set_var(PACKAGED_ENV, "1");
        } else {
            std::env::remove_var(PACKAGED_ENV);
        }
        // 参数镜像是"这一次调用"的，只由打包宿主的 `--worker` 分支设置。
        std::env::remove_var(WORKER_ARGS_ENV);
    }
}

/// 开发与预览共用的宿主入口。
///
/// 运行时命令来自 `solid_gpui::runtime::vite::Vite`，它自己区分三种形态：被 Vite 托管
/// （`SOLID_GPUI_VITE_RUNNER` 指向 Vite 的模块通道）、自起 Vite 开发服务器，以及
/// `solid-gpui preview` 预置的生产包 runner（`bun --conditions=browser <bundle>`）。
/// 三种形态下面板都是 stdio 子进程，环境与 worker 前缀完全一致。
///
/// 内部 worker 在开发/预览里就是**源码**：`bun run <仓库>/src/worker-entry.ts`。生产的
/// worker 包只有打包器知道（SDK 要求消费方从 `.solid-gpui/artifacts.json` 读路径，而不是
/// 在宿主里拼 target/dist 路径），所以这里不猜产物名 —— 打包成品走自己的 `--worker` 重入。
pub fn run_vite_runtime() {
    let root = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/.."));
    let command = solid_gpui::runtime::vite::Vite::new(root)
        .command()
        .unwrap_or_else(|error| {
            eprintln!("无法准备 Vite 运行时：{error}");
            std::process::exit(1);
        });
    // 解释器就是运行面板的那一个：托管开发、自起 Vite、预览 runner 都是 Bun。
    let worker = [
        command.get_program().to_string_lossy().into_owned(),
        "run".to_owned(),
        root.join("src/worker-entry.ts")
            .to_string_lossy()
            .into_owned(),
    ];
    export_environment(root, &worker, false);
    let runtime = ProcessAdapter::spawn(command).unwrap_or_else(|error| {
        eprintln!("无法启动 Vite 运行时：{error}");
        std::process::exit(1);
    });
    solid_gpui::run_application_with_profile(profile, runtime);
}

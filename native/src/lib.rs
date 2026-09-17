//! Shared application profile; development uses Vite, packaged builds embed both JS entry points.
use solid_gpui::ProcessAdapter;
use solid_gpui::components::host::ComponentHost;
use solid_gpui::gpui::*;
use std::path::{Path, PathBuf};

#[cfg(feature = "embedded")]
mod embedded;
#[cfg(feature = "embedded")]
pub use embedded::run_packaged;

const ROOT_ENV: &str = "R5_SERVER_ROOT";

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

pub fn run_development() {
    let root = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/.."));
    let mut command = solid_gpui::runtime::vite::Vite::new(root)
        .command()
        .unwrap_or_else(|error| {
            eprintln!("无法准备 Vite 运行时：{error}");
            std::process::exit(1);
        });
    let worker = [
        command.get_program().to_string_lossy().into_owned(),
        "run".to_owned(),
        root.join("src/worker-entry.ts")
            .to_string_lossy()
            .into_owned(),
    ];
    command
        .env(ROOT_ENV, data_root(root))
        .env("R5_SERVER_APP_ROOT", root)
        .env(
            "R5_SERVER_DAEMON",
            serde_json::to_string(&worker).expect("worker argv"),
        )
        .env_remove("R5_SERVER_PACKAGED")
        .env_remove("R5_SERVER_WORKER_ARGS");
    let runtime = ProcessAdapter::spawn(command).unwrap_or_else(|error| {
        eprintln!("无法启动 Vite 运行时：{error}");
        std::process::exit(1);
    });
    solid_gpui::run_application_with_profile(profile, runtime);
}

//! 开发 / 预览宿主：运行时由 `Vite` 决定（被 Vite 托管、自起开发服务器、或预览生产包）。
//!
//! 打包成品的入口不是这里：打包器用 `native/src/packaged-main.rs` 替换主入口，
//! 由它调用 `r5_server_gui::run_packaged`（嵌入式图上的两份 JS）。
//!
//! 参数只有一种用途：Vite 的 `prepare` 用 `--export-native` 取组件目录（生成
//! `src/generated/native.ts`）。除此之外这个宿主不接受命令行操作 —— 面板是图形程序，
//! 面向服主的入口只有它自己。
fn main() {
    if std::env::args().any(|arg| arg == "--export-native") {
        use solid_gpui::host::HostProfile;
        print!(
            "{}",
            r5_server_gui::profile()
                .native_bindings()
                .expect("native contract")
        );
        return;
    }
    if std::env::args().len() != 1 {
        eprintln!(
            "这是开发/预览宿主：请用 `bun run dev`（开发）或 `solid-gpui preview`（预览）启动。"
        );
        std::process::exit(2);
    }
    r5_server_gui::run_vite_runtime();
}

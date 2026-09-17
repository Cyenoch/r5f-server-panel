//! Development host only. The build command generates the single-file production entry.
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
        eprintln!("开发宿主请通过项目根目录的 bun run dev 启动。");
        std::process::exit(2);
    }
    r5_server_gui::run_development();
}

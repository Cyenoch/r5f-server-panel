// 打包后单文件发行版的进程入口。
//
// 这个文件不是 `r5-server-gui` 的编译单元：它由 `scripts/build.ts` 通过
// `application.main` 交给上游打包器，`include!` 进生成的 bin crate —— 只有在那个 crate
// 里，`BUN_EMBEDDED_ENTRY` 与 `BUN_EMBEDDED_WORKERS` 才存在（它们由打包器按序列化进镜像
// 的模块图写出，是**图里的真实键**，不是按文件名猜出来的路径）。放在 `src/` 下不会被
// 当成额外的 bin target，因为 Cargo 只自动识别 `src/main.rs` 与 `src/bin/*.rs`。
//
// 注释必须是普通 `//`：`include!` 把本文件插进生成的 `src/main.rs` 中间，`//!` 那种内部
// 文档注释在宏展开的位置非法（E0753）。
//
// 宿主行为全部在应用自己的库里：`run_packaged` 负责数据根、`--worker` 子进程约定、worker
// 完成码（完整 u32）与退出路径。这里只做一件事 —— 选出发给它的两个入口身份。

fn main() {
    r5_server_gui::run_packaged(BUN_EMBEDDED_ENTRY, packaged_worker());
}

// 与打包器一起序列化进镜像的唯一 worker 入口键。
//
// 镜像里恰好一个 worker 是这个应用的契约（开发态由宿主 `--worker` 起同一个入口）：少了
// 说明镜像不完整，多了说明有人加了第二个 `--workers` 而 `run_packaged` 只接受一个。两种
// 情况都直接报错退出，而不是挑一个「看起来对」的键 —— 运行期按键精确查找，猜错等于启动
// 失败，而且失败点会离原因很远。
fn packaged_worker() -> &'static str {
    let workers = BUN_EMBEDDED_WORKERS;
    match workers.len() {
        1 => workers[0],
        found => {
            eprintln!("镜像里序列化了 {found} 个 worker 入口，本应用需要且只需要 1 个。");
            std::process::exit(1);
        }
    }
}

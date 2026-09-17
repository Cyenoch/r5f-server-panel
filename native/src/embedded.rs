//! 打包（嵌入式）运行：一个可执行文件同时装下 GUI、内部 worker 和两份 JS 入口。
//!
//! 结果交回走 SDK 的公开完成结果 API：worker 用 `completeEmbedded` 声明完整 u32，这里读
//! `EmbeddedBunAdapter::result()`；VM 自己的退出码只有 u8，两者刻意分开（见 `worker_outcome`）。
use super::{WORKER_ARGS_ENV, export_environment, profile};
use solid_gpui::RuntimeAdapter;
use solid_gpui::runtime::embedded::{EmbeddedBunAdapter, EmbeddedResult};
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
    let prefix = [exe.to_string_lossy().into_owned(), "--worker".to_owned()];
    export_environment(root, &prefix, true);
    if let Some(args) = worker_args {
        // 只有打包宿主看得见 `--worker` 之后的原始 argv：嵌入运行里的 argv 不是那一份。
        unsafe {
            std::env::set_var(
                WORKER_ARGS_ENV,
                serde_json::to_string(args).expect("worker arguments"),
            );
        }
    }
    if worker_args.is_some() {
        std::process::exit(run_worker(start(worker_entry)));
    }
    solid_gpui::run_application_with_profile(profile, start(app_entry));
}

/// 一次 worker 会话告诉操作系统什么。
///
/// VM 的退出码只有一个字节，所以应用用 `@solid-gpui/core/embedded` 的完成结果声明真正的结果：
/// adapter 报全宽 `u32`，VM 状态仍只是"VM 是怎么退出的"。worker 入口**刻意**把两者配对
/// （`process.exit(code === 0 ? 0 : 1)`），所以一次落定的会话只可能是三种形状之一。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WorkerOutcome {
    /// 应用声明了这个结果，VM 也按声明的方式结束。
    Declared(u32),
    /// 应用声明了结果，但 VM 结束的方式与之不符。
    Inconsistent { declared: u32, status: Option<i32> },
    /// 会话结束前什么都没声明（启动失败 / 入口抛错 / 被终止）。
    Undeclared { status: Option<i32> },
}

/// worker 的终止策略：会话落定后的两个事实 → 结果。
///
/// 纯函数：生产路径（`run_worker`）与真实嵌入式运行时的测试都走这一份判断，签名里没有
/// 任何"测试开关"。
fn worker_outcome(result: Option<EmbeddedResult>, status: Option<i32>) -> WorkerOutcome {
    match result {
        // 配对只比较"是不是 0"，不把声明出来的码缩窄成 0/1。
        Some(EmbeddedResult { code }) if status == Some(i32::from(code != 0)) => {
            WorkerOutcome::Declared(code)
        }
        Some(EmbeddedResult { code }) => WorkerOutcome::Inconsistent {
            declared: code,
            status,
        },
        None => WorkerOutcome::Undeclared { status },
    }
}

impl WorkerOutcome {
    /// 交给操作系统的进程结果。
    ///
    /// 声明出来的码**原样**保留：`0xC0000409` 与 `0xffff_ffff` 在 Windows 上就是同 32 位的
    /// 退出码（`i32` 只是同一个位模式的另一种写法），不取模、不缩到 u8。POSIX 的 shell 只
    /// 保留低 8 位，那是操作系统的限制，不是这份策略的截断。失败一律 1 —— 与完成结果 API
    /// 之前的 worker 契约一致。
    fn exit_code(self) -> i32 {
        match self {
            WorkerOutcome::Declared(code) => code as i32,
            WorkerOutcome::Inconsistent { .. } | WorkerOutcome::Undeclared { .. } => 1,
        }
    }

    /// 需要写进 stderr 的说明；声明成功的会话没有可说的。
    fn diagnosis(self) -> Option<String> {
        match self {
            WorkerOutcome::Declared(_) => None,
            WorkerOutcome::Inconsistent { declared, status } => Some(format!(
                "内部 worker 声明了退出码 {declared}（0x{declared:08X}），但 VM 的结束状态是 {status:?}。"
            )),
            WorkerOutcome::Undeclared { status } => Some(format!(
                "内部 worker 没有声明退出码（VM 结束状态：{status:?}）。"
            )),
        }
    }
}

/// Worker completion carries a full u32; the VM's own exit status is one byte, so the declared
/// result is the only channel that survives 1223 (UAC cancellation) or 0xC0000409.
fn run_worker(runtime: Arc<EmbeddedBunAdapter>) -> i32 {
    let mut failure = None;
    loop {
        match runtime.recv_commit() {
            // worker 不渲染：提交帧意味着它用了不该用的传输（这正是旧实现放结果帧的位置）。
            Ok(Some(_frame)) => {
                eprintln!("内部 worker 提交了非预期的数据帧。");
                let _ = runtime.shutdown();
                return 1;
            }
            Ok(None) => break,
            // 会话落定后才会报错（非 0 的 VM 退出状态）。声明了结果的会话会走到这里，
            // 那是正常的失败结果，不该当成"运行失败"再报一次 —— 所以先只留着。
            Err(error) => {
                failure = Some(error.to_string());
                break;
            }
        }
    }
    let outcome = worker_outcome(runtime.result(), runtime.runtime_status());
    if let Some(diagnosis) = outcome.diagnosis() {
        eprintln!("{diagnosis}");
        if let Some(failure) = failure {
            eprintln!("内部 worker 运行失败：{failure}");
        }
    }
    outcome.exit_code()
}

#[cfg(test)]
mod tests {
    use super::*;
    use solid_gpui::RuntimeAdapter;
    use solid_gpui::runtime::embedded::CommitPoll;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    fn declared(code: u32) -> Option<EmbeddedResult> {
        Some(EmbeddedResult { code })
    }

    /// 策略本身：所有需要保留的码、两种不一致、以及"什么都没声明"。
    /// worker 入口真实的配对是 `process.exit(code === 0 ? 0 : 1)`。
    #[test]
    fn outcome_policy_keeps_the_declared_code_and_fails_closed() {
        for (code, status, expected) in [
            (0u32, 0, 0i32),
            (1, 1, 1),
            // UAC 取消：按字节截断会变成 199，正是这条契约要防的误报。
            (1223, 1, 1223),
            // STATUS_STACK_BUFFER_OVERRUN：> i32::MAX，i32 表示为负。
            (0xC000_0409, 1, -1_073_740_791),
            (0xffff_ffff, 1, -1),
        ] {
            let outcome = worker_outcome(declared(code), Some(status));
            assert_eq!(
                outcome,
                WorkerOutcome::Declared(code),
                "code {code} must be declared, not narrowed"
            );
            assert_eq!(outcome.exit_code(), expected, "code {code} exit result");
            assert_eq!(outcome.diagnosis(), None, "code {code} is a normal result");
        }

        for (code, status) in [(0u32, 1), (1223, 0), (7, 200)] {
            let outcome = worker_outcome(declared(code), Some(status));
            assert!(
                matches!(outcome, WorkerOutcome::Inconsistent { declared, .. } if declared == code),
                "code {code} with VM status {status} must be inconsistent"
            );
            assert_eq!(outcome.exit_code(), 1);
            assert!(outcome.diagnosis().is_some());
        }
        // 会话没落定（状态缺失）却有声明：同样不一致，不能拿它当结果。
        let unsettled = worker_outcome(declared(1223), None);
        assert_eq!(
            unsettled,
            WorkerOutcome::Inconsistent {
                declared: 1223,
                status: None
            }
        );
        assert_eq!(unsettled.exit_code(), 1);

        for status in [Some(0), Some(1), Some(-3), None] {
            let outcome = worker_outcome(None, status);
            assert_eq!(outcome, WorkerOutcome::Undeclared { status });
            assert_eq!(outcome.exit_code(), 1);
            assert!(outcome.diagnosis().is_some());
        }
    }

    /// 一次落定：返回 `recv_commit` 报出的失败信息（非 0 的 VM 退出状态会走到这里）。
    fn settle(runtime: &EmbeddedBunAdapter) -> Option<String> {
        loop {
            match runtime.recv_commit_timeout(Duration::from_secs(30)) {
                Ok(CommitPoll::Commit(_)) => continue,
                Ok(CommitPoll::Ended) => return None,
                Ok(CommitPoll::Timeout) => panic!("embedded session did not settle in 30s"),
                Err(error) => return Some(error.to_string()),
            }
        }
    }

    /// 一次性入口脚本：断言失败也把它删掉，不在仓库里留垃圾。
    struct Script(PathBuf);

    impl Script {
        /// 放在 `native/target` 下：cargo 的临时目录、已 gitignore，且从这里向上能找到仓库
        /// 根目录 `node_modules`，所以脚本 import 的就是安装好的公开包。名字带进程 id：
        /// 并发的 cargo 调用（不同测试进程）不能互相覆盖或删掉对方的脚本。
        fn write(name: &str, source: &str) -> Self {
            let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("target");
            fs::create_dir_all(&directory).expect("test scratch directory");
            let path = directory.join(format!("worker-result-{}-{name}.mjs", std::process::id()));
            fs::write(&path, source).expect("test entry script");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Script {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }

    fn session(script: &Script) -> Arc<EmbeddedBunAdapter> {
        EmbeddedBunAdapter::start(script.path()).expect("embedded disk session")
    }

    /// 真实嵌入式运行时：公开完成结果 API 声明的每个码都要原样出现在 adapter 的结果里，
    /// 并经 `worker_outcome` 得到同样的进程结果；没有声明的会话一律报失败（绝不悄悄当成 0），
    /// 被客户端拒绝的越界声明也不能占掉这次会话的结果位。
    ///
    /// 所有会话串在**一个**测试函数里：嵌入式引擎是进程级的，同一时刻只允许一次会话，
    /// 而 cargo 会并行跑测试函数 —— 两个这样的函数会撞成 `SessionActive`。
    #[test]
    fn declared_results_and_missing_results_on_the_real_runtime() {
        for (code, vm_status) in [(0u32, 0u8), (1223, 1), (0xC000_0409, 1), (0xffff_ffff, 1)] {
            let script = Script::write(
                &format!("{code:08x}"),
                &format!(
                    r#"import {{ completeEmbedded, supportsEmbeddedCompletion }} from "@solid-gpui/core/embedded";
if (!supportsEmbeddedCompletion()) throw new Error("the embedded host does not accept a typed completion result");
completeEmbedded({{ code: {code} }});
process.exit({vm_status});
"#
                ),
            );
            let runtime = session(&script);
            settle(&runtime);
            assert_eq!(
                runtime.result(),
                declared(code),
                "the declared code {code} must cross the ABI without truncation"
            );
            assert_eq!(
                runtime.runtime_status(),
                Some(i32::from(vm_status)),
                "the declared code must not replace the VM's own exit status"
            );
            let outcome = worker_outcome(runtime.result(), runtime.runtime_status());
            assert_eq!(outcome.exit_code(), code as i32);
            let _ = runtime.shutdown();
        }

        let throwing = Script::write(
            "throwing",
            r#"import "@solid-gpui/core/embedded";
throw new Error("worker entry failed before declaring a result");
"#,
        );
        let runtime = session(&throwing);
        let failure = settle(&runtime);
        assert!(
            failure.is_some(),
            "a failing entry must be reported through the session's commit path"
        );
        assert_eq!(runtime.result(), None);
        assert_eq!(
            worker_outcome(runtime.result(), runtime.runtime_status()).exit_code(),
            1
        );
        let _ = runtime.shutdown();

        // 脚本能走到 `completeEmbedded({ code: 1223 })` 才说明：公开包解析成功、越界码在
        // 客户端就被拒绝（没有落到宿主）、而且被拒绝的声明没有占掉结果位。
        let refused = Script::write(
            "refused-declaration",
            r#"import { completeEmbedded } from "@solid-gpui/core/embedded";
let refused = false;
try { completeEmbedded(-1); } catch (error) { refused = error instanceof TypeError; }
if (!refused) throw new Error("an out-of-range completion must be refused by the client API");
completeEmbedded({ code: 1223 });
process.exit(1);
"#,
        );
        let runtime = session(&refused);
        settle(&runtime);
        let outcome = worker_outcome(runtime.result(), runtime.runtime_status());
        assert_eq!(
            runtime.result(),
            declared(1223),
            "a refused declaration must leave the session free to declare its real result"
        );
        assert_eq!(outcome.exit_code(), 1223);
        let _ = runtime.shutdown();
    }
}

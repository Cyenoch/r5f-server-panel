/**
 * 记住面板上次停在哪一页。
 *
 * 面板是天天开着的运维工具：昨天在盯着实时日志、早上在改配置，重开时回到原处比回到首页顺手。
 * 存在 `r5-server.json` 的 `panelRoute` 里（工具自己的状态文件，CLI 不读这一项），
 * 不额外生成散落的小文件。
 */
import { loadState, withState } from "@server/state";

/** 上次的页面；没记过或格式不对就是首页。 */
export function rememberedRoute(): string {
  try {
    return loadState().panelRoute ?? "/";
  } catch {
    return "/";
  }
}

/**
 * 记下当前页面。写的是「读一遍再改一个字段」而不是整份覆写：
 * 面板开着的时候用户可能同时在命令行改了设置，别把那些改动冲掉。
 * 写不进去也不影响使用（下次从头开始），所以这里吞掉异常。
 */
export function rememberRoute(path: string): void {
  try {
    const fresh = loadState();
    if (fresh.panelRoute === path) return;
    withState(fresh, (disk) => {
      disk.panelRoute = path;
    });
  } catch {
    // 记不住不是错误：面板照常能用，只是下次回到首页。
  }
}

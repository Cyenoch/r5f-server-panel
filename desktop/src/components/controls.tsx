/**
 * 原生控件的安全包装层。
 *
 * 宿主对数据 props 走**严格 JSON**编码（`native.ts` 的 `encodeJson`）：顶层 props 的
 * `undefined` 会被丢掉，`style` 根本不走 JSON，但**数组/对象里的 `undefined` 会让它直接
 * 抛 `Native JSON contains an unsupported value`** —— 渲染器进程随即退出、窗口变白。
 *
 * `Select` 还多两条原生硬校验（同样实测：不满足就整块画不出来，宿主只回一行英文报错）：
 * 条目 key 必须非空且唯一，且传入的 `value` 必须正好等于某个条目的 key。
 * 清单是异步读来的、当前值又可能来自配置文件，两者对不上是很正常的状态 ——
 * 面板要能"显示成未选中"而不是黑屏，所以在这一层统一兜住。
 *
 * 页面不必各自记得这些 —— 这也是把 `Select` 统一从这里导出的原因。
 */
import { Select as NativeSelect } from "@solid-gpui/core/components";
import type { Choice, ChoiceGroup } from "@solid-gpui/core/components";

/** 一个选择项：只保留真正有值的可选字段。 */
function definedChoice(choice: Choice): Choice {
  const next: Choice = { key: choice.key, label: choice.label };
  if (choice.keywords) next.keywords = choice.keywords;
  if (choice.disabled !== undefined) next.disabled = choice.disabled;
  if (choice.description !== undefined) next.description = choice.description;
  if (choice.icon !== undefined) next.icon = choice.icon;
  return next;
}

export type SelectProps = Parameters<typeof NativeSelect>[0];

/**
 * 下拉选择。除了剔掉条目里的 `undefined`，行为与原生 `Select` 完全一致
 * （`value` 必须是某个条目 key，否则原生层拒渲染 —— 由页面保证）。
 */
export function Select(props: SelectProps) {
  const items: ChoiceGroup[] = [];
  const keys = new Set<string>();
  for (const group of props.items ?? []) {
    const choices: Choice[] = [];
    for (const choice of group.items) {
      if (choice.key.length === 0 || keys.has(choice.key)) continue; // 原生层要求 key 非空且唯一
      keys.add(choice.key);
      choices.push(definedChoice(choice));
    }
    if (choices.length === 0) continue;
    items.push({ key: group.key, items: choices, ...(group.label !== undefined ? { label: group.label } : {}) });
  }
  /*
   * 当前值不在清单里是常态：清单要读服务器目录（异步），而当前值可能来自配置文件里手填的内容。
   * 原生层硬性要求"选中的 key 必须在 items 里"，否则整块画不出来 ——
   * 所以补一条同名条目，界面显示的就是"现在的值"，用户也能看出它不来自清单。
   */
  const current = props.value;
  if (current !== undefined && current !== null && !keys.has(current)) {
    items.unshift({
      key: "__current__",
      items: [{ key: current, label: current, description: "当前值" }],
    });
  }
  return <NativeSelect {...props} items={items} />;
}

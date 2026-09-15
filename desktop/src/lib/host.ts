/**
 * 窗口句柄：`mountApplication` 的 `onMount` 交出 `Root`，而窗口标题这类能力
 * 只在 `Root` 上（不在 `useNative()` 的命令表里）。
 *
 * 单窗口应用，所以是一个模块级引用；多窗口时要改成按 surface 存。
 */
import type { Root } from "@solid-gpui/core";

let current: Root | null = null;

export function bindRoot(root: Root): void {
  current = root;
}

export function windowRoot(): Root | null {
  return current;
}

/** 设标题：拿不到 Root（还没挂载完）时静默跳过，不打断渲染。 */
export function setWindowTitle(title: string): void {
  if (!current) return;
  void current.setTitle(title).catch(() => {});
}

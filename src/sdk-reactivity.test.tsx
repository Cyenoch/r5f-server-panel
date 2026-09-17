/**
 * 面板 UI 路径对 SDK 的回归测试：**一份 Solid** 的信号必须同时驱动 SDK 的 effect、core 的
 * `<Text>` 与 generated 组件的响应式 prop，而且 `MemoryTransport` 上第一帧是 Snapshot、
 * 写信号之后是带着新内容的增量 Patch（重复发整份 Snapshot 不算更新）。
 *
 * 任何一条坏了，面板的表现都是「能渲染但永远不更新」：`solid-js` 装了第二份、或者解析到
 * server 构建时，信号不会通知渲染器（见 SDK `docs/troubleshooting.md`）。测试走公开的
 * `solid-gpui test` 运行器，用的是应用自己的 vite.config.ts。
 *
 * 帧头只按**公开的线上契约**读（`docs/protocol.md` §1「Frame and envelope」），不 import
 * SDK 内部模块。
 */
import { expect, test } from "bun:test";
import { MemoryTransport, Text, View, createRoot } from "@solid-gpui/core";
import { Input } from "@solid-gpui/core/components";
import { createEffect as sdkEffect } from "@solid-gpui/core/runtime";
import { createSignal } from "solid-js";

const SNAPSHOT = 1;
const PATCH = 3;
const PROTOCOL_VERSION = 5;
const UTF8 = new TextDecoder();

/**
 * 一帧的 Body tag。信封按公开契约逐字段读（Bebop 的结构体与联合体各带一层 u32 长度前缀，
 * 所以字段从第 8 个字节开始、判别值在联合体长度之后）：
 *
 *     [0..3] 帧载荷长度  [4..7] 信封消息长度  [8] 字段1 → [9..12] u32 = 5
 *     [13] 字段2（body）→ [14..17] 联合体长度 → [18] tag → [19..] 载荷 → [末尾] 0
 *
 * tag 取值 `1=Snapshot 2=Event 3=Patch 4=Command`。
 */
function bodyTag(frame: Uint8Array): number {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  expect(view.getUint32(0, true)).toBe(frame.byteLength - 4);
  expect(view.getUint32(4, true)).toBe(frame.byteLength - 8);
  let at = 8;
  for (;;) {
    const field = view.getUint8(at);
    if (field === 0) throw new Error("这一帧里没有 body");
    if (field === 1) {
      expect(view.getUint32(at + 1, true)).toBe(PROTOCOL_VERSION);
      at += 5;
      continue;
    }
    if (field === 2) {
      const length = view.getUint32(at + 1, true);
      expect(at + 6 + length).toBe(frame.byteLength - 1);
      expect(view.getUint8(frame.byteLength - 1)).toBe(0);
      return view.getUint8(at + 5);
    }
    throw new Error(`信封里出现未知字段 ${field}`);
  }
}

test("solid-js 的信号同时驱动 SDK 的 effect、core 文本与 generated 组件的 prop，先 Snapshot 后 Patch", async () => {
  const [count, setCount] = createSignal(41);
  const [draft, setDraft] = createSignal("demo");
  const seen: number[] = [];
  const transport = new MemoryTransport();
  const root = createRoot(transport, { surfaceId: 7 });
  try {
    function Probe() {
      // 观察者来自 SDK 的 runtime，信号来自 solid-js 本体：只有两边真的是同一份 Solid
      // 才会跟着变（装了第二份 solid-js 时这里永远只看到 41）。
      sdkEffect(() => seen.push(count()));
      return (
        <View style={{ flexDirection: "column" }}>
          <Text>{`count ${count()}`}</Text>
          <Input value={draft()} onChange={(change) => setDraft(change.value)} />
        </View>
      );
    }

    root.render(() => <Probe />);
    await Promise.resolve();

    expect(seen).toEqual([41]);
    expect(transport.submitted.length).toBe(1);
    const snapshot = transport.submitted[0];
    expect(bodyTag(snapshot)).toBe(SNAPSHOT);
    expect(UTF8.decode(snapshot)).toContain("count 41");

    setCount(42);
    setDraft("name 42");
    await Promise.resolve();

    expect(seen).toEqual([41, 42]);
    const updates = transport.submitted.slice(1);
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.every((frame) => bodyTag(frame) === PATCH)).toBe(true);
    const patched = updates.map((frame) => UTF8.decode(frame)).join("\n");
    // core 的 RawText 与 generated 组件（Input）的受控 value 都必须出现在增量里。
    expect(patched).toContain("count 42");
    expect(patched).toContain("name 42");
  } finally {
    root.unmount();
  }
});

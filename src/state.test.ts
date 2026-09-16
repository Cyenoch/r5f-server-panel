import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("concurrent processes preserve every independent state update", async () => {
  const root = mkdtempSync(join(tmpdir(), "r5-state-concurrency-"));
  const source = `
    import {loadState, withState} from ${JSON.stringify(join(import.meta.dir, "state.ts"))};
    const id = process.argv.at(-1);
    withState(loadState(), disk => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
      disk.templates.push({id, name:id, playlist:"fs_1v1", map:"mp_rr_arena_habitat", overrides:{}, updatedAt:new Date().toISOString()});
    });
  `;
  try {
    const workers = Array.from({ length: 8 }, (_, index) =>
      Bun.spawn([process.execPath, "-e", source, `writer-${index}`], {
        env: { ...process.env, R5F_DEV: "0", R5_SERVER_ROOT: root },
        stdout: "ignore",
        stderr: "inherit",
      }),
    );
    expect(await Promise.all(workers.map((worker) => worker.exited))).toEqual(Array(8).fill(0));
    const saved = JSON.parse(readFileSync(join(root, "r5-server.json"), "utf8")) as {
      templates: { id: string }[];
    };
    expect(saved.templates.map((template) => template.id).toSorted()).toEqual(
      Array.from({ length: 8 }, (_, index) => `writer-${index}`),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

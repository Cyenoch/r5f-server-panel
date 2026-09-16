import { resolve } from "node:path";

/** Explicit opt-in, inherited by dashboard actions and the simulated engine. */
export const DEV_MODE = process.env.R5F_DEV === "1";
export const DEV_ROOT = resolve(process.env.R5_SERVER_ROOT || resolve(import.meta.dir, ".."), ".dev", "r5f");

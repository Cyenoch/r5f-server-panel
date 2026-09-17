import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The executable build replaces this constant; source execution never guesses from Bun's filename.
declare const R5_SERVER_COMPILED: boolean;
export const IS_COMPILED = typeof R5_SERVER_COMPILED !== "undefined" && R5_SERVER_COMPILED;
export const APP_ROOT = IS_COMPILED
  ? dirname(process.execPath)
  : resolve(fileURLToPath(new URL("..", import.meta.url)));

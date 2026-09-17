import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Native startup declares the real directory; source-only tools resolve from their module URL.
// The embedded graph's virtual paths and the data directory are never executable locations.
export const APP_ROOT = process.env.R5_SERVER_APP_ROOT
  ? resolve(process.env.R5_SERVER_APP_ROOT)
  : resolve(fileURLToPath(new URL("..", import.meta.url)));

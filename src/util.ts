/**
 * Small helpers shared by more than one module: reading files that may not
 * exist, and narrowing JSON of unknown provenance.
 */
import { readFileSync } from "node:fs";

/** Contents of a UTF-8 text file, or "" when it is missing or unreadable. */
export function readTextIfPresent(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Narrow unknown JSON into an object; arrays and primitives become an empty record. */
export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

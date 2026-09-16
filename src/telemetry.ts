import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { InstanceMetrics, ServerInstance } from "./panel";
import { ROOT } from "./state";

export type FleetRow = { instance: ServerInstance; metrics: InstanceMetrics | null };
export type MetricSample = {
  at: number;
  running: number;
  players: number | null;
  capacity: number | null;
  memoryMB: number;
  cpuPercent: number | null;
  frameMs: number | null;
};
const RETENTION = 24 * 60 * 60 * 1000;
const INTERVAL = 10_000;
let database: Database | undefined;
let lastSample = 0;
const previousCpu = new Map<string, { at: number; pid: number; seconds: number }>();

function db(): Database {
  if (database) return database;
  mkdirSync(ROOT, { recursive: true });
  database = new Database(join(ROOT, "metrics.sqlite"), { create: true });
  database.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS samples (instance TEXT NOT NULL, at INTEGER NOT NULL, running INTEGER NOT NULL, players INTEGER, capacity INTEGER, memoryMB REAL NOT NULL, cpuPercent REAL, frameMs REAL, PRIMARY KEY(instance, at)); CREATE INDEX IF NOT EXISTS samples_time ON samples(at)",
  );
  return database;
}

export function playerCounts(metrics: InstanceMetrics | null): { players: number | null; capacity: number | null } {
  if (!metrics?.alive) return { players: 0, capacity: 0 };
  const match = /^(\d+)\/(\d+)$/.exec(metrics.metrics?.players ?? "");
  return match ? { players: Number(match[1]), capacity: Number(match[2]) } : { players: null, capacity: null };
}

/** CPU is process CPU-time delta, 100% = one logical core; never lifetime average. */
export function sampleFleet(rows: FleetRow[], now = Date.now()): boolean {
  if (now - lastSample < INTERVAL) return false;
  const samples = rows.map(({ instance, metrics }) => {
    const alive = metrics?.alive === true;
    const before = previousCpu.get(instance.id);
    const cpu =
      alive &&
      metrics &&
      before &&
      before.pid === metrics.pid &&
      now > before.at &&
      metrics.cpuSeconds >= before.seconds
        ? ((metrics.cpuSeconds - before.seconds) * 100_000) / (now - before.at)
        : alive
          ? null
          : 0;
    if (alive && metrics) previousCpu.set(instance.id, { at: now, pid: metrics.pid, seconds: metrics.cpuSeconds });
    else previousCpu.delete(instance.id);
    const frame = metrics?.metrics?.frameMs === undefined ? null : Number(metrics.metrics.frameMs);
    return {
      id: instance.id,
      at: now,
      running: alive ? 1 : 0,
      ...playerCounts(metrics),
      memoryMB: alive ? metrics.workingSetMB : 0,
      cpuPercent: cpu,
      frameMs: alive && frame !== null && Number.isFinite(frame) ? frame : null,
    };
  });
  const connection = db();
  const insert = connection.query("INSERT OR REPLACE INTO samples VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  connection.transaction(() => {
    for (const sample of samples)
      insert.run(
        sample.id,
        sample.at,
        sample.running,
        sample.players,
        sample.capacity,
        sample.memoryMB,
        sample.cpuPercent,
        sample.frameMs,
      );
    connection.query("DELETE FROM samples WHERE at < ?").run(now - RETENTION);
  })();
  lastSample = now;
  return true;
}

/** Aggregate unknown live counters as unknown, never as a fabricated zero. */
export function metricHistory(instanceId: string | null, hours = 1): MetricSample[] {
  const since = Date.now() - Math.min(24, Math.max(1, hours)) * 3_600_000;
  if (instanceId)
    return db()
      .query<MetricSample, [string, number]>(
        "SELECT at,running,players,capacity,memoryMB,cpuPercent,frameMs FROM samples WHERE instance = ? AND at >= ? ORDER BY at",
      )
      .all(instanceId, since);
  return db()
    .query<MetricSample, [number]>(`SELECT at, SUM(running) AS running,
    CASE WHEN COUNT(players) = COUNT(*) THEN SUM(players) END AS players,
    CASE WHEN COUNT(capacity) = COUNT(*) THEN SUM(capacity) END AS capacity,
    SUM(memoryMB) AS memoryMB,
    CASE WHEN COUNT(cpuPercent) = COUNT(*) THEN SUM(cpuPercent) END AS cpuPercent,
    MAX(frameMs) AS frameMs FROM samples WHERE at >= ? GROUP BY at ORDER BY at`)
    .all(since);
}

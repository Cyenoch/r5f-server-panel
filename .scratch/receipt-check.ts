import { classifyReceipt, normaliseLogLine } from "../src/receipt.ts";

const cases: [string, string[], string][] = [
  ["unknown", ["[123.456] Native(S): Command 'echo-test' doesn't exist; request 'echo-test' ignored"], "unknown"],
  ["usage sv_addbot", ["[12.3] usage 'sv_addbot': name(string) teamid(int)"], "usage"],
  ["usage playlist_override_set", ["usage: playlist_override_set <var> <value>"], "usage"],
  ["usage help", ["Usage:  help <cvarname>"], "usage"],
  ["success kick", ["[99.1] Native(S): Kicked '1' from server"], "success"],
  ["silent ban", [], "silent"],
  ["status block", ["hostname: R5F Server", "players : 1 humans, 0 bots", "#end"], "success"],
  ["unknown wins over success", ["Kicked '1' from server", "Command 'x' doesn't exist"], "unknown"],
];

let failed = 0;
for (const [label, lines, want] of cases) {
  const got = classifyReceipt(lines);
  const ok = got.kind === want;
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${got.kind} / ${JSON.stringify(got.detail)}`);
}

const norm = [
  ["[123.456] Native(S): Command 'x' doesn't exist", "Command 'x' doesn't exist"],
  ["Native(E):[dt_extend] Loading level", "Loading level"],
  ["[DETOUR] class 1 spills xmm0", "class 1 spills xmm0"],
  ["[99.9] [FIRE-CLOCK] tick 1", "tick 1"],
  ["[Flowstate] Have fun and be respectful.", "[Flowstate] Have fun and be respectful."],
];
for (const [input, want] of norm) {
  const got = normaliseLogLine(input);
  const ok = got === want;
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} normalise ${JSON.stringify(input)} -> ${JSON.stringify(got)}`);
}
console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILURES`);
process.exit(failed === 0 ? 0 : 1);

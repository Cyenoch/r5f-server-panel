/** 一次性：用真机日志里抄下来的 status 块验证解析（含机器人行与地址行）。 */
import { parseStatusBlock } from "../src/commands.ts";

const block = [
  "[54.992] Native(S):hostname: R5F Server",
  "[54.992] Native(S):version : 2.0.0.1/2001 7662 insecure",
  "[54.992] Native(S):udp/ip  : [::ffff:172.19.0.1]:37038 os(Windows) type(dedicated)",
  "[54.992] Native(S):players : 3 humans, 3 bots (125 max) (not hibernating)",
  "[54.992] Native(S):",
  "[54.992] Native(S):# userid name uniqueid connected ping loss state rate",
  "[54.992] Native(S): adr",
  '[54.992] Native(S):# 1 "bot0" 0 00:05 0 0 active 256000',
  "[54.992] Native(S): [::]:0",
  '[54.992] Native(S):# 2 "bot1" 0 00:05 0 0 active 256000',
  "[54.992] Native(S): [::]:0",
  '[54.992] Native(S):# 3 "ProbeBot" 0 00:01 0 0 active 256000',
  "[54.992] Native(S): [::]:0",
  '[54.992] Native(S):# 4 "Real Person" 76561198012345678 01:12 45 0 active 256000',
  "[54.992] Native(S): [::ffff:1.2.3.4]:5000",
  "[54.992] Native(S):#end",
];

const { header, players } = parseStatusBlock(block);
console.log("header:");
for (const line of header) console.log(`  ${line}`);
console.log("players:");
for (const row of players) console.log(`  ${JSON.stringify(row)}`);
const bots = players.filter((row) => row.uniqueid === "0");
const ok = players.length === 4 && bots.length === 3 && players[3].uniqueid === "76561198012345678";
console.log(ok ? "\nPASS：机器人行进列表且 uniqueid 为 0，地址行没被当成玩家" : "\nFAIL");
process.exit(ok ? 0 : 1);

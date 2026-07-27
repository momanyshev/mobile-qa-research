#!/usr/bin/env node
// Прокси к sim-use, пишущий каждый вызов в журнал активного run.
//
// Зачем: план требует логировать каждый вызов с timestamp, длительностью, exit
// code, stdout и stderr. Если агент вызывает sim-use напрямую, transcript
// приходится писать руками — он становится пересказом, а не записью. Через эту
// обёртку журнал ведётся сам, а transcript и selector mix выводятся из него.
//
// Использование (вместо `sim-use …`):
//   node sim.mjs --run <runId> -- ui --device <UDID>
//   node sim.mjs --run <runId> -- tap "#create-issue-button" --device <UDID>
//
// Exit code и потоки пробрасываются как есть, поэтому обёртка прозрачна для
// любого вызывающего.

import { existsSync, readFileSync } from "node:fs";
import { runLogged } from "./lib/cmdlog.mjs";
import { runDir } from "../tools/lib/capture.mjs";

const STAGE = process.env.HARNESS_STAGE || "10";
const argv = process.argv.slice(2);

const sepIndex = argv.indexOf("--");
if (sepIndex === -1) {
  console.error('Использование: node sim.mjs --run <runId> [--platform ios] -- <аргументы sim-use>');
  process.exit(2);
}
const own = argv.slice(0, sepIndex);
const simArgs = argv.slice(sepIndex + 1);

function flag(name) {
  const i = own.indexOf(`--${name}`);
  return i !== -1 && own[i + 1] && !own[i + 1].startsWith("--") ? own[i + 1] : null;
}

const runId = flag("run") || process.env.HARNESS_RUN;
if (!runId) { console.error("Нужен --run <runId> (или переменная HARNESS_RUN)"); process.exit(2); }
if (!simArgs.length) { console.error("После -- не переданы аргументы sim-use"); process.exit(2); }

// Платформу можно не указывать: run ищется по обеим.
const platforms = flag("platform") ? [flag("platform")] : ["ios", "android"];
let dir = null;
for (const p of platforms) {
  const candidate = runDir(STAGE, p, runId);
  if (existsSync(`${candidate}/run.json`)) { dir = candidate; break; }
}
if (!dir) {
  console.error(`Не найден активный run ${runId} в evidence/stage-${STAGE}/{${platforms.join(",")}}/runs/`);
  process.exit(2);
}

const state = JSON.parse(readFileSync(`${dir}/run.json`, "utf8"));
if (state.status !== "started") {
  console.error(`Run ${runId} уже ${state.status}: журналировать вызовы в завершённый run нельзя`);
  process.exit(2);
}

const { status, stdout, stderr } = runLogged(`${dir}/commands.jsonl`, simArgs);
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);
process.exit(status === null ? 1 : status);

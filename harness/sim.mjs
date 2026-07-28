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

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runLogged } from "./lib/cmdlog.mjs";
import { runDir } from "../tools/lib/capture.mjs";

const STAGE = process.env.HARNESS_STAGE || "10";
const argv = process.argv.slice(2);

/**
 * Все стадии, присутствующие в evidence. Нужны, потому что runId уникален сам
 * по себе, а требовать от агента ещё и HARNESS_STAGE — лишнее условие, о
 * которое легко споткнуться: именно на нём споткнулся первый чистый прогон
 * этапа 14.C. Сначала пробуем текущую стадию, затем остальные.
 */
function knownStages() {
  const root = fileURLToPath(new URL("../evidence", import.meta.url));
  if (!existsSync(root)) return [STAGE];
  const found = readdirSync(root)
    .filter((d) => d.startsWith("stage-"))
    .map((d) => d.slice("stage-".length));
  return [STAGE, ...found.filter((s) => s !== STAGE)];
}

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

// Ни платформу, ни стадию указывать не нужно: runId уникален, поэтому ищем по
// всем стадиям и обеим платформам.
const platforms = flag("platform") ? [flag("platform")] : ["ios", "android"];
const stages = knownStages();
let dir = null;
outer:
for (const s of stages) {
  for (const p of platforms) {
    const candidate = runDir(s, p, runId);
    if (existsSync(`${candidate}/run.json`)) { dir = candidate; break outer; }
  }
}
if (!dir) {
  console.error(`Не найден активный run ${runId} ни в одной стадии `
    + `(искал stage-{${stages.join(",")}} / {${platforms.join(",")}})`);
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

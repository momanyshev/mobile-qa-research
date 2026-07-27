#!/usr/bin/env node
// Хелпер журналирования run'ов. Пишет структурированный отчёт в
// evidence/stage-<N>/<platform>/runs.jsonl и, для полного evidence pack,
// сохраняет initial/final UI outline, screenshot и transcript в
// evidence/stage-<N>/<platform>/runs/<runId>/ — закрывает пункты 3 и 5
// «Общего Definition of Done» этапа 7 автоматически для будущих прогонов.
//
// Команды (новый формат, для этапа 14 и далее):
//   node runlog.mjs snapshot --stage 14 --platform ios --run S2-guided \
//        --phase initial --device <UDID>
//        → сохраняет <run>/initial-ui.json и <run>/initial-screen.png
//   node runlog.mjs record --stage 14 --platform ios --run S2-guided \
//        --verdict PASS --json '{"mode":"guided",...}' \
//        [--transcript t.txt] [--api-before a.json] [--api-after b.json]
//        → регистрирует run + пути артефактов, печатает DoD-полноту
//
// Легаси (этап 7): node runlog.mjs <platform> <id> <verdict> [json]
//        → пишет в evidence/stage-7/<platform>/runs.jsonl

import { appendFileSync, mkdirSync, existsSync, copyFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const SUB = ["snapshot", "record"];

function evRoot(stage, platform) {
  return fileURLToPath(new URL(`../evidence/stage-${stage}/${platform}`, import.meta.url));
}

// ── парсинг флагов ────────────────────────────────────────────────────────────
function flags(args) {
  const f = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i]?.startsWith("--")) { f[args[i].slice(2)] = args[i + 1]; i++; }
  }
  return f;
}

// ── snapshot: захват outline + screenshot через sim-use ──────────────────────
function snapshot(f) {
  for (const k of ["stage", "platform", "run", "phase", "device"])
    if (!f[k]) { console.error(`snapshot: нужен --${k}`); process.exit(2); }
  const runDir = `${evRoot(f.stage, f.platform)}/runs/${f.run}`;
  mkdirSync(runDir, { recursive: true });
  const uiPath = `${runDir}/${f.phase}-ui.json`;
  const shotPath = `${runDir}/${f.phase}-screen.png`;
  const ui = execFileSync("sim-use", ["ui", "--json", "--device", f.device], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  writeFileSync(uiPath, ui);
  execFileSync("sim-use", ["screenshot", "--device", f.device, "--output", shotPath]);
  console.log(`snapshot ${f.phase}: ${uiPath} + ${shotPath}`);
}

// ── record: регистрация run + копирование артефактов + проверка полноты ───────
function record(f) {
  for (const k of ["stage", "platform", "run", "verdict"])
    if (!f[k]) { console.error(`record: нужен --${k}`); process.exit(2); }
  const base = evRoot(f.stage, f.platform);
  const runDir = `${base}/runs/${f.run}`;
  mkdirSync(runDir, { recursive: true });

  // Копируем переданные артефакты в папку run.
  const copyInto = (src, name) => {
    if (src && existsSync(src)) { copyFileSync(src, `${runDir}/${name}`); return `runs/${f.run}/${name}`; }
    return null;
  };
  const artifacts = {
    initialUi: existsSync(`${runDir}/initial-ui.json`) ? `runs/${f.run}/initial-ui.json` : null,
    finalUi: existsSync(`${runDir}/final-ui.json`) ? `runs/${f.run}/final-ui.json` : null,
    initialScreen: existsSync(`${runDir}/initial-screen.png`) ? `runs/${f.run}/initial-screen.png` : null,
    finalScreen: existsSync(`${runDir}/final-screen.png`) ? `runs/${f.run}/final-screen.png` : null,
    transcript: copyInto(f.transcript, "transcript.txt"),
    apiBefore: copyInto(f["api-before"], "api-before.json"),
    apiAfter: copyInto(f["api-after"], "api-after.json"),
  };

  // Проверка полноты evidence pack по «Общему DoD».
  const required = {
    "исходный UI (initial-ui)": artifacts.initialUi,
    "исходный API (api-before)": artifacts.apiBefore,
    "финальный UI (final-ui)": artifacts.finalUi,
    "финальный screenshot": artifacts.finalScreen,
    "transcript": artifacts.transcript,
    "итоговый API (api-after)": artifacts.apiAfter,
  };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);

  const entry = {
    run: f.run, platform: f.platform, stage: Number(f.stage), verdict: f.verdict,
    recordedAt: new Date().toISOString(),
    ...(f.json ? JSON.parse(f.json) : {}),
    artifacts,
    evidenceComplete: missing.length === 0,
  };
  appendFileSync(`${base}/runs.jsonl`, JSON.stringify(entry) + "\n");
  console.log(`runlog: stage-${f.stage} ${f.platform} ${f.run} → ${f.verdict}`);
  if (missing.length) console.log(`  ⚠ evidence неполон, нет: ${missing.join(", ")}`);
  else console.log("  ✓ evidence pack полон");
}

// ── легаси-режим этапа 7 ──────────────────────────────────────────────────────
function legacy([platform, id, verdict, detailsJson]) {
  if (!platform || !id || !verdict) { console.error("usage: runlog.mjs <platform> <id> <verdict> [json]  |  snapshot … | record …"); process.exit(2); }
  const dir = evRoot(7, platform);
  mkdirSync(dir, { recursive: true });
  const entry = { id, platform, verdict, recordedAt: new Date().toISOString(), ...(detailsJson ? JSON.parse(detailsJson) : {}) };
  appendFileSync(`${dir}/runs.jsonl`, JSON.stringify(entry) + "\n");
  console.log(`runlog: ${platform} ${id} → ${verdict}`);
}

if (SUB.includes(argv[0])) {
  const f = flags(argv.slice(1));
  if (argv[0] === "snapshot") snapshot(f); else record(f);
} else {
  legacy(argv);
}

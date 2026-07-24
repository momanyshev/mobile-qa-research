#!/usr/bin/env node
// Хелпер журналирования run'ов этапа 7. Пишет один структурированный отчёт
// (manifest + verdict + evidence + вывод о sim-use) в JSONL по платформе.
//
//   node runlog.mjs <platform> <id> <verdict> <json-детали>
//
// Пример:
//   node runlog.mjs ios 7.2 PASS '{"instruction":"...","oracle":"...","note":"..."}'
//
// Файл: evidence/stage-7/<platform>/runs.jsonl

import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [platform, id, verdict, detailsJson] = process.argv.slice(2);
if (!platform || !id || !verdict) {
  console.error("usage: runlog.mjs <platform> <id> <verdict> [json]");
  process.exit(2);
}
const dir = fileURLToPath(new URL(`../evidence/stage-7/${platform}`, import.meta.url));
mkdirSync(dir, { recursive: true });
const entry = {
  id,
  platform,
  verdict,
  recordedAt: new Date().toISOString(),
  ...(detailsJson ? JSON.parse(detailsJson) : {}),
};
appendFileSync(`${dir}/runs.jsonl`, JSON.stringify(entry) + "\n");
console.log(`runlog: ${platform} ${id} → ${verdict}`);

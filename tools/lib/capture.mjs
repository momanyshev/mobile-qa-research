// Захват evidence устройства (UI outline + screenshot) — общий код для
// runlog.mjs (ручные прогоны) и harness (этап 10+). Единый модуль, чтобы
// раскладка артефактов и формат снимков не разошлись между двумя контурами.

import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAX_UI_BUFFER = 64 * 1024 * 1024;

export function evidenceRoot(stage, platform) {
  return fileURLToPath(new URL(`../../evidence/stage-${stage}/${platform}`, import.meta.url));
}

export function runDir(stage, platform, runId) {
  return `${evidenceRoot(stage, platform)}/runs/${runId}`;
}

/**
 * Снимок состояния устройства в фазе phase (initial|final|<произвольная>).
 * Бросает при недоступном устройстве — вызывающий решает, фатально это
 * (обычный run) или собирается best-effort (аварийный abort).
 */
export function captureSnapshot({ stage, platform, run, phase, device }) {
  const dir = runDir(stage, platform, run);
  mkdirSync(dir, { recursive: true });
  const uiPath = `${dir}/${phase}-ui.json`;
  const shotPath = `${dir}/${phase}-screen.png`;

  const ui = execFileSync("sim-use", ["ui", "--json", "--device", device], {
    encoding: "utf8", maxBuffer: MAX_UI_BUFFER,
  });
  writeFileSync(uiPath, ui);
  execFileSync("sim-use", ["screenshot", "--device", device, "--output", shotPath]);

  return { uiPath, shotPath, dir };
}

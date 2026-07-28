#!/usr/bin/env node
// Минимальный воспроизводимый контур одного run (gate 10.0 плана).
//
// Зачем: до серии из 36 runs не нужен полный runner этапа 11, но ручной сбор
// результатов без общей схемы сделает benchmark несравнимым. Harness закрывает
// именно это: одинаковая структура отчёта, автоматические Workspace/seed/
// oracle/teardown и полный evidence pack на каждый run — независимо от исхода.
//
// Команды:
//   list                                   доступные case manifest
//   validate [case]                        разбор и валидация манифестов
//   new-workspace                          UUID, который заранее задают в приложении
//   start   --case C1 --platform ios --device <UDID> [--workspace UUID]
//           [--model M] [--skill R]
//   arm     --run <runId>                  переснять исходный снимок UI после того,
//                                          как приложение наведено на Workspace run'а
//   finish  --run <runId> [--transcript t.txt] [--self-report "…"]
//           [--tool-calls N] [--retries N] [--interventions N]
//           [--confirm-manual] [--knowledge "…"] [--follow-up "…"]
//   abort   --run <runId> --reason "…" [--verdict BLOCKED] [--category environment]
//   selftest                               проверка контура без устройства
//
// Verdict выставляет только oracle (tools/lib/verify.mjs); самоотчёт агента
// сохраняется рядом, но на verdict не влияет.

import {
  existsSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, mkdirSync, readdirSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { newWorkspaceId } from "../tools/lib/workspace.mjs";
import { captureSnapshot, evidenceRoot, runDir } from "../tools/lib/capture.mjs";
import { loadManifest, listCases, unsupportedChecks, adapterFor, ManifestError } from "./lib/manifest.mjs";
import { runOracle, uiText } from "./lib/oracle-runner.mjs";
import { versionManifest } from "./lib/versions.mjs";
import { renderReport, reportStructure } from "./lib/report.mjs";
import { summarizeLog, renderTranscript, retryViolations } from "./lib/cmdlog.mjs";
import { runPreflight, renderPreflight, observedApp } from "./lib/preflight.mjs";
import { captureDeviceLog, needsDiagnostics } from "./lib/diagnostics.mjs";
import { renderSummary } from "./lib/summary.mjs";

const STAGE = process.env.HARNESS_STAGE || "10";

// ── аргументы ─────────────────────────────────────────────────────────────────

function parseFlags(args) {
  const f = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) { f._.push(a); continue; }
    const key = a.slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) { f[key] = true; }
    else { f[key] = next; i++; }
  }
  return f;
}

function die(message, code = 2) { console.error(message); process.exit(code); }

function requireFlag(f, name) {
  if (!f[name] || f[name] === true) die(`Нужен --${name}`);
  return f[name];
}

// ── состояние run ─────────────────────────────────────────────────────────────

function statePath(platform, runId) { return `${runDir(STAGE, platform, runId)}/run.json`; }

function findRun(runId, platform) {
  const platforms = platform ? [platform] : ["ios", "android"];
  for (const p of platforms) {
    const path = statePath(p, runId);
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  }
  die(`Не найден run ${runId} (искал в evidence/stage-${STAGE}/{${platforms.join(",")}}/runs/)`);
}

function saveState(state) {
  const dir = runDir(STAGE, state.platform, state.runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/run.json`, JSON.stringify(state, null, 2));
}

/** Контекст данных run'а восстанавливается из run.json и отдаётся адаптеру. */
function contextOf(state) {
  return state.context;
}

// ── start ─────────────────────────────────────────────────────────────────────

async function cmdStart(f) {
  const caseId = requireFlag(f, "case");
  const platform = requireFlag(f, "platform");
  const manifest = loadManifest(caseId);

  if (manifest.platform !== "any" && manifest.platform !== platform) {
    die(`Case ${caseId} объявлен для платформы ${manifest.platform}, запрошена ${platform}`);
  }
  const device = f.device && f.device !== true ? f.device : null;
  if (!device && !f["no-device"]) {
    die("Нужен --device <UDID> (или --no-device для прогона без устройства, тогда UI-evidence будет отсутствовать)");
  }

  const adapter = adapterFor(manifest);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const runId = f.run && f.run !== true ? f.run : `${manifest.id}-${platform}-${stamp}`;
  const dir = runDir(STAGE, platform, runId);
  const context = await adapter.createContext({ platform, device });

  // Preflight до создания каталога, seed и первого действия: отделяем
  // «run провалился» от «run не следовало начинать». Не пройден — на диске не
  // остаётся ни каталога, ни артефактов: несостоявшийся run не должен попадать
  // в статистику. Пропуск возможен только явным флагом.
  let preflightResult = null;
  if (device && !f["skip-preflight"]) {
    preflightResult = await runPreflight(adapter, { platform, device, context });
    console.log("preflight:");
    console.log(renderPreflight(preflightResult));
    if (!preflightResult.ok) {
      die(`\nRun не начат: preflight не пройден (${preflightResult.failed.length} блокирующих).\n`
        + "Устраните причины либо запустите с --skip-preflight, если это осознанное решение.");
    }
    console.log("");
  }

  mkdirSync(dir, { recursive: true });
  if (preflightResult) writeFileSync(`${dir}/preflight.json`, JSON.stringify(preflightResult, null, 2));
  // --workspace позволяет заранее навести приложение на контекст run'а, чтобы
  // исходный снимок UI отражал реальное стартовое состояние агента.
  if (f.workspace && f.workspace !== true) {
    if (context.kind !== "workspace") die(`--workspace неприменим к adapter «${adapter.id}»`);
    context.workspaceId = f.workspace;
  }

  const versions = versionManifest({
    deviceId: device, platform,
    agentModel: f.model !== true ? f.model : null,
    skillRevision: f.skill !== true ? f.skill : null,
  });
  writeFileSync(`${dir}/version-manifest.json`, JSON.stringify(versions, null, 2));

  // Seed строго до UI-задачи: агент получает точное известное начальное состояние.
  const seeded = await adapter.seed(context, manifest.preconditions.apiSeed);

  const stateBefore = await adapter.readState(context);
  writeFileSync(`${dir}/api-before.json`, JSON.stringify(stateBefore, null, 2));

  let capture = null;
  if (device) {
    try {
      capture = captureSnapshot({ stage: STAGE, platform, run: runId, phase: "initial", device });
    } catch (err) {
      die(`Не удалось снять исходное состояние устройства: ${err.message}\n`
        + "Run не начат — стартовать без зафиксированного начального состояния нельзя.");
    }
  }

  const state = {
    runId, caseId: manifest.id, platform, device,
    adapter: adapter.id, context,
    startedAt: new Date().toISOString(),
    seeded,
    versions, manifestPath: `cases/${manifest.id}.yaml`,
    limits: manifest.limits,
    status: "started",
  };
  saveState(state);

  console.log(`run:        ${runId}`);
  console.log(`case:       ${manifest.id} (${manifest.title || "—"})`);
  console.log(`adapter:    ${adapter.id} (${adapter.displayName})`);
  console.log(`platform:   ${platform}${device ? ` / ${device}` : " (без устройства)"}`);
  console.log(`workspace:  ${adapter.describeContext(context)}`);
  console.log(`seed:       ${seeded.length} записей`);
  console.log(`evidence:   ${dir}`);
  console.log(`initial UI: ${capture ? "снят" : "НЕ снят (--no-device)"}`);
  console.log(`лимиты:     ${manifest.limits.timeoutSeconds} с, ${manifest.limits.retryPerAction} попытки на действие`);
  console.log("");
  console.log("Разрешено:  " + manifest.allowedActions.join(", "));
  console.log("Запрещено:  " + manifest.forbiddenActions.join(", "));
  console.log("");
  console.log("ЗАДАНИЕ АГЕНТУ:");
  console.log(manifest.instruction.trim());
  console.log("");
  if (seeded.length && device) {
    console.log(`ВНИМАНИЕ: seed создан после снимка. Наведите приложение на ${adapter.describeContext(context)},`);
    console.log(`дождитесь загрузки данных и переснимите исходное состояние:`);
    console.log(`  node harness.mjs arm --run ${runId}`);
  }
  console.log(`По завершении: node harness.mjs finish --run ${runId} --transcript <файл>`);
}

// ── arm: пересъёмка исходного состояния после наведения приложения ────────────

function cmdArm(f) {
  const runId = requireFlag(f, "run");
  const state = findRun(runId, f.platform !== true ? f.platform : null);
  if (!state.device) die(`Run ${runId} стартовал без устройства — пересъёмка невозможна`);
  if (state.status !== "started") die(`Run ${runId} уже ${state.status} — пересъёмка исходного состояния запрещена`);
  const cap = captureSnapshot({
    stage: STAGE, platform: state.platform, run: runId, phase: "initial", device: state.device,
  });
  saveState({ ...state, armedAt: new Date().toISOString() });
  console.log(`исходное состояние переснято: ${cap.uiPath}`);
}

// ── finish ────────────────────────────────────────────────────────────────────

async function cmdFinish(f) {
  const runId = requireFlag(f, "run");
  const state = findRun(runId, f.platform !== true ? f.platform : null);
  const manifest = loadManifest(state.caseId);
  const dir = runDir(STAGE, state.platform, runId);
  const adapter = adapterFor(manifest);
  const context = contextOf(state);

  // 1. Финальное состояние устройства.
  let finalUiRaw = null;
  let captureError = null;
  if (state.device) {
    try {
      const cap = captureSnapshot({ stage: STAGE, platform: state.platform, run: runId, phase: "final", device: state.device });
      finalUiRaw = readFileSync(cap.uiPath, "utf8");
    } catch (err) {
      captureError = err.message;
    }
  }

  // 2. Финальное состояние приложения — до teardown.
  const after = await adapter.readState(context);
  writeFileSync(`${dir}/api-after.json`, JSON.stringify(after, null, 2));
  const before = JSON.parse(readFileSync(`${dir}/api-before.json`, "utf8"));

  // 3. Артефакты агента.
  const transcript = resolveTranscript(f, dir);

  // 4. Oracle.
  const oracle = await runOracle(manifest, adapter, {
    context, seeded: state.seeded, before, after,
    finalUiText: uiText(finalUiRaw),
    manualConfirmed: Boolean(f["confirm-manual"]),
  });

  // 5. Teardown — всегда, независимо от verdict.
  const teardown = await doTeardown(manifest, adapter, context);

  finalizeRun({ f, state, manifest, dir, runId, before, after, oracle, teardown, transcript, captureError });
}

// ── abort: аварийное завершение ───────────────────────────────────────────────

async function cmdAbort(f) {
  const runId = requireFlag(f, "run");
  const reason = requireFlag(f, "reason");
  const state = findRun(runId, f.platform !== true ? f.platform : null);
  const manifest = loadManifest(state.caseId);
  const dir = runDir(STAGE, state.platform, runId);
  const adapter = adapterFor(manifest);
  const context = contextOf(state);

  // Всё собирается best-effort: run уже аварийный, отсутствие артефакта не
  // должно мешать очистке данных.
  let captureError = null;
  if (state.device) {
    try {
      captureSnapshot({ stage: STAGE, platform: state.platform, run: runId, phase: "final", device: state.device });
    } catch (err) { captureError = err.message; }
  }
  let after = null;
  try {
    after = await adapter.readState(context);
    writeFileSync(`${dir}/api-after.json`, JSON.stringify(after, null, 2));
  } catch (err) { captureError = `${captureError ? captureError + "; " : ""}состояние «после»: ${err.message}`; }

  const before = existsSync(`${dir}/api-before.json`)
    ? JSON.parse(readFileSync(`${dir}/api-before.json`, "utf8"))
    : null;
  const transcript = resolveTranscript(f, dir);

  const teardown = await doTeardown(manifest, adapter, context, { force: true });

  const verdict = f.verdict && f.verdict !== true ? f.verdict : "BLOCKED";
  const oracle = {
    verdict,
    checks: [],
    reasons: [`run прерван до завершения: ${reason}`],
  };
  finalizeRun({
    f, state, manifest, dir, runId, before, after, oracle, teardown, transcript, captureError,
    aborted: true, abortReason: reason,
    category: f.category && f.category !== true ? f.category : "environment",
  });
}

// ── общий финал: отчёт, журнал, проверка полноты ──────────────────────────────

function copyArtifact(src, dir, name) {
  if (!src || src === true) return null;
  if (!existsSync(src)) { console.error(`⚠ артефакт не найден: ${src}`); return null; }
  copyFileSync(src, `${dir}/${name}`);
  return `runs/${basename(dir)}/${name}`;
}

/**
 * Transcript run'а. Если вызовы шли через sim.mjs, он выводится из машинного
 * журнала — это запись того, что действительно произошло, а не пересказ.
 * Переданный вручную --transcript имеет приоритет (напр. прогон без обёртки).
 */
function resolveTranscript(f, dir) {
  const manual = copyArtifact(f.transcript, dir, "transcript.txt");
  if (manual) return manual;
  if (!existsSync(`${dir}/commands.jsonl`)) return null;
  writeFileSync(`${dir}/transcript.txt`, renderTranscript(`${dir}/commands.jsonl`));
  return `runs/${basename(dir)}/transcript.txt`;
}

function basename(p) { return p.split("/").filter(Boolean).pop(); }

async function doTeardown(manifest, adapter, context, { force = false } = {}) {
  const parts = [];
  if (manifest.teardown.resetState || force) {
    try {
      parts.push(await adapter.teardown(context));
    } catch (err) {
      parts.push(`ОШИБКА teardown: ${err.message}`);
    }
  } else {
    parts.push("сброс состояния отключён манифестом");
  }
  return parts.join("; ");
}

function finalizeRun(o) {
  const { f, state, manifest, dir, runId, before, after, oracle, teardown, transcript, captureError } = o;
  const adapter = adapterFor(manifest);
  // Размер состояния приложения: у REST-адаптера это total, у контейнерного —
  // число ключей. Generic-слой не знает формы состояния, поэтому измеряет обобщённо.
  const sizeOf = (s) => (s?.total ?? (s ? Object.keys(s.defaults ?? s).length : "?"));

  // Неуспешный run требует системного контекста, которого нет в UI-дереве.
  let diagnostics = null;
  if (needsDiagnostics(oracle.verdict)) {
    diagnostics = captureDeviceLog({ platform: state.platform, device: state.device, dir });
    if (!diagnostics.saved) console.log(`диагностика: ${diagnostics.reason}`);
  }

  const artifacts = {
    versionManifest: exists(dir, "version-manifest.json"),
    initialUi: exists(dir, "initial-ui.json"),
    initialScreen: exists(dir, "initial-screen.png"),
    finalUi: exists(dir, "final-ui.json"),
    finalScreen: exists(dir, "final-screen.png"),
    apiBefore: exists(dir, "api-before.json"),
    apiAfter: exists(dir, "api-after.json"),
    transcript,
  };
  const missing = Object.entries(artifacts).filter(([, v]) => !v).map(([k]) => k);
  const evidenceComplete = missing.length === 0;

  // Необязательные артефакты: журнал вызовов и диагностика сбоя.
  const extras = {
    commandLog: exists(dir, "commands.jsonl"),
    deviceLog: exists(dir, "device-log.txt"),
    video: exists(dir, "run-video.mp4"),
  };
  const toolStats = extras.commandLog ? summarizeLog(`${dir}/commands.jsonl`) : null;
  // Retry budget берётся из манифеста и проверяется по журналу, а не со слов
  // агента: «сколько было попыток» — наблюдаемый факт.
  const retryBudget = manifest.limits?.retryPerAction ?? 3;
  const retryBreaches = extras.commandLog
    ? retryViolations(`${dir}/commands.jsonl`, retryBudget) : [];

  const finishedAt = new Date().toISOString();
  const unsupported = unsupportedChecks(manifest);

  const values = {
    "Run ID": runId,
    "Case ID": manifest.id,
    "Platform": state.platform,
    "Device / OS": state.device
      ? `${state.device} (${state.versions?.device?.name || "?"}, ${state.versions?.device?.runtime || "?"})`
      : "без устройства",
    "App commit": state.versions?.appRepo?.commit
      ? `${state.versions.appRepo.commit}${state.versions.appRepo.dirty ? " (dirty)" : ""}` : null,
    "sim-use version": state.versions?.simUseVersion,
    "Agent model": state.versions?.agentModel,
    "Agent skill revision": state.versions?.skillRevision,
    "Workspace / test namespace": `${adapter.id}: ${adapter.describeContext(state.context)}`,
    "Start state": `seed ${state.seeded.length} записей, состояние «до» = ${sizeOf(before)}`,
    "Instruction": manifest.instruction.trim().replace(/\n+/g, " "),
    "Allowed / forbidden actions":
      `разрешено: ${manifest.allowedActions.join(", ")} | запрещено: ${manifest.forbiddenActions.join(", ")}`,
    "Started at / finished at": `${state.startedAt} → ${finishedAt}`,
    // Из журнала, если вызовы шли через sim.mjs; вручную — только как запасной путь.
    "Tool calls": toolStats
      ? `${toolStats.totalCalls} (действий ${toolStats.actionCalls}, по координатам ${toolStats.coordinateActions}, ошибок ${toolStats.failedCalls})`
      : num(f["tool-calls"]),
    "Retries": retryBreaches.length
      ? `${num(f.retries) ?? "?"} | ПРЕВЫШЕН БЮДЖЕТ ${retryBudget}: ${retryBreaches.map((v) => v.message).join("; ")}`
      : num(f.retries),
    "Manual interventions": num(f.interventions),
    "API before": `${sizeOf(before)} → runs/${runId}/api-before.json`,
    "API after": `${sizeOf(after)} → runs/${runId}/api-after.json`,
    "UI postcondition": artifacts.finalUi
      ? `финальный outline снят (runs/${runId}/final-ui.json)`
      : `финальный outline отсутствует${captureError ? `: ${captureError}` : ""}`,
    "Oracle result": oracle.checks.length
      ? oracle.checks.map((c) => `${c.kind}.${c.type}=${c.status}`).join(", ")
      : "проверки не выполнялись",
    "Agent self-report": f["self-report"] !== true ? f["self-report"] : null,
    "Final verdict": oracle.verdict,
    "Failure category": o.category || failureCategory(oracle, toolStats),
    "Evidence paths": [...Object.entries(artifacts), ...Object.entries(extras)]
      .filter(([, v]) => v).map(([k]) => k).join(", "),
    "Teardown result": teardown,
    "New knowledge": f.knowledge !== true ? f.knowledge : null,
    "Follow-up decision": f["follow-up"] !== true ? f["follow-up"] : null,
  };

  const report = renderReport(values);
  writeFileSync(`${dir}/report.txt`, report);

  const entry = {
    runId, caseId: manifest.id, platform: state.platform, stage: Number(STAGE),
    verdict: oracle.verdict,
    startedAt: state.startedAt, finishedAt,
    durationMs: new Date(finishedAt) - new Date(state.startedAt),
    adapter: adapter.id, context: state.context,
    device: state.device, versions: state.versions,
    oracleChecks: oracle.checks.map((c) => ({ kind: c.kind, type: c.type, status: c.status, message: c.message })),
    oracleReasons: oracle.reasons,
    unsupportedChecks: unsupported,
    toolCalls: toolStats ? toolStats.totalCalls : numOrNull(f["tool-calls"]),
    toolStats,
    retries: numOrNull(f.retries),
    interventions: numOrNull(f.interventions),
    selfReport: f["self-report"] !== true ? f["self-report"] || null : null,
    aborted: Boolean(o.aborted), abortReason: o.abortReason || null,
    retryBudget, retryBreaches,
    teardown, artifacts, extras, diagnostics, evidenceComplete,
    reportPath: `runs/${runId}/report.txt`,
  };
  appendFileSync(`${evidenceRoot(STAGE, state.platform)}/runs.jsonl`, JSON.stringify(entry) + "\n");

  saveState({ ...state, status: o.aborted ? "aborted" : "finished", finishedAt, verdict: oracle.verdict });

  console.log(`\nverdict:  ${oracle.verdict}`);
  for (const c of oracle.checks) console.log(`  ${statusMark(c.status)} ${c.kind}.${c.type}: ${c.message}`);
  for (const r of oracle.reasons) console.log(`  → ${r}`);
  console.log(`teardown: ${teardown}`);
  console.log(evidenceComplete ? "evidence: ✓ пакет полон" : `evidence: ⚠ неполон, нет: ${missing.join(", ")}`);
  console.log(`отчёт:    ${dir}/report.txt`);
}

function statusMark(s) { return s === "pass" ? "✓" : s === "fail" ? "✗" : "?"; }
function exists(dir, name) { return existsSync(`${dir}/${name}`) ? `runs/${basename(dir)}/${name}` : null; }
function num(v) { return v === undefined || v === true ? null : v; }
function numOrNull(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

/**
 * Первичная классификация по Приложению C. Автоматически различаются только те
 * категории, для которых есть объективный признак; `product` против `agent`
 * машина различить не может (постусловие не достигнуто в обоих случаях),
 * поэтому FAIL честно помечается как требующий ручного решения, а не
 * записывается в дефекты продукта.
 */
function failureCategory(oracle, toolStats) {
  if (oracle.verdict === "PASS") return "—";
  if (oracle.checks.some((c) => c.status === "error")) return "oracle (проверка не смогла выполниться)";
  if (oracle.verdict === "INCONCLUSIVE") return "oracle (постусловие не автоматизировано)";
  if (toolStats?.failedCalls > 0) {
    return `product | agent | sim-use — требует классификации (${toolStats.failedCalls} вызовов завершились ошибкой)`;
  }
  return "product | agent — требует классификации по Приложению C";
}

// ── validate / list / selftest ────────────────────────────────────────────────

function cmdValidate(f) {
  const ids = f._.length ? f._ : listCases();
  if (!ids.length) die("Нет ни одного case manifest в harness/cases/");
  let bad = 0;
  for (const id of ids) {
    try {
      const m = loadManifest(id);
      const un = unsupportedChecks(m);
      const n = (m.oracle.api?.checks?.length || 0) + (m.oracle.ui?.checks?.length || 0);
      console.log(`✓ ${id}: платформа ${m.platform}, seed ${m.preconditions.apiSeed.length}, проверок ${n}`
        + `${m.oracle.manualChecks?.length ? `, ручных ${m.oracle.manualChecks.length}` : ""}`
        + `${un.length ? `, НЕ ПОДДЕРЖАНО: ${un.join(", ")}` : ""}`);
    } catch (err) {
      bad++;
      console.log(`✗ ${id}: ${err.message}`);
    }
  }
  if (bad) process.exit(1);
}

/** Проверка среды без начала run — агент может позвать её отдельно. */
async function cmdPreflight(f) {
  const platform = requireFlag(f, "platform");
  const device = requireFlag(f, "device");
  const adapter = f.case && f.case !== true ? adapterFor(loadManifest(f.case)) : null;
  const context = adapter ? await adapter.createContext({ platform, device }).catch(() => null) : null;

  const pre = await runPreflight(adapter, { platform, device, context });
  console.log(renderPreflight(pre));
  const app = observedApp(device);
  console.log(`  ${app ? "✓" : "?"} наблюдаемое приложение: ${app || "экран не читается или приложение не запущено"}`);
  console.log(pre.ok ? "\npreflight пройден" : `\npreflight НЕ пройден: ${pre.failed.length} блокирующих`);
  if (!pre.ok) process.exit(1);
}

function cmdList() {
  for (const id of listCases()) {
    try {
      const m = loadManifest(id);
      console.log(`${id.padEnd(28)} ${m.platform.padEnd(8)} ${m.title || ""}`);
    } catch (err) {
      console.log(`${id.padEnd(28)} — ошибка: ${err.message}`);
    }
  }
}

// ── summary: сводный отчёт серии ──────────────────────────────────────────────

function cmdSummary(f) {
  const stage = f.stage && f.stage !== true ? f.stage : STAGE;
  const platforms = f.platform && f.platform !== true ? [f.platform] : ["ios", "android"];
  const { markdown, json } = renderSummary(stage, platforms);

  // Сгенерированные отчёты — вне Git (evals/reports/ уже в .gitignore).
  const outDir = f.out && f.out !== true
    ? f.out
    : fileURLToPath(new URL("../evals/reports", import.meta.url));
  mkdirSync(outDir, { recursive: true });
  const base = `${outDir}/stage-${stage}-summary`;
  writeFileSync(`${base}.md`, markdown);
  writeFileSync(`${base}.json`, JSON.stringify(json, null, 2));

  console.log(markdown);
  console.log(`\nсохранено: ${base}.md и ${base}.json`);
}

async function cmdSelftest() {
  const { selftest } = await import("./selftest.mjs");
  await selftest();
}

// ── точка входа ───────────────────────────────────────────────────────────────

const [cmd, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);

try {
  switch (cmd) {
    case "start": await cmdStart(flags); break;
    case "arm": cmdArm(flags); break;
    case "finish": await cmdFinish(flags); break;
    case "abort": await cmdAbort(flags); break;
    case "preflight": await cmdPreflight(flags); break;
    case "validate": cmdValidate(flags); break;
    case "list": cmdList(); break;
    case "new-workspace": console.log(newWorkspaceId()); break;
    case "summary": cmdSummary(flags); break;
    case "selftest": await cmdSelftest(); break;
    default:
      console.error("Команды: list | validate [case] | preflight | new-workspace | start | arm | finish | abort | summary | selftest");
      process.exit(2);
  }
} catch (err) {
  if (err instanceof ManifestError) die(`Манифест: ${err.message}`);
  throw err;
}

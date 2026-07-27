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

import { IssuesClient } from "../tools/lib/client.mjs";
import { newWorkspaceId } from "../tools/lib/workspace.mjs";
import { seedIssues, teardownWorkspace } from "../tools/lib/fixtures.mjs";
import { captureSnapshot, evidenceRoot, runDir } from "../tools/lib/capture.mjs";
import { loadManifest, listCases, unsupportedChecks, ManifestError } from "./lib/manifest.mjs";
import { runOracle, uiText } from "./lib/oracle-runner.mjs";
import { versionManifest } from "./lib/versions.mjs";
import { renderReport, reportStructure } from "./lib/report.mjs";

const STAGE = process.env.HARNESS_STAGE || "10";
const PROXY_CLI = fileURLToPath(new URL("../tools/proxy.mjs", import.meta.url));

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

function client(state) {
  return new IssuesClient(state.versions?.baseUrl || undefined, state.workspaceId);
}

function resetFaultProfile() {
  try {
    execFileSync("node", [PROXY_CLI, "reset"], { stdio: ["ignore", "pipe", "pipe"] });
    return "fault profile → passthrough";
  } catch (err) {
    return `сброс fault profile не выполнен: ${err.message}`;
  }
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

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const runId = f.run && f.run !== true ? f.run : `${manifest.id}-${platform}-${stamp}`;
  // --workspace позволяет заранее навести приложение на пространство run'а,
  // чтобы исходный снимок UI отражал реальное стартовое состояние агента.
  const workspaceId = f.workspace && f.workspace !== true ? f.workspace : newWorkspaceId();
  const dir = runDir(STAGE, platform, runId);
  mkdirSync(dir, { recursive: true });

  const versions = versionManifest({
    deviceId: device, platform,
    agentModel: f.model !== true ? f.model : null,
    skillRevision: f.skill !== true ? f.skill : null,
  });
  writeFileSync(`${dir}/version-manifest.json`, JSON.stringify(versions, null, 2));

  // Seed строго до UI-задачи: агент получает точное известное начальное состояние.
  const api = new IssuesClient(versions.baseUrl, workspaceId);
  let seeded = [];
  if (manifest.preconditions.apiSeed.length) {
    seeded = await seedIssues(api, manifest.preconditions.apiSeed);
  }

  const apiBefore = await api.list();
  writeFileSync(`${dir}/api-before.json`, JSON.stringify(apiBefore.body, null, 2));

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
    runId, caseId: manifest.id, platform, device, workspaceId,
    startedAt: new Date().toISOString(),
    seeded: seeded.map((s) => ({ id: s.id, title: s.title, status: s.status, severity: s.severity })),
    versions, manifestPath: `cases/${manifest.id}.yaml`,
    limits: manifest.limits,
    status: "started",
  };
  saveState(state);

  console.log(`run:        ${runId}`);
  console.log(`case:       ${manifest.id} (${manifest.title || "—"})`);
  console.log(`platform:   ${platform}${device ? ` / ${device}` : " (без устройства)"}`);
  console.log(`workspace:  ${workspaceId}`);
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
    console.log(`ВНИМАНИЕ: seed создан после снимка. Наведите приложение на Workspace ${workspaceId},`);
    console.log(`дождитесь загрузки списка и переснимите исходное состояние:`);
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
  const api = client(state);

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

  // 2. Финальное состояние API — до teardown.
  const apiAfter = await api.list();
  writeFileSync(`${dir}/api-after.json`, JSON.stringify(apiAfter.body, null, 2));
  const apiBefore = { status: 200, body: JSON.parse(readFileSync(`${dir}/api-before.json`, "utf8")) };

  // 3. Артефакты агента.
  const transcript = copyArtifact(f.transcript, dir, "transcript.txt");

  // 4. Oracle.
  const oracle = await runOracle(manifest, {
    client: api, workspaceId: state.workspaceId,
    seeded: state.seeded, apiBefore, apiAfter,
    finalUiText: uiText(finalUiRaw),
    manualConfirmed: Boolean(f["confirm-manual"]),
  });

  // 5. Teardown — всегда, независимо от verdict.
  const teardown = await doTeardown(manifest, api, state);

  finalizeRun({ f, state, manifest, dir, runId, apiBefore, apiAfter, oracle, teardown, transcript, captureError });
}

// ── abort: аварийное завершение ───────────────────────────────────────────────

async function cmdAbort(f) {
  const runId = requireFlag(f, "run");
  const reason = requireFlag(f, "reason");
  const state = findRun(runId, f.platform !== true ? f.platform : null);
  const manifest = loadManifest(state.caseId);
  const dir = runDir(STAGE, state.platform, runId);
  const api = client(state);

  // Всё собирается best-effort: run уже аварийный, отсутствие артефакта не
  // должно мешать очистке данных.
  let captureError = null;
  if (state.device) {
    try {
      captureSnapshot({ stage: STAGE, platform: state.platform, run: runId, phase: "final", device: state.device });
    } catch (err) { captureError = err.message; }
  }
  let apiAfter = { status: null, body: { items: [], total: null } };
  try {
    apiAfter = await api.list();
    writeFileSync(`${dir}/api-after.json`, JSON.stringify(apiAfter.body, null, 2));
  } catch (err) { captureError = `${captureError ? captureError + "; " : ""}api-after: ${err.message}`; }

  const apiBefore = existsSync(`${dir}/api-before.json`)
    ? { status: 200, body: JSON.parse(readFileSync(`${dir}/api-before.json`, "utf8")) }
    : { status: null, body: { items: [] } };
  const transcript = copyArtifact(f.transcript, dir, "transcript.txt");

  const teardown = await doTeardown(manifest, api, state, { force: true });

  const verdict = f.verdict && f.verdict !== true ? f.verdict : "BLOCKED";
  const oracle = {
    verdict,
    checks: [],
    reasons: [`run прерван до завершения: ${reason}`],
  };
  finalizeRun({
    f, state, manifest, dir, runId, apiBefore, apiAfter, oracle, teardown, transcript, captureError,
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

function basename(p) { return p.split("/").filter(Boolean).pop(); }

async function doTeardown(manifest, api, state, { force = false } = {}) {
  const parts = [];
  if (manifest.teardown.deleteCreatedIssues || force) {
    try {
      const report = await teardownWorkspace(api, { workspaceId: state.workspaceId });
      parts.push(`удалено ${report.deleted.length}, отсутствовало ${report.alreadyAbsent.length}, не удалось ${report.failed.length}`);
      if (report.failed.length) parts.push(`НЕОЧИЩЕННЫЕ FIXTURES: ${JSON.stringify(report.failed)}`);
    } catch (err) {
      parts.push(`ОШИБКА teardown: ${err.message}`);
    }
  } else {
    parts.push("удаление данных отключено манифестом");
  }
  if (manifest.teardown.resetFaultProfile !== false) parts.push(resetFaultProfile());
  return parts.join("; ");
}

function finalizeRun(o) {
  const { f, state, manifest, dir, runId, apiBefore, apiAfter, oracle, teardown, transcript, captureError } = o;

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
    "Workspace / test namespace": state.workspaceId,
    "Start state": `seed ${state.seeded.length} записей, api-before total=${apiBefore.body?.total ?? "?"}`,
    "Instruction": manifest.instruction.trim().replace(/\n+/g, " "),
    "Allowed / forbidden actions":
      `разрешено: ${manifest.allowedActions.join(", ")} | запрещено: ${manifest.forbiddenActions.join(", ")}`,
    "Started at / finished at": `${state.startedAt} → ${finishedAt}`,
    "Tool calls": num(f["tool-calls"]),
    "Retries": num(f.retries),
    "Manual interventions": num(f.interventions),
    "API before": `total=${apiBefore.body?.total ?? "?"} → runs/${runId}/api-before.json`,
    "API after": `total=${apiAfter.body?.total ?? "?"} → runs/${runId}/api-after.json`,
    "UI postcondition": artifacts.finalUi
      ? `финальный outline снят (runs/${runId}/final-ui.json)`
      : `финальный outline отсутствует${captureError ? `: ${captureError}` : ""}`,
    "Oracle result": oracle.checks.length
      ? oracle.checks.map((c) => `${c.kind}.${c.type}=${c.status}`).join(", ")
      : "проверки не выполнялись",
    "Agent self-report": f["self-report"] !== true ? f["self-report"] : null,
    "Final verdict": oracle.verdict,
    "Failure category": o.category || failureCategory(oracle),
    "Evidence paths": Object.entries(artifacts).filter(([, v]) => v).map(([k]) => k).join(", "),
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
    workspaceId: state.workspaceId,
    device: state.device, versions: state.versions,
    oracleChecks: oracle.checks.map((c) => ({ kind: c.kind, type: c.type, status: c.status, message: c.message })),
    oracleReasons: oracle.reasons,
    unsupportedChecks: unsupported,
    toolCalls: numOrNull(f["tool-calls"]), retries: numOrNull(f.retries),
    interventions: numOrNull(f.interventions),
    selfReport: f["self-report"] !== true ? f["self-report"] || null : null,
    aborted: Boolean(o.aborted), abortReason: o.abortReason || null,
    teardown, artifacts, evidenceComplete,
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

function failureCategory(oracle) {
  if (oracle.verdict === "PASS") return "—";
  if (oracle.checks.some((c) => c.status === "error")) return "oracle";
  if (oracle.verdict === "INCONCLUSIVE") return "oracle (постусловие не автоматизировано)";
  return "требует классификации по Приложению C";
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
    case "validate": cmdValidate(flags); break;
    case "list": cmdList(); break;
    case "new-workspace": console.log(newWorkspaceId()); break;
    case "selftest": await cmdSelftest(); break;
    default:
      console.error("Команды: list | validate [case] | new-workspace | start | arm | finish | abort | selftest");
      process.exit(2);
  }
} catch (err) {
  if (err instanceof ManifestError) die(`Манифест: ${err.message}`);
  throw err;
}

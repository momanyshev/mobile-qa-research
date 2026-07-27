// Selftest контура harness. Проверяет то, от чего зависит достоверность
// benchmark: манифест не читается «как получится», oracle честно различает
// PASS/FAIL/INCONCLUSIVE, teardown срабатывает после аварийного прерывания, а
// два run одного case дают отчёты одинаковой структуры.
//
// Требуется работающий backend (npm run dev, порт 8888). Устройство не нужно:
// UI-проверки в этом режиме обязаны давать INCONCLUSIVE, что тоже проверяется.
//
// Запуск: node harness.mjs selftest

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseYaml, YamlError } from "./lib/yaml.mjs";
import { validateManifest, loadManifest, listCases, ManifestError } from "./lib/manifest.mjs";
import { runOracle, uiText } from "./lib/oracle-runner.mjs";
import { renderReport, reportStructure, REPORT_FIELDS } from "./lib/report.mjs";
import { classifyCall, runLogged, summarizeLog, renderTranscript } from "./lib/cmdlog.mjs";
import { needsDiagnostics } from "./lib/diagnostics.mjs";
import { IssuesClient } from "../tools/lib/client.mjs";
import { teardownWorkspace } from "../tools/lib/fixtures.mjs";

const HARNESS = fileURLToPath(new URL("./harness.mjs", import.meta.url));
const SELFTEST_STAGE = "10-selftest";
const EV_DIR = fileURLToPath(new URL(`../evidence/stage-${SELFTEST_STAGE}`, import.meta.url));

class Tally {
  constructor() { this.pass = 0; this.fail = 0; }
  ok(name, cond, detail = "") {
    if (cond) { this.pass++; console.log(`  ✓ ${name}`); }
    else { this.fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
  }
  async throws(name, fn, ErrType) {
    try { await fn(); this.fail++; console.log(`  ✗ ${name} — ошибка не выброшена`); }
    catch (err) {
      const good = !ErrType || err instanceof ErrType;
      if (good) { this.pass++; console.log(`  ✓ ${name}`); }
      else { this.fail++; console.log(`  ✗ ${name} — неожиданный тип: ${err.name}`); }
    }
  }
}

function harness(args, env = {}) {
  return execFileSync("node", [HARNESS, ...args], {
    encoding: "utf8", env: { ...process.env, HARNESS_STAGE: SELFTEST_STAGE, ...env },
  });
}

function runIdFrom(output) {
  const m = /^run:\s+(\S+)/m.exec(output);
  if (!m) throw new Error(`Не удалось прочитать runId из вывода:\n${output}`);
  return m[1];
}

function workspaceFrom(output) {
  const m = /^workspace:\s+(\S+)/m.exec(output);
  return m ? m[1] : null;
}

function jsonlLast(platform) {
  const path = `${EV_DIR}/${platform}/runs.jsonl`;
  const lines = readFileSync(path, "utf8").trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
}

// ── 1. Парсер ─────────────────────────────────────────────────────────────────

async function yamlTests(t) {
  console.log("\nYAML-парсер (строгость):");
  await t.throws("табуляция отвергнута", () => parseYaml("a:\n\tb: 1\n"), YamlError);
  await t.throws("flow-коллекция отвергнута", () => parseYaml("a: [1, 2]\n"), YamlError);
  await t.throws("якорь отвергнут", () => parseYaml("a: &x 1\n"), YamlError);
  await t.throws("дубль ключа отвергнут", () => parseYaml("a: 1\na: 2\n"), YamlError);
  await t.throws("многодокументный отвергнут", () => parseYaml("---\na: 1\n"), YamlError);
  const doc = parseYaml("a: 1\nb:\n  - x\n  - y\nc: \"текст # не комментарий\"\n");
  t.ok("вложенные структуры разобраны", doc.a === 1 && doc.b.length === 2 && doc.c.includes("#"));
}

// ── 2. Манифесты ──────────────────────────────────────────────────────────────

async function manifestTests(t) {
  console.log("\nВалидация манифестов:");
  const cases = listCases();
  t.ok("найдены все шесть pilot-case", cases.length >= 6, `найдено ${cases.length}`);
  for (const id of cases) {
    try { loadManifest(id); t.ok(`манифест ${id} валиден`, true); }
    catch (err) { t.ok(`манифест ${id} валиден`, false, err.message); }
  }
  await t.throws("отсутствие обязательного ключа отвергнуто",
    () => validateManifest({ id: "x" }), ManifestError);
  await t.throws("неизвестный ключ верхнего уровня отвергнут",
    () => validateManifest({ ...minimal(), somethingElse: 1 }), ManifestError);
  await t.throws("oracle без единой проверки отвергнут",
    () => validateManifest({ ...minimal(), oracle: { api: { checks: [] } } }), ManifestError);
  t.ok("минимальный корректный манифест принят", Boolean(validateManifest(minimal())));
}

function minimal() {
  return {
    id: "m", platform: "any", appId: "ru.maksim.qalab", instruction: "делай",
    preconditions: { workspaceId: "generated-per-run", apiSeed: [] },
    allowedActions: ["read-ui"], forbiddenActions: ["production-access"],
    limits: { timeoutSeconds: 60, retryPerAction: 3 },
    oracle: { api: { checks: [{ type: "count", expected: 0 }] } },
    evidence: ["transcript"], teardown: { deleteCreatedIssues: true },
  };
}

// ── 3. Oracle ─────────────────────────────────────────────────────────────────

async function oracleTests(t) {
  console.log("\nOracle (PASS / FAIL / INCONCLUSIVE):");
  const issue = {
    id: "i1", title: "Тест", description: "описание длиннее десяти символов",
    severity: "high", status: "open", createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const list = (items) => ({ status: 200, body: { items, total: items.length } });
  const stubClient = { list: async () => list([]), get: async () => ({ status: 404, body: { error: { code: "NOT_FOUND" } } }) };
  const ctx = (over = {}) => ({
    client: stubClient, workspaceId: "ws", seeded: [issue],
    apiBefore: list([issue]), apiAfter: list([issue]),
    finalUiText: "Тест\nПрочий текст", manualConfirmed: false, ...over,
  });
  const man = (oracle) => ({ ...minimal(), oracle });

  let r = await runOracle(man({ api: { checks: [{ type: "count", expected: 1 }] } }), ctx());
  t.ok("count совпал → PASS", r.verdict === "PASS", r.reasons.join("; "));

  r = await runOracle(man({ api: { checks: [{ type: "count", expected: 2 }] } }), ctx());
  t.ok("count не совпал → FAIL", r.verdict === "FAIL");

  r = await runOracle(man({ api: { checks: [{ type: "fields", where: { title: "Тест" }, expect: { severity: "high" } }] } }), ctx());
  t.ok("fields совпали → PASS", r.verdict === "PASS", r.reasons.join("; "));

  r = await runOracle(man({ api: { checks: [{ type: "fields", where: { title: "Тест" }, expect: { severity: "low" } }] } }), ctx());
  t.ok("fields разошлись → FAIL", r.verdict === "FAIL");

  const edited = { ...issue, severity: "blocker", updatedAt: "2026-01-02T00:00:00.000Z" };
  r = await runOracle(man({ api: { checks: [{ type: "onlyChanged", seedIndex: 0, changed: { severity: "blocker" } }] } }),
    ctx({ apiAfter: list([edited]) }));
  t.ok("onlyChanged: изменилось ровно ожидаемое → PASS", r.verdict === "PASS", r.reasons.join("; "));

  const overEdited = { ...edited, title: "Изменённый заголовок" };
  r = await runOracle(man({ api: { checks: [{ type: "onlyChanged", seedIndex: 0, changed: { severity: "blocker" } }] } }),
    ctx({ apiAfter: list([overEdited]) }));
  t.ok("onlyChanged: непрошеная мутация → FAIL", r.verdict === "FAIL");

  r = await runOracle(man({ api: { checks: [{ type: "unchanged" }] } }), ctx());
  t.ok("unchanged: backend не тронут → PASS", r.verdict === "PASS");

  r = await runOracle(man({ api: { checks: [{ type: "unchanged" }] } }), ctx({ apiAfter: list([]) }));
  t.ok("unchanged: состояние изменилось → FAIL", r.verdict === "FAIL");

  r = await runOracle(man({ api: { checks: [{ type: "absent", seedIndex: 0 }] } }), ctx());
  t.ok("absent: запись удалена → PASS", r.verdict === "PASS", r.reasons.join("; "));

  r = await runOracle(man({ ui: { checks: [{ type: "containsText", text: "Тест" }] } }), ctx());
  t.ok("ui.containsText найден → PASS", r.verdict === "PASS");

  r = await runOracle(man({ ui: { checks: [{ type: "containsText", text: "Отсутствует" }] } }), ctx());
  t.ok("ui.containsText не найден → FAIL", r.verdict === "FAIL");

  r = await runOracle(man({ ui: { checks: [{ type: "notContainsText", text: "Тест" }] } }), ctx());
  t.ok("ui.notContainsText нарушен → FAIL", r.verdict === "FAIL");

  r = await runOracle(man({ ui: { checks: [{ type: "containsText", text: "Тест" }] } }), ctx({ finalUiText: "" }));
  t.ok("нет финального UI → INCONCLUSIVE, а не PASS", r.verdict === "INCONCLUSIVE");

  r = await runOracle(man({ api: { checks: [{ type: "totallyNewCheck" }] } }), ctx());
  t.ok("неизвестный тип проверки → INCONCLUSIVE", r.verdict === "INCONCLUSIVE");

  r = await runOracle(man({ api: { checks: [{ type: "count", expected: 1 }] }, manualChecks: ["человек подтверждает"] }), ctx());
  t.ok("неподтверждённая ручная проверка → INCONCLUSIVE", r.verdict === "INCONCLUSIVE");

  r = await runOracle(man({ api: { checks: [{ type: "count", expected: 1 }] }, manualChecks: ["человек подтверждает"] }),
    ctx({ manualConfirmed: true }));
  t.ok("подтверждённая ручная проверка → PASS", r.verdict === "PASS");

  r = await runOracle(man({ api: { checks: [{ type: "count", expected: 2 }, { type: "totallyNewCheck" }] } }), ctx());
  t.ok("FAIL важнее INCONCLUSIVE", r.verdict === "FAIL");

  t.ok("uiText вытаскивает строки из дерева",
    uiText(JSON.stringify({ a: { label: "Кнопка" }, b: [{ label: "Поле" }] })).includes("Кнопка"));
}

// ── 3.5. Журнал вызовов ───────────────────────────────────────────────────────

async function cmdlogTests(t) {
  console.log("\nЖурнал вызовов (этап 11):");
  t.ok("tap по id классифицируется как selector",
    classifyCall(["tap", "#create-issue-button", "--device", "X"]).selector === "selector");
  t.ok("tap по координатам классифицируется как coordinate",
    classifyCall(["tap", "--x", "10", "--y", "20", "--device", "X"]).selector === "coordinate");
  t.ok("tap по --label — selector",
    classifyCall(["tap", "--label", "Создать", "--device", "X"]).selector === "selector");
  t.ok("ui — наблюдение, не действие",
    classifyCall(["ui", "--json", "--device", "X"]).kind === "observe");

  const logPath = `${EV_DIR}/cmdlog-probe/commands.jsonl`;
  const okCall = runLogged(logPath, ["ok-line"], { bin: "echo" });
  t.ok("успешный вызов записан с exit 0", okCall.status === 0 && okCall.entry.exitCode === 0);
  t.ok("длительность вызова измерена", Number.isFinite(okCall.entry.durationMs));
  t.ok("stdout сохранён в журнале", okCall.entry.stdout.includes("ok-line"));

  const failCall = runLogged(logPath, ["-c", "echo boom >&2; exit 3"], { bin: "sh" });
  t.ok("ненулевой exit code сохранён", failCall.entry.exitCode === 3, `получено ${failCall.entry.exitCode}`);
  t.ok("stderr сохранён", failCall.entry.stderr.includes("boom"));

  const stats = summarizeLog(logPath);
  t.ok("сводка считает все вызовы", stats.totalCalls === 2, `totalCalls=${stats.totalCalls}`);
  t.ok("сводка считает ошибочные вызовы", stats.failedCalls === 1);

  const transcript = renderTranscript(logPath);
  t.ok("transcript выводится из журнала", transcript.includes("ok-line") && transcript.includes("exit=3"));

  t.ok("диагностика требуется только при неуспехе",
    needsDiagnostics("FAIL") && needsDiagnostics("BLOCKED") && !needsDiagnostics("PASS"));
}

// ── 4. Отчёт ──────────────────────────────────────────────────────────────────

async function reportTests(t) {
  console.log("\nОтчёт (Приложение B):");
  const a = renderReport({ "Run ID": "r1", "Final verdict": "PASS" });
  const b = renderReport({ "Run ID": "r2", "Final verdict": "FAIL", "Retries": 3 });
  t.ok("структура одинакова при разных исходах",
    JSON.stringify(reportStructure(a)) === JSON.stringify(reportStructure(b)));
  t.ok("присутствуют все поля шаблона", reportStructure(a).length === REPORT_FIELDS.length);
  await t.throws("неизвестное поле отчёта отвергнуто", () => renderReport({ "Нет такого поля": 1 }));
}

// ── 5. Полный цикл против живого backend ──────────────────────────────────────

async function cycleTests(t) {
  console.log("\nЦикл start → finish (без устройства, живой backend):");
  const api = new IssuesClient();
  const probe = await api.list({ workspaceId: "00000000-0000-4000-8000-000000000000" });
  if (probe.status !== 200) {
    console.log("  ⚠ backend недоступен — цикл пропущен (запустите npm run dev)");
    return;
  }

  // 5.1. Корректное выполнение задачи «агентом» через API.
  let out = harness(["start", "--case", "C1-create-issue", "--platform", "ios", "--no-device"]);
  const run1 = runIdFrom(out);
  const ws1 = workspaceFrom(out);
  await api.create({
    title: "Кнопка сохранения не реагирует",
    description: "Кнопка остаётся неактивной после заполнения всех обязательных полей",
    severity: "high", status: "open",
  }, { workspaceId: ws1 });
  out = harness(["finish", "--run", run1, "--tool-calls", "7", "--retries", "0", "--interventions", "0"]);
  const e1 = jsonlLast("ios");
  t.ok("API-проверки прошли, но без UI verdict = INCONCLUSIVE", e1.verdict === "INCONCLUSIVE", e1.verdict);
  t.ok("api-проверки в журнале отмечены pass",
    e1.oracleChecks.filter((c) => c.kind === "api").every((c) => c.status === "pass"));
  t.ok("evidenceComplete=false без UI-артефактов", e1.evidenceComplete === false);
  t.ok("teardown очистил Workspace", /удалено 1/.test(e1.teardown), e1.teardown);
  const after1 = await api.list({ workspaceId: ws1 });
  t.ok("после teardown Workspace пуст", after1.body.total === 0, `total=${after1.body.total}`);

  // 5.2. Неверно выполненная задача обязана давать FAIL, а не INCONCLUSIVE.
  out = harness(["start", "--case", "C1-create-issue", "--platform", "ios", "--no-device"]);
  const run2 = runIdFrom(out);
  const ws2 = workspaceFrom(out);
  await api.create({
    title: "Кнопка сохранения не реагирует",
    description: "Кнопка остаётся неактивной после заполнения всех обязательных полей",
    severity: "low", status: "open",
  }, { workspaceId: ws2 });
  harness(["finish", "--run", run2]);
  const e2 = jsonlLast("ios");
  t.ok("неверная критичность → FAIL", e2.verdict === "FAIL", e2.verdict);
  t.ok("причина FAIL названа", e2.oracleReasons.some((r) => /severity/.test(r)), e2.oracleReasons.join("; "));
  const after2 = await api.list({ workspaceId: ws2 });
  t.ok("teardown отработал и после FAIL", after2.body.total === 0);

  // 5.3. Структура отчётов двух runs одного case совпадает.
  const rep1 = readFileSync(`${EV_DIR}/ios/runs/${run1}/report.txt`, "utf8");
  const rep2 = readFileSync(`${EV_DIR}/ios/runs/${run2}/report.txt`, "utf8");
  t.ok("отчёты PASS-пути и FAIL-пути имеют одинаковую структуру",
    JSON.stringify(reportStructure(rep1)) === JSON.stringify(reportStructure(rep2)));

  // 5.4. Аварийное прерывание: seed обязан быть убран, verdict — BLOCKED.
  out = harness(["start", "--case", "C2-filters", "--platform", "ios", "--no-device"]);
  const run3 = runIdFrom(out);
  const ws3 = workspaceFrom(out);
  const seeded = await api.list({ workspaceId: ws3 });
  t.ok("seed создан до прерывания", seeded.body.total === 4, `total=${seeded.body.total}`);
  harness(["abort", "--run", run3, "--reason", "selftest: намеренное прерывание run"]);
  const e3 = jsonlLast("ios");
  t.ok("прерванный run → BLOCKED", e3.verdict === "BLOCKED", e3.verdict);
  t.ok("прерванный run помечен aborted", e3.aborted === true);
  t.ok("причина прерывания сохранена", Boolean(e3.abortReason));
  t.ok("evidence прерванного run помечен неполным", e3.evidenceComplete === false);
  const after3 = await api.list({ workspaceId: ws3 });
  t.ok("аварийный teardown удалил все fixtures", after3.body.total === 0, `осталось ${after3.body.total}`);
  t.ok("аварийный teardown сбросил fault profile", /passthrough/.test(e3.teardown), e3.teardown);

  // Подчистка за самим selftest.
  for (const ws of [ws1, ws2, ws3]) {
    try { await teardownWorkspace(api, { workspaceId: ws }); } catch {}
  }
  if (existsSync(EV_DIR)) rmSync(EV_DIR, { recursive: true, force: true });
}

export async function selftest() {
  const t = new Tally();
  await yamlTests(t);
  await manifestTests(t);
  await oracleTests(t);
  await cmdlogTests(t);
  await reportTests(t);
  await cycleTests(t);
  console.log(`\nИтого: ${t.pass} PASS, ${t.fail} FAIL`);
  if (t.fail) process.exit(1);
}

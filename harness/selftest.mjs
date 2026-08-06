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
import { readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseYaml, YamlError } from "./lib/yaml.mjs";
import { validateManifest, loadManifest, listCases, ManifestError } from "./lib/manifest.mjs";
import { runOracle as runOracleRaw, uiText } from "./lib/oracle-runner.mjs";
import qalabAdapter, { readWorkspaceFromScreen } from "./adapters/qalab.mjs";
import speecherAdapter from "./adapters/speecher.mjs";
import elementxAdapter from "./adapters/elementx.mjs";
import { getAdapter, listAdapters } from "./adapters/index.mjs";
import { renderReport, reportStructure, REPORT_FIELDS } from "./lib/report.mjs";
import { classifyCall, runLogged, summarizeLog, renderTranscript, retryViolations } from "./lib/cmdlog.mjs";
import { genericPreflight } from "./lib/preflight.mjs";
import { parseCrashSignals, classifyCrashSignal, renderCrashNote } from "./lib/crash-guard.mjs";
import { step as prepareStep } from "./lib/prepare.mjs";
import { needsDiagnostics } from "./lib/diagnostics.mjs";
import { agentContract } from "./lib/versions.mjs";
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

/**
 * Контекст run'а читается из run.json, а не из строки вывода: формат вывода
 * зависит от адаптера, а run.json — машинный контракт.
 */
function workspaceOf(runId, platform = "ios") {
  const state = JSON.parse(readFileSync(`${EV_DIR}/${platform}/runs/${runId}/run.json`, "utf8"));
  return state.context.workspaceId;
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
  const list = (items) => ({ items, total: items.length });
  // Подменяем сетевые методы адаптера, чтобы проверять логику сведения
  // verdict без живого backend.
  const adapter = {
    ...qalabAdapter,
    checks: {
      ...qalabAdapter.checks,
      count: async (check, c) => (check.query
        ? { status: "pass", message: "запрос-проверка не участвует в selftest" }
        : qalabAdapter.checks.count(check, c)),
      absent: async () => ({ status: "pass", message: "запись удалена (404 NOT_FOUND)" }),
      isolation: async () => ({ status: "pass", message: "изоляция подтверждена" }),
    },
  };
  const ctx = (over = {}) => ({
    context: { kind: "workspace", workspaceId: "ws" }, seeded: [issue],
    before: list([issue]), after: list([issue]),
    finalUiText: "Тест\nПрочий текст", manualConfirmed: false, ...over,
  });
  const man = (oracle) => ({ ...minimal(), oracle });
  const runOracle = (m, c) => runOracleRaw(m, adapter, c);

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
    ctx({ after: list([edited]) }));
  t.ok("onlyChanged: изменилось ровно ожидаемое → PASS", r.verdict === "PASS", r.reasons.join("; "));

  const overEdited = { ...edited, title: "Изменённый заголовок" };
  r = await runOracle(man({ api: { checks: [{ type: "onlyChanged", seedIndex: 0, changed: { severity: "blocker" } }] } }),
    ctx({ after: list([overEdited]) }));
  t.ok("onlyChanged: непрошеная мутация → FAIL", r.verdict === "FAIL");

  r = await runOracle(man({ api: { checks: [{ type: "unchanged" }] } }), ctx());
  t.ok("unchanged: backend не тронут → PASS", r.verdict === "PASS");

  r = await runOracle(man({ api: { checks: [{ type: "unchanged" }] } }), ctx({ after: list([]) }));
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

// ── 3.4. Слой адаптеров (этап 12.2) ───────────────────────────────────────────

async function adapterTests(t) {
  console.log("\nProject adapters:");
  t.ok("зарегистрированы qalab, speecher и elementx",
    ["qalab", "speecher", "elementx"].every((id) => listAdapters().includes(id)));
  t.ok("манифест без поля adapter получает qalab", getAdapter().id === "qalab");
  await t.throws("неизвестный adapter отвергнут", () => getAdapter("нет-такого"));
  await t.throws("манифест с неизвестным adapter отвергнут",
    () => validateManifest({ ...minimal(), adapter: "нет-такого" }), ManifestError);

  const contract = ["createContext", "seed", "readState", "teardown", "describeContext"];
  for (const a of [qalabAdapter, speecherAdapter, elementxAdapter]) {
    t.ok(`${a.id} реализует контракт адаптера`,
      contract.every((m) => typeof a[m] === "function"));
  }

  // Speecher: нет backend, поэтому apiSeed должен отвергаться явно, а не
  // молча игнорироваться — иначе run стартовал бы с неизвестным состоянием.
  await t.throws("speecher отвергает apiSeed (у приложения нет backend)",
    () => speecherAdapter.seed({ device: "X" }, [{ title: "x" }]));
  await t.throws("speecher требует устройство",
    () => speecherAdapter.createContext({ platform: "ios" }));
  await t.throws("speecher отвергает android",
    () => speecherAdapter.createContext({ platform: "android", device: "X" }));

  // Предметные проверки Speecher работают на снимках UserDefaults.
  const before = { defaults: { "speecher.appLanguage": "ru" } };
  const after = { defaults: { "speecher.appLanguage": "en-GB" } };
  let r = await speecherAdapter.checks.defaultsEqual(
    { key: "speecher.appLanguage", expected: "en-GB" }, { after });
  t.ok("defaultsEqual совпал → pass", r.status === "pass", r.message);
  r = await speecherAdapter.checks.defaultsEqual(
    { key: "speecher.appLanguage", expected: "ru" }, { after });
  t.ok("defaultsEqual разошёлся → fail", r.status === "fail");
  r = await speecherAdapter.checks.unchanged({}, { before, after });
  t.ok("unchanged видит изменение → fail", r.status === "fail");
  r = await speecherAdapter.checks.unchanged({}, { before, after: before });
  t.ok("unchanged на неизменном состоянии → pass", r.status === "pass");
  r = await speecherAdapter.checks.onlyKeyChanged(
    { key: "speecher.appLanguage", expected: "en-GB" }, { before, after });
  t.ok("onlyKeyChanged: изменился ровно ключ → pass", r.status === "pass", r.message);
  r = await speecherAdapter.checks.onlyKeyChanged(
    { key: "speecher.appLanguage", expected: "en-GB" },
    { before, after: { defaults: { ...after.defaults, "speecher.icon": "dark" } } });
  t.ok("onlyKeyChanged: побочное изменение → fail", r.status === "fail");

  // Element X: проверки на снимках состояния Matrix-сервера.
  await t.throws("elementx отвергает apiSeed (нужен был бы access token)",
    () => elementxAdapter.seed({}, [{ name: "x" }]));
  await t.throws("elementx отвергает ios",
    () => elementxAdapter.createContext({ platform: "ios", device: "X" }));

  const mBefore = { rooms: [], eventCounts: {}, totalEvents: 0, users: 1 };
  const mAfter = {
    rooms: [{ roomId: "!r:s", name: "QA Room", topic: null, encrypted: true, messageEvents: 1 }],
    eventCounts: { "m.room.encrypted": 1 }, totalEvents: 9, users: 1,
  };
  r = await elementxAdapter.checks.roomExists({ name: "QA Room", encrypted: true }, { after: mAfter });
  t.ok("roomExists: комната найдена → pass", r.status === "pass", r.message);
  r = await elementxAdapter.checks.roomExists({ name: "QA Room", topic: "нет такого" }, { after: mAfter });
  t.ok("roomExists: несовпадение топика → fail", r.status === "fail");
  r = await elementxAdapter.checks.roomAbsent({ name: "QA Room" }, { after: mAfter });
  t.ok("roomAbsent: комната есть → fail", r.status === "fail");
  r = await elementxAdapter.checks.roomsAdded({ expected: 1 }, { before: mBefore, after: mAfter });
  t.ok("roomsAdded: ровно одна комната → pass", r.status === "pass", r.message);
  r = await elementxAdapter.checks.eventTypeAdded({ type: "m.room.encrypted", min: 1 }, { before: mBefore, after: mAfter });
  t.ok("eventTypeAdded: сообщение отправлено → pass", r.status === "pass", r.message);
  r = await elementxAdapter.checks.eventTypeAdded({ type: "m.room.encrypted", min: 2 }, { before: mBefore, after: mAfter });
  t.ok("eventTypeAdded: сообщений меньше ожидаемого → fail", r.status === "fail");
  r = await elementxAdapter.checks.unchanged({}, { before: mBefore, after: mAfter });
  t.ok("elementx unchanged: состояние изменилось → fail", r.status === "fail");
  r = await elementxAdapter.checks.unchanged({}, { before: mBefore, after: mBefore });
  t.ok("elementx unchanged: без изменений → pass", r.status === "pass");
}

// ── 3.45. Preflight и retry budget (этап 14.B) ────────────────────────────────

async function preflightTests(t) {
  console.log("\nPreflight и retry budget:");

  // Локаль проверяется по окружению процесса — подменяем на время проверки.
  const saveLang = process.env.LANG, saveAll = process.env.LC_ALL;
  delete process.env.LANG; delete process.env.LC_ALL;
  let checks = genericPreflight({ platform: "ios", device: "нет-такого" });
  const locale = checks.find((c) => c.name === "локаль UTF-8");
  t.ok("пустая локаль → блокирующий отказ", locale && !locale.ok && locale.level === "fail");
  process.env.LANG = "en_US.UTF-8";
  checks = genericPreflight({ platform: "ios", device: "нет-такого" });
  t.ok("UTF-8 локаль принята", checks.find((c) => c.name === "локаль UTF-8")?.ok === true);
  const dev = checks.find((c) => c.name === "целевое устройство доступно");
  t.ok("несуществующее устройство → блокирующий отказ", dev && !dev.ok && dev.level === "fail");
  if (saveLang === undefined) delete process.env.LANG; else process.env.LANG = saveLang;
  if (saveAll === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = saveAll;

  // Retry budget на синтетическом журнале.
  const log = `${EV_DIR}/retry-probe.jsonl`;
  const mk = (seq, args) => JSON.stringify({ seq, command: "tap", kind: "action", selector: "selector", args });
  const write = (lines) => {
    mkdirSync(EV_DIR, { recursive: true });
    writeFileSync(log, lines.join("\n") + "\n");
  };
  write([1, 2, 3].map((i) => mk(i, ["tap", "--label", "Сохранить"])));
  t.ok("три попытки укладываются в бюджет", retryViolations(log, 3).length === 0);
  write([1, 2, 3, 4].map((i) => mk(i, ["tap", "--label", "Сохранить"])));
  const v = retryViolations(log, 3);
  t.ok("четвёртая попытка одной цели → нарушение", v.length === 1 && v[0].attempts === 4, JSON.stringify(v));
  write([
    mk(1, ["tap", "--label", "А"]), mk(2, ["tap", "--label", "Б"]),
    mk(3, ["tap", "--label", "В"]), mk(4, ["tap", "--label", "Г"]),
  ]);
  t.ok("разные цели подряд нарушением не считаются", retryViolations(log, 3).length === 0);
  write([1, 2, 3, 4].map((i) => mk(i, ["tap", "--x", String(100 + i * 5), "--y", "200"])));
  t.ok("координаты рядом трактуются как одна цель", retryViolations(log, 3).length === 1);
  rmSync(log, { force: true });
}

// ── 3.47. Prepare: семантика шага подготовки ──────────────────────────────────

async function prepareTests(t) {
  console.log("\nPrepare (подъём стенда):");

  const run = async (opts) => {
    const out = { steps: [] };
    const value = await prepareStep(out, "проба", opts);
    return { value, s: out.steps[0] };
  };

  // Идемпотентность — главное свойство: повторный prepare на готовом стенде
  // не должен трогать ничего, иначе он сам станет источником дрейфа.
  let r = await run({ check: () => "уже готово", fix: () => { throw new Error("fix не должен вызываться"); } });
  t.ok("выполненное условие не чинится", r.s.status === "ok" && r.value === "уже готово");

  let fixCalls = 0, ready = false;
  r = await run({ check: () => (ready ? "готово" : null), fix: () => { fixCalls++; ready = true; return "починили"; } });
  t.ok("невыполненное условие чинится один раз", r.s.status === "fixed" && fixCalls === 1);
  t.ok("что именно чинилось, видно в отчёте", /починили/.test(r.s.detail));

  // Починка, которая «прошла», но условие не выполнила, — провал, а не успех:
  // молчаливый ok здесь пропустил бы сломанный стенд в прогон.
  r = await run({ check: () => null, fix: () => "сделали вид" });
  t.ok("безрезультатная починка → failed", r.s.status === "failed" && r.value === null);

  r = await run({ check: () => null, fix: () => { throw new Error("нет прав"); } });
  t.ok("исключение в починке → failed с причиной", r.s.status === "failed" && /нет прав/.test(r.s.detail));

  r = await run({ check: () => null });
  t.ok("шаг без fix не выдумывает починку", r.s.status === "failed");

  // Уровень warn не блокирует старт, fail блокирует.
  const steps = [
    { name: "a", status: "failed", level: "warn" },
    { name: "b", status: "failed", level: "fail" },
  ];
  t.ok("блокирует только уровень fail",
    steps.filter((s) => s.status === "failed" && s.level !== "warn").length === 1);

  // Чтение Workspace с экрана: ровно один UUID — иначе отказ, а не догадка.
  const one = '@12 #3  StaticText  "b840eb36-7fcf-4ce9-a95e-9b65c34073bc"  (37,383 366x18)';
  const two = `${one}\n@20 #9  StaticText  "84c88bda-230d-4624-a6d3-2ec4011c19f0"  (37,500 366x18)`;
  const H = (tree) => ({ shq: () => tree });
  t.ok("единственный UUID на экране принимается",
    readWorkspaceFromScreen(H(one), "dev") === "b840eb36-7fcf-4ce9-a95e-9b65c34073bc");
  t.ok("два разных UUID → отказ вместо догадки", readWorkspaceFromScreen(H(two), "dev") === null);
  t.ok("повтор одного UUID неоднозначностью не считается",
    readWorkspaceFromScreen(H(`${one}\n${one}`), "dev") === "b840eb36-7fcf-4ce9-a95e-9b65c34073bc");
  t.ok("экран без UUID → отказ", readWorkspaceFromScreen(H('StaticText  "Записи"'), "dev") === null);
  t.ok("нечитаемый экран → отказ", readWorkspaceFromScreen(H(null), "dev") === null);

  // Роли узлов различаются по платформам: iOS отдаёт StaticText, Android —
  // TextView. Привязка к роли делала чтение односторонне iOS-овым и роняла
  // подготовку на физическом устройстве.
  const android = '@12  TextView  "b840eb36-7fcf-4ce9-a95e-9b65c34073bc"  (111,1186 858x54)';
  t.ok("Android-дерево (TextView) читается так же",
    readWorkspaceFromScreen(H(android), "dev") === "b840eb36-7fcf-4ce9-a95e-9b65c34073bc");
  t.ok("UUID внутри длинной подписи не считается значением",
    readWorkspaceFromScreen(H('TextView  "Workspace b840eb36-7fcf-4ce9-a95e-9b65c34073bc активен"'), "dev") === null);
}

// ── 3.48. Защита от ложного сигнала о крахе (R-59) ────────────────────────────

async function crashGuardTests(t) {
  console.log("\nСигнал о крахе (R-59):");

  // Тексты дословно из прогона на физическом устройстве, а не придуманные:
  // разбор обязан ловить именно то, что печатает инструмент.
  const banner = "================ PROCESS DISAPPEARED ================\n"
    + "ir.ilmili.telegraph (pid 16330) was alive at the previous command and is GONE now.\n"
    + "Likely crash or termination, not a backgrounding. Verify before trusting subsequent actions.\n"
    + "=====================================================\nApp: ru.maksim.qalab  1080x2340";
  const header = "[!] ir.ilmili.telegraph (pid 16330) has not relaunched since it disappeared."
    + " You may be acting against the home screen.\nApp: ru.maksim.qalab  1080x2340";
  const targetBanner = banner.replace(/ir\.ilmili\.telegraph/g, "ru.maksim.qalab");
  const APP = "ru.maksim.qalab";

  t.ok("баннер разобран", parseCrashSignals(banner)[0]?.process === "ir.ilmili.telegraph");
  t.ok("вид сигнала различается", parseCrashSignals(banner)[0]?.kind === "gone"
    && parseCrashSignals(header)[0]?.kind === "not-relaunched");
  t.ok("повторная шапка разобрана", parseCrashSignals(header)[0]?.pid === 16330);
  t.ok("баннер и шапка про один процесс — один сигнал",
    parseCrashSignals(`${banner}\n${header}`).length === 1);
  t.ok("чистый вывод сигналов не даёт", parseCrashSignals("App: ru.maksim.qalab\n@1 Button").length === 0);

  const alive = () => ({ alive: true, pid: 17078 });
  const dead = () => ({ alive: false, pid: null });
  const unknown = () => null;

  let r = classifyCrashSignal({ output: banner, appId: APP, device: "d", verify: alive });
  t.ok("посторонний процесс при живом целевом → foreign", r.verdict === "foreign" && r.targetPid === 17078);
  t.ok("вывод для агента говорит продолжать", /НЕ применяется/.test(renderCrashNote(r, APP)));

  r = classifyCrashSignal({ output: targetBanner, appId: APP, device: "d", verify: alive });
  t.ok("назван целевой пакет → target даже если процесс жив", r.verdict === "target");
  t.ok("вывод для агента говорит остановиться", /остановись/.test(renderCrashNote(r, APP)));

  r = classifyCrashSignal({ output: banner, appId: APP, device: "d", verify: dead });
  t.ok("посторонний назван, но целевой мёртв → target", r.verdict === "target");

  // Неизвестность разрешается в пользу остановки: продолжить по недоказанному
  // «всё в порядке» дороже, чем зря остановиться.
  r = classifyCrashSignal({ output: banner, appId: APP, device: "d", verify: unknown });
  t.ok("состояние целевого не читается → unclear", r.verdict === "unclear");
  t.ok("unclear трактуется как остановка", /остановись/.test(renderCrashNote(r, APP)));

  r = classifyCrashSignal({ output: banner, appId: null, device: "d", verify: alive });
  t.ok("appId прогона неизвестен → unclear, а не foreign", r.verdict === "unclear");

  r = classifyCrashSignal({ output: "обычный вывод", appId: APP, device: "d", verify: alive });
  t.ok("нет сигнала — нет заключения", r.verdict === "none" && renderCrashNote(r, APP) === null);
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

  // Каждая форма координатной адресации, которую принимает sim-use. Неполный
  // список молча занижал метрику coordinate-free: до 30 июля 2026 сюда не
  // попадали `-x/-y`, `--point` и покомпонентные флаги swipe, и прогоны с
  // координатными тапами объявлялись coordinate-free.
  const coordForms = [
    ["короткие -x/-y", ["tap", "-x", "221", "-y", "624", "--device", "X"]],
    ["--point x,y", ["tap", "--point", "220,625", "--device", "X"]],
    ["покомпонентный swipe", ["swipe", "--start-x", "428", "--start-y", "800", "--end-x", "428", "--end-y", "300", "--device", "X"]],
    ["--from/--to", ["swipe", "--from", "428,800", "--to", "428,300", "--device", "X"]],
    ["позиционная пара", ["swipe", "100,200", "100,600", "--device", "X"]],
  ];
  for (const [name, args] of coordForms) {
    t.ok(`координатная форма распознана: ${name}`,
      classifyCall(args).selector === "coordinate", classifyCall(args).selector);
  }
  t.ok("селектор рядом с координатами даёт mixed, а не coordinate",
    classifyCall(["tap", "--id", "btn", "-x", "10", "-y", "20", "--device", "X"]).selector === "mixed");

  // Ручная проверка: три исхода. Раньше их было два, и наблюдаемое нарушение
  // выглядело как «недоказуемо» — провалы прятались в INCONCLUSIVE.
  const manualManifest = {
    oracle: { api: { checks: [] }, manualChecks: ["агент остановился при crash"] },
  };
  const manualCases = [
    ["не подтверждена → INCONCLUSIVE", {}, "INCONCLUSIVE"],
    ["подтверждена → PASS", { manualConfirmed: true }, "PASS"],
    ["нарушение зафиксировано → FAIL", { manualFailed: "перезапустил приложение" }, "FAIL"],
  ];
  for (const [name, ctx, expected] of manualCases) {
    const res = await runOracleRaw(manualManifest, {}, ctx);
    t.ok(`ручная проверка: ${name}`, res.verdict === expected, res.verdict);
  }
  const failedOracle = await runOracleRaw(manualManifest, {}, { manualFailed: "перезапустил приложение" });
  t.ok("причина нарушения попадает в сообщение проверки",
    /перезапустил приложение/.test(failedOracle.checks[0].message), failedOracle.checks[0].message);

  // Ревизия контракта агента считается из файла, а не задаётся строкой: иначе
  // по отчёту нельзя установить, какие правила действовали в прогоне (R-44).
  const contract = agentContract();
  t.ok("контракт агента прочитан", contract.bytes > 0, contract.error || "пусто");
  t.ok("ревизия контракта — хеш содержимого", /^[0-9a-f]{12}$/.test(contract.sha256 || ""), contract.sha256);
  t.ok("ревизия совпадает при повторном вычислении", agentContract().sha256 === contract.sha256);
  t.ok("контракт содержит правило остановки при crash",
    /PROCESS DISAPPEARED/.test(readFileSync(new URL("../mobile-qa-agent/SKILL.md", import.meta.url), "utf8")));

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
  const ws1 = workspaceOf(run1);
  // Дефект требует шагов и результатов с момента появления типа записи
  // (коммит приложения 735612d). Без них создание возвращает 422, и selftest
  // ловил бы не логику контура, а устаревшую фикстуру.
  await api.create({
    title: "Кнопка сохранения не реагирует",
    description: "Кнопка остаётся неактивной после заполнения всех обязательных полей",
    severity: "high", status: "open",
    stepsToReproduce: "Открыть форму, заполнить все поля и нажать кнопку сохранения",
    expectedResult: "Запись сохраняется",
    actualResult: "Кнопка не реагирует",
  }, { workspaceId: ws1 });
  out = harness(["finish", "--run", run1, "--tool-calls", "7", "--retries", "0", "--interventions", "0"]);
  const e1 = jsonlLast("ios");
  t.ok("API-проверки прошли, но без UI verdict = INCONCLUSIVE", e1.verdict === "INCONCLUSIVE", e1.verdict);
  t.ok("api-проверки в журнале отмечены pass",
    e1.oracleChecks.filter((c) => c.kind === "api").every((c) => c.status === "pass"));
  t.ok("evidenceComplete=false без UI-артефактов", e1.evidenceComplete === false);
  // Видео обязательно только там, где есть что записывать: run без устройства
  // не должен требовать файла, которого физически быть не может.
  t.ok("run без устройства не требует видео", !("video" in e1.artifacts),
    `artifacts.video = ${e1.artifacts.video}`);
  t.ok("видео не числится и в необязательных", !("video" in e1.extras));
  t.ok("teardown очистил Workspace", /удалено 1/.test(e1.teardown), e1.teardown);
  const after1 = await api.list({ workspaceId: ws1 });
  t.ok("после teardown Workspace пуст", after1.body.total === 0, `total=${after1.body.total}`);

  // 5.2. Неверно выполненная задача обязана давать FAIL, а не INCONCLUSIVE.
  out = harness(["start", "--case", "C1-create-issue", "--platform", "ios", "--no-device"]);
  const run2 = runIdFrom(out);
  const ws2 = workspaceOf(run2);
  await api.create({
    title: "Кнопка сохранения не реагирует",
    description: "Кнопка остаётся неактивной после заполнения всех обязательных полей",
    severity: "low", status: "open",
    stepsToReproduce: "Открыть форму, заполнить все поля и нажать кнопку сохранения",
    expectedResult: "Запись сохраняется",
    actualResult: "Кнопка не реагирует",
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
  const ws3 = workspaceOf(run3);
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

  // 5.5. Закрытый run не переигрывается. Второй finish прогнал бы oracle уже
  // после teardown: fixtures удалены, count вернул бы 0, и заведомо ложный FAIL
  // затёр бы корректный verdict. Проверяется на обоих закрывающих командах.
  for (const [cmd, extra] of [["finish", []], ["abort", ["--reason", "повтор"]]]) {
    let refused = false, message = "";
    try {
      harness([cmd, "--run", run3, ...extra]);
    } catch (err) {
      refused = true;
      message = String(err.stderr || err.stdout || err.message);
    }
    t.ok(`повторный ${cmd} закрытого run отклонён`, refused, "команда выполнилась вместо отказа");
    t.ok(`отказ ${cmd} объясняет причину`, /уже закрыт/.test(message), message.split("\n")[0]);
  }
  const after3b = await api.list({ workspaceId: ws3 });
  t.ok("отклонённый повтор не тронул состояние", after3b.body.total === 0, `total=${after3b.body.total}`);

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
  await adapterTests(t);
  await preflightTests(t);
  await prepareTests(t);
  await crashGuardTests(t);
  await cmdlogTests(t);
  await reportTests(t);
  await cycleTests(t);
  console.log(`\nИтого: ${t.pass} PASS, ${t.fail} FAIL`);
  if (t.fail) process.exit(1);
}

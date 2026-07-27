// Сводный отчёт серии runs (этап 11) с метриками раздела 10.4 плана.
//
// Главное правило отчётности плана: `BLOCKED` из-за окружения считается
// отдельно и не исключается молча. Поэтому в каждой сводке присутствуют три
// числа — `allStarted`, `blocked` и `evaluable`, а проценты считаются от
// evaluable и всегда сопровождаются абсолютными значениями.
//
// Метрики, которые harness может посчитать объективно из runs.jsonl, считаются;
// те, что требуют ручного ground truth или ручного baseline (correct verdict
// rate, manual time reduction, seeded defect recall), помечаются как
// недоступные, а не подменяются похожими числами.

import { readFileSync, existsSync } from "node:fs";
import { evidenceRoot } from "../../tools/lib/capture.mjs";

export function readRuns(stage, platform) {
  const path = `${evidenceRoot(stage, platform)}/runs.jsonl`;
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map((l) => JSON.parse(l)).filter((r) => r.runId);
}

function pct(n, d) {
  if (!d) return "—";
  return `${Math.round((n / d) * 1000) / 10}% (${n}/${d})`;
}

/** Метрики одной платформы. Все проценты — от evaluable runs. */
export function computeMetrics(runs) {
  const allStarted = runs.length;
  const blocked = runs.filter((r) => r.verdict === "BLOCKED").length;
  const inconclusive = runs.filter((r) => r.verdict === "INCONCLUSIVE").length;
  const evaluable = runs.filter((r) => r.verdict === "PASS" || r.verdict === "FAIL");
  const passed = evaluable.filter((r) => r.verdict === "PASS");

  // pass@1 — по первому независимому run каждого case (runs хронологичны).
  const firstByCase = new Map();
  for (const r of runs) if (!firstByCase.has(r.caseId)) firstByCase.set(r.caseId, r);
  const firstRuns = [...firstByCase.values()];
  const firstPass = firstRuns.filter((r) => r.verdict === "PASS").length;

  // pass@3 — case считается успешным, если PASS есть в первых трёх runs.
  const byCase = new Map();
  for (const r of runs) {
    if (!byCase.has(r.caseId)) byCase.set(r.caseId, []);
    byCase.get(r.caseId).push(r);
  }
  const pass3 = [...byCase.values()].filter((list) => list.slice(0, 3).some((r) => r.verdict === "PASS")).length;

  // Repeatability 4/5 — только для case, у которых есть минимум пять runs.
  const fiveRunCases = [...byCase.values()].filter((l) => l.length >= 5);
  const repeatable = fiveRunCases.filter((l) => l.slice(0, 5).filter((r) => r.verdict === "PASS").length >= 4).length;

  const withInterventions = runs.filter((r) => (r.interventions || 0) > 0).length;
  const completeEvidence = runs.filter((r) => r.evidenceComplete).length;

  // Coordinate-free — среди успешных runs, у которых есть машинный журнал.
  const passedWithLog = passed.filter((r) => r.toolStats && r.toolStats.actionCalls > 0);
  const coordinateFree = passedWithLog.filter((r) => r.toolStats.coordinateActions === 0).length;

  const durations = runs.map((r) => r.durationMs).filter(Number.isFinite);
  const median = durations.length
    ? durations.slice().sort((a, b) => a - b)[Math.floor(durations.length / 2)]
    : null;

  return {
    allStarted, blocked, inconclusive,
    evaluable: evaluable.length,
    passed: passed.length,
    failed: evaluable.length - passed.length,
    cases: byCase.size,
    firstRuns: firstRuns.length, firstPass,
    pass3Cases: pass3,
    fiveRunCases: fiveRunCases.length, repeatable,
    withInterventions, completeEvidence,
    passedWithLog: passedWithLog.length, coordinateFree,
    medianDurationMs: median,
    unresolvedTeardown: runs.filter((r) => /НЕОЧИЩЕННЫЕ|ОШИБКА teardown/.test(r.teardown || "")).length,
  };
}

function metricsTable(m) {
  return [
    "| Метрика | Значение |",
    "| --- | --- |",
    `| Всего запущено runs | ${m.allStarted} |`,
    `| Из них \`BLOCKED\` (окружение) | ${m.blocked} |`,
    `| Из них \`INCONCLUSIVE\` | ${m.inconclusive} |`,
    `| Evaluable runs (PASS+FAIL) | ${m.evaluable} |`,
    `| PASS / FAIL | ${m.passed} / ${m.failed} |`,
    `| \`pass@1\` (первый run каждого case) | ${pct(m.firstPass, m.firstRuns)} |`,
    `| \`pass@3\` | ${pct(m.pass3Cases, m.cases)} |`,
    `| Repeatability 4/5 | ${m.fiveRunCases ? pct(m.repeatable, m.fiveRunCases) : "— (нет case с 5 runs)"} |`,
    `| Evidence completeness | ${pct(m.completeEvidence, m.allStarted)} |`,
    `| Intervention rate | ${pct(m.withInterventions, m.allStarted)} |`,
    `| Blocked rate | ${pct(m.blocked, m.allStarted)} |`,
    `| Coordinate-free rate (успешные с журналом) | ${m.passedWithLog ? pct(m.coordinateFree, m.passedWithLog) : "— (нет журналов вызовов)"} |`,
    `| Неочищенные fixtures | ${m.unresolvedTeardown} |`,
    `| Медианная длительность run | ${m.medianDurationMs !== null ? `${Math.round(m.medianDurationMs / 1000)} с` : "—"} |`,
  ].join("\n");
}

function runsTable(runs) {
  if (!runs.length) return "_Нет runs._";
  const head = [
    "| Run | Case | Verdict | Evidence | Вызовы | Причина / категория |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  const rows = runs.map((r) => {
    const reason = r.verdict === "PASS" ? "—" : (r.oracleReasons?.[0] || r.abortReason || "—");
    const calls = r.toolStats ? `${r.toolStats.totalCalls} (коорд. ${r.toolStats.coordinateActions})` : (r.toolCalls ?? "—");
    return `| ${r.runId} | ${r.caseId} | ${r.verdict} | ${r.evidenceComplete ? "полон" : "неполон"} | ${calls} | ${String(reason).replace(/\|/g, "\\|").slice(0, 120)} |`;
  });
  return [...head, ...rows].join("\n");
}

/** Полный Markdown-отчёт по этапу. */
export function renderSummary(stage, platforms) {
  const generatedAt = new Date().toISOString();
  const parts = [
    `# Сводный отчёт серии runs — этап ${stage}`,
    "",
    `Сгенерировано: ${generatedAt}`,
    "",
    "Проценты считаются от evaluable runs; `BLOCKED` показан отдельно и не",
    "исключён молча. Метрики, требующие ручного ground truth (correct verdict",
    "rate, seeded defect recall) или ручного baseline (manual time reduction),",
    "здесь не выводятся — их нельзя получить из журнала прогонов.",
    "",
  ];

  const data = {};
  for (const platform of platforms) {
    const runs = readRuns(stage, platform);
    if (!runs.length) continue;
    const m = computeMetrics(runs);
    data[platform] = { metrics: m, runs };
    parts.push(`## ${platform}`, "", metricsTable(m), "", "### Runs", "", runsTable(runs), "");
  }

  if (!Object.keys(data).length) parts.push("_Нет данных: ни одного run не найдено._", "");

  return { markdown: parts.join("\n"), json: { stage, generatedAt, platforms: data } };
}

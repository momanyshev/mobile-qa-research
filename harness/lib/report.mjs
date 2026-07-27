// Отчёт одного run строго по шаблону Приложения B плана. Структура полей
// фиксирована и не зависит от case и исхода: два run одного case обязаны давать
// отчёты одинаковой структуры (требование gate 10.0).

const FIELDS = [
  "Run ID", "Case ID", "Platform", "Device / OS", "App commit", "sim-use version",
  "Agent model", "Agent skill revision", "Workspace / test namespace", "Start state",
  "Instruction", "Allowed / forbidden actions", "Started at / finished at", "Tool calls",
  "Retries", "Manual interventions", "API before", "API after", "UI postcondition",
  "Oracle result", "Agent self-report", "Final verdict", "Failure category",
  "Evidence paths", "Teardown result", "New knowledge", "Follow-up decision",
];

export const REPORT_FIELDS = FIELDS;

function line(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
  return String(value);
}

export function renderReport(values) {
  const unknown = Object.keys(values).filter((k) => !FIELDS.includes(k));
  if (unknown.length) throw new Error(`Отчёт: неизвестные поля ${unknown.join(", ")}`);
  return FIELDS.map((f) => `${f}: ${line(values[f])}`).join("\n") + "\n";
}

/** Список полей отчёта — для сверки структуры двух отчётов между собой. */
export function reportStructure(text) {
  return text.split("\n").filter(Boolean).map((l) => l.slice(0, l.indexOf(":")));
}

// Исполнитель oracle: превращает секцию oracle манифеста в итоговый verdict.
//
// Правила (этапы 6.2, 10.0):
//   * PASS выставляют только проверки, а не формулировка агента;
//   * любая провалившаяся проверка → FAIL;
//   * проверка неизвестного типа или неподтверждённая ручная проверка →
//     INCONCLUSIVE (явная маркировка, а не тихий PASS);
//   * ошибка самого oracle (сеть, отсутствие данных) → INCONCLUSIVE с причиной.
//
// С этапа 12.2 предметные проверки живут в project adapter: здесь остаётся
// только generic-логика сведения результатов к verdict и UI-проверки по
// финальному outline, одинаковые для любого приложения.

const PASS = "pass", FAIL = "fail", UNSUPPORTED = "unsupported", ERROR = "error";

/** Все строковые значения дерева UI одним блоком текста для поиска подстрок. */
export function uiText(uiJsonRaw) {
  if (!uiJsonRaw) return "";
  let parsed;
  try { parsed = JSON.parse(uiJsonRaw); } catch { return uiJsonRaw; }
  const out = [];
  const walk = (node) => {
    if (node === null || node === undefined) return;
    if (typeof node === "string") { out.push(node); return; }
    if (typeof node === "number" || typeof node === "boolean") { out.push(String(node)); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    for (const [k, v] of Object.entries(node)) { out.push(k); walk(v); }
  };
  walk(parsed);
  return out.join("\n");
}

/** UI-проверки, не зависящие от приложения: работают по финальному outline. */
const GENERIC_UI_CHECKS = {
  async containsText(check, { finalUiText }) {
    return finalUiText.includes(check.text)
      ? { status: PASS, message: `финальный UI содержит «${check.text}»` }
      : { status: FAIL, message: `финальный UI не содержит «${check.text}»` };
  },
  async notContainsText(check, { finalUiText }) {
    return !finalUiText.includes(check.text)
      ? { status: PASS, message: `финальный UI не содержит «${check.text}», как и ожидалось` }
      : { status: FAIL, message: `финальный UI неожиданно содержит «${check.text}»` };
  },
};

export function genericUiCheckNames() {
  return Object.keys(GENERIC_UI_CHECKS);
}

/**
 * @param adapter project adapter (harness/adapters)
 * @param ctx { context, seeded, before, after, finalUiText, manualConfirmed }
 */
export async function runOracle(manifest, adapter, ctx) {
  const checks = [];

  for (const check of manifest.oracle.api?.checks || []) {
    checks.push(await runCheck(check, adapter.checks?.[check.type], "api", ctx));
  }
  for (const check of manifest.oracle.ui?.checks || []) {
    const impl = GENERIC_UI_CHECKS[check.type] || adapter.uiChecks?.[check.type];
    checks.push(await runCheck(check, impl, "ui", ctx, { needsUi: true }));
  }
  // У ручной проверки три исхода, а не два. До 30 июля 2026 их было два —
  // «подтверждена» и «не подтверждена», — поэтому наблюдаемое НАРУШЕНИЕ
  // приходилось записывать как INCONCLUSIVE, то есть «недоказуемо». Так
  // скрывались провалы: прогон C8, где агент нарушил правило остановки при
  // crash, по старой схеме выглядел бы неопределённым, а не проваленным.
  for (const manual of manifest.oracle.manualChecks || []) {
    let status = UNSUPPORTED;
    let message = "не автоматизируема и не подтверждена (--confirm-manual)";
    if (ctx.manualFailed) {
      status = FAIL;
      message = `нарушение зафиксировано ревьюером: ${ctx.manualFailed}`;
    } else if (ctx.manualConfirmed) {
      status = PASS;
      message = "подтверждена явным --confirm-manual при завершении run";
    }
    checks.push({ kind: "manual", type: "manual", description: manual, status, message });
  }

  const failed = checks.filter((c) => c.status === FAIL);
  const undecided = checks.filter((c) => c.status === UNSUPPORTED || c.status === ERROR);

  let verdict;
  if (failed.length) verdict = "FAIL";
  else if (undecided.length) verdict = "INCONCLUSIVE";
  else verdict = "PASS";

  const reasons = [
    ...failed.map((c) => `FAIL ${c.type}: ${c.message}`),
    ...undecided.map((c) => `${c.status === ERROR ? "ERROR" : "не поддержано"} ${c.type}: ${c.message}`),
  ];
  return { verdict, checks, reasons };
}

async function runCheck(check, impl, kind, ctx, { needsUi = false } = {}) {
  const base = { kind, type: check.type, spec: check };
  if (!impl) {
    return { ...base, status: UNSUPPORTED, message: `verifier не реализует проверку ${kind}.${check.type}` };
  }
  if (needsUi && !ctx.finalUiText) {
    return { ...base, status: ERROR, message: "нет финального UI outline — постусловие UI недоказуемо" };
  }
  try {
    const result = await impl(check, ctx);
    return { ...base, ...result };
  } catch (err) {
    return { ...base, status: ERROR, message: `сбой oracle: ${err.message}` };
  }
}

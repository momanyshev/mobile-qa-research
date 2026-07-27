// Исполнитель oracle: превращает секцию oracle манифеста в итоговый verdict.
//
// Правила (этап 6.2 и 10.0):
//   * PASS выставляют только функции verify.mjs, а не формулировка агента;
//   * любая провалившаяся проверка → FAIL;
//   * проверка неизвестного типа или неподтверждённая ручная проверка →
//     INCONCLUSIVE (явная маркировка, а не тихий PASS);
//   * ошибка самого oracle (сеть, отсутствие данных) → INCONCLUSIVE с причиной.

import {
  AssertionError, expectCount, expectFields, expectOnlyChanged,
  expect404, expectUnchanged, expectWorkspaceIsolation,
} from "../../tools/lib/verify.mjs";
import { newWorkspaceId } from "../../tools/lib/workspace.mjs";
import { SUPPORTED_API_CHECKS, SUPPORTED_UI_CHECKS } from "./manifest.mjs";

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

function findWhere(items, where) {
  return (items || []).filter((it) => Object.entries(where || {}).every(([k, v]) => it[k] === v));
}

function normalizeList(body) {
  return (body?.items || []).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/**
 * @param ctx { client, workspaceId, seeded, apiBefore, apiAfter, finalUiText, manualConfirmed }
 * @returns { verdict, checks, reasons }
 */
export async function runOracle(manifest, ctx) {
  const checks = [];

  for (const check of manifest.oracle.api?.checks || []) {
    checks.push(await runApiCheck(check, ctx));
  }
  for (const check of manifest.oracle.ui?.checks || []) {
    checks.push(await runUiCheck(check, ctx));
  }
  for (const manual of manifest.oracle.manualChecks || []) {
    checks.push({
      kind: "manual", type: "manual", description: manual,
      status: ctx.manualConfirmed ? PASS : UNSUPPORTED,
      message: ctx.manualConfirmed
        ? "подтверждена явным --confirm-manual при завершении run"
        : "не автоматизируема и не подтверждена (--confirm-manual)",
    });
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

async function runApiCheck(check, ctx) {
  const base = { kind: "api", type: check.type, spec: check };
  if (!SUPPORTED_API_CHECKS.includes(check.type)) {
    return { ...base, status: UNSUPPORTED, message: `verifier не реализует проверку api.${check.type}` };
  }
  try {
    switch (check.type) {
      case "count": {
        const list = check.query
          ? await ctx.client.list({ workspaceId: ctx.workspaceId, query: check.query })
          : ctx.apiAfter;
        expectCount(list, check.expected);
        return { ...base, status: PASS, message: `ровно ${check.expected} записей` };
      }
      case "fields": {
        const found = findWhere(ctx.apiAfter?.body?.items, check.where);
        if (found.length !== 1) {
          return { ...base, status: FAIL, message: `по условию ${JSON.stringify(check.where)} найдено записей: ${found.length}, ожидалась 1` };
        }
        expectFields(found[0], check.expect);
        return { ...base, status: PASS, message: `поля совпали: ${JSON.stringify(check.expect)}` };
      }
      case "onlyChanged": {
        const seed = ctx.seeded?.[check.seedIndex];
        if (!seed) return { ...base, status: ERROR, message: `нет seed с индексом ${check.seedIndex}` };
        const before = findWhere(ctx.apiBefore?.body?.items, { id: seed.id })[0];
        const after = findWhere(ctx.apiAfter?.body?.items, { id: seed.id })[0];
        if (!before) return { ...base, status: ERROR, message: "запись отсутствует в api-before" };
        if (!after) return { ...base, status: FAIL, message: "запись исчезла к моменту api-after" };
        expectOnlyChanged(before, after, check.changed);
        return { ...base, status: PASS, message: `изменилось ровно ${JSON.stringify(check.changed)}` };
      }
      case "absent": {
        const seed = ctx.seeded?.[check.seedIndex];
        if (!seed) return { ...base, status: ERROR, message: `нет seed с индексом ${check.seedIndex}` };
        const res = await ctx.client.get(seed.id, { workspaceId: ctx.workspaceId });
        expect404(res);
        return { ...base, status: PASS, message: `запись ${seed.id} удалена (404 NOT_FOUND)` };
      }
      case "unchanged": {
        expectUnchanged(normalizeList(ctx.apiBefore?.body), normalizeList(ctx.apiAfter?.body));
        return { ...base, status: PASS, message: "backend не изменился (read-only сценарий)" };
      }
      case "isolation": {
        const found = findWhere(ctx.apiAfter?.body?.items, check.where);
        if (found.length !== 1) {
          return { ...base, status: FAIL, message: `по условию ${JSON.stringify(check.where)} найдено записей: ${found.length}, ожидалась 1` };
        }
        const probeWs = newWorkspaceId();
        const other = await ctx.client.list({ workspaceId: probeWs });
        expectWorkspaceIsolation(ctx.apiAfter, other, found[0].id);
        return { ...base, status: PASS, message: `запись не видна в постороннем Workspace ${probeWs}` };
      }
      default:
        return { ...base, status: UNSUPPORTED, message: "не реализовано" };
    }
  } catch (err) {
    if (err instanceof AssertionError) return { ...base, status: FAIL, message: err.message, details: err.details };
    return { ...base, status: ERROR, message: `сбой oracle: ${err.message}` };
  }
}

async function runUiCheck(check, ctx) {
  const base = { kind: "ui", type: check.type, spec: check };
  if (!SUPPORTED_UI_CHECKS.includes(check.type)) {
    return { ...base, status: UNSUPPORTED, message: `verifier не реализует проверку ui.${check.type}` };
  }
  if (!ctx.finalUiText) {
    return { ...base, status: ERROR, message: "нет финального UI outline — постусловие UI недоказуемо" };
  }
  try {
    switch (check.type) {
      case "containsText": {
        const ok = ctx.finalUiText.includes(check.text);
        return ok
          ? { ...base, status: PASS, message: `финальный UI содержит «${check.text}»` }
          : { ...base, status: FAIL, message: `финальный UI не содержит «${check.text}»` };
      }
      case "notContainsText": {
        const ok = !ctx.finalUiText.includes(check.text);
        return ok
          ? { ...base, status: PASS, message: `финальный UI не содержит «${check.text}», как и ожидалось` }
          : { ...base, status: FAIL, message: `финальный UI неожиданно содержит «${check.text}»` };
      }
      case "listMatchesQuery": {
        // Независимый оракул фильтрации: что вернул API по тому же запросу,
        // то и только то должно быть видно в UI.
        const matching = await ctx.client.list({ workspaceId: ctx.workspaceId, query: check.query });
        const matchIds = new Set((matching.body?.items || []).map((i) => i.id));
        const expectVisible = (matching.body?.items || []).map((i) => i.title);
        const expectHidden = (ctx.apiAfter?.body?.items || []).filter((i) => !matchIds.has(i.id)).map((i) => i.title);

        const missing = expectVisible.filter((t) => !ctx.finalUiText.includes(t));
        const leaked = expectHidden.filter((t) => ctx.finalUiText.includes(t));
        if (missing.length || leaked.length) {
          return {
            ...base, status: FAIL,
            message: `UI не совпал с API-запросом ${JSON.stringify(check.query)}: не показаны [${missing.join(", ")}], лишние [${leaked.join(", ")}]`,
          };
        }
        return { ...base, status: PASS, message: `UI совпал с API-запросом: видно ${expectVisible.length}, скрыто ${expectHidden.length}` };
      }
      default:
        return { ...base, status: UNSUPPORTED, message: "не реализовано" };
    }
  } catch (err) {
    if (err instanceof AssertionError) return { ...base, status: FAIL, message: err.message, details: err.details };
    return { ...base, status: ERROR, message: `сбой oracle: ${err.message}` };
  }
}

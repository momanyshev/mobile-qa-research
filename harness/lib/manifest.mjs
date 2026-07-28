// Загрузка и валидация case manifest (Приложение A плана, расширенное
// машинно-проверяемым oracle). Валидация строгая: неизвестный ключ верхнего
// уровня или неверный тип — ошибка, а не «прочитаем что смогли». Неизвестный
// **тип проверки** — не ошибка загрузки, а сигнал verifier'у выставить
// INCONCLUSIVE (этап 10.0 требует явной маркировки, а не тихого PASS).

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseYaml } from "./yaml.mjs";
import { getAdapter, listAdapters, supportedChecks, DEFAULT_ADAPTER } from "../adapters/index.mjs";
import { genericUiCheckNames } from "./oracle-runner.mjs";

export const CASES_DIR = fileURLToPath(new URL("../cases", import.meta.url));

export class ManifestError extends Error {
  constructor(message) { super(message); this.name = "ManifestError"; }
}

const REQUIRED = ["id", "platform", "appId", "instruction", "preconditions",
  "allowedActions", "forbiddenActions", "limits", "oracle", "evidence", "teardown"];
// `adapter` необязателен: манифесты этапов 10–11 писались до появления слоя.
const OPTIONAL = ["title", "notes", "pilot", "adapter"];

const VALID_PLATFORMS = ["ios", "android", "any"];

function need(cond, message) { if (!cond) throw new ManifestError(message); }

export function validateManifest(m, source = "manifest") {
  need(m && typeof m === "object" && !Array.isArray(m), `${source}: корень должен быть map`);

  for (const key of REQUIRED) need(key in m, `${source}: отсутствует обязательный ключ «${key}»`);
  for (const key of Object.keys(m)) {
    need(REQUIRED.includes(key) || OPTIONAL.includes(key), `${source}: неизвестный ключ верхнего уровня «${key}»`);
  }

  need(typeof m.id === "string" && m.id.length > 0, `${source}: id должен быть непустой строкой`);
  need(VALID_PLATFORMS.includes(m.platform), `${source}: platform должен быть один из ${VALID_PLATFORMS.join(", ")}`);
  if (m.adapter !== undefined) {
    need(listAdapters().includes(m.adapter),
      `${source}: неизвестный adapter «${m.adapter}». Доступны: ${listAdapters().join(", ")}`);
  }
  need(typeof m.instruction === "string" && m.instruction.trim().length > 0, `${source}: instruction обязателен`);

  need(m.preconditions && typeof m.preconditions === "object", `${source}: preconditions должен быть map`);
  need(Array.isArray(m.preconditions.apiSeed), `${source}: preconditions.apiSeed должен быть списком (возможно пустым)`);
  for (const [i, seed] of m.preconditions.apiSeed.entries()) {
    need(seed && typeof seed === "object" && !Array.isArray(seed), `${source}: apiSeed[${i}] должен быть map`);
    for (const f of ["title", "description", "severity", "status"]) {
      need(typeof seed[f] === "string", `${source}: apiSeed[${i}].${f} обязателен`);
    }
  }

  for (const key of ["allowedActions", "forbiddenActions", "evidence"]) {
    need(Array.isArray(m[key]) && m[key].every((x) => typeof x === "string"),
      `${source}: ${key} должен быть списком строк`);
  }
  need(m.evidence.length > 0, `${source}: evidence не может быть пустым`);

  need(Number.isInteger(m.limits?.timeoutSeconds) && m.limits.timeoutSeconds > 0,
    `${source}: limits.timeoutSeconds должен быть положительным целым`);
  need(Number.isInteger(m.limits?.retryPerAction) && m.limits.retryPerAction > 0,
    `${source}: limits.retryPerAction должен быть положительным целым`);

  validateOracle(m.oracle, source);

  need(m.teardown && typeof m.teardown === "object", `${source}: teardown должен быть map`);
  // `resetState` — generic-имя; `deleteCreatedIssues` осталось от QA Lab и
  // поддерживается как устаревший синоним ради манифестов этапов 10–11.
  const reset = m.teardown.resetState ?? m.teardown.deleteCreatedIssues;
  need(typeof reset === "boolean",
    `${source}: нужен teardown.resetState (true/false)`);
  m.teardown.resetState = reset;

  return m;
}

function validateOracle(oracle, source) {
  need(oracle && typeof oracle === "object", `${source}: oracle должен быть map`);
  const known = ["api", "ui", "manualChecks"];
  for (const key of Object.keys(oracle)) {
    need(known.includes(key), `${source}: неизвестная секция oracle.${key}`);
  }
  const hasChecks = oracle.api?.checks?.length || oracle.ui?.checks?.length || oracle.manualChecks?.length;
  need(hasChecks, `${source}: oracle не содержит ни одной проверки — run был бы недоказуем`);

  for (const section of ["api", "ui"]) {
    if (!oracle[section]) continue;
    need(Array.isArray(oracle[section].checks), `${source}: oracle.${section}.checks должен быть списком`);
    for (const [i, check] of oracle[section].checks.entries()) {
      need(check && typeof check === "object" && typeof check.type === "string",
        `${source}: oracle.${section}.checks[${i}] должен быть map с ключом type`);
    }
  }
  if (oracle.manualChecks) {
    need(Array.isArray(oracle.manualChecks) && oracle.manualChecks.every((x) => typeof x === "string"),
      `${source}: oracle.manualChecks должен быть списком строк`);
  }
}

export function loadManifest(idOrPath) {
  const path = idOrPath.endsWith(".yaml") ? idOrPath : `${CASES_DIR}/${idOrPath}.yaml`;
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ManifestError(`Case manifest не найден: ${path}. Доступные: ${listCases().join(", ")}`);
  }
  const parsed = parseYaml(text);
  return validateManifest(parsed, idOrPath);
}

export function listCases() {
  try {
    return readdirSync(CASES_DIR).filter((f) => f.endsWith(".yaml")).map((f) => f.replace(/\.yaml$/, ""));
  } catch {
    return [];
  }
}

/**
 * Подстановка уникального токена run'а вместо `{{token}}`.
 *
 * Нужна для повторяемости: сценарий, создающий именованную сущность, при втором
 * прогоне столкнулся бы с уже существующей и провалил проверку «ровно одна
 * запись с таким именем». Токен делает имя уникальным для каждого run, и один
 * и тот же case можно честно прогнать пять раз подряд.
 *
 * Подстановка идёт и в инструкцию агента, и в значения проверок oracle —
 * поэтому они гарантированно говорят об одном и том же объекте.
 */
export function applyToken(manifest, token) {
  const walk = (v) => {
    if (typeof v === "string") return v.replaceAll("{{token}}", token);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(manifest);
}

/** Adapter, выбранный манифестом (или дефолтный). */
export function adapterFor(manifest) {
  return getAdapter(manifest.adapter || DEFAULT_ADAPTER);
}

/**
 * Проверки, тип которых не реализует ни выбранный adapter, ни generic-слой →
 * повод для INCONCLUSIVE. Считается против конкретного адаптера: одна и та же
 * проверка может существовать у одного приложения и отсутствовать у другого.
 */
export function unsupportedChecks(manifest) {
  const adapter = adapterFor(manifest);
  const supported = supportedChecks(adapter);
  const uiKnown = [...supported.ui, ...genericUiCheckNames()];
  const out = [];
  for (const c of manifest.oracle.api?.checks || []) {
    if (!supported.api.includes(c.type)) out.push(`api.${c.type}`);
  }
  for (const c of manifest.oracle.ui?.checks || []) {
    if (!uiKnown.includes(c.type)) out.push(`ui.${c.type}`);
  }
  return out;
}

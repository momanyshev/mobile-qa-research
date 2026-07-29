// Низкоуровневый HTTP-слой оракула. Один вызов = один результат с диагностикой,
// которую требует этап 6: requestId, HTTP-статус, длительность.

const WORKSPACE_HEADER = "X-Demo-Workspace-Id";
const REQUEST_ID_HEADER = "x-request-id";
const FEATURE_FLAG_HEADER = "X-Demo-Feature-Flags";

/**
 * Иммунитет оракула к посеянным дефектам.
 *
 * Дефект включается переменной окружения сервера, то есть действует на все
 * запросы — включая запросы самого оракула. Тогда оракул увидел бы ту же
 * искажённую картину, что и приложение, согласился бы с ней и дефект остался
 * бы незамеченным: проверка ослепла бы ровно там, где должна сработать.
 *
 * Заголовок в контракте флагов побеждает переменную окружения, поэтому оракул
 * на каждом запросе явно выключает все seeded-defect флаги и всегда наблюдает
 * эталонное поведение. Это не обход дефекта, а условие независимости проверки.
 */
const SEEDED_DEFECT_FLAGS = [
  "seedDefectSearchIgnoresDescription",
  "seedDefectSeverityFilterIgnored",
  "seedDefectStatusTransition",
];
const ORACLE_FLAG_HEADER_VALUE = SEEDED_DEFECT_FLAGS.map((f) => `${f}=off`).join(", ");

export class ApiError extends Error {
  constructor(message, result) {
    super(message);
    this.name = "ApiError";
    this.result = result;
  }
}

/**
 * Выполняет один HTTP-запрос к API дефектов.
 * Возвращает структурированный результат — тело не бросает исключение само по
 * себе: решение о PASS/FAIL принимает verify-слой, а не транспорт.
 *
 * @returns {Promise<{status:number, ok:boolean, requestId:(string|null),
 *   durationMs:number, method:string, url:string, workspaceId:(string|null),
 *   requestBody:(object|null), body:(object|null), rawBody:string}>}
 */
export async function apiRequest(baseUrl, method, path, { workspaceId, body, headers } = {}) {
  const url = baseUrl.replace(/\/$/, "") + path;
  const finalHeaders = { [FEATURE_FLAG_HEADER]: ORACLE_FLAG_HEADER_VALUE, ...(headers || {}) };
  if (workspaceId) finalHeaders[WORKSPACE_HEADER] = workspaceId;
  let payload;
  if (body !== undefined && body !== null) {
    finalHeaders["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const started = performance.now();
  let response;
  try {
    response = await fetch(url, { method, headers: finalHeaders, body: payload });
  } catch (err) {
    const durationMs = Math.round(performance.now() - started);
    throw new ApiError(`Network failure for ${method} ${url}: ${err.message}`, {
      status: 0,
      ok: false,
      requestId: null,
      durationMs,
      method,
      url,
      workspaceId: workspaceId || null,
      requestBody: body ?? null,
      body: null,
      rawBody: "",
    });
  }
  const durationMs = Math.round(performance.now() - started);
  const rawBody = await response.text();
  let parsed = null;
  if (rawBody) {
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      parsed = null;
    }
  }

  return {
    status: response.status,
    ok: response.ok,
    requestId: response.headers.get(REQUEST_ID_HEADER),
    durationMs,
    method,
    url,
    workspaceId: workspaceId || null,
    requestBody: body ?? null,
    body: parsed,
    rawBody,
  };
}

export { WORKSPACE_HEADER, REQUEST_ID_HEADER };

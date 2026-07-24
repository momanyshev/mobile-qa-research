// Низкоуровневый HTTP-слой оракула. Один вызов = один результат с диагностикой,
// которую требует этап 6: requestId, HTTP-статус, длительность.

const WORKSPACE_HEADER = "X-Demo-Workspace-Id";
const REQUEST_ID_HEADER = "x-request-id";

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
  const finalHeaders = { ...(headers || {}) };
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

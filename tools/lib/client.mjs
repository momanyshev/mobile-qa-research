// Клиент API дефектов. Повторяет контракт docs/openapi.yaml полигона:
// GET/POST /api/issues, GET/PATCH/DELETE /api/issues/{id}.
// Каждый метод возвращает полный результат транспорта (status, requestId,
// durationMs, body). Клиент ничего не «решает» — проверки живут в verify.mjs.

import { apiRequest } from "./http.mjs";

// Каноническая топология QA Lab: приложение ходит через fault proxy 8888, а
// seed/oracle/teardown — прямо в backend 8890. Default клиента относится именно
// к control plane; proxy можно проверить только явным URL в конструкторе.
export const CANONICAL_ORACLE_BASE_URL = "http://127.0.0.1:8890";
export const DEFAULT_BASE_URL = CANONICAL_ORACLE_BASE_URL;

const APP_PROXY_PORT = 8888;
const LOCAL_PROXY_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "10.0.2.2"]);

export function normalizeOracleBaseUrl(raw) {
  if (!raw || typeof raw !== "string") throw new Error("URL прямого QA Lab backend не задан");
  let url;
  try { url = new URL(raw); } catch { throw new Error(`некорректный URL QA Lab backend: ${raw}`); }
  // observation proxy пересылает трафик через node:http. Разрешить здесь https
  // означало бы принять route, которым приложение затем воспользоваться не сможет.
  if (url.protocol !== "http:") {
    throw new Error(`QA Lab backend требует http URL, получено: ${raw}`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("URL QA Lab backend не должен содержать credentials, query или fragment");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("URL QA Lab backend не должен содержать path: observation proxy поддерживает только origin");
  }
  return url.origin;
}

function isLocalAppProxy(baseUrl) {
  const url = new URL(baseUrl);
  const host = url.hostname.replace(/^\[|\]$/gu, "").replace(/\.$/u, "").toLowerCase();
  return url.port === String(APP_PROXY_PORT)
    && (LOCAL_PROXY_HOSTS.has(host) || host.startsWith("127.")
      || /^::ffff:7f[0-9a-f]{2}:/u.test(host));
}

/** Единственный resolver direct endpoint для harness и standalone oracle. */
export function resolveOracleRoute({ baseUrl, envBaseUrl = process.env.ORACLE_BASE_URL } = {}) {
  const hasArgument = baseUrl !== undefined;
  const hasEnvironment = !hasArgument && envBaseUrl !== undefined && envBaseUrl !== "";
  const source = hasArgument ? "argument" : hasEnvironment ? "environment" : "default";
  const resolved = normalizeOracleBaseUrl(
    hasArgument ? baseUrl : hasEnvironment ? envBaseUrl : CANONICAL_ORACLE_BASE_URL,
  );
  if (isLocalAppProxy(resolved)) {
    throw new Error(`QA Lab oracle не может использовать локальный fault proxy ${resolved}; укажите прямой backend (обычно ${CANONICAL_ORACLE_BASE_URL})`);
  }
  return { baseUrl: resolved, source };
}

export class IssuesClient {
  constructor(baseUrl, workspaceId = null) {
    this.baseUrl = baseUrl === undefined ? resolveOracleRoute().baseUrl : baseUrl;
    this.workspaceId = workspaceId;
    // Каждый вызов дописывается сюда — это машиночитаемый журнал команд run.
    this.log = [];
  }

  withWorkspace(workspaceId) {
    return new IssuesClient(this.baseUrl, workspaceId);
  }

  #record(result) {
    this.log.push({
      seq: this.log.length + 1,
      timestamp: new Date().toISOString(),
      method: result.method,
      url: result.url,
      workspaceId: result.workspaceId,
      status: result.status,
      requestId: result.requestId,
      durationMs: result.durationMs,
    });
    return result;
  }

  async list({ workspaceId = this.workspaceId, query } = {}) {
    let path = "/api/issues";
    if (query) {
      const qs = new URLSearchParams(query).toString();
      if (qs) path += `?${qs}`;
    }
    return this.#record(await apiRequest(this.baseUrl, "GET", path, { workspaceId }));
  }

  async get(id, { workspaceId = this.workspaceId } = {}) {
    return this.#record(await apiRequest(this.baseUrl, "GET", `/api/issues/${id}`, { workspaceId }));
  }

  async create(issue, { workspaceId = this.workspaceId } = {}) {
    return this.#record(await apiRequest(this.baseUrl, "POST", "/api/issues", { workspaceId, body: issue }));
  }

  async patch(id, changes, { workspaceId = this.workspaceId } = {}) {
    return this.#record(await apiRequest(this.baseUrl, "PATCH", `/api/issues/${id}`, { workspaceId, body: changes }));
  }

  async remove(id, { workspaceId = this.workspaceId } = {}) {
    return this.#record(await apiRequest(this.baseUrl, "DELETE", `/api/issues/${id}`, { workspaceId }));
  }
}

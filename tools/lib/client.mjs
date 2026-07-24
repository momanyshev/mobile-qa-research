// Клиент API дефектов. Повторяет контракт docs/openapi.yaml полигона:
// GET/POST /api/issues, GET/PATCH/DELETE /api/issues/{id}.
// Каждый метод возвращает полный результат транспорта (status, requestId,
// durationMs, body). Клиент ничего не «решает» — проверки живут в verify.mjs.

import { apiRequest } from "./http.mjs";

export const DEFAULT_BASE_URL = process.env.ORACLE_BASE_URL || "http://127.0.0.1:8888";

export class IssuesClient {
  constructor(baseUrl = DEFAULT_BASE_URL, workspaceId = null) {
    this.baseUrl = baseUrl;
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

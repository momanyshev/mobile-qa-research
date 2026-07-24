// Seed и teardown. Seed создаёт fixtures через API до UI-задачи; teardown
// удаляет ровно то, что создал run, и обязан отрабатывать при любом исходе,
// включая FAIL, BLOCKED и аварийное завершение (этап 6.1).

import { expectStatus } from "./verify.mjs";

/**
 * Создаёт набор дефектов и возвращает массив созданных сущностей.
 * Бросает, если хоть один POST не вернул 201 — частичный seed виден по
 * возвращённым до ошибки id (доступны через onCreated).
 */
export async function seedIssues(client, issues, { onCreated } = {}) {
  const created = [];
  for (const issue of issues) {
    const res = await client.create(issue);
    expectStatus(res, 201);
    created.push(res.body);
    if (onCreated) onCreated(res.body);
  }
  return created;
}

/**
 * Удаляет записи по id и возвращает отчёт. Не бросает на 404 (уже отсутствует —
 * цель teardown достигнута) и не прерывается на первой ошибке: пытается удалить
 * всё, затем сообщает о неудачах. Это делает teardown устойчивым к аварийному
 * завершению основного сценария.
 */
export async function teardownIssues(client, ids) {
  const report = { deleted: [], alreadyAbsent: [], failed: [] };
  for (const id of ids) {
    try {
      const res = await client.remove(id);
      if (res.status === 204) report.deleted.push(id);
      else if (res.status === 404) report.alreadyAbsent.push(id);
      else report.failed.push({ id, status: res.status, requestId: res.requestId });
    } catch (err) {
      report.failed.push({ id, error: err.message });
    }
  }
  return report;
}

/**
 * Полная очистка Workspace: читает список и удаляет все записи. Используется как
 * страховочный teardown, когда точный набор созданных id неизвестен (например,
 * после аварийного завершения run в изолированном тестовом Workspace).
 */
export async function teardownWorkspace(client, { workspaceId = client.workspaceId } = {}) {
  const list = await client.list({ workspaceId });
  expectStatus(list, 200);
  const ids = (list.body.items || []).map((i) => i.id);
  return teardownIssues(client.withWorkspace(workspaceId), ids);
}

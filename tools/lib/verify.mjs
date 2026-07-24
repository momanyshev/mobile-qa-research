// Независимый oracle. Каждая проверка бросает AssertionError при провале и
// возвращает true при успехе. PASS выставляется только этими функциями, а не
// формулировкой агента (этап 6.2).

export class AssertionError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "AssertionError";
    this.details = details;
  }
}

const SERVER_MANAGED = ["id", "createdAt", "updatedAt"];

function fail(message, details) {
  throw new AssertionError(message, details);
}

/** Ответ имеет ожидаемый HTTP-статус. */
export function expectStatus(result, expected) {
  if (result.status !== expected) {
    fail(`Ожидался статус ${expected}, получен ${result.status}`, {
      requestId: result.requestId,
      body: result.body,
    });
  }
  return true;
}

/** Список содержит ровно N записей (проверяет и total, и длину items). */
export function expectCount(listResult, expected) {
  expectStatus(listResult, 200);
  const { total, items } = listResult.body || {};
  if (total !== expected || !Array.isArray(items) || items.length !== expected) {
    fail(`Ожидалось ${expected} записей, получено total=${total}, items=${items?.length}`, {
      requestId: listResult.requestId,
    });
  }
  return true;
}

/** У сущности перечисленные поля точно равны ожидаемым. */
export function expectFields(issue, expected) {
  if (!issue || typeof issue !== "object") fail("Сущность отсутствует", { issue });
  for (const [key, value] of Object.entries(expected)) {
    if (issue[key] !== value) {
      fail(`Поле ${key}: ожидалось ${JSON.stringify(value)}, получено ${JSON.stringify(issue[key])}`, { issue });
    }
  }
  return true;
}

/**
 * После мутации: изменились ровно ожидаемые поля и ничего лишнего.
 * id и createdAt сохранены; updatedAt продвинулся вперёд; все остальные поля,
 * не входящие в changed, не изменились.
 */
export function expectOnlyChanged(before, after, changed) {
  if (after.id !== before.id) fail("id изменился при мутации", { before, after });
  if (after.createdAt !== before.createdAt) fail("createdAt изменился при мутации", { before, after });

  for (const [key, value] of Object.entries(changed)) {
    if (after[key] !== value) {
      fail(`Ожидалось изменение ${key} → ${JSON.stringify(value)}, получено ${JSON.stringify(after[key])}`, { before, after });
    }
  }

  const changedKeys = new Set([...Object.keys(changed), ...SERVER_MANAGED]);
  for (const key of Object.keys(before)) {
    if (changedKeys.has(key)) continue;
    if (JSON.stringify(after[key]) !== JSON.stringify(before[key])) {
      fail(`Непрошеное изменение поля ${key}: ${JSON.stringify(before[key])} → ${JSON.stringify(after[key])}`, { before, after });
    }
  }

  if (!(new Date(after.updatedAt) >= new Date(before.updatedAt))) {
    fail("updatedAt не продвинулся вперёд после мутации", { before, after });
  }
  return true;
}

/** Ресурс отсутствует: GET по id даёт 404 с контрактом ошибки NOT_FOUND. */
export function expect404(getResult) {
  expectStatus(getResult, 404);
  const code = getResult.body?.error?.code;
  if (code !== "NOT_FOUND") {
    fail(`Ожидался код ошибки NOT_FOUND, получен ${code}`, { body: getResult.body });
  }
  return true;
}

/**
 * Изоляция Workspace: запись присутствует в своём пространстве и отсутствует в
 * другом. Ожидает результаты list из двух разных Workspace и id записи.
 */
export function expectWorkspaceIsolation(ownerList, otherList, issueId) {
  expectStatus(ownerList, 200);
  expectStatus(otherList, 200);
  const inOwner = (ownerList.body.items || []).some((i) => i.id === issueId);
  const inOther = (otherList.body.items || []).some((i) => i.id === issueId);
  if (!inOwner) fail("Запись не найдена в собственном Workspace", { issueId });
  if (inOther) fail("Запись просочилась в чужой Workspace", { issueId });
  return true;
}

/** Read-only сценарий: состояние backend не изменилось (глубокое равенство). */
export function expectUnchanged(before, after) {
  const a = JSON.stringify(before);
  const b = JSON.stringify(after);
  if (a !== b) {
    fail("Состояние backend изменилось в read-only сценарии", { before, after });
  }
  return true;
}

// Изоляция Workspace: свежий UUID на каждый run и защита от повторного
// использования одного пространства параллельными runs (этап 6.1).
//
// По построению каждый run получает уникальный UUID, поэтому пересечения быть
// не может. claim()/release() дополнительно фиксируют активные пространства в
// реестре и не дают двум живым процессам работать в одном Workspace.

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function newWorkspaceId() {
  return randomUUID();
}

const DEFAULT_REGISTRY = process.env.ORACLE_WS_REGISTRY
  || new URL("../.run-registry.json", import.meta.url).pathname;

function readRegistry(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function writeRegistry(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Резервирует Workspace за текущим процессом. Бросает, если пространство уже
 * занято другим живым процессом. Записи мёртвых процессов очищаются.
 */
export function claim(workspaceId, { registry = DEFAULT_REGISTRY, pid = process.pid } = {}) {
  const data = readRegistry(registry);
  for (const [ws, entry] of Object.entries(data)) {
    if (!pidAlive(entry.pid)) delete data[ws];
  }
  if (data[workspaceId] && pidAlive(data[workspaceId].pid) && data[workspaceId].pid !== pid) {
    throw new Error(
      `Workspace ${workspaceId} уже занят активным run (pid ${data[workspaceId].pid}). `
      + "Параллельные runs не должны делить одно пространство."
    );
  }
  data[workspaceId] = { pid, claimedAt: new Date().toISOString() };
  writeRegistry(registry, data);
  return workspaceId;
}

export function release(workspaceId, { registry = DEFAULT_REGISTRY } = {}) {
  const data = readRegistry(registry);
  delete data[workspaceId];
  writeRegistry(registry, data);
}

/** Свежий UUID + сразу claim. Удобный вход для одного run. */
export function claimNewWorkspace(options = {}) {
  return claim(newWorkspaceId(), options);
}

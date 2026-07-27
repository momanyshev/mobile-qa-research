// Version manifest run'а: что именно измеряли. Без него метрики benchmark
// невоспроизводимы — «Обязательные правила каждого запуска» требуют
// зафиксировать commit приложения, версию sim-use, модель агента, ревизию
// skill, платформу, версию ОС и ID устройства.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const APP_REPO = process.env.APP_REPO
  || fileURLToPath(new URL("../../../portfolio-site", import.meta.url));
const RESEARCH_REPO = fileURLToPath(new URL("../..", import.meta.url));

function sh(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], ...opts }).trim();
  } catch {
    return null;
  }
}

function repoState(dir) {
  const commit = sh("git", ["-C", dir, "rev-parse", "--short", "HEAD"]);
  if (!commit) return { commit: null, dirty: null };
  // Пустая строка — успешный ответ «рабочее дерево чисто» (dirty=false).
  // null отличаем: это провал самой команды (dirty=неизвестно).
  const status = sh("git", ["-C", dir, "status", "--porcelain"]);
  return { commit, dirty: status === null ? null : status.length > 0 };
}

export function deviceInfo(deviceId) {
  const raw = sh("sim-use", ["devices", "--json", "--all"]);
  if (!raw) return { deviceId, name: null, runtime: null, platform: null, state: null };
  try {
    const list = JSON.parse(raw)?.data?.devices || [];
    const found = list.find((d) => d.deviceId === deviceId);
    return found || { deviceId, name: null, runtime: null, platform: null, state: null };
  } catch {
    return { deviceId, name: null, runtime: null, platform: null, state: null };
  }
}

export function versionManifest({ deviceId, platform, agentModel, skillRevision } = {}) {
  const app = repoState(APP_REPO);
  const research = repoState(RESEARCH_REPO);
  return {
    capturedAt: new Date().toISOString(),
    simUseVersion: sh("sim-use", ["--version"]),
    node: process.version,
    appRepo: { path: APP_REPO, commit: app.commit, dirty: app.dirty },
    researchRepo: { commit: research.commit, dirty: research.dirty },
    platform: platform || null,
    device: deviceId ? deviceInfo(deviceId) : null,
    agentModel: agentModel || process.env.AGENT_MODEL || null,
    skillRevision: skillRevision || process.env.AGENT_SKILL_REVISION || null,
    baseUrl: process.env.ORACLE_BASE_URL || "http://127.0.0.1:8888",
  };
}

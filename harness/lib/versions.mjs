// Version manifest run'а: что именно измеряли. Без него метрики benchmark
// невоспроизводимы — «Обязательные правила каждого запуска» требуют
// зафиксировать commit приложения, версию sim-use, модель агента, ревизию
// skill, платформу, версию ОС и ID устройства.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

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

/**
 * Ревизия операционного контракта агента — хеш содержимого `SKILL.md`.
 *
 * Раньше здесь стояла только строка из `--skill`, и оператор писал в неё
 * версию **инструмента** (`sim-use-skill-v0.10.0`). По отчётам поэтому
 * невозможно было установить, какие правила действовали в прогоне — это и
 * вскрыл провал `C8`, где агент нарушил правило 7, которого ему не давали.
 * Хеш содержимого не подделывается по невнимательности и меняется ровно тогда,
 * когда меняется контракт.
 */
export function agentContract() {
  const path = fileURLToPath(new URL("../../mobile-qa-agent/SKILL.md", import.meta.url));
  try {
    const body = readFileSync(path);
    return {
      path: "mobile-qa-agent/SKILL.md",
      sha256: createHash("sha256").update(body).digest("hex").slice(0, 12),
      bytes: body.length,
    };
  } catch (err) {
    return { path: "mobile-qa-agent/SKILL.md", sha256: null, bytes: null, error: err.message };
  }
}

export function versionManifest({
  deviceId, platform, agentModel, skillRevision, baseUrl = null, baseUrlSource = null,
} = {}) {
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
    // Что за контракт действовал — считается из файла, а не со слов оператора.
    agentContract: agentContract(),
    // Свободная метка оператора: чем прогон отличался, если контракт тот же.
    skillRevision: skillRevision || process.env.AGENT_SKILL_REVISION || null,
    // Маршрут приходит из уже разрешённого adapter context. Повторное чтение
    // env здесь могло записать не тот endpoint, которым реально пользовался run.
    baseUrl,
    baseUrlSource,
  };
}

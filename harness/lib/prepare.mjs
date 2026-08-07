// Prepare: приведение стенда в состояние, при котором preflight зелёный.
//
// Зачем отдельно от preflight. Preflight — диагностика: он отвечает на вопрос
// «можно ли начинать» и намеренно ничего не чинит, чтобы отказ был честным.
// Но из этого выросла перекошенная стоимость: агент делал выполнение и уборку
// сам, а подъём стенда каждый раз выполнял человек руками по runbook. При
// измерении 10.1 стало видно, что так меряется не стоимость агента, а
// стоимость недоделанного harness.
//
// Разделение ответственности: prepare ПРИВОДИТ, preflight ПРОВЕРЯЕТ. Prepare
// никогда не объявляет успех сам — после него всё равно идёт preflight, и
// именно он решает, начинать ли run. Поэтому ошибка в prepare не может тихо
// пропустить сломанный стенд.
//
// Граница безопасности: prepare перезапускает только те процессы, которые
// уверенно опознаёт как наши (netlify dev из каталога полигона, наш proxy,
// Metro из mobile/). Неопознанный слушатель на нужном порту — это отказ с
// объяснением, а не kill вслепую: за портом может стоять чужая работа.
//
// Команды prepare НЕ пишутся в журнал прогона. Журнал измеряет поведение
// агента (доля координатных действий, число вызовов), и подготовительные
// вызовы исказили бы каждую такую метрику.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const REPO_ROOT = `${HERE}../..`;
const LOG_DIR = `${REPO_ROOT}/harness/.prepare-logs`;

/** Каталог полигона. Репозитории намеренно раздельные, поэтому путь — конфиг, не константа. */
export function appDir() {
  return process.env.QALAB_APP_DIR || `${REPO_ROOT}/../portfolio-site`;
}

export function sh(cmd, args, { timeout = 30_000, cwd, env } = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8", timeout, cwd,
    env: env || process.env,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

/** Тихий вариант: неуспех — это null, а не исключение. */
export function shq(cmd, args, opts) {
  try { return sh(cmd, args, opts); } catch { return null; }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Ждать выполнения условия. Возвращает последнее значение fn() либо null по таймауту.
 */
export async function waitFor(fn, { timeoutMs = 60_000, everyMs = 1_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep(everyMs);
  }
}

/** Кто слушает порт: {pid, cmd} либо null. */
export function portOwner(port) {
  const out = shq("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { timeout: 10_000 });
  const line = out?.split("\n")[1];
  if (!line) return null;
  const pid = Number(line.trim().split(/\s+/)[1]);
  if (!Number.isFinite(pid)) return null;
  const cmd = shq("ps", ["-p", String(pid), "-o", "command="], { timeout: 10_000 }) || "";
  return { pid, cmd };
}

/**
 * Фоновый процесс с логом на диск. Логи нужны разбору: когда netlify dev или
 * Metro не поднялись, причина видна только в их выводе.
 */
export function spawnBackground(cmd, args, { cwd, env, logName }) {
  mkdirSync(LOG_DIR, { recursive: true });
  const logPath = `${LOG_DIR}/${logName}.log`;
  const fd = openSync(logPath, "a");
  const child = spawn(cmd, args, {
    cwd, env: env || process.env, detached: true, stdio: ["ignore", fd, fd],
  });
  child.unref();
  return { pid: child.pid, logPath };
}

/**
 * Шаг подготовки. Семантика намеренно жёсткая:
 *   check() истинно сразу      → `ok`     (ничего не трогали — prepare идемпотентен)
 *   check() ложно, fix() помог → `fixed`  (в отчёте видно, что стенд был не готов)
 *   check() ложно и после fix  → `failed` (run не начнётся)
 * Без fix() шаг может дать только `ok` или `failed` — это шаги-ограждения.
 */
export async function step(out, name, { check, fix, detailOk, level = "fail" }) {
  let value = null;
  try { value = await check(); } catch (err) { value = null; out.lastError = err.message; }
  if (value) {
    out.steps.push({ name, status: "ok", level, detail: detailOk ? detailOk(value) : String(value) });
    return value;
  }
  if (!fix) {
    out.steps.push({ name, status: "failed", level, detail: out.lastError || "условие не выполнено" });
    return null;
  }
  let fixDetail = "";
  try {
    fixDetail = (await fix()) || "";
  } catch (err) {
    out.steps.push({ name, status: "failed", level, detail: `починка не удалась: ${err.message}` });
    return null;
  }
  try { value = await check(); } catch { value = null; }
  if (value) {
    out.steps.push({
      name, status: "fixed", level,
      detail: [fixDetail, detailOk ? detailOk(value) : String(value)].filter(Boolean).join(" → "),
    });
    return value;
  }
  out.steps.push({ name, status: "failed", level, detail: fixDetail || "починка выполнена, условие всё равно не выполнено" });
  return null;
}

// ── Общие шаги, не зависящие от приложения ───────────────────────────────────

/**
 * Локаль. Пустые LANG/LC_ALL дают mojibake при вводе кириллицы
 * (TOOL-LOCALE-001), и лечится это только перезапуском daemon — то есть
 * чинить надо ДО первого вызова sim-use, а не после.
 */
async function stepLocale(out) {
  return step(out, "локаль UTF-8", {
    check: () => (/utf-?8/i.test(process.env.LC_ALL || process.env.LANG || "")
      ? (process.env.LC_ALL || process.env.LANG) : null),
    fix: () => {
      process.env.LANG = "en_US.UTF-8";
      process.env.LC_ALL = "en_US.UTF-8";
      // Daemon наследует локаль при старте: поднявшийся с пустой локалью
      // придётся снять, иначе paste продолжит портить кириллицу.
      shq("sim-use", ["daemon", "stop"], { timeout: 15_000 });
      return "экспортированы LANG/LC_ALL, daemon снят для перезапуска с верной локалью";
    },
    detailOk: (v) => `LANG/LC_ALL = ${v}`,
  });
}

function iosDeviceState(device) {
  const out = shq("xcrun", ["simctl", "list", "devices", "-j"], { timeout: 30_000 });
  if (!out) return null;
  try {
    const all = Object.values(JSON.parse(out).devices).flat();
    return all.find((d) => d.udid === device) || null;
  } catch { return null; }
}

/**
 * Устройство загружено и обслуживаемо.
 *
 * Для iOS мало `simctl boot`: устройство, поднятое без Simulator.app,
 * оказывается headless — `sim-use ui` отвечает «No translation object
 * returned», а запуск приложения падает с FBSOpenApplicationServiceErrorDomain
 * code=5. Поэтому сначала поднимается само приложение Simulator.
 */
async function stepDevice(out, { platform, device }) {
  if (platform === "ios") {
    return step(out, "устройство загружено", {
      check: () => (iosDeviceState(device)?.state === "Booted" ? "Booted" : null),
      fix: async () => {
        shq("open", ["-a", "Simulator"], { timeout: 30_000 });
        await sleep(2_000);
        shq("xcrun", ["simctl", "boot", device], { timeout: 120_000 });
        const ready = await waitFor(
          () => (iosDeviceState(device)?.state === "Booted" ? true : null),
          { timeoutMs: 120_000, everyMs: 2_000 },
        );
        return ready ? "Simulator.app поднят, устройство загружено" : "boot не завершился за 120 с";
      },
      detailOk: () => `${device} Booted`,
    });
  }
  return step(out, "устройство загружено", {
    check: () => (shq("adb", ["-s", device, "shell", "getprop", "sys.boot_completed"], { timeout: 20_000 })?.trim() === "1" ? true : null),
    fix: async () => {
      const ready = await waitFor(
        () => (shq("adb", ["-s", device, "shell", "getprop", "sys.boot_completed"], { timeout: 20_000 })?.trim() === "1" ? true : null),
        { timeoutMs: 180_000, everyMs: 3_000 },
      );
      return ready ? "дождались sys.boot_completed=1" : "эмулятор не загрузился за 180 с — запустите AVD вручную";
    },
    detailOk: () => `${device} boot_completed`,
  });
}

/** sim-use отвечает и видит целевое устройство. */
async function stepSimUse(out, { device }) {
  return step(out, "sim-use видит устройство", {
    check: () => {
      const raw = shq("sim-use", ["devices", "--json"], { timeout: 60_000 });
      if (!raw) return null;
      try {
        const list = JSON.parse(raw)?.data?.devices || [];
        return list.some((d) => d.deviceId === device || d.deviceId?.startsWith(device)) ? true : null;
      } catch { return null; }
    },
    fix: async () => {
      shq("sim-use", ["daemon", "stop"], { timeout: 20_000 });
      await sleep(1_500);
      return "daemon перезапущен";
    },
    detailOk: () => "устройство в списке sim-use",
  });
}

/**
 * Полный прогон подготовки: общие шаги плюс шаги адаптера.
 * Возвращает ту же форму, что preflight, — отчёт кладётся рядом с preflight.json.
 */
export async function runPrepare(adapter, { platform, device, context } = {}) {
  const out = { steps: [], startedAt: new Date().toISOString() };

  await stepLocale(out);
  if (device) {
    await stepDevice(out, { platform, device });
    await stepSimUse(out, { device });
  }
  if (adapter?.prepare) {
    try {
      const extra = await adapter.prepare({ platform, device, context, out, helpers: PREPARE_HELPERS });
      if (Array.isArray(extra)) out.steps.push(...extra);
    } catch (err) {
      out.steps.push({ name: `подготовка адаптера ${adapter.id}`, status: "failed", level: "fail", detail: err.message });
    }
  }

  out.finishedAt = new Date().toISOString();
  out.failed = out.steps.filter((s) => s.status === "failed" && s.level !== "warn");
  out.fixed = out.steps.filter((s) => s.status === "fixed");
  out.ok = out.failed.length === 0;
  return out;
}

/** Помощники, которые адаптер получает вместо собственных импортов. */
/**
 * Синхронная пауза. Нужна там, где ждать приходится внутри синхронной функции
 * (чтение дерева между попытками): async там сделал бы функцию непригодной для
 * selftest'а, где она вызывается с подставными помощниками.
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export const PREPARE_HELPERS = {
  sh, shq, sleep, sleepSync, waitFor, portOwner, spawnBackground, step, appDir, REPO_ROOT,
};

const MARK = { ok: "=", fixed: "+", failed: "x", skipped: "-" };

export function renderPrepare(result) {
  const lines = result.steps.map((s) => `  ${MARK[s.status] || "?"} ${s.name}: ${s.detail}`);
  const fixed = result.fixed?.length || 0;
  lines.push(fixed
    ? `  (изменено шагов: ${fixed} — стенд не был готов)`
    : "  (изменений не потребовалось — стенд уже был готов)");
  return lines.join("\n");
}

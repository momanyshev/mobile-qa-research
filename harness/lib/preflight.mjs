// Preflight: проверки до первого действия агента (этап 14.3).
//
// Смысл — отделить «run провалился» от «run вообще не следовало начинать».
// Большая часть отказов исследования была средовой: пустая локаль портила
// кириллицу, непрогретый эмулятор ронял bridge, `paste` молча не работал без
// hardware keyboard, соседнее устройство создавало риск действий не на том
// экране. Все эти условия проверяемы заранее.
//
// Уровни: `fail` — стартовать нельзя, `warn` — можно, но нужно знать.
// Платформенные и проектные проверки добавляет adapter через `preflight()`.

import { execFileSync } from "node:child_process";

function sh(cmd, args, timeout = 20_000) {
  return execFileSync(cmd, args, {
    encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function check(name, level, ok, detail) {
  return { name, level, ok, detail };
}

/** Устройства, с которыми sim-use может работать прямо сейчас. */
function usableDevices() {
  try {
    return JSON.parse(sh("sim-use", ["devices", "--json"]))?.data?.devices || [];
  } catch {
    return null;
  }
}

/**
 * Общие проверки, не зависящие от приложения.
 * @returns массив результатов проверок
 */
export function genericPreflight({ platform, device }) {
  const out = [];

  // 1. Инструмент доступен и его версия зафиксирована в отчёте.
  let version = null;
  try { version = sh("sim-use", ["--version"]); } catch { /* ниже */ }
  out.push(check("sim-use доступен", "fail", Boolean(version), version ? `версия ${version}` : "команда sim-use не найдена"));
  if (!version) return out;

  // 2. Локаль. Пустые LANG/LC_ALL — причина mojibake при вводе кириллицы
  //    (TOOL-LOCALE-001). Проверяется до старта, потому что после ввода уже поздно.
  const lang = process.env.LC_ALL || process.env.LANG || "";
  out.push(check(
    "локаль UTF-8", "fail", /utf-?8/i.test(lang),
    lang ? `LANG/LC_ALL = ${lang}` : "LANG и LC_ALL пусты — ввод не-ASCII даст mojibake; выполните export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8",
  ));

  // 3. Целевое устройство доступно.
  const devices = usableDevices();
  if (devices === null) {
    out.push(check("список устройств", "fail", false, "sim-use devices не отвечает"));
    return out;
  }
  const target = devices.find((d) => d.deviceId === device || d.deviceId?.startsWith(device));
  out.push(check(
    "целевое устройство доступно", "fail", Boolean(target),
    target ? `${target.name || device} (${target.runtime || "?"}, ${target.state || "?"})`
      : `устройство ${device} не найдено среди доступных: ${devices.map((d) => d.deviceId).join(", ") || "нет ни одного"}`,
  ));

  // 4. Платформа устройства совпадает с заявленной.
  if (target?.platform) {
    out.push(check(
      "платформа совпадает", "fail", target.platform === platform,
      `устройство ${target.platform}, запрошено ${platform}`,
    ));
  }

  // 5. Лишние устройства той же платформы — риск подействовать не на то.
  //    Устройства другой платформы допустимы: run всё равно адресный.
  const samePlatform = devices.filter((d) => d.platform === platform);
  out.push(check(
    "нет лишних устройств платформы", "fail", samePlatform.length <= 1,
    samePlatform.length <= 1 ? "запущено ровно одно" : `запущено ${samePlatform.length}: ${samePlatform.map((d) => d.name || d.deviceId).join(", ")}`,
  ));
  const otherPlatform = devices.filter((d) => d.platform && d.platform !== platform);
  if (otherPlatform.length) {
    out.push(check("устройства другой платформы", "warn", true,
      `запущены и не мешают: ${otherPlatform.map((d) => d.name || d.deviceId).join(", ")}`));
  }

  return out;
}

/**
 * Наблюдается ли нужное приложение. Проверяется отдельно от остального:
 * агент обязан убедиться, что смотрит на своё приложение, а не на чужой экран.
 * Мягкая проверка: приложение может быть ещё не запущено — это нормально,
 * если сценарий сам его стартует.
 */
export function observedApp(device) {
  try {
    const first = sh("sim-use", ["ui", "--device", device], 60_000).split("\n")[0] || "";
    const m = /^App:\s*(.+?)\s{2,}/.exec(first) || /^App:\s*(.+)$/.exec(first);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * Полный preflight: общие проверки + проверки adapter'а.
 * Adapter может не реализовывать `preflight` — тогда используются только общие.
 */
export async function runPreflight(adapter, { platform, device, context }) {
  const checks = genericPreflight({ platform, device });
  if (typeof adapter?.preflight === "function") {
    try {
      checks.push(...(await adapter.preflight({ platform, device, context })));
    } catch (err) {
      checks.push(check(`preflight adapter ${adapter.id}`, "fail", false, err.message));
    }
  }
  const failed = checks.filter((c) => c.level === "fail" && !c.ok);
  return { checks, ok: failed.length === 0, failed };
}

export function renderPreflight({ checks }) {
  return checks
    .map((c) => `  ${c.ok ? "✓" : c.level === "warn" ? "?" : "✗"} ${c.name}: ${c.detail}`)
    .join("\n");
}

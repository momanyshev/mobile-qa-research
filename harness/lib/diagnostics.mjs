// Условно обязательная диагностика (этап 11): screenshot сохраняется всегда, а
// device logs — дополнительно при неуспешном исходе. Смысл требования плана
// «по отчёту можно восстановить причину любого результата»: для PASS достаточно
// штатного пакета, а для FAIL/BLOCKED/INCONCLUSIVE нужен системный контекст,
// которого в UI-дереве нет (краши, отказы сети, системные диалоги).
//
// Сбор — строго best-effort: диагностика не должна ломать и без того неуспешный
// run, поэтому любая ошибка возвращается как причина отсутствия артефакта.

import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const LOG_LINES = 400;

function capture(cmd, args) {
  return execFileSync(cmd, args, {
    encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Системный журнал устройства за последние минуты работы run.
 * iOS — `xcrun simctl spawn <udid> log show`, Android — `adb logcat -d`.
 * @returns { saved: boolean, path?: string, reason?: string }
 */
export function captureDeviceLog({ platform, device, dir, sinceMinutes = 10 }) {
  if (!device) return { saved: false, reason: "run выполнялся без устройства" };
  const path = `${dir}/device-log.txt`;
  try {
    let text;
    if (platform === "ios") {
      text = capture("xcrun", [
        "simctl", "spawn", device, "log", "show",
        "--last", `${sinceMinutes}m`, "--style", "compact",
      ]);
    } else {
      text = capture("adb", ["-s", device, "logcat", "-d", "-v", "time"]);
    }
    const lines = text.split("\n");
    const tail = lines.slice(-LOG_LINES).join("\n");
    writeFileSync(path, `# последние ${Math.min(lines.length, LOG_LINES)} строк системного журнала\n${tail}\n`);
    return { saved: true, path };
  } catch (err) {
    return { saved: false, reason: `сбор журнала устройства не удался: ${err.message}` };
  }
}

/** Нужна ли расширенная диагностика для этого verdict. */
export function needsDiagnostics(verdict) {
  return verdict !== "PASS";
}

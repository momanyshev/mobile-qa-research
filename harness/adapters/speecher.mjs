// Адаптер Speecher Mobile — второе приложение этапа 12 (iOS, SwiftUI).
//
// У приложения нет backend: распознавание речи локальное, наружу уходят только
// ссылки. Поэтому роль «детерминированного backend-адаптера» (формулировка
// плана 12.1) играет контейнер приложения на симуляторе: настройки живут в
// `UserDefaults.standard`, то есть в plist внутри Data-контейнера, который
// читается независимо от UI через `simctl get_app_container` + `plutil`.
//
// Ограничения, принятые сознательно:
//   * seed настроек через `defaults write` не делается — процесс приложения
//     кэширует UserDefaults и перезапишет значение при выходе. Начальное
//     состояние задаётся сбросом приложения, а не подменой файла.
//   * основной сценарий приложения (запись голоса) недостижим: sim-use не
//     подаёт звук на симулятор. Сценарии этапа 12 намеренно немикрофонные.

import { execFileSync } from "node:child_process";

const PASS = "pass", FAIL = "fail", ERROR = "error";
const BUNDLE_ID = "app.speecher.mobile";

function sh(cmd, args) {
  return execFileSync(cmd, args, {
    encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function containerPath(device) {
  return sh("xcrun", ["simctl", "get_app_container", device, BUNDLE_ID, "data"]);
}

/** UserDefaults приложения как обычный объект. Отсутствие plist — пустое состояние. */
function readDefaults(device) {
  const plist = `${containerPath(device)}/Library/Preferences/${BUNDLE_ID}.plist`;
  try {
    return JSON.parse(sh("plutil", ["-convert", "json", "-o", "-", plist]));
  } catch {
    // Приложение ещё не записало ни одной настройки — это валидное состояние.
    return {};
  }
}

export default {
  id: "speecher",
  displayName: "Speecher Mobile",
  bundleId: { ios: BUNDLE_ID },

  async createContext({ platform, device } = {}) {
    if (platform !== "ios") throw new Error("Speecher существует только для iOS");
    if (!device) throw new Error("Speecher-адаптеру нужен --device: состояние читается из контейнера симулятора");
    return { kind: "container", device, bundleId: BUNDLE_ID, container: containerPath(device) };
  },

  describeContext(context) {
    return `контейнер ${context.bundleId} на ${context.device}`;
  },

  /**
   * Начальное состояние задаётся сбросом приложения, а не записью в plist:
   * живой процесс перезаписал бы подменённые значения при завершении.
   */
  async seed(context, seedSpec) {
    if (seedSpec?.length) {
      throw new Error(
        "Speecher-адаптер не поддерживает apiSeed: у приложения нет backend. "
        + "Задавайте начальное состояние через reset в preconditions.",
      );
    }
    return [];
  },

  async readState(context) {
    return { defaults: readDefaults(context.device) };
  },

  /**
   * Возврат к чистому состоянию. Приложение хранит данные только в своём
   * контейнере, поэтому достаточно штатного сброса привилегий и настроек.
   * Ошибки не бросаются: teardown обязан отрабатывать и после аварии.
   */
  async teardown(context) {
    const parts = [];
    try {
      sh("xcrun", ["simctl", "terminate", context.device, BUNDLE_ID]);
      parts.push("приложение остановлено");
    } catch {
      parts.push("приложение уже не запущено");
    }
    try {
      sh("xcrun", ["simctl", "privacy", context.device, "reset", "microphone", BUNDLE_ID]);
      parts.push("разрешение микрофона сброшено");
    } catch (err) {
      parts.push(`сброс разрешения не выполнен: ${err.message.split("\n")[0]}`);
    }
    return parts.join("; ");
  },

  checks: {
    /** Значение настройки в UserDefaults приложения точно равно ожидаемому. */
    async defaultsEqual(check, { after }) {
      const actual = after?.defaults?.[check.key];
      if (actual === undefined) {
        return { status: FAIL, message: `ключ «${check.key}» отсутствует в UserDefaults приложения` };
      }
      return actual === check.expected
        ? { status: PASS, message: `${check.key} = ${JSON.stringify(actual)}` }
        : { status: FAIL, message: `${check.key}: ожидалось ${JSON.stringify(check.expected)}, получено ${JSON.stringify(actual)}` };
    },

    /** Ключ отсутствует (например, настройка ещё не трогалась). */
    async defaultsAbsent(check, { after }) {
      const actual = after?.defaults?.[check.key];
      return actual === undefined
        ? { status: PASS, message: `ключ «${check.key}» отсутствует, как и ожидалось` }
        : { status: FAIL, message: `ключ «${check.key}» неожиданно присутствует: ${JSON.stringify(actual)}` };
    },

    /**
     * Состояние приложения изменилось хоть чем-то. Нужна там, где проверяется
     * сам факт сохранения настройки: если пользователь изменил настройку, а в
     * UserDefaults ничего не появилось, значит настройка не персистится.
     */
    async defaultsChanged(check, { before, after }) {
      const b = before?.defaults ?? {}, a = after?.defaults ?? {};
      const touched = [...new Set([...Object.keys(b), ...Object.keys(a)])]
        .filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k]));
      return touched.length
        ? { status: PASS, message: `сохранённое состояние изменилось: ${touched.join(", ")}` }
        : { status: FAIL, message: "изменение настройки не отражено в UserDefaults — настройка не сохраняется" };
    },

    /** Состояние приложения не изменилось — read-only сценарий. */
    async unchanged(check, { before, after }) {
      const b = JSON.stringify(before?.defaults ?? {});
      const a = JSON.stringify(after?.defaults ?? {});
      return b === a
        ? { status: PASS, message: "UserDefaults приложения не изменились" }
        : { status: FAIL, message: `состояние изменилось в read-only сценарии: ${b} → ${a}` };
    },

    /** Изменился ровно указанный ключ, остальные сохранены. */
    async onlyKeyChanged(check, { before, after }) {
      const b = before?.defaults ?? {}, a = after?.defaults ?? {};
      if (a[check.key] !== check.expected) {
        return { status: FAIL, message: `${check.key}: ожидалось ${JSON.stringify(check.expected)}, получено ${JSON.stringify(a[check.key])}` };
      }
      const touched = [...new Set([...Object.keys(b), ...Object.keys(a)])]
        .filter((k) => k !== check.key && JSON.stringify(b[k]) !== JSON.stringify(a[k]));
      return touched.length
        ? { status: FAIL, message: `непрошеные изменения ключей: ${touched.join(", ")}` }
        : { status: PASS, message: `изменился ровно ${check.key} → ${JSON.stringify(check.expected)}` };
    },
  },

  uiChecks: {},
};

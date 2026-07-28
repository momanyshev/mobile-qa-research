// Адаптер Element X (Matrix) — второе приложение этапа 12 на Android.
//
// Oracle читает состояние **напрямую из SQLite-базы Synapse**, а не через
// Client-Server API. Причины:
//   * независимость: проверка не зависит ни от клиента, ни от его сессии —
//     это отдельный источник истины, как контейнер приложения для Speecher;
//   * без учётных данных: не нужен access token, поэтому harness не обращается
//     с чужими секретами.
//
// Что видно, а что нет. Matrix шифрует **содержимое сообщений**, но не
// состояние комнаты: `m.room.name`, `m.room.topic`, членство и типы событий
// лежат открыто. Поэтому «комната создана с таким-то именем» проверяется
// точно, а «в сообщении такой-то текст» — принципиально нет: факт отправки
// виден как событие `m.room.encrypted`, содержимое — нет. Проверки ниже
// сформулированы ровно по этой границе, без имитации доступа к шифротексту.

import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

const PASS = "pass", FAIL = "fail", ERROR = "error";
const BUNDLE_ID = "io.element.android.x";

const DEFAULT_DB = process.env.MATRIX_DB
  || `${homedir()}/Documents/Projects/matrix-test-server/homeserver.db`;

function openDb(path) {
  if (!existsSync(path)) throw new Error(`База Synapse не найдена: ${path}`);
  // Только чтение: oracle не имеет права влиять на проверяемое состояние.
  return new DatabaseSync(path, { readOnly: true });
}

/** Снимок состояния сервера: комнаты, их имена/топики и счётчики событий. */
function snapshot(dbPath) {
  const db = openDb(dbPath);
  try {
    // Актуальное имя/топик комнаты — последнее по stream_ordering состояние.
    const rooms = db.prepare(`
      SELECT r.room_id AS roomId,
        (SELECT json_extract(ej.json, '$.content.name') FROM events e
           JOIN event_json ej ON ej.event_id = e.event_id
          WHERE e.room_id = r.room_id AND e.type = 'm.room.name'
          ORDER BY e.stream_ordering DESC LIMIT 1) AS name,
        (SELECT json_extract(ej.json, '$.content.topic') FROM events e
           JOIN event_json ej ON ej.event_id = e.event_id
          WHERE e.room_id = r.room_id AND e.type = 'm.room.topic'
          ORDER BY e.stream_ordering DESC LIMIT 1) AS topic,
        (SELECT COUNT(*) FROM events e
          WHERE e.room_id = r.room_id AND e.type = 'm.room.encryption') AS encrypted,
        (SELECT COUNT(*) FROM events e
          WHERE e.room_id = r.room_id AND e.type = 'm.room.encrypted') AS messageEvents
      FROM rooms r ORDER BY r.room_id
    `).all();

    const eventCounts = {};
    for (const row of db.prepare("SELECT type, COUNT(*) AS n FROM events GROUP BY type").all()) {
      eventCounts[row.type] = row.n;
    }
    const totalEvents = db.prepare("SELECT COUNT(*) AS n FROM events").get().n;
    const users = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;

    return {
      rooms: rooms.map((r) => ({
        roomId: r.roomId,
        name: r.name ?? null,
        topic: r.topic ?? null,
        encrypted: r.encrypted > 0,
        messageEvents: r.messageEvents,
      })),
      eventCounts, totalEvents, users,
    };
  } finally {
    db.close();
  }
}

function findRoom(state, name) {
  return (state?.rooms || []).filter((r) => r.name === name);
}

function countOf(state, type) {
  return state?.eventCounts?.[type] ?? 0;
}

export default {
  id: "elementx",
  displayName: "Element X (Matrix)",
  bundleId: { android: BUNDLE_ID },

  async createContext({ platform, device } = {}) {
    if (platform !== "android") throw new Error("Element X в этом исследовании используется только на Android");
    if (!device) throw new Error("Element X-адаптеру нужен --device: приложением управляют по adb");
    const dbPath = DEFAULT_DB;
    if (!existsSync(dbPath)) {
      throw new Error(`База Synapse не найдена: ${dbPath}. Поднимите локальный homeserver перед run.`);
    }
    return { kind: "matrix-db", device, bundleId: BUNDLE_ID, dbPath };
  },

  describeContext(context) {
    return `${context.bundleId} на ${context.device}, состояние из ${context.dbPath.split("/").pop()}`;
  },

  /**
   * Seed через API сознательно не поддерживается: он потребовал бы access
   * token, то есть обращения с учётными данными. Начальное состояние задаётся
   * тем, что уже есть на сервере, а проверки формулируются как разница
   * «до/после».
   */
  async seed(context, seedSpec) {
    if (seedSpec?.length) {
      throw new Error(
        "Element X-адаптер не поддерживает apiSeed: seed через Client-Server API "
        + "потребовал бы access token. Формулируйте проверки как разницу состояний.",
      );
    }
    return [];
  },

  async readState(context) {
    return snapshot(context.dbPath);
  },

  /**
   * Teardown не разрушительный. Данные лежат на одноразовом локальном сервере,
   * а удаление комнат из-под Synapse на живой базе рассинхронизировало бы
   * клиент. Проверки построены на разнице состояний, поэтому накопленные
   * комнаты не мешают. Приложение останавливается, чтобы следующий run
   * стартовал из холодного состояния.
   */
  async teardown(context) {
    const parts = [];
    try {
      execFileSync("adb", ["-s", context.device, "shell", "am", "force-stop", BUNDLE_ID],
        { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
      parts.push("приложение остановлено");
    } catch (err) {
      parts.push(`не удалось остановить приложение: ${err.message.split("\n")[0]}`);
    }
    try {
      const s = snapshot(context.dbPath);
      parts.push(`на сервере осталось комнат: ${s.rooms.length} (локальный стенд, данные не удаляются)`);
    } catch {
      parts.push("состояние сервера не прочитано");
    }
    return parts.join("; ");
  },

  checks: {
    /** Комната с точным именем существует ровно в одном экземпляре. */
    async roomExists(check, { after }) {
      const found = findRoom(after, check.name);
      if (found.length !== 1) {
        return { status: FAIL, message: `комнат с именем «${check.name}»: ${found.length}, ожидалась 1` };
      }
      if (check.topic !== undefined && found[0].topic !== check.topic) {
        return { status: FAIL, message: `топик: ожидался ${JSON.stringify(check.topic)}, получен ${JSON.stringify(found[0].topic)}` };
      }
      if (check.encrypted !== undefined && found[0].encrypted !== check.encrypted) {
        return { status: FAIL, message: `шифрование: ожидалось ${check.encrypted}, получено ${found[0].encrypted}` };
      }
      return { status: PASS, message: `комната «${check.name}» существует (${found[0].roomId})` };
    },

    /** Комнаты с таким именем нет — например, после отмены создания. */
    async roomAbsent(check, { after }) {
      const found = findRoom(after, check.name);
      return found.length === 0
        ? { status: PASS, message: `комнаты «${check.name}» нет, как и ожидалось` }
        : { status: FAIL, message: `комната «${check.name}» неожиданно существует (${found.length} шт.)` };
    },

    /** Число комнат выросло ровно на N. */
    async roomsAdded(check, { before, after }) {
      const delta = (after?.rooms?.length ?? 0) - (before?.rooms?.length ?? 0);
      return delta === check.expected
        ? { status: PASS, message: `добавлено комнат: ${delta}` }
        : { status: FAIL, message: `ожидалось добавление ${check.expected} комнат, фактически ${delta}` };
    },

    /**
     * Событий заданного типа стало больше как минимум на N. Для отправки
     * сообщения в зашифрованной комнате это `m.room.encrypted`: сам факт
     * отправки проверяем, содержимое — нет.
     */
    async eventTypeAdded(check, { before, after }) {
      const delta = countOf(after, check.type) - countOf(before, check.type);
      const min = check.min ?? 1;
      return delta >= min
        ? { status: PASS, message: `событий ${check.type} добавилось: ${delta} (ожидалось ≥ ${min})` }
        : { status: FAIL, message: `событий ${check.type} добавилось ${delta}, ожидалось ≥ ${min}` };
    },

    /** Состояние сервера не изменилось — read-only сценарий. */
    async unchanged(check, { before, after }) {
      const b = { rooms: before?.rooms, totalEvents: before?.totalEvents };
      const a = { rooms: after?.rooms, totalEvents: after?.totalEvents };
      return JSON.stringify(b) === JSON.stringify(a)
        ? { status: PASS, message: "состояние сервера не изменилось" }
        : { status: FAIL, message: `состояние сервера изменилось: событий ${before?.totalEvents} → ${after?.totalEvents}, комнат ${before?.rooms?.length} → ${after?.rooms?.length}` };
    },

    /** Сессия жива: у пользователя зарегистрировано устройство клиента. */
    async sessionAlive(check, { context }) {
      const db = openDb(context.dbPath);
      try {
        const row = db.prepare(
          "SELECT COUNT(*) AS n FROM devices WHERE display_name = ?",
        ).get(check.deviceName ?? "Element X Android");
        return row.n > 0
          ? { status: PASS, message: `сессия клиента зарегистрирована (устройств: ${row.n})` }
          : { status: FAIL, message: "устройство клиента не найдено — сессия не создана" };
      } catch (err) {
        return { status: ERROR, message: `сбой oracle: ${err.message}` };
      } finally {
        db.close();
      }
    },
  },

  uiChecks: {},
};

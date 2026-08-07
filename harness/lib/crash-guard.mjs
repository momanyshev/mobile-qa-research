// Разбор сигнала о крахе: относится ли он к приложению под тестом.
//
// Зачем. `sim-use` следит за исчезновением процессов между командами и при
// пропаже печатает баннер `PROCESS DISAPPEARED`, а дальше добавляет шапку
// «has not relaunched…» к каждой следующей команде. На эмуляторе это работает
// как задумано: посторонних процессов там почти нет, и пропавший процесс почти
// наверняка и есть приложение под тестом.
//
// На физическом устройстве (R-19, Samsung SM-S931B) выяснилось, что это не так.
// Баннер сработал на постороннем фоновом мессенджере при полностью живом
// приложении под тестом, и обе формулировки — «You may be acting against the
// home screen» в том числе — адресуют агента к целевому приложению, хотя речь
// о чужом процессе. Правило 7 контракта требует в таком случае остановиться,
// то есть буквальное исполнение угробило бы прогон впустую. На личном телефоне
// восемь сторонних фоновых процессов, включая мессенджеры и VPN, поэтому
// случай не экзотический, а ожидаемый.
//
// Детектор живёт внутри `sim-use` и нам не принадлежит — исправить его нельзя.
// Поэтому harness не подменяет вывод инструмента, а **дополняет** его
// собственным заключением: чей процесс пропал и жив ли целевой. Решение
// остаётся за агентом, но принимается уже по верным данным.

import { execFileSync } from "node:child_process";

/**
 * Все известные формы сообщения называют пакет и pid, поэтому разбор один:
 *   ir.ilmili.telegraph (pid 16330) was alive at the previous command and is GONE now.
 *   [!] ir.ilmili.telegraph (pid 16330) has not relaunched since it disappeared.
 *   app.nicegram (pid 20431) crashed and relaunched under a new process since the previous command.
 *
 * Третья форма найдена прогоном `C2` уже ПОСЛЕ первой версии разбора, который
 * знал только две: заключение не появилось, и агент шёл запасным путём. Отсюда
 * правило — хвост фразы не перечисляется, а задаётся широко: опознаём по
 * «<пакет> (pid N)» внутри блока `PROCESS DISAPPEARED` либо по строке-шапке.
 * Незнакомая формулировка должна давать разбор, а не молчание: пропущенный
 * сигнал опаснее лишнего.
 */
const BLOCK = /={5,}\s*PROCESS DISAPPEARED\s*={5,}([\s\S]*?)(?:={5,}|$)/g;
const NAMED = /([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)\s+\(pid\s+(\d+)\)\s*([^\n]*)/g;
const HEADER = /(?:^|\n)\s*\[!\]\s*([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)\s+\(pid\s+(\d+)\)\s*([^\n]*)/g;

function kindOf(tail) {
  if (/has not relaunched/i.test(tail)) return "not-relaunched";
  if (/crashed and relaunched/i.test(tail)) return "relaunched";
  if (/GONE now/i.test(tail)) return "gone";
  return "unknown";
}

/** @returns {{process: string, pid: number, kind: string}[]} */
export function parseCrashSignals(output) {
  if (!output) return [];
  const text = String(output);
  const seen = new Map();
  const add = (name, pid, tail) => {
    // Одна команда может нести и баннер, и шапку про тот же процесс — это один
    // сигнал, а не два.
    if (!seen.has(name)) seen.set(name, { process: name, pid: Number(pid), kind: kindOf(tail) });
  };
  for (const block of text.matchAll(BLOCK)) {
    for (const m of block[1].matchAll(NAMED)) add(m[1], m[2], m[3]);
  }
  for (const m of text.matchAll(HEADER)) add(m[1], m[2], m[3]);
  return [...seen.values()];
}

/**
 * Жив ли целевой пакет прямо сейчас.
 *
 * Намеренно **не** через обёртку журналирования: это проверка harness, а не
 * действие агента. Попав в журнал, она исказила бы и число вызовов, и долю
 * координатных действий — то есть ровно те метрики, ради которых журнал есть.
 */
export function targetAlive(device, appId) {
  if (!device || !appId) return null;
  try {
    const raw = execFileSync("sim-use", ["app-state", "--device", device, "--json"], {
      encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"],
    });
    const apps = JSON.parse(raw)?.data?.apps || [];
    const hit = apps.find((a) => String(a.bundleId || "") === appId);
    return hit ? { alive: true, pid: hit.pid } : { alive: false, pid: null };
  } catch {
    return null;
  }
}

/**
 * Заключение по сигналу.
 *
 * `verdict`:
 *   `none`     — сигнала нет;
 *   `target`   — пропал именно целевой пакет, правило 7 применяется как есть;
 *   `foreign`  — пропал посторонний процесс, целевой проверен и жив;
 *   `unclear`  — сигнал о постороннем, но состояние целевого установить не
 *                удалось. Трактуется как `target`: неизвестность в пользу
 *                остановки, а не в пользу продолжения.
 */
export function classifyCrashSignal({ output, appId, device, verify = targetAlive }) {
  const signals = parseCrashSignals(output);
  if (!signals.length) return { verdict: "none", signals: [] };

  const named = signals.map((s) => s.process);
  if (appId && named.includes(appId)) {
    return { verdict: "target", signals, process: appId };
  }
  if (!appId) return { verdict: "unclear", signals, reason: "appId прогона неизвестен" };

  const state = verify(device, appId);
  if (!state) return { verdict: "unclear", signals, reason: "состояние целевого приложения не читается" };
  if (!state.alive) return { verdict: "target", signals, process: appId, reason: "целевой пакет не запущен" };
  return { verdict: "foreign", signals, targetPid: state.pid };
}

/**
 * Строка, которую harness добавляет к выводу инструмента. Вывод самого
 * `sim-use` не трогается: подменять чужой вывод значило бы прятать
 * первоисточник, а он нужен, если заключение окажется неверным.
 */
export function renderCrashNote(result, appId) {
  if (!result || result.verdict === "none") return null;
  const named = result.signals.map((s) => `${s.process} (pid ${s.pid})`).join(", ");
  if (result.verdict === "foreign") {
    return `[harness] Сигнал о крахе относится к постороннему процессу: ${named}. `
      + `Приложение под тестом ${appId} проверено и живо (pid ${result.targetPid}). `
      + `Правило «STOP при крахе» здесь НЕ применяется — продолжай работу и упомяни это в отчёте.`;
  }
  if (result.verdict === "target") {
    return `[harness] Сигнал о крахе относится к приложению под тестом (${appId}). `
      + `Правило «STOP при крахе» применяется: остановись, не перезапускай приложение, `
      + `сними скриншот и доложи.`;
  }
  return `[harness] Сигнал о крахе: ${named}. Состояние приложения под тестом ${appId} `
    + `установить не удалось (${result.reason}). Трактуй как краху целевого: остановись и доложи. `
    + `Неизвестность разрешается в пользу остановки.`;
}

// Журнал вызовов инструмента (этап 11). Каждый вызов sim-use записывается со
// своим timestamp, длительностью, exit code, stdout и stderr — transcript
// перестаёт быть рукописным пересказом и становится машинной записью того, что
// действительно произошло.
//
// Побочный, но важный эффект: по журналу считается selector mix — доля действий
// по координатам против действий по id/label. Это метрика coordinate-free rate
// из 10.4, которую иначе пришлось бы оценивать на глаз.

import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";

/** Действия, меняющие устройство: только они участвуют в selector mix. */
const ACTION_COMMANDS = ["tap", "swipe", "type", "paste", "button", "scroll", "long-press", "key"];

/**
 * Действия, работающие по текущему фокусу или аппаратной кнопке, а не по точке
 * экрана. Для coordinate-free rate они нейтральны: адресация не координатная,
 * но и селектор им не передаётся — считать их «unknown» значило бы искажать
 * метрику.
 */
const FOCUS_COMMANDS = ["type", "paste", "button", "key"];

/** Признак координатного действия — явные --x/--y/--from/--to. */
const COORDINATE_FLAGS = ["--x", "--y", "--from", "--to", "--target-x", "--target-y"];

export function classifyCall(args) {
  const command = args.find((a) => !a.startsWith("-")) || args[0] || "";
  const isAction = ACTION_COMMANDS.includes(command);
  if (!isAction) return { command, kind: "observe", selector: null };

  const hasCoords = args.some((a) => COORDINATE_FLAGS.includes(a));
  // Позиционный alias (@N, #id) или --label/--id — это селекторный путь.
  const hasSelector = args.some((a) => /^[@#]/.test(a)) || args.includes("--label") || args.includes("--id");

  if (FOCUS_COMMANDS.includes(command) && !hasCoords && !hasSelector) {
    return { command, kind: "action", selector: "focus" };
  }

  let selector = "unknown";
  if (hasCoords && !hasSelector) selector = "coordinate";
  else if (hasSelector && !hasCoords) selector = "selector";
  else if (hasSelector && hasCoords) selector = "mixed";

  return { command, kind: "action", selector };
}

/**
 * Выполняет sim-use и записывает вызов в JSONL-журнал run'а.
 * Возвращает { status, stdout, stderr, durationMs } — вызывающий сам решает,
 * что считать ошибкой: журнал фиксирует факт, а не выносит verdict.
 */
export function runLogged(logPath, args, { bin = "sim-use", maxBuffer = 64 * 1024 * 1024 } = {}) {
  mkdirSync(dirname(logPath), { recursive: true });
  const startedAt = new Date();
  const t0 = Date.now();
  const res = spawnSync(bin, args, { encoding: "utf8", maxBuffer });
  const durationMs = Date.now() - t0;

  const { command, kind, selector } = classifyCall(args);
  const entry = {
    seq: countLines(logPath) + 1,
    timestamp: startedAt.toISOString(),
    bin, command, kind, selector,
    args,
    exitCode: res.status,
    durationMs,
    stdout: truncate(res.stdout),
    stderr: truncate(res.stderr),
    ...(res.error ? { spawnError: res.error.message } : {}),
  };
  appendFileSync(logPath, JSON.stringify(entry) + "\n");
  return { status: res.status, stdout: res.stdout || "", stderr: res.stderr || "", durationMs, entry };
}

// `ui --json` даёт огромные деревья: в журнале держим срез, полный outline
// и так сохраняется отдельными артефактами снимков.
function truncate(text, limit = 4000) {
  if (!text) return "";
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…[обрезано ${text.length - limit} символов]`;
}

function countLines(path) {
  if (!existsSync(path)) return 0;
  const raw = readFileSync(path, "utf8");
  return raw ? raw.trimEnd().split("\n").length : 0;
}

export function readLog(logPath) {
  if (!existsSync(logPath)) return [];
  const raw = readFileSync(logPath, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map((l) => JSON.parse(l));
}

/** Сводка журнала для отчёта run: объём, ошибки и selector mix. */
export function summarizeLog(logPath) {
  const calls = readLog(logPath);
  const actions = calls.filter((c) => c.kind === "action");
  const coordinate = actions.filter((c) => c.selector === "coordinate" || c.selector === "mixed").length;
  const failed = calls.filter((c) => c.exitCode !== 0).length;
  return {
    totalCalls: calls.length,
    actionCalls: actions.length,
    observeCalls: calls.length - actions.length,
    failedCalls: failed,
    coordinateActions: coordinate,
    selectorActions: actions.length - coordinate,
    coordinateFree: actions.length > 0 ? coordinate === 0 : null,
    totalToolMs: calls.reduce((s, c) => s + (c.durationMs || 0), 0),
  };
}

/** Человекочитаемый transcript из журнала — для быстрого чтения глазами. */
export function renderTranscript(logPath) {
  const calls = readLog(logPath);
  const lines = calls.map((c) => {
    const head = `#${c.seq} ${c.timestamp} ${c.bin} ${c.args.join(" ")}`;
    const meta = `    → exit=${c.exitCode} ${c.durationMs}ms${c.kind === "action" ? ` selector=${c.selector}` : ""}`;
    const out = (c.stdout || "").trim().split("\n").filter(Boolean).slice(0, 3).map((l) => `    | ${l}`);
    const err = (c.stderr || "").trim() ? [`    ! ${c.stderr.trim().split("\n")[0]}`] : [];
    return [head, meta, ...out, ...err].join("\n");
  });
  return lines.join("\n") + (lines.length ? "\n" : "");
}

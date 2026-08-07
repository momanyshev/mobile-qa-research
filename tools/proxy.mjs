#!/usr/bin/env node
// Proxy наблюдения + управляемые fault profiles (этапы 6.4 и 9.2).
// Работающий сервер читает конфиг fault-профиля на каждый запрос, поэтому
// enable/reset действуют без перезапуска. Отсутствие конфига или profile
// "passthrough" = чистый pass-through, не изменяющий контракт API.
//
// Схема без пересборки приложения: backend на 8890, proxy слушает 8888 → 8890;
// iOS достигает через 127.0.0.1:8888, Android — через 10.0.2.2:8888. Оракул
// бьёт в backend напрямую на 8890, чтобы не засорять журнал.
//
// Команды:
//   node proxy.mjs serve [--port 8888] [--target http://127.0.0.1:8890] [--log <path>]
//   node proxy.mjs start [...те же флаги]
//   node proxy.mjs status
//   node proxy.mjs clear-log
//   node proxy.mjs enable <profile> [--params '<json>']
//   node proxy.mjs reset            # вернуться в чистый pass-through
//   node proxy.mjs stop
//
// Профили: passthrough | fail-first | delay | http-500 | disconnect |
//          malformed-json | out-of-order | double-write

import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync, openSync, closeSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_LOG = HERE + "proxy/requests.jsonl";
const PID_FILE = HERE + "proxy/proxy.pid";
const META_FILE = HERE + "proxy/proxy.json";
const FAULT_FILE = HERE + "proxy/fault.json";
const WORKSPACE_HEADER = "x-demo-workspace-id";

const SCHEMA_VERSION = 1;
const PROFILES = ["passthrough", "fail-first", "delay", "http-500", "disconnect", "malformed-json", "out-of-order", "double-write"];

function parseFlags(argv) {
  const f = { port: 8888, target: "http://127.0.0.1:8890", log: DEFAULT_LOG };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i]?.startsWith("--")) { f[argv[i].slice(2)] = argv[i + 1]; i++; }
    else rest.push(argv[i]);
  }
  f.port = Number(f.port);
  f._rest = rest;
  return f;
}

function ensureDir() {
  mkdirSync(HERE + "proxy", { recursive: true });
}

function readFault() {
  if (!existsSync(FAULT_FILE)) return { schemaVersion: SCHEMA_VERSION, profile: "passthrough", params: {}, token: 0 };
  try { return JSON.parse(readFileSync(FAULT_FILE, "utf8")); }
  catch { return { schemaVersion: SCHEMA_VERSION, profile: "passthrough", params: {}, token: 0 }; }
}

// Совпадает ли запрос с фильтром профиля (по умолчанию — все /api/ запросы).
function matches(req, params) {
  const m = params.match || {};
  if (m.method && req.method !== m.method) return false;
  const prefix = m.pathPrefix || "/api/";
  return req.url.startsWith(prefix);
}

const jsonError = (code, message) =>
  JSON.stringify({ error: { code, message, fields: {}, requestId: null } });

// ── serve ─────────────────────────────────────────────────────────────────────
function countLoggedLines(path) {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).length;
}

function serve(flags) {
  const target = new URL(flags.target);
  // WHATWG URL сохраняет скобки в hostname IPv6, а node:http ожидает адрес
  // без них. Иначе direct IPv6 проходит resolver/preflight, но proxy получает
  // ENOTFOUND и ломает только путь приложения.
  const targetHostname = target.hostname.replace(/^\[|\]$/gu, "");
  // In-memory состояние профиля, сбрасывается при смене token конфига.
  let faultState = { token: null, matchedCount: 0 };

  function logEntry(req, requestBody, status, requestId, started, extra = {}) {
    const seq = countLoggedLines(flags.log) + 1;
    let parsedBody = null;
    if (requestBody.length) {
      try { parsedBody = JSON.parse(requestBody.toString("utf8")); } catch { parsedBody = requestBody.toString("utf8"); }
    }
    appendFileSync(flags.log, JSON.stringify({
      seq, timestamp: new Date(started).toISOString(), method: req.method, url: req.url,
      workspace: req.headers[WORKSPACE_HEADER] || null, requestBody: parsedBody,
      status, responseRequestId: requestId, durationMs: Date.now() - started, ...extra,
    }) + "\n");
  }

  function forward(req, res, requestBody, started, { transformBody, extraLog, afterEnd } = {}) {
    const proxyReq = http.request({
      hostname: targetHostname, port: target.port, path: req.url, method: req.method,
      headers: { ...req.headers, host: target.host },
    }, (proxyRes) => {
      const resChunks = [];
      proxyRes.on("data", (c) => resChunks.push(c));
      proxyRes.on("end", () => {
        let body = Buffer.concat(resChunks);
        const headers = { ...proxyRes.headers };
        if (transformBody) { body = transformBody(body); delete headers["content-length"]; }
        res.writeHead(proxyRes.statusCode, headers);
        res.end(body);
        if (req.url.startsWith("/api/")) logEntry(req, requestBody, proxyRes.statusCode, proxyRes.headers["x-request-id"] || null, started, extraLog);
        if (afterEnd) afterEnd();
      });
    });
    proxyReq.on("error", (err) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(jsonError("PROXY_UPSTREAM_ERROR", err.message));
    });
    if (requestBody.length) proxyReq.write(requestBody);
    proxyReq.end();
  }

  // «Тихая» пересылка копии запроса (для double-write) — ответ игнорируется.
  function forwardSilent(req, requestBody) {
    const r = http.request({
      hostname: targetHostname, port: target.port, path: req.url, method: req.method,
      headers: { ...req.headers, host: target.host },
    }, (rr) => { rr.on("data", () => {}); rr.on("end", () => {}); });
    r.on("error", () => {});
    if (requestBody.length) r.write(requestBody);
    r.end();
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const requestBody = Buffer.concat(chunks);
      const started = Date.now();
      const fault = readFault();
      if (fault.token !== faultState.token) faultState = { token: fault.token, matchedCount: 0 };

      const apply = fault.profile !== "passthrough" && matches(req, fault.params);
      if (!apply) return forward(req, res, requestBody, started);

      faultState.matchedCount += 1;
      const n = faultState.matchedCount;
      const p = fault.params || {};

      switch (fault.profile) {
        case "http-500":
          res.writeHead(500, { "content-type": "application/json", "x-fault": "http-500" });
          res.end(jsonError("INTERNAL_ERROR", "The server could not process the request"));
          logEntry(req, requestBody, 500, null, started, { fault: "http-500" });
          return;

        case "disconnect":
          logEntry(req, requestBody, 0, null, started, { fault: "disconnect" });
          req.socket.destroy();   // обрыв соединения без ответа
          return;

        case "fail-first":
          // Первый совпавший запрос падает, последующие проходят.
          if (n === 1) {
            res.writeHead(p.status || 503, { "content-type": "application/json", "x-fault": "fail-first" });
            res.end(jsonError("INTERNAL_ERROR", "Injected fail-first"));
            logEntry(req, requestBody, p.status || 503, null, started, { fault: "fail-first" });
            return;
          }
          return forward(req, res, requestBody, started, { extraLog: { fault: "fail-first-passed" } });

        case "delay":
          setTimeout(() => forward(req, res, requestBody, started, { extraLog: { fault: "delay", delayMs: p.delayMs || 2000 } }), p.delayMs || 2000);
          return;

        case "out-of-order": {
          // Ранние совпавшие ответы задерживаются сильнее поздних → инверсия
          // порядка, проверка защиты от stale-ответа старого запроса.
          const hold = Math.max(0, ((p.holdCount || 2) - n) * (p.stepMs || 1500));
          setTimeout(() => forward(req, res, requestBody, started, { extraLog: { fault: "out-of-order", heldMs: hold } }), hold);
          return;
        }

        case "malformed-json":
          return forward(req, res, requestBody, started, {
            transformBody: (b) => Buffer.concat([b.subarray(0, Math.max(0, b.length - 1)), Buffer.from("§")]),
            extraLog: { fault: "malformed-json" },
          });

        case "double-write":
          // Дублируем мутацию: сначала штатный запрос, после его завершения —
          // «тихая» копия (последовательно, чтобы избежать concurrency-конфликта
          // на одном blob). Клиент получает один ответ, backend — две мутации.
          if (["POST", "PATCH", "DELETE"].includes(req.method))
            return forward(req, res, requestBody, started, { extraLog: { fault: "double-write" }, afterEnd: () => forwardSilent(req, requestBody) });
          return forward(req, res, requestBody, started, { extraLog: { fault: "double-write" } });

        default:
          return forward(req, res, requestBody, started);
      }
    });
  });

  server.listen(flags.port, () => {
    writeFileSync(flags.log, "");
    writeFileSync(PID_FILE, String(process.pid));
    writeFileSync(META_FILE, JSON.stringify({ ...flags, startedAt: new Date().toISOString() }, null, 2));
    console.log(`proxy: слушает :${flags.port} → ${flags.target}, журнал ${flags.log}`);
  });
  process.on("SIGTERM", () => { server.close(); process.exit(0); });
  process.on("SIGINT", () => { server.close(); process.exit(0); });
}

// ── управление ──────────────────────────────────────────────────────────────
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

function start(flags) {
  if (existsSync(PID_FILE) && pidAlive(Number(readFileSync(PID_FILE, "utf8")))) {
    console.log(`proxy уже запущен (pid ${readFileSync(PID_FILE, "utf8")})`); return;
  }
  const logFd = openSync(HERE + "proxy/serve.out", "a");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve",
    "--port", String(flags.port), "--target", flags.target, "--log", flags.log],
    { detached: true, stdio: ["ignore", logFd, logFd] });
  child.unref(); closeSync(logFd);
  setTimeout(() => {
    if (existsSync(PID_FILE) && pidAlive(Number(readFileSync(PID_FILE, "utf8"))))
      console.log(`proxy запущен в фоне (pid ${readFileSync(PID_FILE, "utf8")}), :${flags.port} → ${flags.target}`);
    else console.log("proxy не поднялся — см. proxy/serve.out");
  }, 600);
}

function status(flags) {
  const running = existsSync(PID_FILE) && pidAlive(Number(readFileSync(PID_FILE, "utf8")));
  const count = existsSync(flags.log) ? countLoggedLines(flags.log) : 0;
  const meta = existsSync(META_FILE) ? JSON.parse(readFileSync(META_FILE, "utf8")) : null;
  const fault = readFault();
  console.log(JSON.stringify({
    running, pid: running ? Number(readFileSync(PID_FILE, "utf8")) : null,
    loggedRequests: count, fault: { profile: fault.profile, params: fault.params }, meta,
  }, null, 2));
}

function clearLog(flags) { writeFileSync(flags.log, ""); console.log("журнал очищен"); }

function enable(flags) {
  const profile = flags._rest[0];
  if (!PROFILES.includes(profile)) {
    console.error(`Неизвестный профиль ${profile}. Доступны: ${PROFILES.join(", ")}`); process.exit(2);
  }
  let params = {};
  if (flags.params) { try { params = JSON.parse(flags.params); } catch { console.error("--params: невалидный JSON"); process.exit(2); } }
  writeFileSync(FAULT_FILE, JSON.stringify({ schemaVersion: SCHEMA_VERSION, profile, params, token: Date.now(), enabledAt: new Date().toISOString() }, null, 2));
  console.log(`fault включён: ${profile} ${JSON.stringify(params)}`);
}

// Возврат в чистый pass-through. Должен вызываться в teardown КАЖДОГО run,
// в том числе после аварийного завершения.
function reset() {
  writeFileSync(FAULT_FILE, JSON.stringify({ schemaVersion: SCHEMA_VERSION, profile: "passthrough", params: {}, token: Date.now() }, null, 2));
  console.log("fault сброшен → passthrough");
}

function stop() {
  if (!existsSync(PID_FILE)) { console.log("proxy не запущен"); return; }
  const pid = Number(readFileSync(PID_FILE, "utf8"));
  try { process.kill(pid, "SIGTERM"); } catch {}
  try { unlinkSync(PID_FILE); } catch {}
  console.log(`proxy остановлен (pid ${pid})`);
}

const [cmd, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);
ensureDir();
switch (cmd) {
  case "serve": serve(flags); break;
  case "start": start(flags); break;
  case "status": status(flags); break;
  case "clear-log": clearLog(flags); break;
  case "enable": enable(flags); break;
  case "reset": reset(); break;
  case "stop": stop(); break;
  default:
    console.error("Команды: serve | start | status | clear-log | enable <profile> | reset | stop");
    process.exit(2);
}

#!/usr/bin/env node
// Pass-through слой наблюдения HTTP-трафика между мобильным приложением и
// backend (этап 6.4). Пока НЕ изменяет ответы — только пересылает и логирует.
// На этапе 9 сюда добавятся fault profiles.
//
// Схема без пересборки приложения: приложение уже собрано на порт 8888.
//   backend  → перезапускается на 8890
//   proxy    → слушает 8888, пересылает на 8890
// Тогда весь трафик приложения (iOS 127.0.0.1:8888, Android 10.0.2.2:8888)
// проходит через proxy прозрачно. Оракул при этом обращается к backend напрямую
// на 8890, чтобы не засорять журнал служебными запросами.
//
// Команды:
//   node proxy.mjs serve [--port 8888] [--target http://127.0.0.1:8890] [--log <path>]
//   node proxy.mjs start [...те же флаги]   # запускает serve в фоне
//   node proxy.mjs status
//   node proxy.mjs clear-log
//   node proxy.mjs stop
//
// Журнал — JSONL: по одной записи на запрос приложения.

import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync, openSync, closeSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_LOG = HERE + "proxy/requests.jsonl";
const PID_FILE = HERE + "proxy/proxy.pid";
const META_FILE = HERE + "proxy/proxy.json";
const WORKSPACE_HEADER = "x-demo-workspace-id";

function parseFlags(argv) {
  const f = { port: 8888, target: "http://127.0.0.1:8890", log: DEFAULT_LOG };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    if (key && argv[i + 1] !== undefined) f[key] = argv[i + 1];
  }
  f.port = Number(f.port);
  return f;
}

function ensureDir() {
  const dir = HERE + "proxy";
  if (!existsSync(dir)) {
    import("node:fs").then((fs) => fs.mkdirSync(dir, { recursive: true }));
  }
}

// ── serve: собственно proxy-сервер ───────────────────────────────────────────
function countLoggedLines(path) {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).length;
}

function serve(flags) {
  const target = new URL(flags.target);

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const requestBody = Buffer.concat(chunks);
      const started = Date.now();
      const isApi = req.url.startsWith("/api/");

      const proxyReq = http.request(
        {
          hostname: target.hostname,
          port: target.port,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: target.host },
        },
        (proxyRes) => {
          const resChunks = [];
          proxyRes.on("data", (c) => resChunks.push(c));
          proxyRes.on("end", () => {
            const responseBody = Buffer.concat(resChunks);
            // Pass-through: статус, заголовки и тело возвращаются без изменений.
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            res.end(responseBody);

            if (isApi) {
              // seq выводится из числа строк в журнале, поэтому clear-log
              // корректно сбрасывает нумерацию даже для работающего сервера.
              const seq = countLoggedLines(flags.log) + 1;
              let parsedBody = null;
              if (requestBody.length) {
                try { parsedBody = JSON.parse(requestBody.toString("utf8")); } catch { parsedBody = requestBody.toString("utf8"); }
              }
              const entry = {
                seq,
                timestamp: new Date(started).toISOString(),
                method: req.method,
                url: req.url,
                workspace: req.headers[WORKSPACE_HEADER] || null,
                requestBody: parsedBody,
                status: proxyRes.statusCode,
                responseRequestId: proxyRes.headers["x-request-id"] || null,
                durationMs: Date.now() - started,
              };
              appendFileSync(flags.log, JSON.stringify(entry) + "\n");
            }
          });
        }
      );
      proxyReq.on("error", (err) => {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "PROXY_UPSTREAM_ERROR", message: err.message, fields: {}, requestId: null } }));
      });
      if (requestBody.length) proxyReq.write(requestBody);
      proxyReq.end();
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

// ── управление ────────────────────────────────────────────────────────────────
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function start(flags) {
  if (existsSync(PID_FILE)) {
    const pid = Number(readFileSync(PID_FILE, "utf8"));
    if (pidAlive(pid)) { console.log(`proxy уже запущен (pid ${pid})`); return; }
  }
  const logFd = openSync(HERE + "proxy/serve.out", "a");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve",
    "--port", String(flags.port), "--target", flags.target, "--log", flags.log],
    { detached: true, stdio: ["ignore", logFd, logFd] });
  child.unref();
  closeSync(logFd);
  setTimeout(() => {
    if (existsSync(PID_FILE) && pidAlive(Number(readFileSync(PID_FILE, "utf8")))) {
      console.log(`proxy запущен в фоне (pid ${readFileSync(PID_FILE, "utf8")}), :${flags.port} → ${flags.target}`);
    } else {
      console.log("proxy не поднялся — см. proxy/serve.out");
    }
  }, 600);
}

function status(flags) {
  const running = existsSync(PID_FILE) && pidAlive(Number(readFileSync(PID_FILE, "utf8")));
  const logPath = flags.log;
  let count = 0;
  if (existsSync(logPath)) {
    count = readFileSync(logPath, "utf8").split("\n").filter((l) => l.trim()).length;
  }
  const meta = existsSync(META_FILE) ? JSON.parse(readFileSync(META_FILE, "utf8")) : null;
  console.log(JSON.stringify({ running, pid: running ? Number(readFileSync(PID_FILE, "utf8")) : null, loggedRequests: count, meta }, null, 2));
}

function clearLog(flags) {
  writeFileSync(flags.log, "");
  console.log("журнал очищен");
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
  case "stop": stop(); break;
  default:
    console.error("Команды: serve | start | status | clear-log | stop");
    process.exit(2);
}

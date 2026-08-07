#!/usr/bin/env node

// Проверка согласованности долговечных документов с исполняемым контуром и
// ledger прогонов. Она намеренно не выносит исследовательский verdict: задача
// только в том, чтобы числа, ссылки и обязательные правила не расходились
// между источниками истины незаметно.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listAdapters } from "../harness/adapters/index.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? `: ${detail}` : ""}`);
  }
}

function body(path) {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function walk(dir, accept, out = []) {
  for (const name of readdirSync(dir)) {
    const path = resolve(dir, name);
    const rel = relative(ROOT, path);
    if ([".git", "node_modules"].includes(name) || rel.startsWith("evals/reports")) continue;
    const info = lstatSync(path);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) walk(path, accept, out);
    else if (accept(path, rel)) out.push(path);
  }
  return out;
}

function readLedger() {
  const files = walk(resolve(ROOT, "evidence"), (path) => basename(path) === "runs.jsonl");
  const entries = [];
  const errors = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]);
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          throw new Error("ожидался JSON object");
        }
        entries.push(entry);
      } catch (err) {
        errors.push(`${relative(ROOT, file)}:${i + 1}: ${err.message}`);
      }
    }
  }
  return { files, entries, errors };
}

function countBy(entries, key) {
  const out = Object.create(null);
  for (const entry of entries) {
    const value = Object.hasOwn(entry, key) ? String(entry[key]) : "missing";
    out[value] = (out[value] || 0) + 1;
  }
  return out;
}

function compact(text) {
  return text.replace(/\s+/gu, " ").trim();
}

function mentionsNumber(text, n, word) {
  const normalized = compact(text);
  const number = `(?:^|\\D)${n}(?!\\d)`;
  return new RegExp(`${number}.{0,120}(?:${word})`, "iu").test(normalized)
    || new RegExp(`(?:${word}).{0,120}${number}`, "iu").test(normalized);
}

function mentionsCount(text, n, word) {
  if (mentionsNumber(text, n, word)) return true;
  if (n !== 1) return false;
  const normalized = compact(text);
  return new RegExp(`(?:${word}).{0,80}\\bодн(?:а|ой|у)\\b`, "iu").test(normalized)
    || new RegExp(`\\bодн(?:а|ой|у)\\b.{0,80}(?:${word})`, "iu").test(normalized);
}

function between(text, start, end) {
  const from = text.indexOf(start);
  if (from < 0) return "";
  const to = text.indexOf(end, from + start.length);
  return text.slice(from, to < 0 ? undefined : to);
}

function checkLinks() {
  const roots = ["README.md", "AGENTS.md", "CLAUDE.md", "docs", "harness", "mobile-qa-agent", "tools"];
  const files = [];
  for (const item of roots) {
    const path = resolve(ROOT, item);
    if (!existsSync(path)) continue;
    if (lstatSync(path).isDirectory()) walk(path, (p) => p.endsWith(".md"), files);
    else files.push(path);
  }

  const broken = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const inline = lines[i].matchAll(/!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/g);
      const references = lines[i].matchAll(/^\s*\[[^\]]+\]:\s*(<[^>]+>|\S+)/g);
      for (const match of [...inline, ...references]) {
        let target = match[1].trim().replace(/^<|>$/g, "");
        if (!target || target.startsWith("#") || /^[a-z]+:/iu.test(target)) continue;
        try { target = decodeURIComponent(target.split(/[?#]/u)[0]); } catch { /* ниже будет broken */ }
        const resolved = resolve(dirname(file), target);
        const escapesRepo = relative(ROOT, resolved).startsWith("..");
        const allowedSibling = escapesRepo
          && resolved.endsWith("/portfolio-site/docs/openapi.yaml")
          && existsSync(resolved);
        if ((!allowedSibling && escapesRepo) || !existsSync(resolved)) {
          broken.push(`${relative(ROOT, file)}:${i + 1} -> ${target}${escapesRepo ? " (вне репозитория)" : ""}`);
        }
      }
    }
  }
  return broken;
}

console.log("Ledger и исполняемый контур:");
const ledger = readLedger();
const verdicts = countBy(ledger.entries, "verdict");
const platforms = countBy(ledger.entries, "platform");
const evidence = countBy(ledger.entries, "evidenceComplete");
const manifests = walk(resolve(ROOT, "harness/cases"), (p) => p.endsWith(".yaml"));
const adapters = listAdapters().sort();

check("все строки runs.jsonl — валидный JSON", ledger.errors.length === 0, ledger.errors.join("; "));
check("ledger не пуст", ledger.entries.length > 0, "нет ни одной записи");
check("в ledger только известные verdict",
  ledger.entries.every((entry) => typeof entry.verdict === "string"
    && ["PASS", "FAIL", "BLOCKED", "INCONCLUSIVE"].includes(entry.verdict)),
  JSON.stringify(verdicts));
check("в ledger только iOS и Android",
  ledger.entries.every((entry) => typeof entry.platform === "string"
    && ["ios", "android"].includes(entry.platform)), JSON.stringify(platforms));
check("evidenceComplete имеет boolean либо отсутствует как legacy",
  ledger.entries.every((entry) => !Object.hasOwn(entry, "evidenceComplete")
    || typeof entry.evidenceComplete === "boolean"), JSON.stringify(evidence));
check("case manifests найдены", manifests.length > 0, "нет ни одного manifest");
check("adapters = qalab, speecher, elementx",
  adapters.join(",") === "elementx,qalab,speecher", adapters.join(", "));
console.log(`  snapshot: runs=${ledger.entries.length}; verdict=${JSON.stringify(verdicts)}; `
  + `platform=${JSON.stringify(platforms)}; evidenceComplete=${JSON.stringify(evidence)}; cases=${manifests.length}`);

console.log("\nТекущие документы:");
const plan = body("docs/testing-learning-plan.md");
const rootReadme = body("README.md");
const knowledgeReadme = body("docs/knowledge/README.md");
const harnessReadme = body("harness/README.md");
const adaptersReadme = body("harness/adapters/README.md");
const agentReadme = body("mobile-qa-agent/README.md");
const versionPinning = body("docs/knowledge/version-pinning.md");
const environmentGuide = body("docs/knowledge/environment.md");
const assetRegister = body("docs/test-asset-register.md");
const skill = body("mobile-qa-agent/SKILL.md");
const contract = body("mobile-qa-agent/CONTRACT.md");
const qalabSource = body("harness/adapters/qalab.mjs");
const clientSource = body("tools/lib/client.mjs");
const versionsSource = body("harness/lib/versions.mjs");
const currentPlan = between(plan, "## Карта прогресса", "Ниже сохранена датированная хронология");
const rootStatus = between(rootReadme, "## Текущий статус", "## Приложения-стенды");
const knowledgeStatus = between(knowledgeReadme, "## Актуальный post-plan delta", "\n## ");
const currentSurfaces = [
  ["план", currentPlan],
  ["root README", rootStatus],
  ["knowledge index", knowledgeStatus],
  ["README агента", agentReadme],
  ["README harness", harnessReadme],
];

for (const [name, text] of currentSurfaces) {
  check(`${name}: указан ledger ${ledger.entries.length}`,
    mentionsNumber(text, ledger.entries.length, "(?:ledger|запис|прогон)"));
  for (const [verdict, count] of Object.entries(verdicts)) {
    check(`${name}: ${verdict} = ${count}`, mentionsCount(text, count, verdict));
  }
  for (const [platform, count] of Object.entries(platforms)) {
    check(`${name}: ${platform} = ${count}`, mentionsCount(text, count, platform));
  }
  for (const [state, count] of Object.entries(evidence)) {
    const label = state === "missing" ? "(?:legacy|без поля|поля нет)" : `(?:evidenceComplete.{0,40})?${state}`;
    check(`${name}: evidenceComplete ${state} = ${count}`, mentionsCount(text, count, label));
  }
}
check(`README harness: case manifests = ${manifests.length}`,
  mentionsNumber(harnessReadme, manifests.length, "(?:case|манифест)"));
check("план: указан текущий PIVOT",
  /формальн\S* verdict.{0,80}PIVOT/iu.test(compact(currentPlan)));
check("план: stage-16 назван post-plan namespace",
  /stage-16/iu.test(currentPlan)
    && /техническ\S* namespace/iu.test(compact(currentPlan))
    && /постплан/iu.test(currentPlan));
check("root README: stage-16 объяснён", /stage-16.{0,160}(?:post-plan|постплан)/iu.test(compact(rootReadme)));
check("план: замер 10.1 записан без ложного speedup",
  /10\.1.{0,120}A=4.{0,40}B=0.{0,40}C=15.{0,80}19/iu.test(compact(currentPlan))
    && /(?:19.{0,100}270|270.{0,100}19).{0,100}(?:нельзя|несопостав)/iu.test(compact(currentPlan)));
check("план: R-19 закрыт отдельно от частичного 4.3",
  /(?:R-19.{0,50}закрыт|закрыт.{0,50}R-19)/iu.test(compact(currentPlan))
    && /(?:4\.3.{0,80}(?:не закрыт|частич)|не закрыва\S*.{0,30}4\.3)/iu.test(compact(currentPlan)));
check("план: пять physical attempts и четыре evaluable результата различены",
  /пять попыт/iu.test(compact(currentPlan))
    && /четыре evaluable.{0,80}3.{0,20}PASS.{0,30}1.{0,20}FAIL/iu.test(compact(currentPlan))
    && /первая `?C1`?.{0,30}BLOCKED.{0,50}повторн\S* `?C1`?.{0,30}FAIL/iu.test(compact(currentPlan)));
check("README harness: команда prepare документирована", /harness\.mjs prepare|\bprepare\b/iu.test(harnessReadme));
check("README harness: suite = 202", mentionsNumber(harnessReadme, 202, "(?:selftest|suite|проверк)"));
check("README агента: suite = 202", mentionsNumber(agentReadme, 202, "(?:selftest|suite|проверк)"));
check("version pinning: suite = 202", mentionsNumber(versionPinning, 202, "(?:selftest|suite|проверк)"));
check("README adapters: перечислен elementx", /`elementx`/u.test(adaptersReadme));
check("README агента: завершены 14.A–14.E", /14\.A[^\n]{0,80}14\.E[^\n]{0,80}(?:заверш|закрыт|готов)/iu.test(agentReadme));
check("README агента: старое число 103 удалено", !/103\s+проверк/iu.test(agentReadme));
check("README harness: старое число 142 удалено", !/142\s+проверк/iu.test(harnessReadme));
check("version pinning: старое число 103 удалено", !/103\s+проверк/iu.test(versionPinning));
check("README агента: нет старого статуса «готов только 14.A»",
  !/(?:готов|закрыт|заверш)[^\n]{0,30}только[^\n]{0,20}14\.A|14\.B[^\n]{0,60}(?:впереди|предстоит)/iu.test(agentReadme));
check("текущая карта: нет старого утверждения «physical не проверялся»",
  !/физическ[^\n]{0,40}(?:не провер|ни разу|не выделен)/iu.test(currentPlan));
check("текущая карта: R-19 не назван открытым",
  !/R-19.{0,50}(?:открыт|не провер)/iu.test(compact(currentPlan)));

console.log("\nОперационный контракт:");
const r65 = compact(between(skill, "9. **Адресат ввода", "10. **Журналирование"));
const r67 = compact(between(skill, "**Неизменившееся дерево", "**`keyboard-state`"));
const r68 = compact(between(skill, "**На физическом Android", "**Перед свайпом"));
const r70 = compact(between(skill, "10. **Журналирование", "## Приоритет селекторов"));
const crashRule = compact(between(skill, "7. **Crash", "8. **Teardown"));
const contractPolicies = compact(between(contract, "## Политики", "## Чек-лист контракта"));

check("SKILL R-65: успех команды не доказывает адресата",
  /type ok/iu.test(r65) && /focused/iu.test(r65) && /только.{0,80}команд/iu.test(r65)
    && /value.{0,40}целев/iu.test(r65));
check("SKILL R-65: исключение oracle явно дано во входе, иначе stop",
  /входе run явно/iu.test(r65) && /проверк\S* каждого.{0,40}поля/iu.test(r65)
    && /нет.{0,80}останов/iu.test(r65) && /мутац\S* соседн/iu.test(r65));
check("SKILL R-67: post-swipe снимок advisory и нужен следующий",
  /первый `?ui`? после swipe.{0,80}устарев/iu.test(r67)
    && /как минимум следующий/iu.test(r67));
check("SKILL R-67: нет magic N и координаты требуют подтверждения",
  /никакое фиксированное число.{0,80}не доказывает свежесть/iu.test(r67)
    && /screenshot|стабильн\S* selector/iu.test(r67)
    && /не повторяй жест/iu.test(r67));
check("SKILL R-68: stable ID первый, coordinate fallback ограничен",
  /стабильный ID.{0,40}обязательный первый путь/iu.test(r68)
    && /координат\S*.{0,80}не (?:являются|является) fallback/iu.test(r68)
    && /screenshot/iu.test(r68));
check("SKILL R-70: wrapper/TCC → BLOCKED + abort без прямых команд",
  /R-70/u.test(r70) && /BLOCKED\/environment/u.test(r70) && /abort/u.test(r70)
    && /незажурналирован\S* прям\S* команд/iu.test(r70));
check("SKILL crash: foreign+target alive — единственное продолжение",
  /посторонн\S* процесс/iu.test(crashRule) && /жив\S* целев/iu.test(crashRule)
    && /целев\S* или неясн\S* процесс.{0,40}stop/iu.test(crashRule));
check("CONTRACT повторяет fail-closed R-65/R-67/R-70",
  /MUST NOT считаться доказательством/iu.test(contractPolicies)
    && /напечатанн\S* вход run явно/iu.test(contractPolicies)
    && /фиксированное число повторов.{0,50}не доказывает свежесть/iu.test(contractPolicies)
    && /BLOCKED\/environment/iu.test(contractPolicies)
    && /MUST NOT продолжать прямыми незажурналированными/iu.test(contractPolicies));
check("CONTRACT не заявляет изоляцию QA Lab выполненной",
  /- \[ \][^\n]{0,160}(?:Workspace|namespace)/iu.test(contract)
    && !/- \[x\][^\n]{0,160}(?:Workspace|namespace)/iu.test(contract));
check("CONTRACT не заявляет exception-safe teardown выполненным",
  /- \[ \][^\n]{0,160}Teardown/iu.test(contract)
    && /не защищён `finally`/iu.test(contract));
check("environment фиксирует direct default и optional override oracle",
  /(?:default.{0,80}8890|8890.{0,80}default)/iu.test(compact(environmentGuide))
    && /ORACLE_BASE_URL.{0,120}(?:необязательн|override)/iu.test(compact(environmentGuide))
    && /локальн\S*.{0,140}8888.{0,100}отверг/iu.test(compact(environmentGuide)));
check("resolver кода запрещает local 8888 и имеет default 8890",
  /CANONICAL_ORACLE_BASE_URL\s*=\s*"http:\/\/127\.0\.0\.1:8890"/u.test(clientSource)
    && /isLocalAppProxy\(resolved\)/u.test(clientSource)
    && /fault proxy/u.test(clientSource));
check("version manifest получает route из context, не перечитывает env",
  /baseUrl\s*=\s*null, baseUrlSource\s*=\s*null/u.test(versionsSource)
    && !/ORACLE_BASE_URL/u.test(versionsSource)
    && /baseUrlSource/u.test(harnessReadme));
check("proxy readiness сверяет port, target и listener PID",
  /status\.meta\.port/u.test(qalabSource)
    && /status\.meta\.target/u.test(qalabSource)
    && /status\.pid/u.test(qalabSource)
    && /owner\.pid/u.test(qalabSource));
check("environment фиксирует небезопасную ownership-проверку prepare",
  /любой `node`.{0,80}8890\/3999/iu.test(compact(environmentGuide))
    && /Metro.{0,80}(?:без проверки cwd|cwd\/checkout)/iu.test(compact(environmentGuide)));
check("register оставляет arm fail-closed debt открытым",
  /R-66.{0,500}fail-closed arm открыт/iu.test(compact(assetRegister))
    && /нечитаемое \(`null`\) наблюдение проходит/iu.test(compact(assetRegister)));
check("SKILL не возвращает старую гарантию свежего ui",
  !/После каждого действия\s*[—-]\s*свежий `ui`/iu.test(skill));

const skillSha256 = createHash("sha256").update(skill).digest("hex");
check("version pinning содержит полный SHA-256 текущего SKILL",
  versionPinning.includes(skillSha256), skillSha256);

console.log("\nMarkdown-ссылки:");
const brokenLinks = checkLinks();
check("все локальные Markdown-targets существуют; внешний OpenAPI — только известный sibling",
  brokenLinks.length === 0, brokenLinks.join("; "));

console.log(`\nИтого: ${passed} PASS, ${failed} FAIL`);
if (failed) process.exit(1);

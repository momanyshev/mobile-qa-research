#!/usr/bin/env node
// CLI оракула. Тонкая обёртка над lib/* для использования из shell в ходе run
// и как исполняемая проверка самого инструментария (`selftest`).
//
// Примеры:
//   node oracle.mjs new-workspace
//   node oracle.mjs seed <ws> low:open:"Заголовок:Описание длиннее десяти"
//   node oracle.mjs list <ws>
//   node oracle.mjs get <ws> <id>
//   node oracle.mjs teardown <ws>
//   node oracle.mjs selftest            # полный цикл seed→verify→teardown
//
// Базовый URL берётся из ORACLE_BASE_URL (по умолчанию прямой backend
// http://127.0.0.1:8890; proxy приложения 8888 сюда не относится).

import { IssuesClient, resolveOracleRoute } from "./lib/client.mjs";
import { newWorkspaceId, claim, release } from "./lib/workspace.mjs";
import { seedIssues, teardownIssues, teardownWorkspace } from "./lib/fixtures.mjs";
import {
  expectStatus, expectCount, expectFields, expectOnlyChanged,
  expect404, expectWorkspaceIsolation, expectUnchanged,
} from "./lib/verify.mjs";

const { baseUrl } = resolveOracleRoute();
const [cmd, ...args] = process.argv.slice(2);

function out(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

// "severity:status:Заголовок:Описание" → объект дефекта.
function parseIssueSpec(spec) {
  const [severity, status, title, description] = spec.split(":");
  return { title, description, severity, status };
}

async function main() {
  const client = new IssuesClient(baseUrl);

  switch (cmd) {
    case "new-workspace": {
      out({ workspaceId: newWorkspaceId() });
      break;
    }
    case "seed": {
      const [ws, ...specs] = args;
      const created = await seedIssues(client.withWorkspace(ws), specs.map(parseIssueSpec));
      out({ workspaceId: ws, created });
      break;
    }
    case "list": {
      const [ws] = args;
      const res = await client.list({ workspaceId: ws });
      out({ status: res.status, requestId: res.requestId, durationMs: res.durationMs, body: res.body });
      break;
    }
    case "get": {
      const [ws, id] = args;
      const res = await client.get(id, { workspaceId: ws });
      out({ status: res.status, requestId: res.requestId, durationMs: res.durationMs, body: res.body });
      break;
    }
    case "teardown": {
      const [ws, ...ids] = args;
      const report = ids.length
        ? await teardownIssues(client.withWorkspace(ws), ids)
        : await teardownWorkspace(client, { workspaceId: ws });
      out({ workspaceId: ws, teardown: report });
      break;
    }
    case "selftest": {
      await selftest(client);
      break;
    }
    default:
      console.error("Команды: new-workspace | seed | list | get | teardown | selftest");
      process.exit(2);
  }
}

// Полный самопроверочный цикл: доказывает работу всех helper и правил oracle на
// живом backend. Печатает PASS/FAIL и завершается ненулевым кодом при провале.
async function selftest(client) {
  const ws = claim(newWorkspaceId());
  const wsOther = claim(newWorkspaceId());
  const c = client.withWorkspace(ws);
  const cOther = client.withWorkspace(wsOther);
  const checks = [];
  const record = (name, fn) => {
    try { fn(); checks.push({ name, ok: true }); }
    catch (e) { checks.push({ name, ok: false, error: e.message }); }
  };

  try {
    // seed: три записи
    const seeded = await seedIssues(c, [
      { title: "Selftest первая запись", description: "Описание длиннее десяти символов", severity: "low", status: "open" },
      { title: "Selftest вторая запись", description: "Описание длиннее десяти символов", severity: "medium", status: "in_progress" },
      { title: "Selftest третья запись", description: "Описание длиннее десяти символов", severity: "high", status: "open" },
    ]);
    record("seed создал три записи", () => { if (seeded.length !== 3) throw new Error("не 3"); });

    // count
    const list1 = await c.list();
    record("expectCount = 3", () => expectCount(list1, 3));

    // read-only не меняет backend
    const before = (await c.list()).body;
    await c.list();
    const after = (await c.list()).body;
    record("read-only не изменил backend", () => expectUnchanged(before, after));

    // fields
    const target = seeded[0];
    const got = await c.get(target.id);
    record("expectFields точной записи", () => {
      expectStatus(got, 200);
      expectFields(got.body, { title: "Selftest первая запись", severity: "low", status: "open" });
    });

    // patch: меняем только status, остальное не трогаем
    const patched = await c.patch(target.id, { status: "in_progress" });
    record("PATCH статуса: изменился только status", () => {
      expectStatus(patched, 200);
      expectOnlyChanged(target, patched.body, { status: "in_progress" });
    });

    // isolation
    const ownerList = await c.list();
    const otherList = await cOther.list();
    record("Workspace isolation", () => expectWorkspaceIsolation(ownerList, otherList, target.id));

    // delete + 404 + список
    const del = await c.remove(target.id);
    record("DELETE → 204", () => expectStatus(del, 204));
    const gone = await c.get(target.id);
    record("удалённая запись → 404 NOT_FOUND", () => expect404(gone));
    const list2 = await c.list();
    record("после удаления остаётся 2", () => expectCount(list2, 2));
  } finally {
    // teardown обязателен при любом исходе, включая исключение выше
    const t1 = await teardownWorkspace(client, { workspaceId: ws });
    const t2 = await teardownWorkspace(client, { workspaceId: wsOther });
    const empty1 = await c.list();
    const empty2 = await cOther.list();
    record("teardown очистил Workspace A", () => expectCount(empty1, 0));
    record("teardown очистил Workspace B", () => expectCount(empty2, 0));
    checks.push({ name: "teardown report", ok: true, detail: { A: t1, B: t2 } });
    release(ws); release(wsOther);
  }

  const failed = checks.filter((c) => c.ok === false);
  out({ verdict: failed.length ? "FAIL" : "PASS", workspaceA: ws, workspaceB: wsOther, checks });
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });

// Адаптер полигона QA Lab Mobile. Переносит сюда всё знание о REST API
// дефектов, которое раньше было вшито в generic-контур harness (этап 12.2).
// Поведение намеренно совпадает с этапами 10–11: манифесты C1…C6 не менялись.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { IssuesClient } from "../../tools/lib/client.mjs";
import { newWorkspaceId } from "../../tools/lib/workspace.mjs";
import { seedIssues, teardownWorkspace } from "../../tools/lib/fixtures.mjs";
import {
  AssertionError, expectCount, expectFields, expectOnlyChanged,
  expect404, expectUnchanged, expectWorkspaceIsolation,
} from "../../tools/lib/verify.mjs";

const PASS = "pass", FAIL = "fail", ERROR = "error";
const PROXY_CLI = fileURLToPath(new URL("../../tools/proxy.mjs", import.meta.url));

/** Возврат observation-proxy в чистый pass-through после run (этап 9). */
function resetFaultProfile() {
  try {
    execFileSync("node", [PROXY_CLI, "reset"], { stdio: ["ignore", "pipe", "pipe"] });
    return "fault profile → passthrough";
  } catch (err) {
    return `сброс fault profile не выполнен: ${err.message}`;
  }
}

function client(context) {
  return new IssuesClient(context.baseUrl || undefined, context.workspaceId);
}

function findWhere(items, where) {
  return (items || []).filter((it) => Object.entries(where || {}).every(([k, v]) => it[k] === v));
}

function normalizeList(snapshot) {
  return (snapshot?.items || []).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/** Обёртка: AssertionError → FAIL, прочая ошибка → ERROR (не тихий PASS). */
async function guard(fn, okMessage) {
  try {
    await fn();
    return { status: PASS, message: typeof okMessage === "function" ? okMessage() : okMessage };
  } catch (err) {
    if (err instanceof AssertionError) return { status: FAIL, message: err.message, details: err.details };
    return { status: ERROR, message: `сбой oracle: ${err.message}` };
  }
}

export default {
  id: "qalab",
  displayName: "QA Lab Mobile",
  bundleId: { ios: "ru.maksim.qalab", android: "ru.maksim.qalab" },

  /** Полигону нужен живой backend: без него seed и oracle недоказуемы. */
  async preflight({ context } = {}) {
    const baseUrl = context?.baseUrl || process.env.ORACLE_BASE_URL || "http://127.0.0.1:8888";
    try {
      const res = await new IssuesClient(baseUrl, "00000000-0000-4000-8000-000000000000").list();
      return [{
        name: "backend QA Lab отвечает", level: "fail", ok: res.status === 200,
        detail: res.status === 200 ? `${baseUrl} → 200` : `${baseUrl} → ${res.status}`,
      }];
    } catch (err) {
      return [{
        name: "backend QA Lab отвечает", level: "fail", ok: false,
        detail: `${baseUrl} недоступен: ${err.message}. Запустите npm run dev в portfolio-site`,
      }];
    }
  },

  async createContext({ baseUrl } = {}) {
    return {
      kind: "workspace",
      workspaceId: newWorkspaceId(),
      baseUrl: baseUrl || process.env.ORACLE_BASE_URL || "http://127.0.0.1:8888",
    };
  },

  describeContext(context) {
    return `Workspace ${context.workspaceId}`;
  },

  async seed(context, seedSpec) {
    if (!seedSpec?.length) return [];
    const created = await seedIssues(client(context), seedSpec);
    return created.map((s) => ({ id: s.id, title: s.title, status: s.status, severity: s.severity }));
  },

  async readState(context) {
    const res = await client(context).list();
    return res.body;
  },

  async teardown(context) {
    const report = await teardownWorkspace(client(context), { workspaceId: context.workspaceId });
    const parts = [`удалено ${report.deleted.length}, отсутствовало ${report.alreadyAbsent.length}, не удалось ${report.failed.length}`];
    if (report.failed.length) parts.push(`НЕОЧИЩЕННЫЕ FIXTURES: ${JSON.stringify(report.failed)}`);
    // Fault-профили — часть стенда именно QA Lab (этап 9), поэтому сброс живёт
    // здесь, а не в generic-контуре: другим приложениям этот proxy не нужен.
    parts.push(resetFaultProfile());
    return parts.join("; ");
  },

  checks: {
    async count(check, { context, after }) {
      const list = check.query
        ? await client(context).list({ query: check.query })
        : { status: 200, body: after };
      return guard(() => expectCount(list, check.expected), `ровно ${check.expected} записей`);
    },

    async fields(check, { after }) {
      const found = findWhere(after?.items, check.where);
      if (found.length !== 1) {
        return { status: FAIL, message: `по условию ${JSON.stringify(check.where)} найдено записей: ${found.length}, ожидалась 1` };
      }
      return guard(() => expectFields(found[0], check.expect), `поля совпали: ${JSON.stringify(check.expect)}`);
    },

    async onlyChanged(check, { seeded, before, after }) {
      const seed = seeded?.[check.seedIndex];
      if (!seed) return { status: ERROR, message: `нет seed с индексом ${check.seedIndex}` };
      const b = findWhere(before?.items, { id: seed.id })[0];
      const a = findWhere(after?.items, { id: seed.id })[0];
      if (!b) return { status: ERROR, message: "запись отсутствует в состоянии «до»" };
      if (!a) return { status: FAIL, message: "запись исчезла к моменту состояния «после»" };
      return guard(() => expectOnlyChanged(b, a, check.changed), `изменилось ровно ${JSON.stringify(check.changed)}`);
    },

    async absent(check, { context, seeded }) {
      const seed = seeded?.[check.seedIndex];
      if (!seed) return { status: ERROR, message: `нет seed с индексом ${check.seedIndex}` };
      const res = await client(context).get(seed.id);
      return guard(() => expect404(res), `запись ${seed.id} удалена (404 NOT_FOUND)`);
    },

    async unchanged(check, { before, after }) {
      return guard(
        () => expectUnchanged(normalizeList(before), normalizeList(after)),
        "backend не изменился (read-only сценарий)",
      );
    },

    async isolation(check, { context, after }) {
      const found = findWhere(after?.items, check.where);
      if (found.length !== 1) {
        return { status: FAIL, message: `по условию ${JSON.stringify(check.where)} найдено записей: ${found.length}, ожидалась 1` };
      }
      const probeWs = newWorkspaceId();
      const other = await client(context).list({ workspaceId: probeWs });
      return guard(
        () => expectWorkspaceIsolation({ status: 200, body: after }, other, found[0].id),
        `запись не видна в постороннем Workspace ${probeWs}`,
      );
    },
  },

  /** UI-проверка фильтрации: видимое в UI сверяется с независимым API-запросом. */
  uiChecks: {
    async listMatchesQuery(check, { context, after, finalUiText }) {
      const matching = await client(context).list({ query: check.query });
      const matchIds = new Set((matching.body?.items || []).map((i) => i.id));
      const expectVisible = (matching.body?.items || []).map((i) => i.title);
      const expectHidden = (after?.items || []).filter((i) => !matchIds.has(i.id)).map((i) => i.title);

      const missing = expectVisible.filter((t) => !finalUiText.includes(t));
      const leaked = expectHidden.filter((t) => finalUiText.includes(t));
      if (missing.length || leaked.length) {
        return {
          status: FAIL,
          message: `UI не совпал с API-запросом ${JSON.stringify(check.query)}: не показаны [${missing.join(", ")}], лишние [${leaked.join(", ")}]`,
        };
      }
      return { status: PASS, message: `UI совпал с API-запросом: видно ${expectVisible.length}, скрыто ${expectHidden.length}` };
    },
  },
};

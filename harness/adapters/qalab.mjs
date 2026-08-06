// Адаптер полигона QA Lab Mobile. Переносит сюда всё знание о REST API
// дефектов, которое раньше было вшито в generic-контур harness (этап 12.2).
// Поведение намеренно совпадает с этапами 10–11: манифесты C1…C6 не менялись.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
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

// Роль узла в выражение не входит намеренно: iOS отдаёт `StaticText`, Android
// — `TextView`, и привязка к роли делала бы чтение односторонне iOS-овым.
// Совпадением считается только строка, целиком равная UUID, — UUID внутри
// более длинной подписи не подойдёт, что и требуется.
const UUID_TEXT = /"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/gi;

/**
 * Прочитать Workspace, на который приложение смотрит сейчас.
 *
 * Направление согласования выбрано после неудачной попытки обратного.
 * Сначала prepare наводил приложение на сгенерированный UUID через модалку —
 * и упёрся в то, что поле открывается заполненным текущим значением, а
 * backspace у `sim-use` нет: `selectTextOnFocus` выделяет текст только при
 * настоящем фокусе, программный тап такого выделения не даёт ни на Android
 * (R-48), ни, как выяснилось, на iOS. Ввод дописывался к прежнему UUID и
 * давал невалидное значение.
 *
 * Поэтому Workspace берётся у приложения, а не навязывается ему. Побочно это
 * убирает целый класс расхождений: приложение и oracle не могут смотреть в
 * разные пространства, если пространство ровно одно и прочитано с экрана.
 * Изоляция при этом сохраняется — её обеспечивает teardown, опустошающий
 * пространство после каждого прогона, а не свежесть UUID. Плата за решение:
 * параллельные прогоны на одном устройстве недопустимы, что и так верно.
 */
export function readWorkspaceFromScreen(H, device) {
  const tree = H.shq("sim-use", ["ui", "--device", device], { timeout: 90_000 });
  if (!tree) return null;
  const found = [...tree.matchAll(UUID_TEXT)].map((m) => m[1]);
  const unique = [...new Set(found)];
  // Ровно один — иначе непонятно, какой из них рабочий, и угадывать нельзя.
  return unique.length === 1 ? unique[0] : null;
}

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

  /**
   * Подъём стенда полигона. Схема канонична и не обсуждается по месту:
   * backend слушает 8890, proxy 8888 → 8890, приложение ходит через 8888,
   * oracle бьёт в 8890 напрямую. Смысл — иммунитет oracle к fault-профилям:
   * если бы он ходил через proxy, поднятый профиль искажал бы и проверку.
   */
  async prepare({ platform, device, context, helpers: H } = {}) {
    const out = { steps: [] };
    const backendUrl = "http://127.0.0.1:8890";

    // 1. Backend. Порт 8890 намеренно нештатный: netlify dev по умолчанию
    //    занимает 8888, который в этой схеме принадлежит proxy. Стенд,
    //    поднятый «как обычно», ломает схему тихо — приложение работает,
    //    а журнала наблюдения нет.
    await H.step(out, "backend QA Lab на 8890", {
      check: async () => {
        try {
          const res = await new IssuesClient(backendUrl, "00000000-0000-4000-8000-000000000000").list();
          return res.status === 200 ? backendUrl : null;
        } catch { return null; }
      },
      fix: async () => {
        const owner = H.portOwner(8890);
        if (owner && !/netlify|node/.test(owner.cmd)) {
          throw new Error(`порт 8890 занят посторонним процессом (pid ${owner.pid}): ${owner.cmd.slice(0, 90)}. `
            + "Prepare не снимает неопознанные процессы — освободите порт вручную");
        }
        // netlify dev поднимает внутренний сервер функций на 3999 отдельным
        // процессом, и тот переживает SIGTERM родителя. Осиротевший 3999 —
        // причина, по которой следующий netlify dev падает с EADDRINUSE ещё
        // до того, как займёт свой порт: снимаем его вместе с родителем.
        for (const port of [8890, 3999]) {
          const o = H.portOwner(port);
          if (o && /netlify|node/.test(o.cmd)) {
            H.shq("kill", [String(o.pid)], { timeout: 10_000 });
            await H.sleep(1_500);
          }
        }
        const dir = H.appDir();
        if (!existsSync(`${dir}/package.json`)) {
          throw new Error(`каталог полигона не найден: ${dir}. Задайте QALAB_APP_DIR`);
        }
        const { pid, logPath } = H.spawnBackground(
          "npx", ["netlify", "dev", "--offline", "--no-open", "--port", "8890"],
          { cwd: dir, logName: "backend-8890" },
        );
        const up = await H.waitFor(async () => {
          try {
            const res = await new IssuesClient(backendUrl, "00000000-0000-4000-8000-000000000000").list();
            return res.status === 200 ? true : null;
          } catch { return null; }
        }, { timeoutMs: 180_000, everyMs: 2_000 });
        if (!up) throw new Error(`netlify dev не ответил за 180 с, лог: ${logPath}`);
        return `поднят netlify dev (pid ${pid}), лог ${logPath}`;
      },
      detailOk: () => `${backendUrl} → 200`,
    });

    // 2. Proxy. Он же обнуляет fault-профиль: профиль, забытый предыдущим
    //    прогоном, — это тихо искажённый стенд, а не заметная поломка.
    await H.step(out, "observation proxy 8888 → 8890", {
      check: () => {
        const raw = H.shq("node", [PROXY_CLI, "status"], { timeout: 20_000 });
        if (!raw) return null;
        try {
          const st = JSON.parse(raw);
          return st.running && H.portOwner(8888) ? st : null;
        } catch { return null; }
      },
      fix: async () => {
        const owner = H.portOwner(8888);
        if (owner && !/proxy\.mjs|netlify|node/.test(owner.cmd)) {
          throw new Error(`порт 8888 занят посторонним процессом (pid ${owner.pid}): ${owner.cmd.slice(0, 90)}`);
        }
        // Частый случай: netlify dev поднят «как обычно» и сам сел на 8888.
        // Это не посторонний процесс, но схему он ломает — снимаем адресно.
        if (owner && /netlify/.test(owner.cmd)) {
          H.shq("kill", [String(owner.pid)], { timeout: 10_000 });
          await H.sleep(3_000);
        }
        H.shq("node", [PROXY_CLI, "start", "--port", "8888", "--target", backendUrl], { timeout: 30_000 });
        const up = await H.waitFor(() => (H.portOwner(8888) ? true : null), { timeoutMs: 30_000 });
        if (!up) throw new Error("proxy не занял 8888");
        return "proxy поднят" + (owner ? ` (снят netlify dev с 8888, pid ${owner.pid})` : "");
      },
      detailOk: (st) => `running, профиль ${st.fault?.profile || "passthrough"}`,
    });

    await H.step(out, "fault profile = passthrough", {
      check: () => {
        const raw = H.shq("node", [PROXY_CLI, "status"], { timeout: 20_000 });
        try { return JSON.parse(raw)?.fault?.profile === "passthrough" ? "passthrough" : null; } catch { return null; }
      },
      fix: () => { H.shq("node", [PROXY_CLI, "reset"], { timeout: 20_000 }); return "сброшен"; },
    });

    // 3. Metro. Самая дорогая ошибка проекта: базовый URL API зашивается
    //    ПЛАТФОРМЕННОЙ командой сборки, поэтому Metro, поднятый для другой
    //    платформы, отдаёт чужой bundle — приложение стучится не туда при
    //    полностью исправном backend. Прогон 4 августа был так потерян
    //    целиком. Проверка идёт по тому, кто фактически слушает 8081.
    if (device) {
      // Физическое устройство отличается от эмулятора по форме серийника:
      // adb выдаёт эмуляторам `emulator-NNNN`, реальным устройствам — серийный
      // номер производителя. Различие существенно для двух вещей ниже.
      const physical = platform === "android" && !/^emulator-/.test(device);

      // Реверс-туннель: на эмуляторе стенд достижим по алиасу 10.0.2.2, у
      // физического устройства такого алиаса нет, а идти по LAN означало бы
      // зависеть от топологии сети (VPN, изоляция клиентов на точке доступа,
      // смена сети — всё это ломает зашитый в сборку адрес, ср. R-29).
      // `adb reverse` уводит трафик в USB: телефон стучится в собственный
      // 127.0.0.1:8888, а попадает на стенд Mac.
      if (physical) {
        await H.step(out, "reverse-туннель 8888 на устройство", {
          check: () => {
            const list = H.shq("adb", ["-s", device, "reverse", "--list"], { timeout: 20_000 });
            return list?.includes("tcp:8888 tcp:8888") ? "tcp:8888 → tcp:8888" : null;
          },
          fix: () => {
            H.sh("adb", ["-s", device, "reverse", "tcp:8888", "tcp:8888"], { timeout: 20_000 });
            return "туннель поднят";
          },
        });
      }

      const wantScript = platform === "ios"
        ? "ios:local"
        : (physical ? "android:device" : "android:local");
      // «Чужим» считается не только Metro другой платформы, но и Metro той же
      // платформы, поднятый ДРУГИМ скриптом: `android:local` зашивает
      // 10.0.2.2, `android:device` — 127.0.0.1. Бандл от неверного скрипта
      // выглядит рабочим и молча стучится не туда — тот же класс отказа, что
      // потерял прогон 4 августа, только внутри одной платформы.
      const foreign = platform === "ios"
        ? /run:android|:android/
        : (physical ? /run:ios|:ios|android:local/ : /run:ios|:ios|android:device/);
      await H.step(out, `Metro под платформу ${platform}`, {
        check: () => {
          const owner = H.portOwner(8081);
          if (!owner) return null;
          if (foreign.test(owner.cmd)) return null;
          return owner;
        },
        fix: async () => {
          const owner = H.portOwner(8081);
          let note = "";
          if (owner) {
            if (!/expo|metro|react-native/.test(owner.cmd)) {
              throw new Error(`порт 8081 занят неопознанным процессом (pid ${owner.pid}): ${owner.cmd.slice(0, 90)}`);
            }
            // pkill по имени здесь не работает: expo run:* поднимает Metro
            // под собственным именем процесса. Снимается ровно тот, кто
            // фактически держит порт.
            H.shq("kill", [String(owner.pid)], { timeout: 10_000 });
            await H.sleep(3_000);
            note = `снят чужой Metro (pid ${owner.pid}); `;
          }
          const mobileDir = `${H.appDir()}/mobile`;
          const env = { ...process.env };
          if (platform === "android") {
            env.JAVA_HOME = env.JAVA_HOME || "/Applications/Android Studio.app/Contents/jbr/Contents/Home";
            env.ANDROID_HOME = env.ANDROID_HOME || `${process.env.HOME}/Library/Android/sdk`;
          }
          // Серийник передаётся явно: при нескольких видимых устройствах
          // `expo run:android` просит выбрать интерактивно и падает в
          // неинтерактивном режиме.
          const args = ["run", wantScript];
          if (platform === "android") args.push("--", "--device", device);
          const { pid, logPath } = H.spawnBackground(
            "npm", args, { cwd: mobileDir, env, logName: `metro-${platform}` },
          );
          // Сборка и установка идут в этой же команде, поэтому ожидание
          // длинное: холодный expo run:* доходит до 10 минут.
          const up = await H.waitFor(() => {
            const o = H.portOwner(8081);
            return o && !foreign.test(o.cmd) ? true : null;
          }, { timeoutMs: 900_000, everyMs: 5_000 });
          if (!up) throw new Error(`${wantScript} не поднял Metro за 15 мин, лог: ${logPath}`);
          return `${note}запущен npm run ${wantScript} (pid ${pid}), лог ${logPath}`;
        },
        detailOk: (o) => `pid ${o.pid}, ${o.cmd.slice(0, 60)}`,
      });

      // 4. Приложение запущено. После expo run:* оно поднимается само, но
      //    prepare может быть вызван и на уже собранном стенде.
      await H.step(out, "приложение запущено", {
        check: () => {
          const raw = H.shq("sim-use", ["app-state", "--device", device, "--json"], { timeout: 60_000 });
          if (!raw) return null;
          try {
            // app-state отдаёт СПИСОК запущенных приложений, включая системные;
            // нужное ищется по bundleId, а не берётся первым попавшимся.
            const apps = JSON.parse(raw)?.data?.apps || [];
            const app = apps.find((a) => String(a.bundleId || "").includes("qalab"));
            return app ? `${app.bundleId} (pid ${app.pid})` : null;
          } catch { return null; }
        },
        fix: async () => {
          if (platform === "ios") H.shq("xcrun", ["simctl", "launch", device, "ru.maksim.qalab"], { timeout: 60_000 });
          else H.shq("adb", ["-s", device, "shell", "monkey", "-p", "ru.maksim.qalab", "-c", "android.intent.category.LAUNCHER", "1"], { timeout: 60_000 });
          await H.sleep(4_000);
          return "приложение запущено";
        },
        level: "warn",
      });

      // 5. Workspace прогона. Раньше это был единственный оставшийся ручной
      //    шаг между start и arm: человек открывал модалку и вбивал UUID.
      //    Расхождение здесь тихое — агент видит чужие данные, oracle свои,
      //    и результат выглядит как «дефектов нет».
      if (context) {
        await H.step(out, "Workspace прогона согласован с приложением", {
          check: () => {
            const shown = readWorkspaceFromScreen(H, device);
            if (!shown) return null;
            // Явно переданный --workspace не подменяется: оператор мог указать
            // конкретное пространство осознанно, и молча увести прогон в
            // другое было бы хуже отказа.
            if (context.workspacePinned) return shown === context.workspaceId ? shown : null;
            context.workspaceId = shown;
            return shown;
          },
          detailOk: (id) => (context.workspacePinned
            ? `${id} — совпадает с переданным --workspace`
            : `${id} — взят с экрана приложения`),
        });

        // Пустота проверяется, но НЕ чинится: удалять чужие данные молча
        // нельзя, а непустое пространство означает, что предыдущий teardown
        // не отработал — это повод разобраться, а не подчистить и забыть.
        await H.step(out, "Workspace прогона пуст", {
          check: async () => {
            const res = await new IssuesClient(context.baseUrl, context.workspaceId).list();
            if (res.status !== 200) return null;
            const n = res.body?.items?.length ?? 0;
            return n === 0 ? "0 записей" : null;
          },
          detailOk: (v) => v,
        });
      }
    }

    return out.steps;
  },

  /** Полигону нужен живой backend: без него seed и oracle недоказуемы. */
  async preflight({ device, context } = {}) {
    const out = [];
    const baseUrl = context?.baseUrl || process.env.ORACLE_BASE_URL || "http://127.0.0.1:8888";
    try {
      const res = await new IssuesClient(baseUrl, "00000000-0000-4000-8000-000000000000").list();
      out.push({
        name: "backend QA Lab отвечает", level: "fail", ok: res.status === 200,
        detail: res.status === 200 ? `${baseUrl} → 200` : `${baseUrl} → ${res.status}`,
      });
    } catch (err) {
      out.push({
        name: "backend QA Lab отвечает", level: "fail", ok: false,
        detail: `${baseUrl} недоступен: ${err.message}. Запустите npm run dev в portfolio-site`,
      });
    }

    // Приложение должно смотреть в тот же Workspace, куда пойдёт seed. Иначе
    // агент видит чужие (или пустые) данные, а oracle — свои: расхождение
    // тихое и выглядит как «дефектов нет». Именно это сорвало первый прогон
    // recall, поэтому проверка живёт здесь, а не в памяти оператора.
    if (device && context?.workspaceId) {
      try {
        const tree = execFileSync("sim-use", ["ui", "--device", device], {
          encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
        });
        const shown = tree.includes(context.workspaceId);
        out.push({
          name: "приложение наведено на Workspace run'а", level: "warn", ok: shown,
          detail: shown
            ? `${context.workspaceId} виден на экране`
            : `на экране НЕ найден ${context.workspaceId} — приложение смотрит в другой Workspace либо экран с ним не открыт; seed уйдёт мимо агента`,
        });
      } catch (err) {
        out.push({
          name: "приложение наведено на Workspace run'а", level: "warn", ok: false,
          detail: `не удалось прочитать экран: ${err.message.split("\n")[0]}`,
        });
      }
    }
    return out;
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

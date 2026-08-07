# Project adapters (этап 12.2)

Сменный слой, отделяющий знание конкретного приложения от generic-контура
harness. Требование плана: «Определить сменный project adapter для
launch/reset/seed/oracle» и «Запретить перенос QA Lab-specific IDs, labels и
бизнес-шагов» в общий код.

Граница проведена так:

| Generic (не знает о приложении) | Adapter (знает только своё приложение) |
| --- | --- |
| жизненный цикл run: prepare/start/arm/finish/abort | как подготовить стенд и создать изолированный контекст данных |
| захват evidence, журнал вызовов, отчёт | как засеять начальное состояние |
| правила verdict (PASS/FAIL/INCONCLUSIVE) | как прочитать состояние (снимок «до»/«после») |
| метрики серии | как очистить за собой |
| UI-проверки по outline | какие предметные проверки существуют |

## Контракт

Каждый адаптер экспортирует объект по умолчанию:

```js
export default {
  id: "qalab",
  displayName: "QA Lab Mobile",
  bundleId: { ios: "ru.maksim.qalab", android: "ru.maksim.qalab" },

  // Необязательный hook подготовки приложения и его внешних сервисов.
  // Он приводит среду, но verdict о готовности всё равно выносит preflight.
  async prepare({ platform, device, context, out, helpers }),

  // Изолированный контекст данных на один run (Workspace, контейнер, аккаунт).
  async createContext({ platform, device }) -> context,

  // Точное начальное состояние из manifest.preconditions.apiSeed.
  async seed(context, seedSpec) -> seededEntities[],

  // Снимок состояния для api-before / api-after. Должен быть сериализуемым.
  async readState(context) -> snapshot,

  // Очистка. Обязана отрабатывать при любом исходе, включая аварийный.
  async teardown(context) -> reportString,

  // Предметные проверки oracle: { имяТипа: async (check, ctx) => result }.
  checks: {},
};
```

`context` — произвольный сериализуемый объект адаптера; harness хранит его в
`run.json` и передаёт обратно в `finish`/`abort`, поэтому он должен переживать
JSON-сериализацию (никаких живых соединений внутри). Если adapter использует
сетевой oracle, effective route и его provenance также принадлежат context:
version manifest не должен повторно вычислять их из изменяемого окружения.

Результат проверки: `{ status: "pass"|"fail"|"error", message }`. Adapter
никогда не решает судьбу run целиком — сведение к verdict остаётся в generic
`oracle-runner`.

## Доступные адаптеры

- **`qalab`** — QA Lab Mobile (полигон). Контекст = Workspace UUID, состояние =
  список дефектов REST API, проверки поверх `tools/lib/verify.mjs`. В context
  сохраняются нормализованный direct `baseUrl` и `baseUrlSource`: явный
  аргумент → `ORACLE_BASE_URL` → default `http://127.0.0.1:8890`. Seed,
  readState, сетевые checks и teardown используют только этот route; приложение
  остаётся на observation/fault proxy 8888. Локальный `:8888` как oracle route
  отвергается. Само приложение и backend находятся во внешнем
  sibling-репозитории, а не здесь.
- **`speecher`** — Speecher Mobile (второе приложение, iOS). Backend'а нет:
  контекст = контейнер приложения на симуляторе, состояние = `UserDefaults`
  приложения, прочитанный через `simctl get_app_container` + `plutil`. Это и
  есть «детерминированный backend-адаптер» в терминах плана 12.1.
- **`elementx`** — Element X (Android). Контекст = установленное приложение и
  одноразовый локальный Synapse, состояние oracle = прямой снимок SQLite базы.
  Seed через Client-Server API намеренно не используется, чтобы адаптеру не
  требовался access token.

Манифест выбирает адаптер полем `adapter:`; при отсутствии поля используется
`qalab` (обратная совместимость с case-манифестами этапов 10–11).

Для QA Lab отдельный Workspace UUID на каждый run остаётся обязательной частью
контракта. Текущее автоматическое `prepare` без закреплённого `--workspace`
переиспользует UUID с экрана — это известное несоответствие реализации, а не
новая политика изоляции. Teardown обязан очищать run, но не заменяет свежий
namespace.

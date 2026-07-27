# Project adapters (этап 12.2)

Сменный слой, отделяющий знание конкретного приложения от generic-контура
harness. Требование плана: «Определить сменный project adapter для
launch/reset/seed/oracle» и «Запретить перенос QA Lab-specific IDs, labels и
бизнес-шагов» в общий код.

Граница проведена так:

| Generic (не знает о приложении) | Adapter (знает только своё приложение) |
| --- | --- |
| жизненный цикл run: start/arm/finish/abort | как создать изолированный контекст данных |
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
JSON-сериализацию (никаких живых соединений внутри).

Результат проверки: `{ status: "pass"|"fail"|"error", message }`. Adapter
никогда не решает судьбу run целиком — сведение к verdict остаётся в generic
`oracle-runner`.

## Доступные адаптеры

- **`qalab`** — QA Lab Mobile (полигон). Контекст = Workspace UUID, состояние =
  список дефектов REST API, проверки поверх `tools/lib/verify.mjs`.
- **`speecher`** — Speecher Mobile (второе приложение, iOS). Backend'а нет:
  контекст = контейнер приложения на симуляторе, состояние = `UserDefaults`
  приложения, прочитанный через `simctl get_app_container` + `plutil`. Это и
  есть «детерминированный backend-адаптер» в терминах плана 12.1.

Манифест выбирает адаптер полем `adapter:`; при отсутствии поля используется
`qalab` (обратная совместимость с case-манифестами этапов 10–11).

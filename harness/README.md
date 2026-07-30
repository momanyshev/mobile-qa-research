# Harness (этапы 10.0, 11, 12) — воспроизводимый eval-контур run

Закрывает обязательное условие этапа 10 плана: до серии из 36 pilot-runs нужен
контур, в котором **каждый run одинаково структурирован** — иначе benchmark
несравним. Harness даёт один и тот же путь для любого case и любого исхода:
свежий Workspace → seed → фиксация исходного состояния → задание агенту →
фиксация финального состояния → независимый oracle verdict → teardown → полный
evidence pack и отчёт по Приложению B.

Строится поверх инструментария этапа 6 (`../tools/lib`): тот же клиент API,
oracle (`verify.mjs`), fixtures и захват UI. Harness не дублирует их, а
оркестрирует.

С этапа 12 знание о конкретном приложении вынесено в **project adapter**
(`adapters/`, контракт — `adapters/README.md`). Generic-контур не содержит ни
одного identifier, label или бизнес-шага приложения и общается с ним только
через `createContext / seed / readState / teardown / checks`. Манифест выбирает
адаптер полем `adapter:`; без поля используется `qalab`.

## Ключевые свойства

- **Verdict выставляет только oracle** (`verify.mjs` или проверки адаптера), не
  формулировка агента. Самоотчёт агента сохраняется рядом, но на verdict не
  влияет.
- **Честный INCONCLUSIVE вместо тихого PASS.** Неизвестный тип проверки,
  отсутствие финального UI outline или неподтверждённая ручная проверка дают
  `INCONCLUSIVE`, а не PASS.
- **Строгий манифест.** `lib/yaml.mjs` громко падает на табах, flow-коллекциях,
  якорях, дублирующихся ключах и многодокументных файлах — с номером строки.
  Тихо неверно прочитанный манифест испортил бы данные benchmark.
- **Teardown при любом исходе**, включая аварийный `abort`. Что именно чистить,
  знает адаптер: QA Lab удаляет fixtures и возвращает proxy в passthrough,
  Speecher останавливает приложение и сбрасывает системные разрешения.
- **Version manifest на каждый run**: commit приложения, версия sim-use, модель,
  ревизия skill, устройство и ОС — без этого метрики невоспроизводимы.
- **Машинный журнал вызовов** (этап 11): каждый вызов sim-use через `sim.mjs`
  пишется с timestamp, длительностью, exit code, stdout и stderr. Transcript и
  selector mix выводятся из журнала, а не пишутся руками.
- **Диагностика при неуспехе**: для любого verdict кроме `PASS` дополнительно
  снимается системный журнал устройства.
- **Видео на каждом прогоне с устройством** (этап 14.D): запись идёт от `start`
  до `finish`/`abort`, отсутствие файла делает evidence-пакет неполным. Журнал
  команд говорит, что было вызвано, но не что происходило на экране. Сам `.mp4`
  не версионируется (`.gitignore`), его размер выносится в отчёт.
- **Preflight до старта** (этап 14.B): проверяются доступность инструмента,
  UTF-8 локаль, целевое устройство, совпадение платформы, отсутствие лишних
  устройств той же платформы плюс проектные условия адаптера. Не пройден — run
  не начинается и не оставляет следов на диске.
- **Retry budget по журналу**: бюджет из `limits.retryPerAction` проверяется по
  фактическим вызовам, а не со слов агента. Даёт нижнюю оценку — серии со
  сменой селектора между попытками из журнала неразличимы.

## Структура

```
harness/
  cases/          C1…C6, D1…D3, M1…M2, E1…E2 — QA Lab; S1…S5 — Speecher (iOS); A1…A5 — Element X (Android)
  adapters/       сменный слой знания о приложении: qalab, speecher, elementx
  lib/
    yaml.mjs        строгий парсер подмножества YAML (громкий отказ)
    manifest.mjs    загрузка + валидация манифеста; список неподдержанных проверок
    oracle-runner.mjs  манифест → verdict поверх verify.mjs; INCONCLUSIVE честно
    versions.mjs    version manifest run'а
    report.mjs      отчёт по Приложению B — фиксированные 27 полей
    cmdlog.mjs      журнал вызовов, selector mix, transcript из журнала
    diagnostics.mjs системный журнал устройства при неуспешном исходе
    video.mjs       запись экрана на весь run, обязательный артефакт
    summary.mjs     метрики раздела 10.4 по серии runs
    preflight.mjs   проверки среды до старта run (этап 14.B)
  harness.mjs     CLI: list | validate | preflight | new-workspace | start | arm | finish | abort | summary | selftest
  sim.mjs         журналирующая обёртка вокруг sim-use
  selftest.mjs    проверка контура (129 проверок), нужен живой backend
```

Evidence: `../evidence/stage-<N>/<platform>/runs/<runId>/` + строка в
`runs.jsonl` с `evidenceComplete`. Стадия задаётся `HARNESS_STAGE` (по умолчанию
`10`).

## Быстрый старт

Предусловие: backend `npm run dev` (порт 8888) в `../../portfolio-site`. Для
прогонов с устройством — поднятый Simulator/Emulator и наведённое приложение.
**До первой sim-use-команды экспортировать UTF-8 локаль** (иначе кириллица
через `paste` даст mojibake, см. runbook TOOL-LOCALE-001):

```bash
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
```

```bash
node harness.mjs selftest                 # 129 проверок контура (без устройства)
node harness.mjs validate                 # разбор и проверка всех манифестов
node harness.mjs list                     # доступные case

# проверка среды до старта (14.B):
node harness.mjs preflight --platform ios --device <UDID> --case <caseId>

# один run с устройством:
WS=$(node harness.mjs new-workspace)       # заранее задать этот UUID в приложении
node harness.mjs start --case C1-create-issue --platform ios --device <UDID> \
     --workspace "$WS" --model "<модель>" --skill "sim-use-skill-v0.10.0"
# (если seed непустой или приложение наведено уже после start — переснять
#  исходное состояние, чтобы снимок отражал реальный старт агента)
node harness.mjs arm --run <runId>

# … агент выполняет задание. Все вызовы — через журналирующую обёртку: …
node sim.mjs --run <runId> -- ui --device <UDID>
node sim.mjs --run <runId> -- tap "#create-issue-button" --device <UDID>

node harness.mjs finish --run <runId> \
     --retries N --interventions N \
     --self-report "…" --knowledge "…" --follow-up "…"

# аварийное завершение (fixtures всё равно очищаются):
node harness.mjs abort --run <runId> --reason "…" [--category environment]

# сводные метрики серии (10.4); отчёты пишутся в gitignored evals/reports/
node harness.mjs summary --stage 10
```

Если вызовы шли через `sim.mjs`, флаг `--transcript` не нужен: transcript и
число вызовов берутся из журнала. `--transcript` остаётся запасным путём для
прогонов без обёртки.

`start` печатает задание, разрешённые/запрещённые действия и лимиты из
манифеста — это и есть prompt агенту.

## Case-манифесты

Формат — Приложение A плана, расширенное машинно-проверяемым `oracle`:

- `oracle.api.checks[]` — предметные проверки **выбранного адаптера**.
  `qalab`: `count`, `fields`, `onlyChanged`, `absent`, `unchanged`,
  `isolation` (поверх `verify.mjs`). `speecher`: `defaultsEqual`,
  `defaultsAbsent`, `defaultsChanged`, `onlyKeyChanged`, `unchanged`
  (поверх `UserDefaults` из контейнера симулятора);
- `oracle.ui.checks[]` — `containsText` и `notContainsText` работают для любого
  приложения; `listMatchesQuery` даёт адаптер `qalab` (сверяет видимое в UI с
  независимым API-запросом);
- `oracle.manualChecks[]` — то, что нельзя проверить автоматически (например,
  показ Alert, живущего только во время run). Без `--confirm-manual` при
  `finish` run честно завершается как `INCONCLUSIVE`.

Шесть pilot-case QA Lab: C1 создание, C2 фильтры, C3 редактирование,
C4 несохранённые изменения, C5 Workspace isolation, C6 API-инспектор.

Пять case второго приложения (Speecher, iOS): S1 навигация и список,
S2 смена языка с проверкой после перезапуска, S3 сохранение выбора иконки,
S4 отказ в системном разрешении, S5 exploratory charter.

## Границы (scope MVP)

Это gate-контур, не полный runner этапа 11. Он **не** запускает агента, не
управляет устройством и не считает агрегированные метрики benchmark — эти
измерения (10.1–10.3) требуют агента с чистым контекстом и выполняются на
этапе 14. Два drive-only прогона C1 (модель ведёт UI вручную) проверяют сам
harness, а не автономность агента.

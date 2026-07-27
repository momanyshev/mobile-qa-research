# Harness (gate 10.0) — минимальный воспроизводимый контур run

Закрывает обязательное условие этапа 10 плана: до серии из 36 pilot-runs нужен
контур, в котором **каждый run одинаково структурирован** — иначе benchmark
несравним. Harness даёт один и тот же путь для любого case и любого исхода:
свежий Workspace → seed → фиксация исходного состояния → задание агенту →
фиксация финального состояния → независимый oracle verdict → teardown → полный
evidence pack и отчёт по Приложению B.

Строится поверх инструментария этапа 6 (`../tools/lib`): тот же клиент API,
oracle (`verify.mjs`), fixtures и захват UI. Harness не дублирует их, а
оркестрирует.

## Ключевые свойства

- **Verdict выставляет только oracle** (`verify.mjs`), не формулировка агента.
  Самоотчёт агента сохраняется рядом, но на verdict не влияет.
- **Честный INCONCLUSIVE вместо тихого PASS.** Неизвестный тип проверки,
  отсутствие финального UI outline или неподтверждённая ручная проверка дают
  `INCONCLUSIVE`, а не PASS.
- **Строгий манифест.** `lib/yaml.mjs` громко падает на табах, flow-коллекциях,
  якорях, дублирующихся ключах и многодокументных файлах — с номером строки.
  Тихо неверно прочитанный манифест испортил бы данные benchmark.
- **Teardown при любом исходе**, включая аварийный `abort`: fixtures удаляются,
  fault profile сбрасывается в passthrough.
- **Version manifest на каждый run**: commit приложения, версия sim-use, модель,
  ревизия skill, устройство и ОС — без этого метрики невоспроизводимы.

## Структура

```
harness/
  cases/          шесть pilot case-манифестов C1…C6 (Приложение A + oracle)
  lib/
    yaml.mjs        строгий парсер подмножества YAML (громкий отказ)
    manifest.mjs    загрузка + валидация манифеста; список неподдержанных проверок
    oracle-runner.mjs  манифест → verdict поверх verify.mjs; INCONCLUSIVE честно
    versions.mjs    version manifest run'а
    report.mjs      отчёт по Приложению B — фиксированные 27 полей
  harness.mjs     CLI: list | validate | new-workspace | start | arm | finish | abort | selftest
  selftest.mjs    проверка контура (54 проверки), нужен живой backend
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
node harness.mjs selftest                 # 54 проверки контура (без устройства)
node harness.mjs validate                 # разбор и проверка всех манифестов
node harness.mjs list                     # доступные case

# один run с устройством:
WS=$(node harness.mjs new-workspace)       # заранее задать этот UUID в приложении
node harness.mjs start --case C1-create-issue --platform ios --device <UDID> \
     --workspace "$WS" --model "<модель>" --skill "sim-use-skill-v0.10.0"
# (если seed непустой и приложение уже наведено — переснять исходное состояние)
node harness.mjs arm --run <runId>
# … агент выполняет задание, команды пишутся в transcript.txt …
node harness.mjs finish --run <runId> --transcript transcript.txt \
     --tool-calls N --retries N --interventions N \
     --self-report "…" --knowledge "…" --follow-up "…"

# аварийное завершение (fixtures всё равно очищаются):
node harness.mjs abort --run <runId> --reason "…" [--category environment]
```

`start` печатает задание, разрешённые/запрещённые действия и лимиты из
манифеста — это и есть prompt агенту.

## Case-манифесты

Формат — Приложение A плана, расширенное машинно-проверяемым `oracle`:

- `oracle.api.checks[]` — `count`, `fields`, `onlyChanged`, `absent`,
  `unchanged`, `isolation` (выполняются функциями `verify.mjs`);
- `oracle.ui.checks[]` — `containsText`, `notContainsText`, `listMatchesQuery`
  (по финальному UI outline; `listMatchesQuery` сверяет видимое в UI с
  независимым API-запросом);
- `oracle.manualChecks[]` — то, что нельзя проверить автоматически (например,
  показ Alert, живущего только во время run). Без `--confirm-manual` при
  `finish` run честно завершается как `INCONCLUSIVE`.

Шесть pilot-case: C1 создание, C2 фильтры, C3 редактирование, C4 несохранённые
изменения, C5 Workspace isolation, C6 API-инспектор.

## Границы (scope MVP)

Это gate-контур, не полный runner этапа 11. Он **не** запускает агента, не
управляет устройством и не считает агрегированные метрики benchmark — эти
измерения (10.1–10.3) требуют агента с чистым контекстом и выполняются на
этапе 14. Два drive-only прогона C1 (модель ведёт UI вручную) проверяют сам
harness, а не автономность агента.

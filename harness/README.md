# Harness (этапы 10–14 + post-plan) — воспроизводимый eval-контур run

Закрывает обязательное условие этапа 10 плана: до серии из 36 pilot-runs нужен
контур, в котором **каждый run одинаково структурирован** — иначе benchmark
несравним. Требуемый compliant-путь для любого case и исхода:
prepare → preflight → отдельный изолированный контекст → seed → фиксация
исходного состояния → задание агенту → фиксация финального состояния →
независимый oracle verdict → teardown → evidence pack и отчёт по Приложению B.
Default-подготовка QA Lab пока не обеспечивает отдельный контекст без явного
`--workspace`; несоответствие и безопасный текущий запуск описаны ниже.

На 7 августа 2026 года ledger содержит 89 записей: 71 `PASS`, 12 `FAIL`,
5 `BLOCKED`, 1 `INCONCLUSIVE`; 56 на iOS и 33 на Android.
`evidenceComplete: true` имеют 64 записи, `false` — одна, а у 24 legacy-записей
поля нет. Это накопленная история, не один benchmark.

Строится поверх инструментария этапа 6 (`../tools/lib`): тот же клиент API,
oracle (`verify.mjs`), fixtures и захват UI. Harness не дублирует их, а
оркестрирует.

С этапа 12 знание о конкретном приложении вынесено в **project adapter**
(`adapters/`, контракт — `adapters/README.md`). Generic-контур не содержит ни
одного identifier, label или бизнес-шага приложения и общается с ним только
через `prepare? / createContext / seed / readState / teardown / checks`.
Манифест выбирает адаптер полем `adapter:`; без поля используется `qalab`.

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
- **Teardown обязателен при любом исходе**, включая аварийный `abort`. Явные
  `finish`/`abort` пути проверены, но exception-safety пока неполна: исключение
  при финальном capture/readState/oracle может обойти cleanup, а сбой capture
  после seed в `start` — оставить fixtures. Это открытое несоответствие
  реализации, поэтому обещание «teardown гарантирован» до code-fix не даётся.
  Что именно чистить, знает адаптер: QA Lab удаляет fixtures и возвращает proxy
  в passthrough, Speecher останавливает приложение и сбрасывает системные
  разрешения, Element X останавливает приложение, сохраняя одноразовую локальную
  базу для oracle.
- **Version manifest на каждый run**: commit приложения, версия sim-use, модель,
  ревизия skill, устройство и ОС, а для сетевого adapter — фактические
  `baseUrl`/`baseUrlSource` из уже разрешённого context. Без этого метрики
  невоспроизводимы.
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
- **Prepare перед preflight**: приводит стенд к ожидаемому состоянию, но не
  выносит verdict о готовности. `start` вызывает его автоматически; отдельная
  команда нужна для диагностики подготовки.
- **Retry budget по журналу**: бюджет из `limits.retryPerAction` проверяется по
  фактическим вызовам, а не со слов агента. Даёт нижнюю оценку — серии со
  сменой селектора между попытками из журнала неразличимы.

## Структура

```
harness/
  cases/          29 манифестов: 18 QA Lab, 5 Speecher, 6 Element X
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
    prepare.mjs     приведение стенда перед preflight
    preflight.mjs   проверки среды до старта run (этап 14.B)
  harness.mjs     CLI: list | validate | prepare | preflight | new-workspace | start | arm | finish | abort | summary | selftest
  sim.mjs         журналирующая обёртка вокруг sim-use
  selftest.mjs    suite контура (202 проверки; 26 требуют живой backend)
```

Evidence: `../evidence/stage-<N>/<platform>/runs/<runId>/` + строка в
`runs.jsonl` с `evidenceComplete`. Стадия задаётся `HARNESS_STAGE` (по умолчанию
`10`). Каталог `stage-16` — технический namespace постплановой валидации 4–7
августа, а не дополнительный этап завершённого 15-этапного плана.

## Быстрый старт

Для QA Lab нужен внешний sibling-репозиторий `../../portfolio-site`; его путь
для подготовки задаётся `QALAB_APP_DIR`. Version manifest отдельно использует
`APP_REPO`: пока это известное несоответствие, обе переменные должны указывать
на один checkout. Для прогонов с устройством нужен целевой Simulator, Emulator
или физическое устройство.
**До первой sim-use-команды экспортировать UTF-8 локаль** (иначе кириллица
через `paste` даст mojibake, см. runbook TOOL-LOCALE-001):

```bash
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
```

```bash
node harness.mjs selftest                 # 202 проверки контура (26 требуют живой backend)
node harness.mjs validate                 # разбор и проверка всех манифестов
node harness.mjs list                     # доступные case

# отдельная диагностика подготовки; start вызывает prepare сам:
node harness.mjs prepare --platform ios --device <UDID> --case <caseId>

# проверка готовности без изменений среды:
node harness.mjs preflight --platform ios --device <UDID> --case <caseId>

# один QA Lab run: новый UUID сначала явно задаётся в приложении;
# oracle по умолчанию идёт прямо на backend 8890, приложение — через proxy 8888
WS=$(node harness.mjs new-workspace)
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

`ORACLE_BASE_URL` нужен только для нестандартного прямого HTTP backend. QA Lab
нормализует его как origin, сохраняет вместе с source в version manifest и
отвергает локальный адрес proxy `:8888` до seed.

После CHG-002 176 offline-проверок suite прошли. Полный цикл из 26 сетевых
проверок на текущей ревизии ещё не перепройден: среда Codex не получила доступ
к уже работающему локальному backend 8890. Последний полный запуск до CHG-002 —
180 PASS; он не выдаётся за проверку нового routing-кода.

Если вызовы шли через `sim.mjs`, флаг `--transcript` не нужен: transcript и
число вызовов берутся из журнала. `--transcript` остаётся запасным путём для
прогонов без обёртки.

`start` печатает задание, разрешённые/запрещённые действия и лимиты из
манифеста — это и есть prompt агенту.

Отдельный контекст на run остаётся обязательным. Автоматический QA Lab
`prepare` без явно закреплённого `--workspace` сейчас переиспользует UUID,
прочитанный с экрана. Это известное несоответствие реализации, а не разрешение
заменить изоляцию teardown'ом; до исправления compliant-run использует новый
UUID и проверяет его совпадение с приложением.

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

Шесть case Element X (Android): A1…A5 и G1; oracle читает состояние локального
Synapse независимо от UI.

## Границы контура

Harness готовит и проверяет среду, фиксирует lifecycle, evidence и агрегаты, но
не запускает модель как отдельный процесс: выданное `start` задание выполняет
агент, а все его команды проходят через `sim.mjs`. Формальный verdict остаётся
за независимым oracle.

Контур не доказывает экономию времени сам по себе. В одном коротком замере 10.1
получено `A=4`, `B=0`, `C=15` — 19 человеко-минут; сравнивать их с 270 минутами
ручного исследования нельзя из-за разного scope. Поэтому итог исследования
остаётся `PIVOT`, а не `GO`.

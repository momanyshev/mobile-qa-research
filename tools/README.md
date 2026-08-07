# Oracle toolkit и observation proxy (этап 6)

Инструментарий трёх ролей API в исследовании: **seed** (точное начальное
состояние), **oracle** (независимая проверка результата UI-действий) и
**teardown** (очистка). Плюс pass-through **proxy** для наблюдения фактического
HTTP-трафика приложения. Без внешних зависимостей — только Node ≥ 20.

Контракт API — `../../portfolio-site/docs/openapi.yaml` (полигон). Default
независимого oracle — прямой backend `http://127.0.0.1:8890`; fault proxy
приложения на 8888 в control plane не используется. `ORACLE_BASE_URL` нужен
только как override на другой прямой HTTP origin без path. Локальный `:8888`
resolver отвергает до запроса.

## Структура

```
tools/
  lib/
    http.mjs       один запрос → результат с requestId, статусом, длительностью
    client.mjs     IssuesClient: list/get/create/patch/remove + журнал вызовов
    workspace.mjs  свежий UUID на run + guard от параллельного дележа Workspace
    verify.mjs     независимые проверки oracle (бросают AssertionError)
    fixtures.mjs   seedIssues, teardownIssues, teardownWorkspace
  oracle.mjs       CLI: new-workspace | seed | list | get | teardown | selftest
  proxy.mjs        pass-through proxy: serve | start | status | clear-log | stop
  check-docs.mjs   ledger + README + contract + Markdown links без устройства
```

## Проверка документационного drift

После добавления прогонов или изменения операционного контракта запускается:

```bash
node tools/check-docs.mjs
```

Команда выводит агрегаты напрямую из всех `runs.jsonl`, сверяет число case и
adapter'ов с исполняемым контуром, проверяет актуальные README, обязательные
правила `SKILL.md` и локальные Markdown-ссылки. Это структурный gate, а не
исследовательский oracle: он ловит рассинхронизацию документов, но не выставляет
verdict мобильному run.

## Oracle: быстрый старт

```bash
node oracle.mjs selftest          # полный цикл seed→verify→teardown, печатает PASS/FAIL
node oracle.mjs new-workspace     # свежий Workspace UUID
node oracle.mjs seed <ws> 'high:open:Заголовок:Описание длиннее десяти символов'
node oracle.mjs list <ws>
node oracle.mjs teardown <ws>     # без id — очистка всего Workspace
```

Для нестандартного direct backend задайте, например,
`ORACLE_BASE_URL=http://127.0.0.1:9890`. Это не адрес приложения и не способ
направить oracle через observation proxy.

Проверки в `verify.mjs`:

- `expectStatus`, `expectCount` — HTTP-статус и точное число записей;
- `expectFields` — точные значения перечисленных полей;
- `expectOnlyChanged` — изменились ровно ожидаемые поля, id/createdAt сохранены,
  updatedAt продвинут, ничего лишнего не поменялось;
- `expect404` — ресурс отсутствует (404 + код `NOT_FOUND`);
- `expectWorkspaceIsolation` — запись видна в своём Workspace и не видна в чужом;
- `expectUnchanged` — read-only сценарий не изменил backend.

`PASS` выставляют только эти функции, а не формулировка агента.

## Примитивы teardown устойчивы после вызова

`teardownIssues`/`teardownWorkspace` не бросают на 404 (цель уже достигнута) и
не прерываются на первой ошибке — пытаются удалить всё и возвращают отчёт
`{ deleted, alreadyAbsent, failed }`. Если lifecycle дошёл до вызова teardown,
эти примитивы применяются после `FAIL`, `BLOCKED` и аварийного завершения
сценария (проверено на этапе 6). Но текущий harness ещё не защищает весь
`start`/`finish` через `finally`: исключение capture/readState/oracle может не
вызвать cleanup вообще. Это открытое exception-safety несоответствие, а не
свойство самих примитивов teardown.

## Журнал прогонов и полный evidence pack (`runlog.mjs`)

Стандарт прогона для этапа 14 (закрывает пункты 3 и 5 «Общего DoD» этапа 7
автоматически): на каждый run сохраняются initial/final UI outline, screenshot,
transcript и API before/after, а `record` проверяет полноту.

```bash
# 1) в начале run — снимок исходного состояния
node runlog.mjs snapshot --stage 14 --platform ios --run S2-guided --phase initial --device <UDID>
#    + API before: node oracle.mjs list <ws> > api-before.json

# 2) … агент выполняет сценарий, команды пишутся в transcript.txt …

# 3) в конце run — снимок финального состояния
node runlog.mjs snapshot --stage 14 --platform ios --run S2-guided --phase final --device <UDID>
#    + API after: node oracle.mjs list <ws> > api-after.json

# 4) регистрация run + артефактов + проверка полноты
node runlog.mjs record --stage 14 --platform ios --run S2-guided --verdict PASS \
     --json '{"mode":"guided","oracle":"…","note":"…"}' \
     --transcript transcript.txt --api-before api-before.json --api-after api-after.json
#    печатает «✓ evidence pack полон» или «⚠ evidence неполон, нет: …»
```

Артефакты складываются в `evidence/stage-<N>/<platform>/runs/<runId>/`; запись —
в `evidence/stage-<N>/<platform>/runs.jsonl` с полем `evidenceComplete`. Легаси
`runlog.mjs <platform> <id> <verdict> [json]` (этап 7) сохранён.

## Proxy наблюдения

Схема без пересборки приложения (приложение собрано на порт 8888):

```
backend  netlify dev на 8890
proxy    слушает 8888 → пересылает на 8890
app      iOS 127.0.0.1:8888 / Android 10.0.2.2:8888 → проходит через proxy
oracle   обращается к backend напрямую на 8890 (не засоряет журнал)
```

```bash
node proxy.mjs start --port 8888 --target http://127.0.0.1:8890 --log ./proxy/requests.jsonl
node proxy.mjs status        # running, pid, число записей в журнале
node proxy.mjs clear-log     # обнулить журнал перед измерением
node proxy.mjs stop
```

Журнал — JSONL, по записи на каждый `/api/*` запрос приложения:
`seq, timestamp, method, url, workspace, requestBody, status,
responseRequestId, durationMs`. `seq` выводится из числа строк журнала, поэтому
`clear-log` корректно сбрасывает нумерацию даже для работающего сервера.

Pass-through не меняет контракт: статус, тело и заголовки (включая
`X-Request-Id`) возвращаются без изменений.

### Fault profiles (этап 9)

Работающий сервер читает `proxy/fault.json` на каждый запрос, поэтому
`enable`/`reset` действуют без перезапуска. Отсутствие конфига или профиль
`passthrough` = чистый pass-through.

```bash
node proxy.mjs enable http-500                          # 500 на совпавшие запросы
node proxy.mjs enable delay --params '{"delayMs":2000}' # задержка
node proxy.mjs enable fail-first --params '{"status":503}'
node proxy.mjs enable double-write --params '{"match":{"method":"POST"}}'
node proxy.mjs status        # показывает активный профиль
node proxy.mjs reset         # → passthrough (обязателен в teardown каждого run)
```

Профили: `passthrough`, `http-500`, `delay`, `fail-first`, `malformed-json`,
`disconnect`, `out-of-order`, `double-write`. Фильтр совпадения —
`params.match.method` и `params.match.pathPrefix` (по умолчанию все `/api/`).
Конфиг versioned (`schemaVersion`); request log помечает применённый профиль
полем `fault`. `reset` возвращает чистый pass-through и обязан вызываться в
teardown, в том числе после аварийного run. Каталог дефектов и соответствие
профилям — `../docs/stage-9-defect-catalog.md`.

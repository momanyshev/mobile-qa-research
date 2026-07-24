# Oracle toolkit и observation proxy (этап 6)

Инструментарий трёх ролей API в исследовании: **seed** (точное начальное
состояние), **oracle** (независимая проверка результата UI-действий) и
**teardown** (очистка). Плюс pass-through **proxy** для наблюдения фактического
HTTP-трафика приложения. Без внешних зависимостей — только Node ≥ 20.

Контракт API — `../../portfolio-site/docs/openapi.yaml` (полигон). Базовый URL
берётся из `ORACLE_BASE_URL` (по умолчанию `http://127.0.0.1:8888`).

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
```

## Oracle: быстрый старт

```bash
node oracle.mjs selftest          # полный цикл seed→verify→teardown, печатает PASS/FAIL
node oracle.mjs new-workspace     # свежий Workspace UUID
node oracle.mjs seed <ws> 'high:open:Заголовок:Описание длиннее десяти символов'
node oracle.mjs list <ws>
node oracle.mjs teardown <ws>     # без id — очистка всего Workspace
```

Проверки в `verify.mjs`:

- `expectStatus`, `expectCount` — HTTP-статус и точное число записей;
- `expectFields` — точные значения перечисленных полей;
- `expectOnlyChanged` — изменились ровно ожидаемые поля, id/createdAt сохранены,
  updatedAt продвинут, ничего лишнего не поменялось;
- `expect404` — ресурс отсутствует (404 + код `NOT_FOUND`);
- `expectWorkspaceIsolation` — запись видна в своём Workspace и не видна в чужом;
- `expectUnchanged` — read-only сценарий не изменил backend.

`PASS` выставляют только эти функции, а не формулировка агента.

## Teardown устойчив к сбоям

`teardownIssues`/`teardownWorkspace` не бросают на 404 (цель уже достигнута) и
не прерываются на первой ошибке — пытаются удалить всё и возвращают отчёт
`{ deleted, alreadyAbsent, failed }`. Поэтому очистка отрабатывает после `FAIL`,
`BLOCKED` и аварийного завершения сценария (проверено на этапе 6).

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
`X-Request-Id`) возвращаются без изменений. На этапе 9 сюда добавятся fault
profiles.

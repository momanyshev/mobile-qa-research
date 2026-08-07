# CHG-002 — Отделить QA Lab oracle от fault proxy

**Статус:** реализовано; offline-приёмка пройдена, полный live selftest ожидает
доступа среды к локальному backend 8890.

**Дата:** 7 августа 2026 года.

**Согласование:** пользователь одобрил исправление routing oracle как следующий
пункт после reconciliation документации. Каноническая топология уже принята на
этапах 6 и 9: приложение ходит через observation/fault proxy 8888, независимый
oracle — прямо в backend 8890.

**Основание:** аудит `34afe7d` показал, что `qalab.createContext()` по умолчанию
задаёт `context.baseUrl = http://127.0.0.1:8888`. Через этот context выполняются
prepare-проверка пустоты Workspace, preflight, seed, снимки состояния до/после,
сетевые oracle checks и teardown. Поэтому fault profile способен влиять на
проверяющий контур, а version manifest фиксирует тот же неверный default.

## Намерение

Сделать независимость QA Lab oracle свойством исполняемого контура, а не
обязательной памятью оператора. При обычном запуске без переменных окружения все
API-действия harness и standalone oracle должны идти напрямую в backend 8890;
трафик приложения остаётся на proxy 8888.

## Scope

- канонический default и разрешение override в `tools/lib/client.mjs`;
- effective `context.baseUrl` QA Lab adapter и все операции, использующие его;
- preflight/prepare-проверки QA Lab, которые читают backend;
- проверка, что управляемый proxy 8888 действительно нацелен в effective
  direct backend и принадлежит записанному proxy PID;
- корректная передача IPv6 hostname proxy в `node:http`;
- фиксация фактического URL oracle в version manifest;
- unit/integration selftest маршрута;
- текущие README, environment guide, план и drift-checker, которые описывают
  временный обход через `ORACLE_BASE_URL`.

## Non-goals

- не менять URL приложения: iOS/Android продолжают ходить через proxy 8888;
- не менять fault profiles, proxy protocol или backend приложения;
- не исправлять общую ownership-эвристику backend/Metro, reuse Workspace,
  `arm` fail-open или exception-safe teardown — это отдельные changes;
- не менять Speecher/Element X adapters и их oracle;
- не переписывать старые version manifests и evidence;
- не запрещать явный `ORACLE_BASE_URL` для прямого backend другого стенда.

## Требования

### ROUTE-1 — безопасный default

Без `ORACLE_BASE_URL` канонический URL API-клиента oracle и
`qalab.createContext().baseUrl` MUST быть `http://127.0.0.1:8890`. Ни одна
QA Lab API-операция harness не должна молча использовать локальный proxy 8888.

### ROUTE-2 — единый effective URL

Prepare-проверка пустоты, preflight, seed, `readState` до/после, сетевые oracle
checks и teardown MUST создавать клиент из одного `context.baseUrl`. Нельзя
иметь отдельный скрытый fallback на 8888 в любом из этих путей.

### ROUTE-3 — явный override

Явный аргумент `baseUrl` в `createContext` MUST иметь приоритет над
`ORACLE_BASE_URL`, а переменная окружения — над каноническим default. Override
трактуется как URL **прямого backend**, а не proxy приложения; нормализованный
HTTP origin без credentials/path/query/fragment должен попасть в version
manifest без повторного разрешения из env. Локальные адреса proxy на порту
8888 (`127.0.0.1`, `localhost`, loopback IPv6 и Android host alias) MUST быть
отвергнуты до seed, даже если proxy сейчас работает в passthrough.

### ROUTE-4 — честный preflight и provenance

Preflight MUST проверять именно effective URL контекста и печатать его в detail.
Version manifest MUST фиксировать тот же URL, который использует adapter, а не
повторно вычислять независимый default.

### ROUTE-5 — граница proxy

Prepare сохраняет топологию `backend 8890; proxy 8888 → 8890`; bundle
приложения и reverse-туннель не меняются. Исправление routing oracle MUST NOT
лишить fault cases возможности искажать только трафик приложения. Готовность
proxy считается доказанной только если control-plane сообщает порт 8888,
effective target и PID, совпадающий с владельцем listener; mismatch блокирует
prepare и не чинится догадкой.

### ROUTE-6 — fail closed при недоступном direct backend

Если direct backend по effective URL недоступен, preflight блокирует run. Harness
MUST NOT откатываться на доступный proxy 8888 и MUST NOT продолжать с общим
контуром наблюдения и проверки.

## Сценарии приёмки

### Основной путь

`ORACLE_BASE_URL` не задан. QA Lab context получает 8890; seed, before/after,
oracle и teardown обращаются только к 8890; version manifest содержит 8890.
Приложение продолжает обращаться к 8888 и попадает под fault profile.

### Граничный путь — другой прямой backend

Оператор задаёт `ORACLE_BASE_URL=http://127.0.0.1:<другой-порт>` либо передаёт
`baseUrl` в adapter. Все API-операции и version manifest используют один
нормализованный HTTP origin; явный аргумент имеет приоритет.

### Неуспешный путь — жив только proxy

Proxy 8888 отвечает, direct backend 8890 нет. Preflight возвращает blocking
failure по 8890; fallback на 8888 отсутствует, run не создаётся.

### Неуспешный путь — fault profile активен

Тестовый proxy возвращает ошибку или искажённый ответ. Вызовы QA Lab adapter
всё равно уходят по direct URL и получают эталонное состояние; запросов oracle
к proxy не возникает.

## Матрица проверки

| Требование | Проверка / артефакт |
| --- | --- |
| ROUTE-1 | unit: context и standalone client без env получают 8890 |
| ROUTE-2, ROUTE-5 | transport probe: URL вызовов seed/read/check/teardown не содержит 8888 |
| ROUTE-3 | unit: precedence explicit → env → default; локальный proxy URL отвергнут |
| ROUTE-4 | integration: `run.json.context.baseUrl` и `version-manifest.baseUrl` совпадают |
| ROUTE-5 | unit: неверные target/port/PID proxy не проходят readiness |
| ROUTE-6 | preflight с недоступным direct URL возвращает blocking failure без fallback |
| docs | `tools/check-docs.mjs`, Markdown links, `git diff --check` |
| regression | manifest validation, syntax checks, полный harness selftest |

## План реализации

1. Ввести один канонический resolver URL oracle и убрать default 8888.
2. Перевести QA Lab context/preflight/prepare и version manifest на effective
   URL контекста.
3. Добавить transport/provenance tests, которые разделяют direct backend и
   proxy, а не проверяют два контура одной переменной окружения.
4. Удалить из текущих инструкций обязательный workaround через env, сохранив
   override как поддерживаемую возможность.
5. Прогнать все verification gates и записать наблюдаемый результат здесь.

## Результат реализации

- В `tools/lib/client.mjs` один resolver обслуживает standalone oracle и QA Lab
  adapter: приоритет `argument → environment → default`, default 8890,
  нормализация до HTTP origin и fail-closed для локального proxy 8888.
- `context.baseUrl` стал единственным маршрутом preflight, seed, readState,
  сетевых checks и teardown. Version manifest получает этот URL и
  `baseUrlSource` из сохранённого context, а не перечитывает env.
- `prepare` проверяет точные port/target/listener PID observation proxy и не
  подменяет недоступный custom direct backend локальным. IPv6 target передаётся
  в `node:http` без URL-скобок.
- В suite добавлены 21 offline routing-проверка и одна проверка равенства
  context/manifest внутри живого цикла. Наблюдаемый запуск: **176/176 offline
  PASS**, затем ожидаемый отказ доступа sandbox к
  `http://127.0.0.1:8890`; код backend при этом слушал порт вне sandbox.
- Старые run/evidence/version manifests не менялись. На момент review активных
  (`started`) legacy runs не было. Если такой старый run с сохранённым
  `baseUrl=8888` появится из внешней копии, resume намеренно использует его
  сохранённый context; перед продолжением потребуется явная миграция, а не
  молчаливое переписывание evidence.

Текущая suite содержит 202 проверки: 26 проверок живого цикла ещё должны пройти
одним полным запуском без `ORACLE_BASE_URL`. До результата `202 PASS, 0 FAIL`
CHG-002 не считается полностью принятой live-gate, хотя реализация и offline
regression готовы.

Остальные gates на текущем дереве:

- `node tools/check-docs.mjs` — `95 PASS, 0 FAIL`;
- `node harness/harness.mjs validate` — 29 валидных manifests;
- syntax check всех `.mjs` в `harness/`, `tools/`, `mobile-qa-agent/` — PASS;
- `git diff --check` — PASS;
- независимый code review — блокирующих замечаний нет; legacy compatibility
  ограничена явно описанным resume старого сохранённого context.

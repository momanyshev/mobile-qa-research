# Предусловия окружения

Что должно быть верно **до** первой команды прогона. Симптомы уже случившихся
поломок и порядок восстановления — в [../runbook.md](../runbook.md); здесь
только правила подготовки.

Зафиксированные версии (Xcode, AVD, `sim-use`, идентификаторы устройств) — в
этапе 1 `../testing-learning-plan.md`. Команды запуска полигона — в
[../../README.md](../../README.md), раздел «Связка с полигоном».

## Metro не переиспользуется между платформами

Базовый URL API зашивается в bundle **платформенной командой сборки**
(`ios:local` → `127.0.0.1:8888`, `android:local` → `10.0.2.2:8888`). Один
процесс Metro, поднятый для iOS, отдаст Android-клиенту iOS-овый URL, и
приложение будет показывать ошибку API при полностью исправном backend.

Переключаясь между платформами: остановить чужой Metro, запустить
платформенную команду заново и **проверить фактический URL в API-инспекторе
приложения** — а не полагаться на то, какая команда была запущена.

## Android требует явных путей в свежей shell-сессии

Node 22 и Android SDK не лежат в глобальном `PATH`, поэтому нужны

```bash
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
ANDROID_HOME="/Users/maksim/Library/Android/sdk"
```

## Локаль до первой команды sim-use

`LANG` и `LC_ALL` в UTF-8 экспортируются **до** первого вызова `sim-use`
в сессии. Daemon наследует локаль при старте: если он поднялся с пустой
локалью, `paste` тихо превращает кириллицу в mojibake (TOOL-LOCALE-001), и
лечится это только перезапуском daemon. Проверка входит в generic-preflight
harness.

## Изоляция и уборка

- Перед экспериментом создаётся отдельный Workspace UUID.
- Teardown обязателен при **любом** verdict, включая `BLOCKED` и прерывание.
  Порог MVP по утечкам — ноль (см.
  [safety-and-forbidden-actions.md](safety-and-forbidden-actions.md)).
- Приложение должно смотреть в тот же Workspace, куда пойдёт seed. Расхождение
  тихое: агент видит чужие или пустые данные, oracle — свои, и результат
  выглядит как «дефектов нет». Проверка встроена в preflight адаптера `qalab`.

## Relaunch и crash awareness

Намеренный перезапуск приложения сопровождается `sim-use app-state --reset`.
Без этого crash-baseline предыдущего прогона остаётся в силе и либо даёт ложный
`PROCESS DISAPPEARED`, либо, наоборот, маскирует настоящий crash.

## iOS Simulator должен быть запущен как приложение

Устройство, загруженное без `Simulator.app`, оказывается в headless-состоянии
без дисплея: `simctl io … screenshot` отвечает `Device does not have a
'default' display port`, `sim-use ui` — `No translation object returned`, а
запуск приложения падает с `FBSOpenApplicationServiceErrorDomain code=5`.
Порядок: `open -a Simulator`, затем `shutdown` + `boot` того же устройства.
Одного запуска `Simulator.app` поверх уже загруженного устройства недостаточно.

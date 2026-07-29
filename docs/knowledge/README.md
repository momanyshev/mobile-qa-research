# Свод знаний (этап 13.3)

Двенадцать обязательных документов плана. Часть написана здесь, часть уже
существовала как рабочий артефакт предыдущих этапов — дублировать её было бы
вредно, поэтому индекс ведёт к первоисточнику.

| # | Документ | Где |
| --- | --- | --- |
| 1 | Selector guide | [selector-guide.md](selector-guide.md) |
| 2 | iOS pitfalls и recovery | [../runbook.md](../runbook.md), раздел «iOS Simulator» |
| 3 | Android pitfalls и recovery | [../runbook.md](../runbook.md), раздел «Android Emulator / устройство» |
| 4 | API oracle adapter guide | [../../harness/adapters/README.md](../../harness/adapters/README.md) — контракт адаптера и три реализации |
| 5 | Test data, reset и teardown | [safety-and-forbidden-actions.md](safety-and-forbidden-actions.md) (раздел teardown) + [../../tools/README.md](../../tools/README.md) |
| 6 | Safety и forbidden actions | [safety-and-forbidden-actions.md](safety-and-forbidden-actions.md) |
| 7 | Crash и escalation protocol | [../runbook.md](../runbook.md), раздел «Общие правила остановки» |
| 8 | Evidence pack и report schema | [../../harness/README.md](../../harness/README.md) + Приложение B плана (27 полей отчёта) |
| 9 | Failure taxonomy с примерами | [failure-taxonomy.md](failure-taxonomy.md) |
| 10 | Prompt patterns | [prompt-patterns.md](prompt-patterns.md) + [../stage-8-agent-modes.md](../stage-8-agent-modes.md) |
| 11 | Version pinning и upgrade benchmark | [version-pinning.md](version-pinning.md) |
| 12 | Ограничения, не решаемые промптом | [hard-limits.md](hard-limits.md) |

## Рабочий регламент репозитория

Не входит в двенадцать документов плана: это правила ведения работы, вынесенные
сюда из `AGENTS.md`, чтобы тот остался оглавлением.

| Документ | О чём |
| --- | --- |
| [recording-rules.md](recording-rules.md) | Как результат попадает в документы: verdict, системные наблюдения против дефектов полигона, галочки, evidence, git |
| [environment.md](environment.md) | Предусловия до первой команды прогона: Metro на платформу, пути Android, локаль, изоляция, relaunch |

## С чего начать новому участнику

Порядок чтения, рассчитанный на то, чтобы понять возможности и границы подхода
**не повторяя весь путь**:

1. **[hard-limits.md](hard-limits.md)** — чего подход не умеет и почему это не
   лечится формулировкой задания. Самое дорогое знание исследования.
2. **Capability matrix** (этап 13.1 плана) — что подтверждено, что условно, что
   непригодно, со ссылкой на конкретный эксперимент.
3. **[selector-guide.md](selector-guide.md)** — как адресовать элементы и
   почему наличие testID решает меньше, чем кажется.
4. **[../runbook.md](../runbook.md)** — симптом → причина → восстановление.
   Открывать при первом же непонятном поведении.
5. **[../../harness/README.md](../../harness/README.md)** — как устроен контур
   прогона и почему verdict выставляет только oracle.
6. **[failure-taxonomy.md](failure-taxonomy.md)** — как классифицировать
   неуспех, не подгоняя объяснение под желаемый результат.

## Что стоит за этими документами

41 прогон на трёх приложениях: QA Lab Mobile (React Native, полигон с
намеренно хорошей разметкой), Speecher (SwiftUI, ноль `accessibilityIdentifier`,
без backend) и Element X (Compose, настоящие testID, полноценный Matrix
backend). Evidence всех прогонов версионируется в `../../evidence/`, сводные
метрики — `harness.mjs summary`.

Главные выводы в одном абзаце: инструмент **переносится** между приложениями и
стеками (85% generic-слоя без правок), достижимость определяется **типом
контрола**, а не разметкой, независимый oracle строится **тремя разными
способами** (REST API, контейнер приложения, база сервера), а автономность
агента **ещё не измерена** — для этого нужен чистый контекст, и это работа
этапа 14.

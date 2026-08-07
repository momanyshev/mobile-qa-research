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
| [development-workflow.md](development-workflow.md) | Принятая методология SDD: область применения, change lifecycle, источники истины и verification gates |
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

## Исторический срез этапа 13

На 28 июля 2026 года за этими документами стоял 41 прогон на трёх приложениях:
QA Lab Mobile (React Native, внешний полигон с
намеренно хорошей разметкой), Speecher (SwiftUI, ноль `accessibilityIdentifier`,
без backend) и Element X (Compose, настоящие testID, полноценный Matrix
backend). Evidence всех прогонов версионируется в `../../evidence/`, сводные
метрики — `harness.mjs summary`.

Вывод этого датированного среза: инструмент **переносится** между приложениями и
стеками (85% generic-слоя без правок), достижимость определяется **типом
контрола**, а не разметкой, независимый oracle строится **тремя разными
способами** (REST API, контейнер приложения, база сервера). На эту дату
автономность ещё не была измерена; это историческое утверждение, не текущий
статус.

## Актуальный post-plan delta

На 7 августа 2026 года ledger содержит 89 записей: 71 `PASS`, 12 `FAIL`, 5
`BLOCKED`, 1 `INCONCLUSIVE`; 56 iOS и 33 Android. Из них 64 имеют
`evidenceComplete: true`, одна — `false`, 24 legacy-записи поля не имеют,
поэтому 89 нельзя трактовать как один однородный benchmark.

Этапы 14.A–14.E и план из 15 этапов завершены с verdict **`PIVOT`**. В одном
коротком замере получено `A=4`, `B=0`, `C=15`, всего 19 человеко-минут, но
экономия на сопоставимом scope не доказана. `R-19` закрыт пятью попытками на
одном Samsung SM-S931B / Android 15 (3 `PASS`, 1 `FAIL`, 1 `BLOCKED`), что не
равно широкой поддержке физических устройств или полному recovery-набору
этапа 4.3. `evidence/stage-16/` — технический namespace постплановой валидации
4–7 августа, а не новый этап 16.

После CHG-002 direct oracle QA Lab (`8890`) отделён в коде от fault proxy
приложения (`8888`), а context/version manifest и readiness proxy используют
один проверяемый route. Suite расширена до 202 проверок: 176 offline прошли,
26 live-cycle проверок текущей ревизии пока pending из-за недоступности
локального backend из среды Codex. Это не закрывает отдельные долги Workspace,
exception-safe teardown, process ownership и `arm`.

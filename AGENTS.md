# mobile-qa-research

Оглавление репозитория для AI-агента. Знания здесь **не хранятся** — только
критические правила и указатели на документы, где знание живёт целиком.

## Что это за проект

Проверка гипотезы: `sim-use` может стать основой мобильного QA-агента, который
автономно выполняет проверки на iOS и Android и подтверждает результат через
независимый oracle. Полный контекст — `docs/testing-learning-plan.md`.

## Критические правила

Пять правил, нарушение которых обесценивает работу сессии, а не просто требует
правки. Всё остальное — в документах ниже.

1. **Объект исследования — инструмент, не приложение.** `sim-use`,
   accessibility-деревья iOS и Android, окружение. Приложения под тестом —
   только стенд; их дефекты не исследуются и не чинятся, а фиксируются одной
   строкой вне плана. Прошлые сессии уже уходили в проверку функционала
   приложения, и эту работу приходилось откатывать.
2. **Работа идёт строго по текущему этапу плана.** Открой «Карту прогресса» и
   строку «Текущий этап» в `docs/testing-learning-plan.md`; не перескакивай
   вперёд и не возвращайся назад без запроса пользователя.
3. **`PASS` выставляет только независимый oracle.** Ни самооценка агента, ни
   `ok:true` инструмента доказательством не являются.
4. **`[x]` ставится только после наблюдаемого действия или артефакта.**
   Пользователь ведёт чек-листы лично — не отмечай пункты авансом.
5. **Teardown обязателен при любом verdict**, включая `BLOCKED` и прерванный
   прогон.

## Методология изменений

Будущие нетривиальные изменения собственного кода, контрактов и рабочих правил
ведутся по SDD. До реализации открой и выполни канонический регламент
`docs/knowledge/development-workflow.md`; сама запись изменения заводится в
`docs/changes/` как `CHG-NNN`.

## Оглавление

### Ведение исследования

| Документ | О чём |
| --- | --- |
| [docs/testing-learning-plan.md](docs/testing-learning-plan.md) | Главный документ: 15 этапов, «Карта прогресса», обязательные правила запуска, глоссарий, системные наблюдения, accessibility-карты |
| [docs/knowledge/README.md](docs/knowledge/README.md) | Точка входа в свод знаний и порядок чтения для нового участника. Двенадцать обязательных документов плана — счёт по плану, а не по файлам: часть из них живёт вне `docs/knowledge/`, и там же сказано, какие |
| [docs/knowledge/development-workflow.md](docs/knowledge/development-workflow.md) | Принятая методология SDD для будущих изменений собственного кода, контрактов и рабочих правил |
| [docs/changes/](docs/changes/) | Change-записи SDD (`CHG-NNN`): основание, согласование, решения, критерии приёмки. Заводится до реализации нетривиального изменения — порядок в `development-workflow.md` |
| [docs/knowledge/recording-rules.md](docs/knowledge/recording-rules.md) | Как результат попадает в документы: verdict, системные наблюдения против дефектов полигона, галочки, evidence, git |
| [docs/decision-log.md](docs/decision-log.md) | Принятые решения с обоснованием и альтернативами |
| [docs/test-asset-register.md](docs/test-asset-register.md) | Реестр проверок `R-NN`: что автоматизировано, что отложено и почему |
| [docs/comparison-agent-vs-manual.md](docs/comparison-agent-vs-manual.md) | Очная ставка агента и ручного прогона на одной сборке: что ловит каждый, где границы подхода |
| [docs/feature-run-record-types.md](docs/feature-run-record-types.md) | Сторона агента в этой очной ставке: прогоны по новой фиче без посева дефектов |

### Работа с инструментом и платформами

| Документ | О чём |
| --- | --- |
| [docs/knowledge/environment.md](docs/knowledge/environment.md) | Предусловия до первой команды: Metro на платформу, пути Android, локаль, изоляция, relaunch |
| [docs/runbook.md](docs/runbook.md) | Симптом → причина → восстановление → нужна ли эскалация. Открывать при первом непонятном поведении |
| [docs/knowledge/selector-guide.md](docs/knowledge/selector-guide.md) | Как адресовать элементы и почему `testID` решает меньше, чем кажется |
| [docs/knowledge/hard-limits.md](docs/knowledge/hard-limits.md) | Чего подход не умеет и почему это не лечится формулировкой задания |
| [docs/knowledge/failure-taxonomy.md](docs/knowledge/failure-taxonomy.md) | Классификация неуспеха без подгонки под желаемый результат |
| [docs/knowledge/safety-and-forbidden-actions.md](docs/knowledge/safety-and-forbidden-actions.md) | Запрещённые действия, destructive-политика, требования к teardown |
| [docs/knowledge/prompt-patterns.md](docs/knowledge/prompt-patterns.md) | Что работает в формулировках заданий; стартовый промпт при смене модели |
| [docs/knowledge/version-pinning.md](docs/knowledge/version-pinning.md) | Зафиксированные версии и как перемерять после апгрейда |
| [docs/sim-use-skill-v0.10.0.md](docs/sim-use-skill-v0.10.0.md) | Замороженная копия bundled skill `sim-use` 0.10.0 |

### Код

| Каталог | О чём |
| --- | --- |
| [harness/README.md](harness/README.md) | Контур прогона: манифесты, отчёт, метрики, selftest |
| [harness/adapters/README.md](harness/adapters/README.md) | Контракт project adapter и три реализации (QA Lab, Speecher, Element X) |
| [tools/README.md](tools/README.md) | Oracle, fixtures и fault-профили полигона |
| [mobile-qa-agent/](mobile-qa-agent/) | Собственный агент этапа 14: `SKILL.md`, `CONTRACT.md`, evals |
| `evidence/stage-N/<platform>/` | Артефакты прогонов; версионируются вместе с изменением плана |

## Внешняя зависимость

Прогоны выполняются на сторонних приложениях: QA Lab Mobile, Speecher,
Element X. Ни одно из них не является частью этого репозитория и не
разрабатывается здесь — это стенд. Как поднять стенд — [README.md](README.md),
раздел «Приложения-стенды».

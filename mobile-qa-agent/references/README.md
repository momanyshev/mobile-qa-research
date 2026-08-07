# References агента

Структура из плана (14.2) предполагала семь отдельных файлов. Шесть из них уже
существуют как рабочие артефакты этапов 5–13 и **проверены практикой** —
копировать их в агента значило бы завести вторую версию правды, которая
разойдётся с первой. Поэтому здесь карта, а не копии.

| Тема из 14.2 | Канонический документ |
| --- | --- |
| `sim-use-commands.md` | [sim-use-commands.md](sim-use-commands.md) — **здесь**, написан под агента |
| `selector-guide.md` | [../../docs/knowledge/selector-guide.md](../../docs/knowledge/selector-guide.md) |
| `ios-pitfalls.md` | [../../docs/runbook.md](../../docs/runbook.md), раздел «iOS Simulator» |
| `android-pitfalls.md` | [../../docs/runbook.md](../../docs/runbook.md), раздел «Android Emulator / устройство» |
| `api-oracles.md` | [../../harness/adapters/README.md](../../harness/adapters/README.md) — контракт adapter и три реализации |
| `safety-and-escalation.md` | [../../docs/knowledge/safety-and-forbidden-actions.md](../../docs/knowledge/safety-and-forbidden-actions.md) |
| `report-schema.md` | [../../harness/README.md](../../harness/README.md) + Приложение B плана |

Дополнительно, чего в 14.2 не было, но что нужно агенту:

- [../../docs/knowledge/failure-taxonomy.md](../../docs/knowledge/failure-taxonomy.md)
  — классификация неуспеха с реальными примерами;
- [../../docs/knowledge/hard-limits.md](../../docs/knowledge/hard-limits.md)
  — что не обходится переформулировкой задания.

## Как этим пользоваться

`SKILL.md` самодостаточен для обычного прогона: приоритет селекторов, правила
остановки, запреты и порядок работы описаны там целиком. References читаются
**по потребности**, когда встретилась конкретная проблема, а не подряд перед
стартом.

В blind eval действует более узкая граница: ссылки из таблицы выше не становятся
разрешёнными только потому, что перечислены здесь. Исполнитель читает лишь
источники, явно разрешённые напечатанным eval protocol. Текущий protocol
разрешает `docs/runbook.md` и этот каталог references, но закрывает
`docs/knowledge/*`, plan, evidence, case manifest и adapter-документы.

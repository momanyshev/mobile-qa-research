# Mobile QA Research: sim-use

Исследование пригодности инструмента `sim-use` как основы автономного
мобильного QA-агента для iOS и Android. Здесь живут план исследования,
доказательства (evidence), заметки по инструменту и — начиная с этапа 14 —
собственный AI-агент.

Это исследование **инструмента**, а не приложения: тренажёром служит
QA Lab Mobile из соседнего репозитория `../portfolio-site`, но его дефекты и
функционал не являются предметом этого проекта.

## Структура

Полное оглавление репозитория — в [AGENTS.md](AGENTS.md). Коротко:

- `docs/testing-learning-plan.md` — главный документ: план из 15 этапов,
  «Карта прогресса», правила запусков, глоссарий, системные наблюдения и
  accessibility-карты платформ.
- `docs/knowledge/` — свод знаний: selector guide, hard limits, runbook,
  правила фиксации результатов, предусловия окружения. Точка входа —
  `docs/knowledge/README.md`.
- `harness/` — воспроизводимый контур прогона: манифесты кейсов, адаптеры
  приложений, отчёты, selftest.
- `tools/` — oracle, fixtures и fault-профили полигона.
- `mobile-qa-agent/` — собственный агент этапа 14: skill, контракт, evals.
- `evidence/stage-N/<platform>/` — скриншоты и артефакты по этапам плана.
  В отличие от полигона, evidence здесь версионируется.
- `evals/reports/` — отчёты оценочных прогонов.

## Текущий статус

Смотри таблицу «Карта прогресса» и строку «Текущий этап» в
`docs/testing-learning-plan.md` — это единственный источник истины по
прогрессу.

## Связка с полигоном

Приложение-полигон и его окружение запускаются из `../portfolio-site`:

```bash
# backend (порт 8888) — из корня portfolio-site
npm run dev
```

```bash
# iOS-клиент — из корня portfolio-site
npm --prefix mobile run ios:local
```

```bash
# Android-клиент — из корня portfolio-site, с явными путями SDK
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
ANDROID_HOME="/Users/maksim/Library/Android/sdk" \
npm --prefix mobile run android:local
```

Зафиксированные версии окружения (Xcode, AVD, `sim-use`, устройства) — в
этапе 1 плана. Правила старта сессии для AI-агентов — в `AGENTS.md`.

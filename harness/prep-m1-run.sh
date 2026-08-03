#!/bin/zsh
# Подготовка одного прогона M1 под серию повторяемости.
# Шаги ручной подготовки одинаковы для всех пяти прогонов, и делать их руками —
# значит вносить в серию собственную вариативность оператора. Скрипт печатает
# только runId; всё остальное — в stderr.
set -e
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
D=A4FB9F80-3147-45FC-9DBE-53DE7D2FBC37
R=/Users/maksim/Documents/Projects/mobile-qa-research
cd "$R"

say() { print -u2 "  $*"; }

# 1. Приложение должно быть живо: предыдущий прогон мог оставить его убитым.
if ! xcrun simctl spawn $D launchctl list 2>/dev/null | grep -q qalab; then
  say "приложение не запущено — стартую"
  xcrun simctl launch $D ru.maksim.qalab >/dev/null 2>&1
  sleep 15
fi

WS=$(node harness/harness.mjs new-workspace)
say "workspace: $WS"

# 2. Навести приложение на новый Workspace. Прокрутка вверх — по правому краю,
#    чтобы не задеть инлайн-колесо статуса (R-27).
for i in 1 2 3; do
  sim-use swipe --from 428,300 --to 428,880 --duration 0.5 --device $D >/dev/null 2>&1
  sleep 1
done
sim-use tap --label "Изменить Workspace ID" --device $D >/dev/null 2>&1
sleep 2
sim-use tap "#workspace-input" --device $D >/dev/null 2>&1
sleep 2
sim-use paste "$WS" --replace --device $D >/dev/null 2>&1
sleep 1
sim-use tap --label "Сохранить и перейти" --device $D >/dev/null 2>&1
sleep 4

# 3. Старт прогона: seed создаётся здесь, поэтому приложение его ещё не видит.
OUT=$(HARNESS_STAGE=14 node harness/harness.mjs start \
  --case M1-status-guided --platform ios --device $D \
  --workspace "$WS" --model "subagent (clean context)" \
  --skill "серия повторяемости 14.E" 2>&1)
RUN=$(print -r -- "$OUT" | grep '^run:' | awk '{print $2}')
if [[ -z "$RUN" ]]; then print -u2 "$OUT"; exit 1; fi
say "run: $RUN"
TOKEN=$(print -r -- "$OUT" | grep -o 'сбрасывается [a-f0-9]*' | awk '{print $2}')
say "token: $TOKEN"

# 4. Перезапуск — единственный надёжный способ заставить список перечитаться
#    после seed (R-30).
xcrun simctl terminate $D ru.maksim.qalab >/dev/null 2>&1
sleep 2
xcrun simctl launch $D ru.maksim.qalab >/dev/null 2>&1
sleep 18
sim-use app-state --reset --device $D >/dev/null 2>&1

# 5. Проверка, что seed виден агенту: иначе прогон недействителен (R-26).
if ! sim-use ui --device $D 2>&1 | grep -q "1 дефект"; then
  print -u2 "  ОСТАНОВ: приложение не показывает посеянную запись"
  exit 1
fi
say "seed виден"

HARNESS_STAGE=14 node harness/harness.mjs arm --run "$RUN" >/dev/null 2>&1
say "вооружён"

print -r -- "$RUN $TOKEN"

# sim-use: шпаргалка (v0.10.0)

Только то, что нужно в прогоне. Все вызовы — через обёртку
`node harness/sim.mjs --run <runId> -- <команда>`, иначе не соберётся
transcript.

`--device <id>` обязателен везде: UDID для iOS, adb-serial (`emulator-5554`)
для Android.

## Наблюдение

```
ui --device <id>                 дерево доступности (человекочитаемо)
ui --json --device <id>          то же в JSON (используется для evidence)
screenshot --device <id> --output <путь>
app-state --device <id>          какие приложения запущены
app-state --reset --device <id>  снять crash-baseline после явного relaunch
keyboard-state --device <id>     видна ли программная клавиатура
devices --json --all             список устройств с ОС и состоянием
```

Первая строка вывода `ui` — имя наблюдаемого приложения. **Сверяй его с
заданием перед первым действием.**

## Действия

```
tap "#<identifier>" --device <id>        по стабильному ID
tap --label "<точный текст>" --device <id>
tap "@12" --device <id>                  по alias из свежего ui
tap --x <X> --y <Y> --device <id>        координаты — последний путь
long-press … --device <id>
swipe --from X,Y --to X,Y --duration <с> --device <id>
button back --device <id>                Android: только внутри модалки
```

Уточнение неоднозначного селектора: `--element-type Button`,
`--frame maxY=<…>`.

## Ввод текста

```
type "<текст>" --device <id>             iOS; зависит от раскладки устройства
paste "<текст>" --device <id>            iOS; требует hardware keyboard
paste --replace "<текст>" --device <id>  заменить содержимое поля
android type "<текст>" --device <id>     Android; работает с Unicode
android type --clear "<текст>" --device <id>
```

**Кириллица на iOS** — только `paste`, и только при подключённой hardware
keyboard. Перед сессией обязательно:

```
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
```

Иначе daemon испортит текст в mojibake (67 символов прочитаются как 127).

## Диагностика

```
daemon status                    состояние демона
daemon stop                      перезапуск при mojibake или зависании
android init --device <id>       переустановка bridge на Android
record-video --device <id> --output <путь>
```

Если app-scoped `ui` внезапно пуст на Android — вероятен системный overlay.
Диагностировать: `adb exec-out screencap -p > <файл>` и посмотреть глазами.

## Частые ловушки

| Симптом | Причина | Что делать |
| --- | --- | --- |
| `Selector matched N elements` | коллизия одинаковых подписей | `--element-type` или `--frame` |
| `tap` прошёл, эффекта нет | устаревший alias или системная зона | свежий `ui`, проверить постусловие |
| `No matching element` сразу после навигации | анимация не завершилась | `--wait-timeout N`, не `sleep` |
| текст превратился в `–Ъ–љ–Њ…` | пустая локаль демона | `daemon stop`, экспорт UTF-8, повтор |
| `paste` молча ничего не вставил | нет hardware keyboard (iOS) | включить в настройках симулятора |
| колесо picker перелетает | инерция свайпа | тап по строке рядом с центром: один шаг за тап |
| элемент есть в дереве, тап мимо (iOS) | элемент вне viewport | прокрутить в видимую область |
| элемента нет в дереве (Android) | дерево = viewport | прокрутить и переснять `ui` |

Полный runbook «симптом → причина → восстановление» —
`../../docs/runbook.md`.

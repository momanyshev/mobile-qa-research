// Запись экрана на весь run (этап 14.D). До этого момента harness искал
// `run-video.mp4` в артефактах, но никто его не создавал: требование плана
// «video обязателен для FAIL/INCONCLUSIVE» существовало только на бумаге, и во
// всех прогонах поле video молча стояло в false. Требование без механизма —
// это отсутствующее требование, поэтому запись выполняет сам контур.
//
// Два наблюдения этапа 4, из которых следует реализация:
//   * `record-video` останавливается сигналом SIGINT и завершается с кодом 1,
//     но MP4 при этом финализируется корректно — ненулевой код не ошибка;
//   * на Android `mdls` не индексирует длительность записи, поэтому валидация
//     идёт по размеру файла и наличию атома moov, а не по метаданным.

import { spawn } from "node:child_process";
import { existsSync, statSync, readFileSync } from "node:fs";

// Масштаб считается от НАТИВНОГО разрешения, а не от точек: на iPhone 17 Pro
// Max (440×956 pt при 3x) `--scale 0.5` даёт 660×1434, то есть половину от
// 1320×2868. Замерено: scale 0.5 + quality 80 ≈ 2.5 МБ/мин, то есть ~37 МБ на
// 15-минутный прогон. Ниже — режим ~1.5 МБ/мин, при котором последовательность
// действий на экране остаётся читаемой.
const DEFAULT_FPS = 6;
const DEFAULT_SCALE = 0.35;
const DEFAULT_QUALITY = 50;
const MIN_VALID_BYTES = 1024;
const FINALIZE_TIMEOUT_MS = 15_000;
const POLL_MS = 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Старт записи экрана в фоне. Ошибка старта не срывает run: она возвращается
 * причиной, а отсутствие видео поймает проверка полноты evidence.
 * @returns {{started: boolean, pid?: number, path?: string, reason?: string}}
 */
export function startRecording({
  device, dir, fps = DEFAULT_FPS, scale = DEFAULT_SCALE, quality = DEFAULT_QUALITY,
}) {
  if (!device) return { started: false, reason: "run выполняется без устройства" };
  const path = `${dir}/run-video.mp4`;
  try {
    const child = spawn("sim-use", [
      "record-video", "--device", device, "--output", path,
      "--fps", String(fps), "--scale", String(scale), "--quality", String(quality),
    ], { detached: true, stdio: "ignore" });
    child.unref();
    if (!child.pid) return { started: false, reason: "процесс записи не получил pid" };
    return { started: true, pid: child.pid, path };
  } catch (err) {
    return { started: false, reason: `запись не запустилась: ${err.message}` };
  }
}

/** Содержит ли файл атом moov — единственный кросс-платформенный признак того,
 *  что MP4 финализирован и пригоден к воспроизведению. */
function hasMoov(path) {
  try {
    const buf = readFileSync(path);
    return buf.includes(Buffer.from("moov"));
  } catch {
    return false;
  }
}

/**
 * Остановка записи и проверка результата. SIGINT, затем ожидание, пока файл
 * перестанет расти и получит moov. Возвращает валидность явно, чтобы отчёт
 * различал «видео нет» и «видео есть, но битое».
 * @returns {{saved: boolean, path?: string, bytes?: number, reason?: string}}
 */
export async function stopRecording({ pid, path }) {
  if (!pid) return { saved: false, reason: "запись не запускалась" };
  try {
    process.kill(pid, "SIGINT");
  } catch (err) {
    if (err.code !== "ESRCH") return { saved: false, reason: `остановка записи не удалась: ${err.message}` };
    // ESRCH — процесс уже завершился сам; файл всё равно может быть валиден.
  }

  const deadline = Date.now() + FINALIZE_TIMEOUT_MS;
  let lastSize = -1;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    if (!existsSync(path)) continue;
    const size = statSync(path).size;
    if (size === lastSize && size >= MIN_VALID_BYTES && hasMoov(path)) {
      return { saved: true, path, bytes: size };
    }
    lastSize = size;
  }

  if (!existsSync(path)) return { saved: false, reason: "файл записи не создан" };
  const bytes = statSync(path).size;
  if (bytes < MIN_VALID_BYTES) return { saved: false, bytes, reason: `файл записи пуст (${bytes} байт)` };
  return { saved: false, bytes, reason: `MP4 не финализирован за ${FINALIZE_TIMEOUT_MS / 1000} с (нет атома moov)` };
}

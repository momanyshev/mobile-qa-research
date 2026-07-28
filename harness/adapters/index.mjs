// Реестр project adapter'ов. Generic-контур обращается к приложению только
// через этот слой и не знает ни одного identifier, label или бизнес-шага
// конкретного приложения (требование этапа 12.2).

import qalab from "./qalab.mjs";
import speecher from "./speecher.mjs";
import elementx from "./elementx.mjs";

const ADAPTERS = { qalab, speecher, elementx };

/** По умолчанию — qalab: манифесты этапов 10–11 не содержат поля adapter. */
export const DEFAULT_ADAPTER = "qalab";

export function listAdapters() {
  return Object.keys(ADAPTERS);
}

export function getAdapter(id = DEFAULT_ADAPTER) {
  const adapter = ADAPTERS[id];
  if (!adapter) {
    throw new Error(`Неизвестный adapter «${id}». Доступны: ${listAdapters().join(", ")}`);
  }
  return adapter;
}

/** Типы проверок, поддерживаемые адаптером — для валидации манифеста. */
export function supportedChecks(adapter) {
  return {
    api: Object.keys(adapter.checks || {}),
    ui: Object.keys(adapter.uiChecks || {}),
  };
}

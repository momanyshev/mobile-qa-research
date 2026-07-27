// Строгий парсер подмножества YAML для case manifest (Приложение A плана).
//
// Почему не полный YAML и не JSON: манифесты пишет человек, поэтому нужен
// YAML; но harness — измерительный прибор, и тихо неверно прочитанный манифест
// испортил бы данные benchmark. Поэтому парсер поддерживает ровно то, что нужно
// манифестам, и **громко падает** на всём остальном (табы, якоря, flow-коллекции,
// многодокументные файлы) вместо молчаливой догадки.
//
// Поддерживается: вложенные map по отступу в 2 пробела, списки скаляров,
// списки map, блочные скаляры `>`/`>-`/`|`/`|-`, пустые `[]`/`{}`, кавычки,
// числа, булевы, null, комментарии.

export class YamlError extends Error {
  constructor(message, line) {
    super(line ? `${message} (строка ${line})` : message);
    this.name = "YamlError";
    this.line = line;
  }
}

const KEY_RE = /^([A-Za-z0-9_.\-]+):(?:\s+(.*))?$/;

export function parseYaml(text) {
  const lines = text.split("\n");
  const state = { lines, i: 0 };

  for (let n = 0; n < lines.length; n++) {
    if (lines[n].includes("\t")) throw new YamlError("Табуляция запрещена, используйте пробелы", n + 1);
    if (lines[n].trimEnd() === "---" || lines[n].trimEnd() === "...") {
      throw new YamlError("Многодокументные YAML не поддерживаются", n + 1);
    }
  }

  const value = parseBlock(state, 0);
  skipBlank(state);
  if (state.i < lines.length) {
    throw new YamlError(`Лишнее содержимое после конца документа: ${lines[state.i].trim()}`, state.i + 1);
  }
  return value === null ? {} : value;
}

// ── навигация по строкам ──────────────────────────────────────────────────────

function isSkippable(raw) {
  const t = raw.trim();
  return t === "" || t.startsWith("#");
}

function skipBlank(state) {
  while (state.i < state.lines.length && isSkippable(state.lines[state.i])) state.i++;
}

function indentOf(raw) {
  return raw.length - raw.trimStart().length;
}

/** Следующая значимая строка без потребления: { raw, indent, line } или null. */
function peek(state) {
  const save = state.i;
  skipBlank(state);
  if (state.i >= state.lines.length) { state.i = save; return null; }
  const raw = state.lines[state.i];
  const info = { raw, indent: indentOf(raw), line: state.i + 1, at: state.i };
  state.i = save;
  return info;
}

// ── блок: map либо список ─────────────────────────────────────────────────────

function parseBlock(state, minIndent) {
  const head = peek(state);
  if (!head || head.indent < minIndent) return null;
  return head.raw.trimStart().startsWith("-")
    ? parseSequence(state, head.indent)
    : parseMapping(state, head.indent);
}

function parseMapping(state, indent) {
  const map = {};
  for (;;) {
    const head = peek(state);
    if (!head || head.indent < indent) break;
    if (head.indent > indent) throw new YamlError("Неожиданный отступ внутри map", head.line);
    if (head.raw.trimStart().startsWith("- ")) break;

    const content = head.raw.trim();
    const m = KEY_RE.exec(content);
    if (!m) throw new YamlError(`Ожидалась пара «ключ: значение», получено: ${content}`, head.line);
    const [, key, rawValue] = m;
    if (Object.prototype.hasOwnProperty.call(map, key)) {
      throw new YamlError(`Дублирующийся ключ ${key}`, head.line);
    }
    state.i = head.at + 1;

    map[key] = readValue(state, rawValue, indent, head.line);
  }
  return map;
}

function parseSequence(state, indent) {
  const list = [];
  for (;;) {
    const head = peek(state);
    if (!head || head.indent < indent) break;
    if (head.indent > indent) throw new YamlError("Неожиданный отступ внутри списка", head.line);
    const content = head.raw.trim();
    if (!content.startsWith("-")) break;
    if (content !== "-" && !content.startsWith("- ")) {
      throw new YamlError(`Ожидался элемент списка «- значение», получено: ${content}`, head.line);
    }
    const rest = content === "-" ? "" : content.slice(2).trim();
    state.i = head.at + 1;

    if (rest === "") {
      const nested = parseBlock(state, indent + 1);
      list.push(nested);
      continue;
    }
    // «- key: value» — map, первая пара которой лежит на строке дефиса.
    const m = KEY_RE.exec(rest);
    if (m) {
      const item = {};
      item[m[1]] = readValue(state, m[2], indent + 2, head.line);
      const tail = parseBlockAt(state, indent + 2);
      if (tail && typeof tail === "object" && !Array.isArray(tail)) Object.assign(item, tail);
      else if (tail !== null) throw new YamlError("Ожидались продолжающие ключи map в элементе списка", head.line);
      list.push(item);
      continue;
    }
    list.push(parseScalar(rest, head.line));
  }
  return list;
}

/** Продолжение map ровно на заданном отступе (для «- key: value»). */
function parseBlockAt(state, indent) {
  const head = peek(state);
  if (!head || head.indent !== indent) return null;
  if (head.raw.trimStart().startsWith("- ")) return null;
  return parseMapping(state, indent);
}

/**
 * Значение ключа: пустое → вложенный блок; блочный скаляр → собранный текст;
 * иначе → скаляр на той же строке.
 */
function readValue(state, rawValue, indent, line) {
  const value = rawValue === undefined ? "" : rawValue.trim();

  if (value === "") {
    const nested = parseBlock(state, indent + 1);
    return nested === null ? null : nested;
  }
  if (value === ">" || value === ">-" || value === "|" || value === "|-") {
    return readBlockScalar(state, indent, value);
  }
  return parseScalar(value, line);
}

function readBlockScalar(state, indent, marker) {
  const collected = [];
  for (;;) {
    if (state.i >= state.lines.length) break;
    const raw = state.lines[state.i];
    if (raw.trim() === "") { collected.push(""); state.i++; continue; }
    if (indentOf(raw) <= indent) break;
    collected.push(raw.slice(indent + 2));
    state.i++;
  }
  while (collected.length && collected[collected.length - 1] === "") collected.pop();
  const folded = marker.startsWith(">");
  let text = folded ? collected.map((l) => l.trim()).join(" ") : collected.join("\n");
  if (!marker.endsWith("-")) text += "\n";
  return text;
}

// ── скаляры ───────────────────────────────────────────────────────────────────

function stripComment(s) {
  // Комментарий только после пробела и вне кавычек — иначе «#» часть значения.
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "#" && i > 0 && /\s/.test(s[i - 1])) return s.slice(0, i).trimEnd();
  }
  return s;
}

function parseScalar(raw, line) {
  const s = stripComment(raw).trim();

  if (s.startsWith("&") || s.startsWith("*")) {
    throw new YamlError("Якоря и алиасы YAML не поддерживаются", line);
  }
  if (s === "[]") return [];
  if (s === "{}") return {};
  if (s.startsWith("[") || s.startsWith("{")) {
    throw new YamlError("Flow-коллекции не поддерживаются, используйте блочную запись", line);
  }
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) throw new YamlError("Незакрытая двойная кавычка", line);
    try { return JSON.parse(s); } catch { throw new YamlError(`Некорректная строка в кавычках: ${s}`, line); }
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) throw new YamlError("Незакрытая одинарная кавычка", line);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s === "" || s === "null" || s === "~") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d*\.\d+$/.test(s)) return Number(s);
  return s;
}

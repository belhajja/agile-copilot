/**
 * Markdown → Jira wiki markup, exactly as mcp-atlassian 0.23.1 does it for Jira REST v2
 * (`JiraPreprocessor.markdown_to_jira`), quirks included, so that the REST backend and
 * mcp-atlassian post the same text (ruling P3-R19). Ported from mcp-atlassian (MIT, Copyright (c)
 * 2024 Hyeonsoo Lee): see packages/jira-tools/THIRD_PARTY_NOTICES.md for the licence.
 *
 * Why a port, not an npm package: on 2026-10-04 the npm registry was searched (`npm search "jira
 * wiki markup markdown"`, plus `jira2md`, `j2m`, `markdown-to-jira`, `md-to-jira`, `jira-markdown`).
 * The closest, `jira2md` 3.0.1 (Apache-2.0, last release 2023-10; mcp-atlassian's rules descend
 * from its J2M rules), differed from the image on 10 of 23 inputs, including common model output:
 * `- ` bullets and tables stay Markdown and `**` inside code blocks is rewritten.
 *
 * Same output, linear time. Python's regexes are kept where they run in linear time; the ones that
 * are quadratic on hostile input (whitespace runs spanning lines, unclosed `[`, `<`, `![`, `<tag>`,
 * long `*`/`_` runs) are replaced by scanners with the same leftmost-first, greedy semantics over
 * precomputed "next character of this kind" tables. Python semantics are spelled out: `.` is
 * `[^\n]`, `^`/`$` (MULTILINE) are a line start/end at `\n` only, `\s` is Unicode whitespace,
 * `\d` any decimal digit (`\p{Nd}`), `\w` Unicode letters, digits and `_`. NUL is removed from the
 * input first so that the NUL-delimited placeholders cannot be forged (mcp-atlassian keeps it).
 * The contract test compares this function with the image's own converter. Keep in step with the
 * pinned image.
 */

const VALID_LANGUAGES = new Set([
  'actionscript',
  'actionscript3',
  'ada',
  'applescript',
  'bash',
  'c',
  'c#',
  'c++',
  'coldfusion',
  'cpp',
  'cs',
  'csharp',
  'css',
  'delphi',
  'diff',
  'erl',
  'erlang',
  'go',
  'groovy',
  'haskell',
  'html',
  'java',
  'javafx',
  'javascript',
  'js',
  'json',
  'less',
  'lua',
  'none',
  'nyan',
  'objc',
  'objective-c',
  'patch',
  'perl',
  'php',
  'powershell',
  'ps1',
  'py',
  'python',
  'r',
  'rainbow',
  'rb',
  'ruby',
  'sass',
  'scala',
  'sh',
  'sql',
  'swift',
  'vb',
  'visualbasic',
  'xml',
  'yaml',
  'yml',
]);
const LANGUAGE_MAPPING: Readonly<Record<string, string>> = {
  dockerfile: 'bash',
  docker: 'bash',
  typescript: 'javascript',
  ts: 'javascript',
  tsx: 'javascript',
  jsx: 'javascript',
  kotlin: 'java',
  kt: 'java',
  makefile: 'bash',
  make: 'bash',
  cmake: 'bash',
};
const codeLanguage = (lang: string): string | null => {
  if (!lang) return null;
  const lower = lang.toLowerCase();
  if (VALID_LANGUAGES.has(lower)) return lower;
  return Object.hasOwn(LANGUAGE_MAPPING, lower) ? (LANGUAGE_MAPPING[lower] ?? null) : null;
};

// Python's `\s` for str (str.isspace): ASCII whitespace, \x1c-\x1f, NEL, NBSP and Unicode spaces.
// biome-ignore lint/suspicious/noControlCharactersInRegex: Python's \s includes \x1c-\x1f.
const PY_SPACE = /[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;
const isSpace = (c: string | undefined) => c !== undefined && PY_SPACE.test(c);
const SOL = '(?<=^|\\n)';
const EOL = '(?=\\n|$)';

/** next[i] = the first index ≥ i whose character passes `test` (s.length if none). O(n). */
function nextTable(s: string, test: (c: string) => boolean): Int32Array {
  const next = new Int32Array(s.length + 1);
  next[s.length] = s.length;
  for (let i = s.length - 1; i >= 0; i--)
    next[i] = test(s[i] ?? '') ? i : (next[i + 1] ?? s.length);
  return next;
}
const at = (t: Int32Array, i: number, n: number) => (i <= n ? (t[i] ?? n) : n);

/**
 * First occurrence of `needle` at or after `from`, for non-decreasing `from` only: each search
 * starts past the previous answer, so a whole pass costs O(n).
 */
function finder(s: string, needle: string) {
  let found = -2;
  return (from: number) => {
    if (found === -1 || found >= from) return found;
    found = s.indexOf(needle, from);
    return found;
  };
}

/** Replaces each match with a placeholder and keeps its transformed text (`_extract_blocks`). */
function extract(
  text: string,
  pattern: RegExp,
  transform: (...groups: string[]) => string,
  store: string[],
  prefix: string,
): string {
  return text.replace(pattern, (...m: unknown[]) => {
    store.push(transform(...(m.slice(0, -2) as string[])));
    return `\0${prefix}${store.length - 1}\0`;
  });
}
/** Puts stored blocks back, highest index first (`_restore_blocks`). */
function restore(text: string, store: readonly string[], prefix: string): string {
  let out = text;
  for (let i = store.length - 1; i >= 0; i--) {
    out = out.replaceAll(`\0${prefix}${i}\0`, store[i] ?? '');
  }
  return out;
}

/**
 * `re.sub(pattern, repl, s)` for patterns matched by hand: `matchAt(i)` returns the match's end and
 * replacement, or null; matches never overlap and scanning resumes at the end of each one.
 */
function scan(s: string, matchAt: (i: number) => [end: number, text: string] | null): string {
  let out = '';
  let copied = 0;
  for (let i = 0; i < s.length; ) {
    const m = matchAt(i);
    if (m) {
      out += s.slice(copied, i) + m[1];
      copied = m[0];
      i = m[0];
    } else i++;
  }
  return out + s.slice(copied);
}

/** `(!?\[[^\]\n]*\]\()([^)]+)(\))`: protects a Markdown link or image target. */
function protectLinkTargets(s: string, keep: (target: string) => string): string {
  const n = s.length;
  const closeOrNl = nextTable(s, (c) => c === ']' || c === '\n');
  const paren = nextTable(s, (c) => c === ')');
  return scan(s, (i) => {
    const open = s[i] === '!' && s[i + 1] === '[' ? i + 1 : s[i] === '[' ? i : -1;
    if (open < 0) return null;
    const close = at(closeOrNl, open + 1, n);
    if (s[close] !== ']' || s[close + 1] !== '(') return null;
    const end = at(paren, close + 2, n);
    if (end >= n || end === close + 2) return null;
    return [end + 1, `${s.slice(i, close + 2)}${keep(s.slice(close + 2, end))})`];
  });
}

const SCHEME_CHAR = /[A-Za-z0-9+.-]/;
/** `<((?:[A-Za-z][A-Za-z0-9+.-]*:[^>\s]+|[^<>\s@]+@[^<>\s@]+))>`: protects an autolink target. */
function protectAutolinks(s: string, keep: (target: string) => string): string {
  const n = s.length;
  const schemeEnd = nextTable(s, (c) => !SCHEME_CHAR.test(c));
  const gtOrSpace = nextTable(s, (c) => c === '>' || PY_SPACE.test(c));
  const mailStop = nextTable(s, (c) => c === '<' || c === '>' || c === '@' || PY_SPACE.test(c));
  const target = (i: number): number => {
    if (/[A-Za-z]/.test(s[i + 1] ?? '')) {
      const colon = at(schemeEnd, i + 2, n);
      if (s[colon] === ':') {
        const end = at(gtOrSpace, colon + 1, n);
        if (end > colon + 1 && s[end] === '>') return end;
      }
    }
    const atSign = at(mailStop, i + 1, n);
    if (atSign > i + 1 && s[atSign] === '@') {
      const end = at(mailStop, atSign + 1, n);
      if (end > atSign + 1 && s[end] === '>') return end;
    }
    return -1;
  };
  return scan(s, (i) => {
    if (s[i] !== '<') return null;
    const end = target(i);
    return end < 0 ? null : [end + 1, `<${keep(s.slice(i + 1, end))}>`];
  });
}

// Python's `[^\W_]` (a Unicode letter or digit).
const INTRAWORD_UNDERSCORES = /(?<=[\p{L}\p{N}])_+(?=[\p{L}\p{N}])/gu;
const MARK = /[*_]/;

/**
 * `re.sub(r"([*_]+)(.*?)\1", …, line)`: at a run of `*`/`_`, the longest prefix g of the run that
 * occurs again at or after its own end wins (the regex tries the longest first), with its first
 * such occurrence closing it. "g_k occurs at ≥ i+k" is monotone in k, so k is found by binary search.
 */
function emphasis(line: string): string {
  const n = line.length;
  const runEnd = nextTable(line, (c) => !MARK.test(c));
  return scan(line, (i) => {
    if (!MARK.test(line[i] ?? '')) return null;
    const run = at(runEnd, i, n) - i;
    const occurrence = (k: number) => line.indexOf(line.slice(i, i + k), i + k);
    let lo = 0;
    let hi = Math.min(run, Math.floor((n - i) / 2));
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (occurrence(mid) >= 0) lo = mid;
      else hi = mid - 1;
    }
    if (lo === 0) return null;
    const close = occurrence(lo);
    const mark = lo === 1 ? '_' : '*';
    return [close + lo, mark + line.slice(i + lo, close) + mark];
  });
}

function boldItalicLine(input: string): string {
  // Jira italicises any _word_ span: escape underscores inside words (snake_case, customfield_1).
  const line = input.replace(INTRAWORD_UNDERSCORES, (run) => '\\_'.repeat(run.length));
  if (/^[*_]+/.test(line) && isSpace(line[line.search(/[^*_]|$/)])) return line;
  return emphasis(line);
}

/**
 * `^(\s+)?<marker> (.*)$` (MULTILINE) for list items: `\s+` may span blank lines, which then
 * collapse into the item and deepen it (mcp-atlassian's quirk, kept). After the longest
 * whitespace run from a line start, `marker(q)` returns the index after "<marker> " or -1.
 */
function listItems(s: string, symbol: string, marker: (q: number) => number): string {
  const n = s.length;
  const spaceEnd = nextTable(s, (c) => !PY_SPACE.test(c));
  const newline = nextTable(s, (c) => c === '\n');
  return scan(s, (i) => {
    if (i > 0 && s[i - 1] !== '\n') return null;
    const q = at(spaceEnd, i, n);
    const item = marker(q);
    if (item < 0) return null;
    const end = at(newline, item, n);
    return [end, `${symbol.repeat(Math.floor((q - i) / 2) + 1)} ${s.slice(item, end)}`];
  });
}
const bulletAt = (s: string) => (q: number) =>
  '-+*'.includes(s[q] ?? 'x') && s[q + 1] === ' ' ? q + 2 : -1;
const DIGIT = /^\p{Nd}/u;
const numberAt = (s: string) => (q: number) => {
  let j = q;
  for (let m = DIGIT.exec(s.slice(j, j + 2)); m; m = DIGIT.exec(s.slice(j, j + 2))) {
    j += m[0].length;
  }
  return j > q && s[j] === '.' && s[j + 1] === ' ' ? j + 2 : -1;
};

/** `<open>(.*?)<close>` with `.` = `[^\n]`, or `[\s\S]` when `multiline`. */
function between(
  s: string,
  open: string,
  close: string,
  multiline: boolean,
  replace: (inner: string) => string,
): string {
  const findOpen = finder(s, open);
  const findClose = finder(s, close);
  const findNl = finder(s, '\n');
  return scan(s, (i) => {
    if (findOpen(i) !== i) return null;
    const from = i + open.length;
    const end = findClose(from);
    if (end < 0) return null;
    if (!multiline) {
      const nl = findNl(from);
      if (nl >= 0 && nl < end) return null;
    }
    return [end + close.length, replace(s.slice(from, end))];
  });
}

const HTML_TAGS: readonly [string, string][] = [
  ['cite', '??'],
  ['del', '-'],
  ['ins', '+'],
  ['sup', '^'],
  ['sub', '~'],
];

/** `<span style="color:(#[^"]+)">([\s\S]*?)</span>` */
function colors(s: string): string {
  const open = '<span style="color:#';
  const findOpen = finder(s, open);
  const findQuote = finder(s, '"');
  const findClose = finder(s, '</span>');
  return scan(s, (i) => {
    if (findOpen(i) !== i) return null;
    const hash = i + open.length - 1;
    const quote = findQuote(hash + 1);
    if (quote <= hash + 1 || s[quote + 1] !== '>') return null;
    const end = findClose(quote + 2);
    if (end < 0) return null;
    return [end + 7, `{color:${s.slice(hash, quote)}}${s.slice(quote + 2, end)}{color}`];
  });
}

/** The link and image rules, in mcp-atlassian's order, one pass each. */
function links(input: string): string {
  let s = input;
  // !\[\]\(([^)\n\s]+)\)  →  !url!
  {
    const n = s.length;
    const t = s;
    const parenOrSpace = nextTable(t, (c) => c === ')' || PY_SPACE.test(c));
    s = scan(t, (i) => {
      if (!t.startsWith('![](', i)) return null;
      const end = at(parenOrSpace, i + 4, n);
      return end > i + 4 && t[end] === ')' ? [end + 1, `!${t.slice(i + 4, end)}!`] : null;
    });
  }
  // !\[([^\]\n]+)\]\(([^)\n\s]+)\)  →  !url|alt=text!
  {
    const n = s.length;
    const t = s;
    const closeOrNl = nextTable(t, (c) => c === ']' || c === '\n');
    const parenOrSpace = nextTable(t, (c) => c === ')' || PY_SPACE.test(c));
    s = scan(t, (i) => {
      if (t[i] !== '!' || t[i + 1] !== '[') return null;
      const close = at(closeOrNl, i + 2, n);
      if (close === i + 2 || t[close] !== ']' || t[close + 1] !== '(') return null;
      const end = at(parenOrSpace, close + 2, n);
      if (end === close + 2 || t[end] !== ')') return null;
      return [end + 1, `!${t.slice(close + 2, end)}|alt=${t.slice(i + 2, close)}!`];
    });
  }
  // \[([^\]]+)\]\(([^)]+)\)  →  [text|url]
  {
    const n = s.length;
    const t = s;
    const close = nextTable(t, (c) => c === ']');
    const paren = nextTable(t, (c) => c === ')');
    s = scan(t, (i) => {
      if (t[i] !== '[') return null;
      const c = at(close, i + 1, n);
      if (c === i + 1 || c >= n || t[c + 1] !== '(') return null;
      const end = at(paren, c + 2, n);
      if (end === c + 2 || end >= n) return null;
      return [end + 1, `[${t.slice(i + 1, c)}|${t.slice(c + 2, end)}]`];
    });
  }
  // <([^>]+)>  →  [text]
  {
    const n = s.length;
    const t = s;
    const gt = nextTable(t, (c) => c === '>');
    s = scan(t, (i) => {
      if (t[i] !== '<') return null;
      const end = at(gt, i + 1, n);
      return end > i + 1 && end < n ? [end + 1, `[${t.slice(i + 1, end)}]`] : null;
    });
  }
  return s;
}

// Python's str.strip(): Unicode whitespace at both ends.
const PY_TRIM = new RegExp(`^(?:${PY_SPACE.source})+|(?:${PY_SPACE.source})+$`, 'g');
const isRow = (l: string | undefined) => l !== undefined && /^\|[^\n]*\|$/.test(l);
const SEPARATOR = new RegExp(`^\\|(?:[-|:]|${PY_SPACE.source})+\\|$`);
const cells = (l: string) =>
  l
    .split('|')
    .slice(1, -1)
    .map((c) => c.replace(PY_TRIM, ''));

export function markdownToJiraWiki(markdown: string): string {
  const input = markdown.replaceAll('\0', '');
  if (!input) return '';
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];
  let out = extract(
    input,
    /```([\p{L}\p{N}_]*)\n([\s\S]+?)```/gu,
    (_m, lang = '', content = '') => {
      const jiraLang = codeLanguage(lang);
      return `{code${jiraLang ? `:${jiraLang}` : ''}}${content}{code}`;
    },
    codeBlocks,
    'CODEBLOCK',
  );
  out = extract(out, /`([^`]+)`/g, (_m, code = '') => `{{${code}}}`, inlineCodes, 'INLINECODE');

  // Headers underlined with = or -, then # headers (a space is required after the #s).
  out = out.replace(
    new RegExp(`${SOL}([^\\n]*?)\\n([=-])+${EOL}`, 'g'),
    (_m, title: string, mark: string) => `h${mark === '=' ? 1 : 2}. ${title}`,
  );
  out = out.replace(
    new RegExp(`${SOL}(#+) ([^\\n]*)${EOL}`, 'g'),
    (_m, hashes: string, title: string) => `h${hashes.length}. ${title}`,
  );

  // Link targets are kept away from the emphasis rules.
  const urls: string[] = [];
  const keepUrl = (target: string) => {
    urls.push(target);
    return `\0MARKDOWNURL${urls.length - 1}\0`;
  };
  out = protectAutolinks(protectLinkTargets(out, keepUrl), keepUrl);
  out = out.split('\n').map(boldItalicLine).join('\n');
  out = restore(out, urls, 'MARKDOWNURL');

  // Bulleted and numbered lists, two spaces per level.
  out = listItems(out, '*', bulletAt(out));
  out = listItems(out, '#', numberAt(out));

  for (const [tag, mark] of HTML_TAGS) {
    out = between(out, `<${tag}>`, `</${tag}>`, false, (inner) => mark + inner + mark);
  }
  out = colors(out);
  out = between(out, '~~', '~~', false, (inner) => `-${inner}-`);
  out = links(out);

  // Tables: a header row followed by a separator row, then the data rows.
  const lines = out.split('\n');
  let i = 0;
  while (i < lines.length) {
    const next = lines[i + 1];
    if (next !== undefined && SEPARATOR.test(next) && isRow(lines[i])) {
      lines[i] = `||${cells(lines[i] ?? '').join('||')}||`;
      lines.splice(i + 1, 1);
      while (i < lines.length && isRow(lines[i + 1])) {
        lines[i + 1] = `|${cells(lines[i + 1] ?? '').join('|')}|`;
        i++;
      }
    }
    i++;
  }
  out = lines.join('\n');

  out = restore(out, codeBlocks, 'CODEBLOCK');
  return restore(out, inlineCodes, 'INLINECODE');
}

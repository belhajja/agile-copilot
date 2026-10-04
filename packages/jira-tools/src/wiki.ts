/**
 * Markdown → Jira wiki markup, exactly as mcp-atlassian 0.23.1 does it for Jira REST v2
 * (`JiraPreprocessor.markdown_to_jira`, MIT, © 2024 Hyeonsoo Lee), quirks included, so that the
 * REST backend and mcp-atlassian post the same text (ruling P3-R19). A line-by-line port rather
 * than an npm converter: `jira2md` (the closest package, whose J2M rules mcp-atlassian's descend
 * from) differs on common model output: `- ` bullets and tables are left as Markdown, and `**`
 * inside code blocks is rewritten. The contract test compares this function with the image's own
 * converter on a corpus. Keep in step with the pinned image.
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

// Python's `[^\W_]` (a Unicode letter or digit).
const INTRAWORD_UNDERSCORES = /(?<=[\p{L}\p{N}])_+(?=[\p{L}\p{N}])/gu;

function boldItalicLine(input: string): string {
  // Jira italicises any _word_ span: escape underscores inside words (snake_case, customfield_1).
  const line = input.replace(INTRAWORD_UNDERSCORES, (run) => '\\_'.repeat(run.length));
  if (/^[*_]+\s/.test(line)) return line;
  return line.replace(/([*_]+)(.*?)\1/g, (_m, wrap: string, inner: string) => {
    const mark = wrap.length === 1 ? '_' : '*';
    return mark + inner + mark;
  });
}

const HTML_TAGS: readonly [string, string][] = [
  ['cite', '??'],
  ['del', '-'],
  ['ins', '+'],
  ['sup', '^'],
  ['sub', '~'],
];

export function markdownToJiraWiki(input: string): string {
  if (!input) return '';
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];
  let out = extract(
    input,
    /```(\w*)\n([\s\S]+?)```/g,
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
    /^(.*?)\n([=-])+$/gm,
    (_m, title: string, mark: string) => `h${mark === '=' ? 1 : 2}. ${title}`,
  );
  out = out.replace(/^(#+) (.*)$/gm, (_m, hashes: string, title: string) => {
    return `h${hashes.length}. ${title}`;
  });

  // Link targets are kept away from the emphasis rules.
  const urls: string[] = [];
  const keepUrl = (target: string) => {
    urls.push(target);
    return `\0MARKDOWNURL${urls.length - 1}\0`;
  };
  out = out.replace(
    /(!?\[[^\]\n]*\]\()([^)]+)(\))/g,
    (_m, open: string, target: string, close: string) => open + keepUrl(target) + close,
  );
  out = out.replace(
    /<((?:[A-Za-z][A-Za-z0-9+.-]*:[^>\s]+|[^<>\s@]+@[^<>\s@]+))>/g,
    (_m, target: string) => `<${keepUrl(target)}>`,
  );
  out = out.split('\n').map(boldItalicLine).join('\n');
  out = restore(out, urls, 'MARKDOWNURL');

  // Bulleted and numbered lists, two spaces per level.
  out = out.replace(/^(\s+)?[-+*] (.*)$/gm, (_m, indent: string | undefined, item: string) => {
    return `${'*'.repeat(Math.floor((indent?.length ?? 0) / 2) + 1)} ${item}`;
  });
  out = out.replace(/^(\s+)?\d+\. (.*)$/gm, (_m, indent: string | undefined, item: string) => {
    return `${'#'.repeat(Math.floor((indent?.length ?? 0) / 2) + 1)} ${item}`;
  });

  for (const [tag, mark] of HTML_TAGS) {
    out = out.replace(new RegExp(`<${tag}>(.*?)<\\/${tag}>`, 'g'), `${mark}$1${mark}`);
  }
  out = out.replace(/<span style="color:(#[^"]+)">([\s\S]*?)<\/span>/gm, '{color:$1}$2{color}');
  out = out.replace(/~~(.*?)~~/g, '-$1-');
  out = out.replace(/!\[\]\(([^)\n\s]+)\)/g, '!$1!');
  out = out.replace(/!\[([^\]\n]+)\]\(([^)\n\s]+)\)/g, '!$2|alt=$1!');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '[$1|$2]');
  out = out.replace(/<([^>]+)>/g, '[$1]');

  // Tables: a header row followed by a separator row, then the data rows.
  const lines = out.split('\n');
  const isRow = (l: string | undefined) => l !== undefined && /^\|.*\|$/.test(l);
  const cells = (l: string) =>
    l
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
  let i = 0;
  while (i < lines.length) {
    const next = lines[i + 1];
    if (next !== undefined && /^\|[-\s|:]+\|$/.test(next) && isRow(lines[i])) {
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

// Expected outputs are mcp-atlassian 0.23.1's own `JiraPreprocessor.markdown_to_jira`, captured from
// the image (the contract test re-checks a corpus against the running image). Its quirks are kept
// on purpose: both backends must post the same text (ruling P3-R19).
export const WIKI_CASES: readonly (readonly [string, string])[] = [
  ['**Risk:** the API team is late', '*Risk:* the API team is late'],
  ['Needs a *review*', 'Needs a _review_'],
  ['**a** and **b**', '*a* and *b*'],
  ['# Title\nSome text', 'h1. Title\nSome text'],
  ['Title\n=====', 'h1. Title'],
  ['Sub\n---', 'h2. Sub'],
  ['Use `a **b**` here', 'Use {{a **b**}} here'],
  [
    'See [the doc](https://example.com/foo_bar_baz)',
    'See [the doc|https://example.com/foo_bar_baz]',
  ],
  [
    '![](https://x.io/a.png) and ![logo](https://x.io/l.png)',
    '!https://x.io/a.png! and !https://x.io/l.png|alt=logo!',
  ],
  ['<https://example.com/a_b_c> <me@x.io>', '[https://example.com/a_b_c] [me@x.io]'],
  ['- one\n- two', '* one\n* two'],
  ['  - nested\n    - deeper', '** nested\n*** deeper'],
  ['1. first\n   2. second', '# first\n## second'],
  ['```ts\nconst a = **b**;\n```', '{code:javascript}const a = **b**;\n{code}'],
  ['```\nplain\n```', '{code}plain\n{code}'],
  ['foo_bar_baz and __init__', 'foo\\_bar\\_baz and *init*'],
  ['Ünïcødé_wörd_x', 'Ünïcødé\\_wörd\\_x'],
  ['~~gone~~', '-gone-'],
  ['<del>x</del> <ins>y</ins> <sup>2</sup> <sub>i</sub> <cite>c</cite>', '-x- +y+ ^2^ ~i~ ??c??'],
  ['<span style="color:#ff0000">red</span>', '{color:#ff0000}red{color}'],
  ['| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\nafter', '||a||b||\n|1|2|\n|3|4|\nafter'],
  ['plain text, no markup', 'plain text, no markup'],
  ['', ''],
  // CRLF and Unicode: Python's `.` and `$` stop only at \n, `\d` is any decimal digit, `\s` any
  // Unicode space (captured from the image like the rest).
  ['- one\r\n- two\r\n', '* one\r\n* two\r\n'],
  ['# Title\r\nText', 'h1. Title\r\nText'],
  ['Title\r\n=====', 'h1. Title\r'],
  ['**bold**\r\nnext', '*bold*\r\nnext'],
  ['~~a\rb~~', '-a\rb-'],
  ['*a\u2028b*', '_a\u2028b_'],
  ['<del>a\rb</del>', '-a\rb-'],
  ['`code`\u2028`more`', '{{code}}\u2028{{more}}'],
  ['```py\r\ncode\r\n```', '``{{py\r\ncode\r\n}}``'],
  ['| a |\r\n|---|\r\n| 1 |', '| a |\r\n|---|\r\n| 1 |'],
  ['[x](http://a.io)\r\n<b>', '[x|http://a.io]\r\n[b]'],
  ['\u0661. first\n\u0662. second', '# first\n# second'],
  ['\u{1d7cf}. math digit', '# math digit'],
  ['  \u0663. nested', '## nested'],
  ['snake_case\u0663x', 'snake\\_case\u0663x'],
  ['x\u00a0- y', 'x\u00a0- y'],
  ['\u2003- em space item', '* em space item'],
  ['line\n\u2003\n- after', 'line\n** after'],
  ['a\u001c- b\n\u001c- c', 'a\u001c- b\n* c'],
  // mcp-atlassian's quirks, kept identical:
  ['***both***', '*both*'],
  ['* **bold** item', '* **bold** item'], // no emphasis on a line starting with "* "
  ['> quoted', '> quoted'], // no blockquote conversion
  ['2 * 3 * 4', '2 _ 3 _ 4'],
  ['line\n\n\n- after blank', 'line\n** after blank'], // blank lines before a list item collapse
];

/**
 * Inputs that made the regex port quadratic (newlines, `[`, `<`, images, emphasis runs…), each
 * about `size` characters long.
 */
export function pathologicalMarkdown(size: number): Record<string, string> {
  const rep = (unit: string) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  return {
    newlines: rep('\n'),
    spacesAndNewlines: rep(' \n'),
    crlf: rep('\r\n'),
    brackets: rep('['),
    angles: rep('<'),
    imageNoAlt: rep('![](a'),
    imageAlt: rep('![a](b'),
    linkOpen: rep('[a]('),
    bangBracket: rep('!['),
    autolink: rep('<a:'),
    autolinkMail: rep('<a@'),
    starThenUnderscores: `*${rep('_').slice(1)}`,
    stars: rep('*'),
    emphasisMix: rep('*_'),
    tags: rep('<del>'),
    color: rep('<span style="color:#a'),
    strike: rep('~~a'),
    backticks: rep('`'),
    fences: rep('```a\n'),
    hashes: rep('#'),
    dashes: rep('- '),
    digits: rep('1. '),
    pipes: rep('|'),
  };
}

/** A deterministic PRNG (mulberry32): the same strings on every run and machine. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MARKUP_ALPHABET = [
  '*',
  '**',
  '_',
  '__',
  '`',
  '```',
  '```js\n',
  '\n',
  '\r\n',
  '\n\n',
  ' ',
  '  ',
  '\t',
  '- ',
  '+ ',
  '* ',
  '1. ',
  '٢. ',
  '# ',
  '## ',
  '=',
  '-',
  '[',
  ']',
  '(',
  ')',
  '!',
  '![',
  '](',
  '<',
  '>',
  '@',
  ':',
  '|',
  '|---|',
  '~~',
  '"',
  '#',
  '.',
  'a',
  'b',
  'Z',
  'é',
  '٣',
  'x_y',
  'http://h.io/p_q',
  'me@x.io',
  '<del>',
  '</del>',
  '<sup>',
  '</sup>',
  '<span style="color:#f00">',
  '</span>',
  '\\',
  '{',
  '}',
  ' ',
  ' ',
  ' ',
];

/** `count` strings over Markdown's markup alphabet, from a fixed seed (never containing NUL). */
export function generatedMarkdown(count: number, seed = 20261004): string[] {
  const next = mulberry32(seed);
  const pick = () => MARKUP_ALPHABET[Math.floor(next() * MARKUP_ALPHABET.length)] ?? '';
  return Array.from({ length: count }, () =>
    Array.from({ length: 1 + Math.floor(next() * 24) }, pick).join(''),
  );
}

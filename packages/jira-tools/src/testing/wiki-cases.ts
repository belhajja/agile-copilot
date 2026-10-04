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
  // mcp-atlassian's quirks, kept identical:
  ['***both***', '*both*'],
  ['* **bold** item', '* **bold** item'], // no emphasis on a line starting with "* "
  ['> quoted', '> quoted'], // no blockquote conversion
  ['2 * 3 * 4', '2 _ 3 _ 4'],
  ['line\n\n\n- after blank', 'line\n** after blank'], // blank lines before a list item collapse
];

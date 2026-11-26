// llm-large-files: the page's small enhancements.
// The theme toggle, the Copy buttons, the colouring of code, the "Sections" menu.
// Nothing here sends a request. The page is complete without this file.

const root = document.documentElement;

/* ---------- a polite live region, shared with the figures ---------- */

let live = document.querySelector('[data-live]');
if (!live) {
  live = document.createElement('p');
  live.className = 'visually-hidden';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  live.dataset.live = '';
  document.body.append(live);
}

/** Say a short message to a screen reader, politely. */
export function announce(message) {
  live.textContent = '';
  setTimeout(() => { live.textContent = message; }, 50);
}

/** True when the visitor asked for less motion. Read it when you need it: it can change. */
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- theme: follow the system until the visitor chooses ---------- */

const THEME_KEY = 'llf-theme';
const systemDark = matchMedia('(prefers-color-scheme: dark)');
const theme = () => root.dataset.theme || (systemDark.matches ? 'dark' : 'light');
const toggles = document.querySelectorAll('[data-theme-toggle]');

function labelToggles() {
  const next = theme() === 'dark' ? 'light' : 'dark';
  for (const button of toggles) {
    button.setAttribute('aria-label', `Switch to ${next} theme`);
    button.title = `Switch to ${next} theme`;
  }
}
for (const button of toggles) {
  button.addEventListener('click', () => {
    const next = theme() === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch { /* storage is off: the choice lasts for this page */ }
    labelToggles();
  });
}
systemDark.addEventListener('change', labelToggles);
labelToggles();

/* ---------- code colouring: comments, strings, keywords. The text stays the same ---------- */

const TS_KEYWORDS = new Set((
  'as async await break case catch class const continue default delete do else enum export extends false ' +
  'finally for from function if implements import in instanceof interface let new null of return satisfies ' +
  'static switch this throw true try type typeof undefined var void while yield'
).split(' '));

// One pass, left to right: a comment, a string, or a word. What is between them is plain.
const TS_TOKEN = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\[\s\S]|[^`\\])*`)|([A-Za-z_$][\w$]*)/g;

function tokensOfTs(source) {
  const out = [];
  let at = 0;
  for (const match of source.matchAll(TS_TOKEN)) {
    const start = match.index;
    let kind = match[1] ? 'c' : match[2] ? 's' : '';
    if (match[3] && TS_KEYWORDS.has(match[3])) {
      // not a keyword when it is a property: `files.delete(…)`, `{ type: "text" }`
      const isKey = /^\s*:/.test(source.slice(start + match[0].length, start + match[0].length + 8))
        && /[{,(]\s*$/.test(source.slice(Math.max(0, start - 40), start));
      if (source[start - 1] !== '.' && !isKey) kind = 'k';
    }
    if (!kind) continue;
    if (start > at) out.push(['', source.slice(at, start)]);
    out.push([kind, match[0]]);
    at = start + match[0].length;
  }
  if (at < source.length) out.push(['', source.slice(at)]);
  return out;
}

const JSON_TOKEN = /("(?:\\.|[^"\\\n])*")(\s*:)?|\b(true|false|null)\b/g;

function tokensOfJson(source) {
  const out = [];
  let at = 0;
  for (const match of source.matchAll(JSON_TOKEN)) {
    // a string before a colon is a key: it stays plain, so the values stand out
    const kind = match[3] ? 'k' : match[2] ? '' : 's';
    if (!kind) continue;
    if (match.index > at) out.push(['', source.slice(at, match.index)]);
    out.push([kind, match[0]]);
    at = match.index + match[0].length;
  }
  if (at < source.length) out.push(['', source.slice(at)]);
  return out;
}

function tokensOfBash(source) {
  const out = [];
  let i = 0;
  let command = true; // the next word names a command
  while (i < source.length) {
    const ch = source[i];
    let end = i + 1;
    let kind = '';
    if (ch === '#' && (i === 0 || /\s/.test(source[i - 1]))) {
      end = source.indexOf('\n', i);
      if (end < 0) end = source.length;
      kind = 'c';
    } else if (ch === '"' || ch === "'") {
      while (end < source.length && source[end] !== ch) end += ch === '"' && source[end] === '\\' ? 2 : 1;
      end = Math.min(end + 1, source.length);
      kind = 's';
      command = false;
    } else if (ch === '\\') {
      end = Math.min(i + 2, source.length); // a continued line is still the same command
    } else if (ch === '\n' || ch === ';' || ch === '|' || ch === '&') {
      command = true;
    } else if (!/\s/.test(ch)) {
      while (end < source.length && !/[\s;|&"'\\]/.test(source[end])) end += 1;
      const word = source.slice(i, end);
      if (command && /^[A-Za-z_][\w.-]*$/.test(word)) kind = 'k';
      if (!/^[A-Za-z_]\w*=/.test(word)) command = false; // NAME=value comes before the command
    }
    out.push([kind, source.slice(i, end)]);
    i = end;
  }
  return out;
}

const TOKENIZERS = { ts: tokensOfTs, js: tokensOfTs, json: tokensOfJson, bash: tokensOfBash, text: (source) => [['', source]] };

function colour(element) {
  const language = /(?:^|\s)language-(\w+)/.exec(element.className)?.[1];
  const tokenize = TOKENIZERS[language];
  if (!tokenize || element.childElementCount) return;
  const source = element.textContent;
  const fragment = document.createDocumentFragment();
  // One block a line (its line feed stays inside it), so a wrapped line can hang past its indent.
  let line = null;
  for (const [kind, text] of tokenize(source)) {
    for (const piece of text.match(/[^\n]*\n|[^\n]+/g) ?? []) {
      if (!line) {
        line = document.createElement('span');
        line.className = 'cl';
        fragment.append(line);
      }
      if (kind) {
        const span = document.createElement('span');
        span.className = `tok-${kind}`;
        span.textContent = piece;
        line.append(span);
      } else {
        line.append(piece);
      }
      if (piece.endsWith('\n')) line = null;
    }
  }
  fragment.normalize();
  for (const block of fragment.children) {
    const space = /^[ \t]*/.exec(block.textContent)[0];
    if (!space) continue;
    block.style.setProperty('--i', space.replace(/\t/g, '  ').length);
    // The indent goes in a span that does not wrap: a first word longer than the row then breaks
    // inside itself, and the indent is not left alone on a row of its own.
    const first = block.firstChild;
    if (first.nodeType !== Node.TEXT_NODE || !first.data.startsWith(space)) continue;
    const lead = document.createElement('span');
    lead.className = 'ci';
    lead.textContent = space;
    first.data = first.data.slice(space.length);
    block.prepend(lead);
  }
  if (fragment.textContent === source) element.replaceChildren(fragment);
}
for (const element of document.querySelectorAll('code[class*="language-"], pre[class*="language-"]')) {
  try { colour(element); } catch { /* the sample stays plain */ }
}

/* ---------- copy buttons: every pre.code, and every element marked data-copy ---------- */

/** Copy text to the clipboard. Resolves to true when it worked. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.append(area);
    area.select();
    let done = false;
    try { done = document.execCommand('copy'); } catch { /* no clipboard at all */ }
    area.remove();
    return done;
  }
}

function copyButton(text, what) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-small copy';
  button.textContent = 'Copy';
  button.setAttribute('aria-label', `Copy ${what}`);
  let timer;
  button.addEventListener('click', async () => {
    const done = await copyText(text);
    button.textContent = done ? 'Copied' : 'Not copied';
    announce(done ? `Copied ${what}` : `Could not copy ${what}`);
    clearTimeout(timer);
    timer = setTimeout(() => { button.textContent = 'Copy'; }, 1600);
  });
  return button;
}

// <pre class="code" data-copy-label="the quickstart">: the label ends the sentence "Copied …"
for (const pre of document.querySelectorAll('pre.code')) {
  const text = (pre.querySelector('code') ?? pre).textContent;
  pre.prepend(copyButton(text, pre.dataset.copyLabel || 'the sample'));
}
// <div class="cmd" data-copy>: copies its <code>, or the value of data-copy when it has one
for (const element of document.querySelectorAll('[data-copy]')) {
  const text = element.dataset.copy || (element.querySelector('code') ?? element).textContent;
  element.append(copyButton(text.trim(), element.dataset.copyLabel || 'the text'));
}

/* ---------- the "Sections" menu under 1024 px: close it after a choice ---------- */

const menu = document.querySelector('.nav-menu');
if (menu) {
  menu.addEventListener('click', (event) => { if (event.target.closest('a')) menu.open = false; });
  document.addEventListener('click', (event) => { if (menu.open && !menu.contains(event.target)) menu.open = false; });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !menu.open) return;
    menu.open = false;
    menu.querySelector('summary').focus();
  });
}

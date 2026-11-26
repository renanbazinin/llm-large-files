// llm-large-files: the ledger of the loop.
// One recorded question shows at a time: a row of chips, made here from the tables in the page,
// chooses which. Previous and Next move a highlight through the rows of the table that shows.
// The "Show" buttons of the rules choose a question too. ?ledger=<key> opens with that one.
// Nothing here sends a request, and nothing plays by itself. Without this file the first table
// shows and the others are closed <details>.

const figure = document.getElementById('fig-ledger');
const blocks = figure ? [...figure.querySelectorAll('[data-ledger]')] : [];
const chipsBox = figure?.querySelector('[data-ledger-chips]');
const navBox = figure?.querySelector('[data-ledger-nav]');

if (blocks.length && chipsBox && navBox) {
  const titleOf = (block) => block.querySelector('.ledger-cap')?.textContent.trim() || block.dataset.ledger;
  const rowsOf = (block) => [...block.querySelectorAll('tbody tr')];
  const showButtons = [...document.querySelectorAll('[data-ledger-show]')];
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  // the page's polite live region (site.js writes to the same one)
  const live = document.querySelector('[data-live]');
  let saying = 0;
  const say = (text) => {
    if (!live) return;
    clearTimeout(saying);
    live.textContent = '';
    saying = setTimeout(() => { live.textContent = text; }, 50);
  };

  const button = (label) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'btn btn-small';
    el.textContent = label;
    return el;
  };

  let shown = blocks[0];
  let at = -1; // the row the highlight is on; -1 when it is on none

  const chips = blocks.map((block) => {
    const chip = button(titleOf(block));
    chip.addEventListener('click', () => show(block, true));
    chipsBox.append(chip);
    return chip;
  });

  const position = document.createElement('span');
  position.className = 'ledger-pos';
  const previous = button('Previous');
  const next = button('Next');
  previous.addEventListener('click', () => step(at - 1));
  next.addEventListener('click', () => step(at + 1));
  navBox.setAttribute('role', 'group');
  navBox.setAttribute('aria-label', 'Step through the requests');
  navBox.append(position, previous, next);

  function draw() {
    const rows = rowsOf(shown);
    rows.forEach((row, i) => {
      if (i === at) row.setAttribute('aria-current', 'step');
      else row.removeAttribute('aria-current');
    });
    position.textContent = at < 0 ? `${rows.length} requests` : `request ${at + 1} of ${rows.length}`;
    previous.disabled = at <= 0;
    next.disabled = at >= rows.length - 1;
  }

  function step(to) {
    const rows = rowsOf(shown);
    if (to < 0 || to >= rows.length) return;
    at = to;
    draw();
    rows[at].scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
    const role = rows[at].querySelector('th .tag')?.textContent.trim();
    say(`Request ${at + 1} of ${rows.length}${role ? `, role ${role}` : ''}`);
  }

  function show(block, announce) {
    for (const row of rowsOf(shown)) row.removeAttribute('aria-current');
    shown = block;
    at = -1;
    blocks.forEach((other, i) => {
      other.toggleAttribute('data-ledger-shown', other === block);
      chips[i].setAttribute('aria-pressed', String(other === block));
    });
    for (const el of showButtons) el.setAttribute('aria-pressed', String(el.dataset.ledgerShow === block.dataset.ledger));
    draw();
    if (announce) say(`Showing: ${titleOf(block)}, ${rowsOf(block).length} requests`);
  }

  for (const el of showButtons) {
    const block = blocks.find((b) => b.dataset.ledger === el.dataset.ledgerShow);
    if (!block) { el.hidden = true; continue; }
    el.addEventListener('click', () => {
      show(block, true);
      // bring the ledger into view when its top is not on screen
      const top = figure.getBoundingClientRect().top;
      if (top < 0 || top > innerHeight * 0.6) {
        figure.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
      }
    });
  }

  // the chips do the switching from here on: every <details> stays open, and its summary is hidden
  for (const block of blocks) if (block.tagName === 'DETAILS') block.open = true;
  figure.classList.add('is-live');

  const wanted = new URLSearchParams(location.search).get('ledger');
  show(blocks.find((block) => block.dataset.ledger === wanted) || blocks[0], false);
}

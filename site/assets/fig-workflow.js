// llm-large-files: the player of Figure 1, the workflow.
//
// The figure is whole without this file: every wire is inked and stage 7 shows. The player only
// traces a path through it. Its contract with the markup:
//   - the figure is #fig-workflow, with data-stages="7";
//   - everything that belongs to a stage carries data-stage="n". The player sets data-current="k"
//     on the figure and, on each of those elements, exactly one of is-done (n < k), is-now (n = k)
//     and is-todo (n > k). fig-workflow.css draws the three states;
//   - the transport is rendered into the empty [data-transport]; the stage panel is .wf-panel;
//   - the node of the loop carries data-beats, the number of recorded tool turns;
//   - ?wf=5 in the URL opens the page on stage 5, and nothing plays by itself.
// Nothing here measures a position, animates a layout property or sends a request.

const figure = document.getElementById('fig-workflow');
if (figure) setUp(figure);

function setUp(figure) {
  const panel = figure.querySelector('.wf-panel');
  const slot = figure.querySelector('[data-transport]');
  if (!panel || !slot) return;

  const total = Number(figure.dataset.stages) || 7;
  const staged = [...figure.querySelectorAll('[data-stage]')];
  const titles = Array.from({ length: total }, (_, i) =>
    panel.querySelector(`.wf-stage[data-stage="${i + 1}"] h3`)?.textContent.trim() || `Stage ${i + 1}`);
  const loop = figure.querySelector('[data-beats]');
  const loopStage = loop ? Number(loop.dataset.stage) : 0;
  const beats = loop ? Math.max(1, Number(loop.dataset.beats) || 1) : 0;
  const pips = loop ? [...loop.querySelectorAll('.wf-pips i')] : [];
  const turns = [...panel.querySelectorAll('.wf-turn')];
  const lessMotion = matchMedia('(prefers-reduced-motion: reduce)');

  // A run takes about ten seconds: stages 1 to 3 in two seconds together, the question and the
  // fork 1.5 s each, the loop one beat for each recorded tool turn, the answer 1.5 s.
  const HOLD = { 1: 660, 2: 660, 3: 680, 4: 1500, 5: 1500, 7: 1500 };
  const BEAT = 1100;
  const START_AFTER = 1200; // the whole picture is seen first, then a run starts by itself

  let current = total;
  let playing = false;
  let byItself = false; // the run in progress was started by the player, not by the visitor
  let touched = false;  // the visitor has used the figure: nothing starts by itself any more
  let played = false;   // a run has reached its end
  let timer = 0;
  let waiting = 0;

  /* ---------- the transport: Play, Previous, Next, and a tab for each stage ---------- */

  const make = (tag, attributes, text) => {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const chevron = (d) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 8 12');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
    return svg;
  };

  const playButton = make('button', { type: 'button', class: 'btn btn-small wf-play' }, 'Play');
  const previous = make('button', { type: 'button', class: 'btn btn-small wf-step', 'aria-label': 'Previous stage', title: 'Previous stage' });
  previous.append(chevron('M6 1 1 6l5 5'));
  const next = make('button', { type: 'button', class: 'btn btn-small wf-step', 'aria-label': 'Next stage', title: 'Next stage' });
  next.append(chevron('M2 1l5 5-5 5'));
  const tablist = make('div', { class: 'wf-tabs', role: 'tablist', 'aria-label': 'Stages of the workflow' });
  const tabs = titles.map((title, i) => make('button', {
    type: 'button', class: 'btn btn-small wf-tab', role: 'tab', id: `wf-tab-${i + 1}`,
    'aria-controls': panel.id, 'aria-label': `Stage ${i + 1} of ${total}: ${title}`, title,
  }, String(i + 1)));
  tablist.append(...tabs);
  slot.setAttribute('role', 'group');
  slot.setAttribute('aria-label', 'Step through the workflow');
  slot.append(playButton, previous, next, tablist);

  // The same two steps beside the stage itself: the bar is out of sight when the stage is read.
  const pager = make('div', { class: 'wf-pager', role: 'group', 'aria-label': 'Step through the stages' });
  const pagerPrevious = make('button', { type: 'button', class: 'btn btn-small' }, 'Previous');
  const pagerNext = make('button', { type: 'button', class: 'btn btn-small' }, 'Next');
  pager.append(pagerPrevious, pagerNext);
  // The panel says the stage a visitor steps to, and stays silent while the player runs.
  const status = make('p', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite' });
  panel.prepend(pager);
  panel.append(status);
  // On a wide screen the panel is under the fold while the map is looked at: the name of the
  // stage is also written beside the map, for the eye only.
  const map = figure.querySelector('.wf-map');
  const name = make('p', { class: 'wf-name', 'aria-hidden': 'true' });
  map?.append(name);
  panel.setAttribute('role', 'tabpanel');
  panel.tabIndex = 0;

  /* ---------- the three states ---------- */

  function show(k, by) {
    current = Math.min(total, Math.max(1, k));
    figure.dataset.current = String(current);
    for (const node of staged) {
      const n = Number(node.dataset.stage);
      node.classList.toggle('is-done', n < current);
      node.classList.toggle('is-now', n === current);
      node.classList.toggle('is-todo', n > current);
    }
    tabs.forEach((tab, i) => {
      const selected = i + 1 === current;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    panel.setAttribute('aria-labelledby', tabs[current - 1].id);
    for (const button of [previous, pagerPrevious]) button.setAttribute('aria-disabled', String(current === 1));
    for (const button of [next, pagerNext]) button.setAttribute('aria-disabled', String(current === total));
    name.textContent = `stage ${current} of ${total} · ${titles[current - 1]}`;
    // said to a screen reader only for a step the visitor takes: the player runs in silence
    status.textContent = by === 'visitor' ? `Stage ${current} of ${total}: ${titles[current - 1]}` : '';
  }

  // Inside the loop's stage: beat b of the recorded tool turns. 0 is the stage at rest, all of it shown.
  function setBeat(b) {
    pips.forEach((pip, i) => pip.classList.toggle('is-off', b > 0 && i >= b));
    for (const turn of turns) turn.classList.toggle('is-wait', b > 0 && Number(turn.dataset.turn) > b);
    // two names for one sweep of the loop's arrow: changing the name runs it again
    figure.classList.toggle('wf-beat-a', b > 0 && b % 2 === 1);
    figure.classList.toggle('wf-beat-b', b > 0 && b % 2 === 0);
  }

  /* ---------- playing ---------- */

  function label() {
    playButton.textContent = playing ? 'Pause' : played && current === total ? 'Replay' : 'Play';
  }
  function stopTimers() {
    clearTimeout(timer);
    clearTimeout(waiting);
    timer = 0;
    waiting = 0;
  }
  function settle(reachedTheEnd) {
    stopTimers();
    playing = false;
    byItself = false;
    if (reachedTheEnd) played = true;
    setBeat(0);
    figure.classList.remove('is-playing');
    label();
  }
  function run(n) {
    show(n, 'player');
    if (n === loopStage) {
      beat(1);
      return;
    }
    setBeat(0);
    timer = setTimeout(() => (n < total ? run(n + 1) : settle(true)), HOLD[n] ?? 1000);
  }
  function beat(b) {
    setBeat(b);
    timer = setTimeout(() => {
      if (b < beats) beat(b + 1);
      else if (loopStage < total) run(loopStage + 1);
      else settle(true);
    }, BEAT);
  }
  function play(from, startedByItself = false) {
    if (lessMotion.matches) return;
    stopTimers();
    playing = true;
    byItself = startedByItself;
    figure.classList.add('is-playing');
    label();
    run(from);
  }
  // A step the visitor takes: the run ends, the stage shows at once.
  function go(k) {
    settle(false);
    show(k, 'visitor');
    label();
  }

  playButton.addEventListener('click', () => {
    if (playing) settle(false);
    else play(current >= total ? 1 : current);
  });
  const stepBy = (delta) => (event) => {
    if (event.currentTarget.getAttribute('aria-disabled') === 'true') return;
    go(current + delta);
  };
  for (const button of [previous, pagerPrevious]) button.addEventListener('click', stepBy(-1));
  for (const button of [next, pagerNext]) button.addEventListener('click', stepBy(1));
  tabs.forEach((tab, i) => tab.addEventListener('click', () => go(i + 1)));

  // Left and Right step from anywhere in the transport; Home and End from a tab. Focus follows the tabs.
  function onKey(event) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const onTab = event.target instanceof Element && event.target.closest('[role="tab"]');
    let to = 0;
    if (event.key === 'ArrowLeft') to = current - 1;
    else if (event.key === 'ArrowRight') to = current + 1;
    else if (event.key === 'Home' && onTab) to = 1;
    else if (event.key === 'End' && onTab) to = total;
    else return;
    event.preventDefault();
    go(to);
    if (onTab) tabs[current - 1].focus();
  }
  slot.addEventListener('keydown', onKey);
  pager.addEventListener('keydown', onKey);

  // A node is not a control (the tabs are), but a click on it selects its stage.
  for (const area of figure.querySelectorAll('.wf-map, .wf-ruler')) {
    area.addEventListener('click', (event) => {
      const node = event.target instanceof Element && event.target.closest('[data-stage]');
      if (node && area.contains(node)) go(Number(node.dataset.stage));
    });
  }

  /* ---------- starting by itself, once ---------- */

  // Anything the visitor does in the figure ends that for good.
  function touch(event) {
    touched = true;
    clearTimeout(waiting);
    waiting = 0;
    const onPlay = event.target instanceof Element && event.target.closest('.wf-play');
    if (event.type !== 'focusin' && byItself && !onPlay) {
      settle(false);
      // A touch that is not on a control (the start of a scroll, on a phone) must not leave the
      // figure at the stage the run happened to be at: back to the whole picture. A click on a
      // control lands on its own stage right after, through go().
      const onControl = event.target instanceof Element && event.target.closest('button, .wf-map [data-stage], .wf-ruler [data-stage]');
      if (!onControl) {
        show(total, 'player');
        label();
      }
    }
  }
  figure.addEventListener('pointerdown', touch);
  figure.addEventListener('focusin', touch);
  figure.addEventListener('keydown', (event) => {
    if (!['Tab', 'Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) touch(event);
  });

  function syncMotion() {
    playButton.hidden = lessMotion.matches;
    if (lessMotion.matches) settle(false);
  }
  lessMotion.addEventListener('change', syncMotion);

  const asked = Number(new URLSearchParams(location.search).get('wf'));
  const fromUrl = Number.isInteger(asked) && asked >= 1 && asked <= total;
  // The first state is set without a transition: a page opened on stage 5 shows stage 5 at once.
  figure.classList.add('wf-still');
  show(fromUrl ? asked : total, 'player');
  setBeat(0);
  syncMotion();
  figure.classList.add('is-live');
  requestAnimationFrame(() => requestAnimationFrame(() => figure.classList.remove('wf-still')));

  // The run starts the first time the top of the map is on screen: a small sentinel near that
  // top is watched, not a share of the whole figure.
  const sentinel = figure.querySelector('[data-sentinel]');
  if (sentinel && !fromUrl && !lessMotion.matches && 'IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      if (touched) return;
      const start = () => {
        waiting = 0;
        if (touched || playing || lessMotion.matches) return;
        // a tab in the background waits until it is looked at
        if (document.hidden) document.addEventListener('visibilitychange', start, { once: true });
        else play(1, true);
      };
      waiting = setTimeout(start, START_AFTER);
    });
    observer.observe(sentinel);
  }
}

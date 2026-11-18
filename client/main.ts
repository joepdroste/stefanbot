import { DiscordSDK } from '@discord/embedded-app-sdk';

type Mark = 'skip' | 'wrong' | 'artist' | 'correct';
type Track = { id: number; title: string; artist: string; cover?: string };
type State = {
  mode: 'daily' | 'endless'; roundId: string; pool: string; poolLabel: string; day: string; stages: number[]; marks: Mark[]; seconds: number;
  over: boolean; won: boolean; points: number; answer: Track | null; players: { id: string; name: string; marks: Mark[] }[];
};

const POOLS: Record<string, string> = {
  all: 'Everything', pop: 'Pop', hiphop: 'Hip-Hop', rock: 'Rock', rnb: 'R&B', country: 'Country', kpop: 'K-Pop',
  jpop: 'J-Pop', anime: 'Anime', jrock: 'J-Rock', latin: 'Latin', dance: 'Dance / EDM', metal: 'Metal', indie: 'Indie',
  soul: 'Soul', afro: 'Afrobeats', jazz: 'Jazz', disney: 'Disney', dutch: 'Nederlands',
  classic: 'Classics (70s–90s)', '2000s': '2000s', '2010s': '2010s', '2020s': '2020s',
};
const MARK_EMOJI: Record<Mark, string> = { skip: '⬛', wrong: '🟥', artist: '🟨', correct: '🟩' };
const MARK_LABEL: Record<Mark, string> = { skip: 'Skipped', wrong: 'Wrong', artist: 'Right artist', correct: 'Correct' };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusLine = $('status');

const sdk = new DiscordSDK(import.meta.env.DISCORD_CLIENT_ID);
let accessToken = '';
let mode: 'daily' | 'endless' = 'daily';
let pool = 'all';
let state: State | null = null;
// Guess titles only live in this tab; the server just keeps the marks.
const guessLabels = new Map<string, string[]>();
let selected: Track | null = null;
let lastRoundId = '';
let clip: { key: string; audio: HTMLAudioElement } | null = null;

async function post<T>(path: string, body: object): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ mode, instance: sdk.instanceId, guild: sdk.guildId, pool, ...body }),
  });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `HTTP ${response.status}`);
  return response.json();
}

const roundKey = () => `${mode}:${state?.roundId}`;

function render() {
  if (!state) return;
  $('game').hidden = false;
  statusLine.hidden = true;
  for (const tab of document.querySelectorAll<HTMLButtonElement>('.tab')) tab.setAttribute('aria-pressed', String(tab.dataset.mode === mode));
  const poolSelect = $<HTMLSelectElement>('pool');
  poolSelect.hidden = mode !== 'endless';
  $('playlist-form').hidden = mode !== 'endless';
  // Imported playlists aren't in the fixed list, so show them as one extra option.
  // Follow the group's pool whenever a new song starts; until then keep this player's pick for the next song.
  if (state.roundId !== lastRoundId) {
    lastRoundId = state.roundId;
    if (mode === 'endless') pool = state.pool;
  }
  poolSelect.querySelector('[data-playlist]')?.remove();
  if (!(pool in POOLS)) {
    const option = new Option(pool === state.pool ? state.poolLabel : 'Playlist (next song)', pool);
    option.dataset.playlist = '';
    poolSelect.append(option);
  }
  poolSelect.value = pool;

  // Each stage gets a slice of the bar proportional to its length, with a floor so 0.1s stays visible.
  const total = state.stages.at(-1)!;
  const reached = state.over ? total : state.seconds;
  $('bar').style.setProperty('--reached', `${Math.max(3, (reached / total) * 100)}%`);
  $('bar').replaceChildren(...state.stages.map((seconds) => {
    const tick = document.createElement('i');
    tick.style.left = `${(seconds / total) * 100}%`;
    return tick;
  }), $('fill'));
  $('clip-length').textContent = `${state.seconds}s`;

  const labels = guessLabels.get(roundKey()) ?? [];
  $('rows').replaceChildren(...state.stages.map((_, index) => {
    const row = document.createElement('li');
    const mark = state!.marks[index];
    if (mark) {
      row.dataset.mark = mark;
      row.textContent = labels[index] ?? MARK_LABEL[mark];
      const tag = document.createElement('span');
      tag.textContent = mark === 'skip' ? '' : MARK_LABEL[mark];
      row.append(tag);
    } else if (index === state!.marks.length && !state!.over) {
      row.dataset.current = '';
      row.textContent = `${state!.stages[index]}s clip`;
    }
    return row;
  }));

  $('guess-form').hidden = state.over;
  $('skip').textContent = state.marks.length === state.stages.length - 1 ? 'Give up' : `Skip +${state.stages[state.marks.length + 1] - state.seconds}s`;
  $<HTMLButtonElement>('submit').disabled = !selected;

  $('result').hidden = !state.over;
  if (state.over && state.answer) {
    $<HTMLImageElement>('cover').src = state.answer.cover ?? '';
    $('result-line').textContent = state.won ? `Got it in ${state.marks.length}${state.mode === 'endless' ? ` · +${state.points} pts` : ''}` : 'Out of clips';
    $('answer').textContent = `${state.answer.title} — ${state.answer.artist}`;
    $('share').textContent = state.marks.map((mark) => MARK_EMOJI[mark]).join('');
    $('next').hidden = mode !== 'endless';
  }

  $('players').replaceChildren(...state.players.map((player) => {
    const item = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = player.name;
    const grid = document.createElement('span');
    grid.className = 'grid';
    grid.textContent = player.marks.map((mark) => MARK_EMOJI[mark]).join('') + '⬜'.repeat(state!.stages.length - player.marks.length);
    item.append(name, grid);
    return item;
  }));
  if (!state.players.length) {
    const empty = document.createElement('li');
    empty.textContent = mode === 'daily' ? 'Nobody has played today yet.' : 'Just you so far.';
    $('players').replaceChildren(empty);
  }
}

async function refresh() {
  state = await post<State>('/api/state', {});
  render();
}

async function playClip() {
  if (!state) return;
  const key = `${roundKey()}:${state.marks.length}:${state.over}`;
  if (clip?.key !== key) {
    clip?.audio.pause();
    const response = await fetch('/api/clip', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ mode, instance: sdk.instanceId, guild: sdk.guildId }),
    });
    if (!response.ok) throw new Error(`Clip failed: HTTP ${response.status}`);
    clip = { key, audio: new Audio(URL.createObjectURL(await response.blob())) };
  }
  const { audio } = clip;
  audio.currentTime = 0;
  await audio.play();
  const total = state.stages.at(-1)!;
  const tick = () => {
    $('fill').style.width = `${Math.min(100, (audio.currentTime / total) * 100)}%`;
    if (!audio.paused && !audio.ended) requestAnimationFrame(tick);
    else $('fill').style.width = '0';
  };
  requestAnimationFrame(tick);
}

async function guess(track: Track | null) {
  const labels = guessLabels.get(roundKey()) ?? [];
  labels[state!.marks.length] = track ? `${track.title} — ${track.artist}` : 'Skipped';
  guessLabels.set(roundKey(), labels);
  selected = null;
  $<HTMLInputElement>('search').value = '';
  $('suggestions').hidden = true;
  state = await post<State>('/api/guess', { trackId: track?.id ?? null });
  render();
  if (!state.over) await playClip();
}

let searchTimer = 0;
let suggestions: Track[] = [];
let highlighted = -1;

function renderSuggestions() {
  const list = $('suggestions');
  list.hidden = !suggestions.length;
  list.replaceChildren(...suggestions.map((track, index) => {
    const item = document.createElement('li');
    item.role = 'option';
    item.ariaSelected = String(index === highlighted);
    item.innerHTML = '<b></b><span></span>';
    item.querySelector('b')!.textContent = track.title;
    item.querySelector('span')!.textContent = track.artist;
    item.addEventListener('mousedown', (event) => { event.preventDefault(); pick(track); });
    return item;
  }));
}

function pick(track: Track) {
  selected = track;
  $<HTMLInputElement>('search').value = `${track.title} — ${track.artist}`;
  suggestions = [];
  renderSuggestions();
  render();
}

$('search').addEventListener('input', () => {
  selected = null;
  render();
  clearTimeout(searchTimer);
  const query = $<HTMLInputElement>('search').value;
  searchTimer = window.setTimeout(async () => {
    suggestions = await post<Track[]>('/api/search', { query });
    highlighted = suggestions.length ? 0 : -1;
    renderSuggestions();
  }, 250);
});

$('search').addEventListener('keydown', (event) => {
  if (!suggestions.length) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    highlighted = (highlighted + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length;
    renderSuggestions();
  } else if (event.key === 'Enter' && highlighted >= 0) {
    event.preventDefault();
    pick(suggestions[highlighted]);
  } else if (event.key === 'Escape') {
    suggestions = [];
    renderSuggestions();
  }
});
$('search').addEventListener('blur', () => { suggestions = []; renderSuggestions(); });

function reportErrors(action: () => Promise<void>) {
  return () => action().catch((error) => {
    console.error(error);
    statusLine.hidden = false;
    statusLine.textContent = `Something went wrong: ${error.message}`;
  });
}

$('guess-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (selected) reportErrors(() => guess(selected))();
});
$('skip').addEventListener('click', reportErrors(() => guess(null)));
$('play').addEventListener('click', reportErrors(playClip));
$('next').addEventListener('click', reportErrors(async () => {
  state = await post<State>('/api/next', {});
  render();
  await playClip();
}));
async function switchPool(newPool: string) {
  pool = newPool;
  // Mid-song the new pool waits for the next song; before your first guess it switches right away.
  if (state?.over || !state?.marks.length) {
    statusLine.hidden = false;
    statusLine.textContent = pool in POOLS ? 'Loading…' : 'Loading playlist, this can take a minute…';
    state = await post<State>('/api/next', {});
    render();
  }
}

$('pool').addEventListener('change', reportErrors(() => switchPool($<HTMLSelectElement>('pool').value)));
$('playlist-form').addEventListener('submit', (event) => {
  event.preventDefault();
  reportErrors(() => switchPool($<HTMLInputElement>('playlist').value.trim()))();
});
for (const tab of document.querySelectorAll<HTMLButtonElement>('.tab')) {
  tab.addEventListener('click', reportErrors(async () => {
    mode = tab.dataset.mode as typeof mode;
    clip?.audio.pause();
    await refresh();
  }));
}

$<HTMLSelectElement>('pool').replaceChildren(...Object.entries(POOLS).map(([value, label]) => new Option(label, value)));

reportErrors(async () => {
  await sdk.ready();
  const { code } = await sdk.commands.authorize({
    client_id: import.meta.env.DISCORD_CLIENT_ID, response_type: 'code', state: '', prompt: 'none', scope: ['identify'],
  });
  ({ access_token: accessToken } = await post<{ access_token: string }>('/api/token', { code }));
  await sdk.commands.authenticate({ access_token: accessToken });
  await refresh();
  // Poll so everyone in the call sees each other's progress and new songs.
  setInterval(reportErrors(refresh), 3000);
})();

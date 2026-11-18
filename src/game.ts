import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const execFileAsync = promisify(execFile);

// Clip length in seconds for each attempt; a skip or wrong guess moves to the next one.
export const STAGES = [0.1, 0.5, 2, 8, 15];

// Deezer editorial playlists, genre charts and artist top tracks. Genre and era are one choice
// because Deezer track listings carry no release year. Discord allows at most 25 choices.
const playlist = (id: number) => `playlist/${id}/tracks`;
const artistTop = (id: number) => `artist/${id}/top`;
export const POOLS: Record<string, { label: string; sources: string[] }> = {
  all: { label: 'Everything', sources: [1470022445, 867825522, 878989033, 248297032, 14917741483, 13650084141].map(playlist) },
  pop: { label: 'Pop', sources: ['chart/132/tracks', ...[8282573142, 8326097522, 8512471762].map(playlist)] },
  hiphop: { label: 'Hip-Hop', sources: ['chart/116/tracks', playlist(7846286162)] },
  rock: { label: 'Rock', sources: [1306931615, 1419215845].map(playlist) },
  rnb: { label: 'R&B', sources: [1999466402, 2021626162, 5411628342].map(playlist) },
  country: { label: 'Country', sources: [1294431447, 1130102843].map(playlist) },
  kpop: { label: 'K-Pop', sources: [4096400722, 10738561582, 9001527742].map(playlist) },
  // Ado, Natori, imase, 9Lana, YOASOBI, Kenshi Yonezu
  jpop: { label: 'J-Pop', sources: [...[6049895724, 3884441062, 3884381442].map(playlist), ...[121146382, 59871352, 154196932, 155448802, 108153772, 5289039].map(artistTop)] },
  anime: { label: 'Anime', sources: [9016993522, 5206929684, 11225268324].map(playlist) },
  animeop: { label: 'Anime Openings', sources: [13319386703, 9908910262].map(playlist) },
  jrock: { label: 'J-Rock', sources: [playlist(6055749804)] },
  latin: { label: 'Latin', sources: [178699142, 1273315391, 789123393].map(playlist) },
  dance: { label: 'Dance / EDM', sources: [706093725, 4135818362, 4135981802].map(playlist) },
  metal: { label: 'Metal', sources: [1294679255, 1050179021].map(playlist) },
  indie: { label: 'Indie', sources: [8716319082, 8190352822].map(playlist) },
  soul: { label: 'Soul', sources: [1257789321, 7365666824].map(playlist) },
  afro: { label: 'Afrobeats', sources: [3153080842, 1257036831].map(playlist) },
  jazz: { label: 'Jazz', sources: [playlist(1615514485)] },
  disney: { label: 'Disney', sources: [playlist(1962379246)] },
  dutch: { label: 'Nederlands', sources: [1369324075, 3228614262, 8311303422, 8311305462, 8311306722].map(playlist) },
  classic: { label: 'Classics (70s–90s)', sources: [1470022445, 867825522, 878989033].map(playlist) },
  '2000s': { label: '2000s', sources: [playlist(248297032)] },
  '2010s': { label: '2010s', sources: [playlist(14917741483)] },
  '2020s': { label: '2020s', sources: [playlist(13650084141)] },
};

export type Track = { id: number; title: string; artist: string; cover: string };
export type Mark = 'skip' | 'wrong' | 'artist' | 'correct';

const MARK_EMOJI: Record<Mark, string> = { skip: '⬛', wrong: '🟥', artist: '🟨', correct: '🟩' };
const MARK_LETTER: Record<Mark, string> = { skip: 's', wrong: 'w', artist: 'a', correct: 'c' };

async function deezer(path: string, retried = false): Promise<any> {
  const response = await fetch(`https://api.deezer.com/${path}`);
  if (!response.ok) throw new Error(`Deezer ${path}: HTTP ${response.status}`);
  const body = await response.json();
  // Code 4 is Deezer's 50 requests / 5 s quota; one wait covers a burst like a playlist import.
  if (body.error?.code === 4 && !retried) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    return deezer(path, true);
  }
  if (body.error) throw new Error(`Deezer ${path}: ${body.error.message}`);
  return body;
}

function toTrack(raw: any): Track {
  return { id: raw.id, title: raw.title_short ?? raw.title, artist: raw.artist.name, cover: raw.album?.cover_medium ?? '' };
}

const hasPreview = (raw: any) => raw.readable !== false && Boolean(raw.preview);

// ponytail: pools cached for the process lifetime; restart to pick up new chart entries.
const poolCache = new Map<string, Promise<{ label: string; tracks: Track[] }>>();

// A pool is a POOLS key or a Spotify / YouTube / Deezer playlist link.
export function loadPool(poolName: string): Promise<{ label: string; tracks: Track[] }> {
  let pool = poolCache.get(poolName);
  if (!pool) {
    pool = POOLS[poolName] ? loadDeezerSources(POOLS[poolName].label, POOLS[poolName].sources) : loadPlaylist(poolName);
    pool.catch(() => poolCache.delete(poolName));
    poolCache.set(poolName, pool);
  }
  return pool;
}

async function loadDeezerSources(label: string, sources: string[]) {
  const pages = await Promise.all(sources.map((source) => deezer(`${source}?limit=300`)));
  return { label, tracks: uniqueTracks(pages.flatMap((page) => page.data).filter(hasPreview).map(toTrack)) };
}

function uniqueTracks(tracks: Track[]): Track[] {
  return [...new Map(tracks.map((track) => [songKey(track), track])).values()];
}

const SPOTIFY_LINK = /^https:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(playlist|album)\/([A-Za-z0-9]+)/;
const YOUTUBE_LINK = /^https:\/\/(?:www\.|music\.|m\.)?youtube\.com\/\S*[?&]list=([\w-]+)/;
const DEEZER_LINK = /^https:\/\/(?:www\.)?deezer\.com\/(?:[a-z]{2}\/)?(playlist|album)\/(\d+)/;
// ponytail: only the first 150 songs of an imported playlist are used, to keep Deezer lookups quick.
const PLAYLIST_LIMIT = 150;

export function isPlaylistLink(text: string): boolean {
  return [SPOTIFY_LINK, YOUTUBE_LINK, DEEZER_LINK].some((pattern) => pattern.test(text));
}

async function loadPlaylist(link: string): Promise<{ label: string; tracks: Track[] }> {
  const deezerMatch = link.match(DEEZER_LINK);
  if (deezerMatch) {
    const [, kind, id] = deezerMatch;
    const info = await deezer(`${kind}/${id}`);
    return loadDeezerSources(info.title, [`${kind}/${id}/tracks`]);
  }
  const { label, songs } = SPOTIFY_LINK.test(link) ? await spotifySongs(link) : await youtubeSongs(link);
  const tracks: Track[] = [];
  // Sequential on purpose: Deezer allows 50 requests per 5 seconds.
  for (const song of songs.slice(0, PLAYLIST_LIMIT)) {
    const track = await findOnDeezer(song);
    if (track) tracks.push(track);
  }
  if (!tracks.length) throw new Error(`None of the songs in ${link} were found on Deezer`);
  return { label, tracks: uniqueTracks(tracks) };
}

type Song = { title: string; artist: string };

async function spotifySongs(link: string): Promise<{ label: string; songs: Song[] }> {
  const [, kind, id] = link.match(SPOTIFY_LINK)!;
  // The public embed page carries the track list, so no Spotify API key is needed.
  const response = await fetch(`https://open.spotify.com/embed/${kind}/${id}`, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`Spotify ${kind} ${id}: HTTP ${response.status}`);
  const data = (await response.text()).match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s)?.[1];
  if (!data) throw new Error('Spotify embed page has no track data (page format changed?)');
  const entity = JSON.parse(data).props.pageProps.state.data.entity;
  return {
    label: entity.name,
    songs: entity.trackList.map((item: any) => ({ title: item.title, artist: item.subtitle.split(',')[0].trim() })),
  };
}

async function youtubeSongs(link: string): Promise<{ label: string; songs: Song[] }> {
  const [, listId] = link.match(YOUTUBE_LINK)!;
  const { stdout } = await execFileAsync(
    'yt-dlp', ['--flat-playlist', '-J', '--playlist-end', String(PLAYLIST_LIMIT), `https://www.youtube.com/playlist?list=${listId}`],
    { maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
  );
  const playlist = JSON.parse(stdout);
  return {
    label: playlist.title,
    songs: playlist.entries.map((entry: any) => ({
      title: cleanVideoTitle(entry.title ?? ''),
      artist: (entry.channel ?? entry.uploader ?? '').replace(/ - Topic$/, ''),
    })),
  };
}

export function cleanVideoTitle(title: string): string {
  return title
    .replace(/[([【「][^)\]】」]*\b(official|music video|mv|m\/v|lyrics?|audio|visualizer|video|hd|4k)\b[^)\]】」]*[)\]】」]/gi, ' ')
    .replace(/歌いました|歌ってみた|\bofficial (music )?video\b|\bM\/?V\b/gi, ' ')
    .replace(/[【】「」『』|｜]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function findOnDeezer(song: Song): Promise<Track | null> {
  const quote = (text: string) => text.replace(/"/g, '');
  const queries = [`${song.artist} ${song.title}`, song.title];
  if (song.artist) queries.unshift(`artist:"${quote(song.artist)}" track:"${quote(song.title)}"`);
  for (const query of queries) {
    const hit = (await deezer(`search?q=${encodeURIComponent(query)}&limit=5`)).data.find(hasPreview);
    if (hit) return toTrack(hit);
  }
  return null;
}

export async function randomTrack(poolName: string): Promise<Track> {
  const { tracks } = await loadPool(poolName);
  return tracks[Math.floor(Math.random() * tracks.length)];
}

export function dailyIndex(seed: string, length: number): number {
  return createHash('sha256').update(seed).digest().readUInt32BE(0) % length;
}

export async function dailyTrack(scope: string, day: string): Promise<Track> {
  const { tracks } = await loadPool('all');
  return tracks[dailyIndex(`${scope}:${day}`, tracks.length)];
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function searchTracks(query: string): Promise<Track[]> {
  if (!query.trim()) return [];
  const body = await deezer(`search?q=${encodeURIComponent(query)}&limit=10`);
  return body.data.map(toTrack);
}

export async function getTrack(id: number): Promise<Track> {
  return toTrack(await deezer(`track/${id}`));
}

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+-\s+.*$/, '') // "Song - Remastered 2011"
    .replace(/[([].*?[)\]]/g, '') // "(feat. X)", "[Live]"
    .replace(/\b(feat|ft)\..*$/, '')
    .replace(/&/g, 'and')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function songKey(track: Track): string {
  return `${normalize(track.title)}|${normalize(track.artist)}`;
}

export function judge(answer: Track, guess: Track | null): Mark {
  if (!guess) return 'skip';
  if (songKey(answer) === songKey(guess)) return 'correct';
  if (normalize(answer.artist) === normalize(guess.artist)) return 'artist';
  return 'wrong';
}

export class Round {
  track: Track;
  marks: Mark[];

  constructor(track: Track, marks: Mark[] = []) {
    this.track = track;
    this.marks = marks;
  }

  get won() { return this.marks.at(-1) === 'correct'; }
  get over() { return this.won || this.marks.length >= STAGES.length; }
  get seconds() { return STAGES[Math.min(this.marks.length, STAGES.length - 1)]; }
  // Points for a win: 5 on the first clip down to 1 on the last.
  get points() { return this.won ? STAGES.length - this.marks.length + 1 : 0; }

  guess(guess: Track | null): Mark {
    if (this.over) throw new Error('Round is already over');
    const mark = judge(this.track, guess);
    this.marks.push(mark);
    return mark;
  }

  grid(): string {
    return this.marks.map((mark) => MARK_EMOJI[mark]).join('') + '⬜'.repeat(STAGES.length - this.marks.length);
  }

  static encodeMarks(marks: Mark[]): string {
    return marks.map((mark) => MARK_LETTER[mark]).join('');
  }

  static decodeMarks(encoded: string): Mark[] {
    const byLetter = Object.fromEntries(Object.entries(MARK_LETTER).map(([mark, letter]) => [letter, mark as Mark]));
    return [...encoded].map((letter) => byLetter[letter]);
  }
}

// ponytail: in-memory cache of the 200 most recent previews; enough for a handful of servers.
const previewCache = new Map<number, Promise<Buffer>>();

function preview(trackId: number): Promise<Buffer> {
  let audio = previewCache.get(trackId);
  if (!audio) {
    // Preview URLs are signed and expire, so look the track up fresh each time.
    audio = deezer(`track/${trackId}`).then(async (raw) => {
      if (!raw.preview) throw new Error(`Track ${trackId} has no preview`);
      const response = await fetch(raw.preview);
      if (!response.ok) throw new Error(`Preview ${trackId}: HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    });
    audio.catch(() => previewCache.delete(trackId));
    previewCache.set(trackId, audio);
    if (previewCache.size > 200) previewCache.delete(previewCache.keys().next().value!);
  }
  return audio;
}

// mp3 for chat attachments and the browser, ogg/opus for voice channels.
export async function cutClip(trackId: number, seconds: number, format: 'mp3' | 'ogg'): Promise<Buffer> {
  const input = await preview(trackId);
  const codec = format === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', '160k', '-f', 'mp3'] : ['-c:a', 'libopus', '-ar', '48000', '-ac', '2', '-f', 'ogg'];
  const ffmpeg = spawn('ffmpeg', ['-loglevel', 'error', '-i', 'pipe:0', '-t', String(seconds), '-af', 'afade=t=out:st=' + Math.max(0, seconds - 0.03) + ':d=0.03', ...codec, 'pipe:1']);
  const chunks: Buffer[] = [];
  const errors: Buffer[] = [];
  ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk));
  ffmpeg.stderr.on('data', (chunk) => errors.push(chunk));
  const code = await new Promise((resolve, reject) => {
    // ffmpeg closes stdin once it has read enough for the clip, so EPIPE here is expected.
    ffmpeg.stdin.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE') reject(error); });
    ffmpeg.on('error', reject).on('close', resolve);
    ffmpeg.stdin.end(input);
  });
  if (code !== 0) throw new Error(`ffmpeg exited ${code}: ${Buffer.concat(errors)}`);
  return Buffer.concat(chunks);
}

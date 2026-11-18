import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

// Clip length in seconds for each attempt; a skip or wrong guess moves to the next one.
export const STAGES = [0.1, 0.5, 2, 8, 15];

// Deezer editorial playlists / genre charts. Genre and era are one choice because Deezer
// track listings carry no release year.
export const POOLS: Record<string, { label: string; sources: string[] }> = {
  all: { label: 'Everything', sources: ['playlist/1470022445', 'playlist/867825522', 'playlist/878989033', 'playlist/248297032', 'playlist/14917741483', 'playlist/13650084141'] },
  pop: { label: 'Pop', sources: ['chart/132', 'playlist/8282573142', 'playlist/8326097522', 'playlist/8512471762'] },
  hiphop: { label: 'Hip-Hop', sources: ['chart/116', 'playlist/7846286162'] },
  rock: { label: 'Rock', sources: ['playlist/1306931615', 'playlist/1419215845'] },
  rnb: { label: 'R&B', sources: ['playlist/1999466402', 'playlist/2021626162', 'playlist/5411628342'] },
  country: { label: 'Country', sources: ['playlist/1294431447', 'playlist/1130102843'] },
  kpop: { label: 'K-Pop', sources: ['playlist/4096400722', 'playlist/10738561582', 'playlist/9001527742'] },
  classic: { label: 'Classics (70s–90s)', sources: ['playlist/1470022445', 'playlist/867825522', 'playlist/878989033'] },
  '2000s': { label: '2000s', sources: ['playlist/248297032'] },
  '2010s': { label: '2010s', sources: ['playlist/14917741483'] },
  '2020s': { label: '2020s', sources: ['playlist/13650084141'] },
};

export type Track = { id: number; title: string; artist: string; cover: string };
export type Mark = 'skip' | 'wrong' | 'artist' | 'correct';

const MARK_EMOJI: Record<Mark, string> = { skip: '⬛', wrong: '🟥', artist: '🟨', correct: '🟩' };
const MARK_LETTER: Record<Mark, string> = { skip: 's', wrong: 'w', artist: 'a', correct: 'c' };

async function deezer(path: string) {
  const response = await fetch(`https://api.deezer.com/${path}`);
  if (!response.ok) throw new Error(`Deezer ${path}: HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`Deezer ${path}: ${body.error.message}`);
  return body;
}

function toTrack(raw: any): Track {
  return { id: raw.id, title: raw.title_short ?? raw.title, artist: raw.artist.name, cover: raw.album?.cover_medium ?? '' };
}

// ponytail: pools cached for the process lifetime; restart to pick up new chart entries.
const poolCache = new Map<string, Promise<Track[]>>();

export function loadPool(poolName: string): Promise<Track[]> {
  const pool = POOLS[poolName];
  if (!pool) throw new Error(`Unknown pool ${poolName}`);
  let tracks = poolCache.get(poolName);
  if (!tracks) {
    tracks = Promise.all(pool.sources.map((source) => deezer(`${source}/tracks?limit=300`))).then((pages) => {
      const unique = new Map<string, Track>();
      for (const raw of pages.flatMap((page) => page.data)) {
        if (raw.readable === false || !raw.preview) continue;
        const track = toTrack(raw);
        unique.set(songKey(track), track);
      }
      return [...unique.values()];
    });
    tracks.catch(() => poolCache.delete(poolName));
    poolCache.set(poolName, tracks);
  }
  return tracks;
}

export async function randomTrack(poolName: string): Promise<Track> {
  const tracks = await loadPool(poolName);
  return tracks[Math.floor(Math.random() * tracks.length)];
}

export function dailyIndex(seed: string, length: number): number {
  return createHash('sha256').update(seed).digest().readUInt32BE(0) % length;
}

export async function dailyTrack(scope: string, day: string): Promise<Track> {
  const tracks = await loadPool('all');
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

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize as normalizePath } from 'node:path';
import { cutClip, dailyTrack, getTrack, POOLS, randomTrack, Round, searchTracks, STAGES, today, type Track } from './game.ts';
import { addScore, dailyPlayers, getDailyMarks, saveDailyMarks, type Player } from './store.ts';

const DIST = join(import.meta.dirname, '..', 'dist');
const CONTENT_TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// One shared song per launched Activity; each player guesses it on their own.
type Instance = { serial: number; pool: string; track: Track; rounds: Map<string, { player: Player; round: Round }> };
// ponytail: Activity instances are kept in memory forever; prune idle ones if this ever runs in many servers.
const instances = new Map<string, Instance>();
let instanceSerial = 0;
// ponytail: access tokens are cached without expiry; fine for a process restarted now and then.
const tokenUsers = new Map<string, Player>();

async function userFor(request: IncomingMessage): Promise<Player> {
  const token = request.headers.authorization?.replace(/^Bearer /, '');
  if (!token) throw new HttpError(401, 'Missing token');
  let player = tokenUsers.get(token);
  if (!player) {
    const response = await fetch('https://discord.com/api/v10/users/@me', { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new HttpError(401, 'Invalid token');
    const user = await response.json();
    player = { id: user.id, name: user.global_name ?? user.username };
    tokenUsers.set(token, player);
  }
  return player;
}

type Body = { mode?: 'daily' | 'endless'; instance?: string; guild?: string | null; pool?: string; trackId?: number | null; code?: string; query?: string };

async function readBody(request: IncomingMessage): Promise<Body> {
  let text = '';
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 10_000) throw new HttpError(413, 'Body too large');
  }
  return text ? JSON.parse(text) : {};
}

async function instanceFor(body: Body): Promise<Instance> {
  if (!body.instance) throw new HttpError(400, 'Missing instance');
  let instance = instances.get(body.instance);
  if (!instance) {
    const pool = body.pool && POOLS[body.pool] ? body.pool : 'all';
    instance = { serial: ++instanceSerial, pool, track: await randomTrack(pool), rounds: new Map() };
    instances.set(body.instance, instance);
  }
  return instance;
}

// Resolves the caller's round for either mode, plus how to persist it after a guess.
async function roundFor(body: Body, player: Player) {
  const scope = body.guild ?? `user:${player.id}`;
  if (body.mode === 'daily') {
    const day = today();
    const round = new Round(await dailyTrack(scope, day), getDailyMarks(scope, day, player.id));
    return { scope, round, save: () => saveDailyMarks(scope, day, player, round.marks) };
  }
  const instance = await instanceFor(body);
  let entry = instance.rounds.get(player.id);
  if (!entry) {
    entry = { player, round: new Round(instance.track) };
    instance.rounds.set(player.id, entry);
  }
  const round = entry.round;
  return { scope, round, save: () => { if (round.won) addScore(scope, player, round.points); } };
}

async function state(body: Body, player: Player) {
  const { scope, round } = await roundFor(body, player);
  const players = body.mode === 'daily'
    ? dailyPlayers(scope, today()).map((row) => ({ id: row.user, name: row.name, marks: row.marks }))
    : [...(await instanceFor(body)).rounds.values()].map((entry) => ({ id: entry.player.id, name: entry.player.name, marks: entry.round.marks }));
  return {
    mode: body.mode,
    // Lets the client notice a new song without revealing which one.
    roundId: body.mode === 'daily' ? today() : String((await instanceFor(body)).serial),
    pool: body.mode === 'daily' ? 'all' : (await instanceFor(body)).pool,
    day: today(),
    stages: STAGES,
    marks: round.marks,
    seconds: round.over ? 30 : round.seconds,
    over: round.over,
    won: round.won,
    points: round.points,
    answer: round.over ? round.track : null,
    players,
  };
}

async function api(path: string, body: Body, request: IncomingMessage): Promise<unknown> {
  if (path === '/api/token') {
    if (!body.code) throw new HttpError(400, 'Missing code');
    const response = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID!, client_secret: process.env.DISCORD_CLIENT_SECRET!,
        grant_type: 'authorization_code', code: body.code,
      }),
    });
    if (!response.ok) throw new HttpError(401, `Token exchange failed: ${await response.text()}`);
    return { access_token: (await response.json()).access_token };
  }

  const player = await userFor(request);
  if (body.mode !== 'daily' && body.mode !== 'endless' && path !== '/api/search') throw new HttpError(400, 'Bad mode');

  if (path === '/api/search') return (await searchTracks(String(body.query ?? '').slice(0, 100))).map(({ id, title, artist }) => ({ id, title, artist }));
  if (path === '/api/state') return state(body, player);
  if (path === '/api/guess') {
    const { round, save } = await roundFor(body, player);
    if (round.over) throw new HttpError(409, 'Round is over');
    round.guess(typeof body.trackId === 'number' ? await getTrack(body.trackId) : null);
    save();
    return state(body, player);
  }
  if (path === '/api/next') {
    const instance = await instanceFor(body);
    const own = instance.rounds.get(player.id);
    // Only someone who has finished the current song can move the group on.
    if (own && !own.round.over) throw new HttpError(409, 'Finish your round first');
    const pool = body.pool && POOLS[body.pool] ? body.pool : instance.pool;
    instances.set(body.instance!, { serial: ++instanceSerial, pool, track: await randomTrack(pool), rounds: new Map() });
    return state(body, player);
  }
  throw new HttpError(404, 'Not found');
}

async function serveStatic(path: string, response: ServerResponse) {
  const file = normalizePath(join(DIST, path === '/' ? 'index.html' : path));
  if (!file.startsWith(DIST)) throw new HttpError(404, 'Not found');
  const content = await readFile(file).catch((error) => {
    if (error.code === 'ENOENT') throw new HttpError(404, 'Not found');
    throw error;
  });
  response.writeHead(200, { 'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' });
  response.end(content);
}

export function startServer(port: number) {
  createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    try {
      if (!path.startsWith('/api/')) return await serveStatic(path, response);
      if (request.method !== 'POST') throw new HttpError(405, 'POST only');
      const body = await readBody(request);
      if (path === '/api/clip') {
        const player = await userFor(request);
        const { round } = await roundFor(body, player);
        const clip = await cutClip(round.track.id, round.over ? 30 : round.seconds, 'mp3');
        response.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' });
        return response.end(clip);
      }
      const result = await api(path, body, request);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result));
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error instanceof SyntaxError ? 400 : 500;
      if (status === 500) console.error(error);
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: status === 500 ? 'Internal error' : (error as Error).message }));
    }
  }).listen(port, '127.0.0.1', () => console.log(`Activity server on http://127.0.0.1:${port}`));
}

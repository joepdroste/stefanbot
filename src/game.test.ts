import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { dailyIndex, judge, normalize, Round, STAGES, type Track } from './game.ts';

const track = (title: string, artist: string, id = 1): Track => ({ id, title, artist, cover: '' });
const answer = track('Mr. Brightside', 'The Killers');

test('normalize ignores versions, features, accents and punctuation', () => {
  assert.equal(normalize('Mr. Brightside - Remastered 2011'), normalize('mr brightside'));
  assert.equal(normalize('Señorita (feat. Camila Cabello)'), 'senorita');
  assert.equal(normalize('Simon & Garfunkel'), normalize('Simon and Garfunkel'));
  assert.equal(normalize('Stay ft. Justin Bieber'), 'stay');
  assert.equal(normalize('Song [Live]'), 'song');
});

test('judge matches other versions of the same song and flags right artist', () => {
  assert.equal(judge(answer, track('Mr. Brightside (Live)', 'The Killers', 99)), 'correct');
  assert.equal(judge(answer, track('Somebody Told Me', 'The Killers')), 'artist');
  assert.equal(judge(answer, track('Mr. Brightside', 'Some Cover Band')), 'wrong');
  assert.equal(judge(answer, null), 'skip');
});

test('round advances clips, scores by attempt and ends after the last clip', () => {
  const round = new Round(answer);
  assert.equal(round.seconds, STAGES[0]);
  round.guess(null);
  round.guess(track('Nope', 'Nobody'));
  assert.equal(round.seconds, STAGES[2]);
  round.guess(answer);
  assert.ok(round.over && round.won);
  assert.equal(round.points, 3);
  assert.equal(round.grid(), '⬛🟥🟩⬜⬜');
  assert.throws(() => round.guess(answer));

  const firstTry = new Round(answer);
  firstTry.guess(answer);
  assert.equal(firstTry.points, 5);

  const lost = new Round(answer);
  for (const _ of STAGES) lost.guess(null);
  assert.ok(lost.over && !lost.won);
  assert.equal(lost.points, 0);
  assert.equal(lost.seconds, STAGES.at(-1));
});

test('marks survive encode/decode', () => {
  const marks = ['skip', 'wrong', 'artist', 'correct'] as const;
  assert.deepEqual(Round.decodeMarks(Round.encodeMarks([...marks])), marks);
  assert.deepEqual(Round.decodeMarks(''), []);
});

test('daily index is stable per seed and in range', () => {
  assert.equal(dailyIndex('guild:2026-11-18', 500), dailyIndex('guild:2026-11-18', 500));
  const picks = new Set(Array.from({ length: 30 }, (_, day) => dailyIndex(`guild:2026-11-${day}`, 500)));
  assert.ok(picks.size > 20);
  for (const pick of picks) assert.ok(pick >= 0 && pick < 500);
});

test('daily streak counts consecutive won days and stops at a loss or gap', async () => {
  process.chdir(mkdtempSync(join(tmpdir(), 'stefanbot-')));
  const { saveDailyMarks, dailyStreak } = await import('./store.ts');
  const player = { id: 'u1', name: 'Player' };
  saveDailyMarks('g', '2026-11-14', player, ['correct']);
  saveDailyMarks('g', '2026-11-15', player, ['skip', 'skip', 'skip', 'skip', 'skip']);
  saveDailyMarks('g', '2026-11-16', player, ['correct']);
  saveDailyMarks('g', '2026-12-31', player, ['correct']);
  saveDailyMarks('g', '2027-01-01', player, ['wrong', 'correct']);
  assert.equal(dailyStreak('g', 'u1', '2026-11-16'), 1);
  assert.equal(dailyStreak('g', 'u1', '2026-11-15'), 0);
  assert.equal(dailyStreak('g', 'u1', '2027-01-01'), 2);
  assert.equal(dailyStreak('g', 'u1', '2026-11-17'), 0);
});

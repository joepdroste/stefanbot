import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Round, type Mark } from './game.ts';

mkdirSync('data', { recursive: true });
const db = new DatabaseSync('data/stefanbot.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS daily (scope TEXT, day TEXT, user TEXT, name TEXT, marks TEXT, PRIMARY KEY (scope, day, user));
  CREATE TABLE IF NOT EXISTS scores (scope TEXT, user TEXT, name TEXT, points INTEGER, wins INTEGER, PRIMARY KEY (scope, user));
`);

export type Player = { id: string; name: string };

export function getDailyMarks(scope: string, day: string, userId: string): Mark[] {
  const row = db.prepare('SELECT marks FROM daily WHERE scope = ? AND day = ? AND user = ?').get(scope, day, userId);
  return row ? Round.decodeMarks(row.marks as string) : [];
}

export function saveDailyMarks(scope: string, day: string, player: Player, marks: Mark[]) {
  db.prepare('INSERT INTO daily VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET name = excluded.name, marks = excluded.marks')
    .run(scope, day, player.id, player.name, Round.encodeMarks(marks));
}

export function dailyPlayers(scope: string, day: string): { user: string; name: string; marks: Mark[] }[] {
  return db.prepare('SELECT user, name, marks FROM daily WHERE scope = ? AND day = ?').all(scope, day)
    .map((row) => ({ user: row.user as string, name: row.name as string, marks: Round.decodeMarks(row.marks as string) }));
}

// Consecutive days won up to and including `day`.
export function dailyStreak(scope: string, userId: string, day: string): number {
  const rows = db.prepare('SELECT day, marks FROM daily WHERE scope = ? AND user = ? AND day <= ? ORDER BY day DESC').all(scope, userId, day);
  let streak = 0;
  let expected = new Date(day + 'T00:00:00Z');
  for (const row of rows) {
    if (row.day !== expected.toISOString().slice(0, 10) || !(row.marks as string).endsWith('c')) break;
    streak++;
    expected = new Date(expected.getTime() - 86_400_000);
  }
  return streak;
}

export function addScore(scope: string, player: Player, points: number) {
  db.prepare('INSERT INTO scores VALUES (?, ?, ?, ?, 1) ON CONFLICT DO UPDATE SET name = excluded.name, points = points + excluded.points, wins = wins + 1')
    .run(scope, player.id, player.name, points);
}

export function leaderboard(scope: string): { name: string; points: number; wins: number }[] {
  return db.prepare('SELECT name, points, wins FROM scores WHERE scope = ? ORDER BY points DESC LIMIT 10').all(scope) as any;
}

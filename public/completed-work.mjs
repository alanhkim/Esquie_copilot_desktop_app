import { matchingTasks } from './task-board.mjs';

const periods = new Set(['all', 'last30', 'last90', 'quarter', 'year', 'unknown']);
const isoTimestamp = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function validInstant(value) {
  if (typeof value !== 'string') return null;
  const match = isoTimestamp.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, 0);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 ||
      calendar.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return null;
  const instant = new Date(value);
  return Number.isFinite(instant.valueOf()) ? instant : null;
}

export function ownerLocalDateKey(value, timezone) {
  const instant = value instanceof Date ? value : validInstant(value);
  if (!instant || !Number.isFinite(instant.valueOf()) || typeof timezone !== 'string' || !timezone.trim()) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone.trim(), year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(instant);
    const date = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return date.year && date.month && date.day ? `${date.year}-${date.month}-${date.day}` : null;
  } catch {
    return null;
  }
}

function shiftDateKey(value, days) {
  const [year, month, day] = value.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

function periodStart(period, today) {
  if (period === 'last30') return shiftDateKey(today, -29);
  if (period === 'last90') return shiftDateKey(today, -89);
  if (period === 'quarter') {
    const [year, month] = today.split('-').map(Number);
    return `${year}-${String(Math.floor((month - 1) / 3) * 3 + 1).padStart(2, '0')}-01`;
  }
  if (period === 'year') return `${today.slice(0, 4)}-01-01`;
  return null;
}

export function completedWorkTasks(tasks, conversations, query, accountFilter, period, timezone, now = new Date()) {
  if (!periods.has(period)) return { available: false, reason: 'Choose a supported completion period.', tasks: [] };
  const completed = tasks.filter(task => task.status === 'done');
  if (period === 'all' || period === 'unknown') {
    const matches = matchingTasks(completed, conversations, query, true, accountFilter);
    return {
      available: true,
      tasks: period === 'all' ? matches : matches.filter(task => validInstant(task.completedAt) === null)
    };
  }
  const today = ownerLocalDateKey(now, timezone);
  if (!today) return { available: false, reason: 'Set a valid owner timezone in Operations to evaluate completion-date periods. The device timezone is not used.', tasks: [] };
  const start = periodStart(period, today);
  const matches = matchingTasks(completed, conversations, query, true, accountFilter);
  return {
    available: true,
    tasks: matches.filter(task => {
      const completedDate = ownerLocalDateKey(task.completedAt, timezone);
      return completedDate !== null && completedDate >= start && completedDate <= today;
    })
  };
}

export function recordedTimestamp(value) {
  return validInstant(value)?.toISOString() || '';
}

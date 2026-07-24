// Almacén persistente de recordatorios (archivo JSON).
// En Render se guarda en el disco montado en /data; en local, en ./reminders-local.json
import fs from 'fs';
import { madridDateParts, madridToUtc, TZ } from './calendar.js';

const FILE = process.env.REMINDERS_FILE
  || (fs.existsSync('/data') ? '/data/reminders.json' : './reminders-local.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return [];
  }
}

let reminders = load();

function persist() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(reminders));
  } catch (e) {
    console.error('reminders save error:', e.message);
  }
}

// r = { id, chatId, text, dueTs, repeat? }
export function addReminder(r) {
  reminders.push(r);
  persist();
}

// Último aviso que sonó por chat (recordatorio o aviso de evento), para poder "posponerlo".
// eventStartTs: si vino de un evento, la hora de inicio del evento (para "faltando X min").
const lastFired = new Map();
export function setLastFired(chatId, text, eventStartTs = null) {
  lastFired.set(chatId, { text, eventStartTs });
}
export function getLastFired(chatId) {
  return lastFired.get(chatId) || null;
}

export function dueReminders(nowTs) {
  return reminders.filter((r) => r.dueTs <= nowTs);
}

export function removeReminders(ids) {
  reminders = reminders.filter((r) => !ids.includes(r.id));
  persist();
}

export function pendingCount(chatId) {
  return reminders.filter((r) => !chatId || r.chatId === chatId).length;
}

// Lista los recordatorios pendientes (de un chat), ordenados por hora
export function listReminders(chatId) {
  return reminders
    .filter((r) => !chatId || r.chatId === chatId)
    .sort((a, b) => a.dueTs - b.dueTs);
}

// Borra un recordatorio por id. Devuelve true si borró algo.
export function removeReminder(id) {
  const before = reminders.length;
  reminders = reminders.filter((r) => r.id !== id);
  if (reminders.length !== before) {
    persist();
    return true;
  }
  return false;
}

// Actualiza la hora de un recordatorio (para reprogramar los recurrentes)
export function updateReminderDue(id, newDueTs) {
  const r = reminders.find((x) => x.id === id);
  if (r) {
    r.dueTs = newDueTs;
    persist();
  }
}

// Calcula la PRÓXIMA hora de aviso de una regla de repetición, posterior a afterTs.
// repeat = { type: 'daily'|'weekly'|'monthly', hh, mm, dow?(0=dom..6=sáb), dom?(1-31) }
export function nextOccurrence(repeat, afterTs) {
  const { type, hh = 9, mm = 0, dow, dom } = repeat;
  if (type === 'daily') {
    for (let off = 0; off <= 2; off++) {
      const p = madridDateParts(off);
      const ts = madridToUtc(p.y, p.m, p.d, hh, mm).getTime();
      if (ts > afterTs) return ts;
    }
  } else if (type === 'weekly') {
    for (let off = 0; off <= 14; off++) {
      const p = madridDateParts(off);
      const wd = new Date(Date.UTC(p.y, p.m - 1, p.d, 12)).getUTCDay();
      if (wd === dow) {
        const ts = madridToUtc(p.y, p.m, p.d, hh, mm).getTime();
        if (ts > afterTs) return ts;
      }
    }
  } else if (type === 'monthly') {
    let { y, m } = madridDateParts(0);
    for (let i = 0; i < 24; i++) {
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const d = Math.min(dom, lastDay);
      const ts = madridToUtc(y, m, d, hh, mm).getTime();
      if (ts > afterTs) return ts;
      m++;
      if (m > 12) { m = 1; y++; }
    }
  }
  return null;
}

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

// Texto legible de una repetición
export function describeRepeat(repeat) {
  const hora = `${String(repeat.hh ?? 9).padStart(2, '0')}:${String(repeat.mm ?? 0).padStart(2, '0')}`;
  if (repeat.type === 'daily') return `cada día a las ${hora}`;
  if (repeat.type === 'weekly') return `cada ${DIAS[repeat.dow]} a las ${hora}`;
  if (repeat.type === 'monthly') return `el día ${repeat.dom} de cada mes a las ${hora}`;
  return '';
}

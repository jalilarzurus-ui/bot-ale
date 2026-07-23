// Almacén persistente de recordatorios (archivo JSON).
// En Render se guarda en el disco montado en /data; en local, en ./reminders-local.json
import fs from 'fs';

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

// r = { id, chatId, text, dueTs }
export function addReminder(r) {
  reminders.push(r);
  persist();
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

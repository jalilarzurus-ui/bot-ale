// Lista de PENDIENTES (tareas sin hora concreta). El bot las recuerda cada día
// hasta que se marcan como hechas. Persistente en disco (/data en Render).
import fs from 'fs';

const FILE = process.env.TASKS_FILE
  || (fs.existsSync('/data') ? '/data/tasks.json' : './tasks-local.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return [];
  }
}

let tasks = load();

function persist() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(tasks));
  } catch (e) {
    console.error('tasks save error:', e.message);
  }
}

const rid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// t = { id, chatId, text, createdTs }
export function addTask(chatId, text) {
  const t = { id: rid(), chatId, text: text.trim(), createdTs: Date.now() };
  tasks.push(t);
  persist();
  return t;
}

// Pendientes de un chat, más antiguos primero.
export function listTasks(chatId) {
  return tasks
    .filter((t) => t.chatId === chatId)
    .sort((a, b) => a.createdTs - b.createdTs);
}

export function pendingTaskCount(chatId) {
  return tasks.filter((t) => t.chatId === chatId).length;
}

// Borra por id. Devuelve true si borró algo.
export function removeTask(id) {
  const before = tasks.length;
  tasks = tasks.filter((t) => t.id !== id);
  if (tasks.length !== before) {
    persist();
    return true;
  }
  return false;
}

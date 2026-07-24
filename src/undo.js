// Última acción reversible por chat (crear/cancelar/mover un evento), para "deshacer".
// En memoria y de vida corta: tras 10 min ya no se puede deshacer.
const lastAction = new Map(); // chatId -> { describe, undo, expiresAt }
const TTL = 10 * 60 * 1000;

// undo: async () => string (mensaje de resultado). describe: qué se hizo (para mensajes).
export function setLastAction(chatId, { describe, undo }) {
  lastAction.set(chatId, { describe, undo, expiresAt: Date.now() + TTL });
}

export function getLastAction(chatId) {
  const a = lastAction.get(chatId);
  if (!a) return null;
  if (Date.now() > a.expiresAt) {
    lastAction.delete(chatId);
    return null;
  }
  return a;
}

export function clearLastAction(chatId) {
  lastAction.delete(chatId);
}

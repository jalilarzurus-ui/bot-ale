// Acciones peligrosas (cancelar/mover eventos) que esperan un "sí" del usuario.
// En memoria y de vida corta: si el servidor se reinicia, se pide de nuevo.
const pending = new Map(); // chatId -> { describe, exec, expiresAt }
const TTL = 5 * 60 * 1000; // 5 minutos

// exec: async () => string (mensaje de resultado). describe: texto ya mostrado al pedir confirmación.
export function setPending(chatId, { describe, exec }) {
  pending.set(chatId, { describe, exec, expiresAt: Date.now() + TTL });
}

export function getPending(chatId) {
  const p = pending.get(chatId);
  if (!p) return null;
  if (Date.now() > p.expiresAt) {
    pending.delete(chatId);
    return null;
  }
  return p;
}

export function clearPending(chatId) {
  pending.delete(chatId);
}

// Normaliza: minúsculas, sin acentos, sin signos, espacios colapsados.
function norm(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim().replace(/\s+/g, ' ');
}

const YES = /^(si|sip|sisi|claro|dale|hazlo|confirmo|confirmar|confirmado|correcto|corecto|adelante|de una|eso|eso es|asi es|exacto|procede|proceder|de acuerdo|ok si|vale si|perfecto|va)\b/;
const NO = /^(no|nel|nop|dejalo|dejala|olvidalo|olvidala|mejor no|para|espera|cancela eso|asi no|nada|negativo)\b/;

export function isYes(text) {
  return YES.test(norm(text));
}
export function isNo(text) {
  return NO.test(norm(text));
}

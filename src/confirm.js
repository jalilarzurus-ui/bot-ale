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

// Coincidencia COMPLETA (^...$), no solo el inicio: así "claro que no", "va a llover"
// o "para mañana" NO se toman por sí/no. Ante la duda, no se confirma (seguro por defecto).
// Se permite un cierre de cortesía opcional ("por favor", "porfa", "gracias").
const CORTESIA = '(?:\\s+(?:por\\s+favor|porfa|gracias|please))?';
const YES = new RegExp('^(?:si|sisi|si si|sip|claro|claro que si|dale|dale si|si dale|hazlo|hazlo ya|si hazlo|confirmo|confirmar|confirmado|correcto|adelante|exacto|eso es|eso mismo|asi es|de una|de acuerdo|procede|ok|oka|okey|okay|vale|va|perfecto|obvio)' + CORTESIA + '$');
const NO = new RegExp('^(?:no|no no|nel|nop|nope|para nada|dejalo|dejala|dejalo asi|olvidalo|olvidala|mejor no|no gracias|nada|negativo|cancelalo|cancela eso|asi no|no lo hagas|no hagas nada|dejalo estar)' + CORTESIA + '$');

export function isYes(text) {
  return YES.test(norm(text));
}
export function isNo(text) {
  return NO.test(norm(text));
}

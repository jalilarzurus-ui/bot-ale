// Llamada robusta a la API de mensajes de Anthropic.
// Reintenta ante fallos transitorios (rate limit 429, sobrecarga 529, 5xx, red)
// para que un pico puntual NO se traduzca en "no te entendí" de cara al usuario.
const URL = 'https://api.anthropic.com/v1/messages';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Señal de "el cerebro (IA) no está disponible ahora mismo" — distinta de "no lo entendí".
export const AI_DOWN = Symbol('AI_DOWN');

export async function anthropic(body, { retries = 2 } = {}) {
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, down: false, data: null };
  let lastStatus = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(URL, {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (res.ok) return { ok: true, down: false, data: await res.json() };
      lastStatus = res.status;
      // 429 (rate limit) y 5xx (incluye 529 "overloaded") → esperar y reintentar
      if (res.status === 429 || res.status >= 500) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      // 4xx de cliente (400/401/403) → reintentar no ayuda
      return { ok: false, down: true, status: res.status, data: await res.json().catch(() => null) };
    } catch {
      await sleep(500 * (attempt + 1)); // error de red → reintentar
    }
  }
  return { ok: false, down: true, status: lastStatus, data: null };
}

// Extrae el texto de la respuesta (primer bloque de tipo texto).
export function textOf(data) {
  const blocks = data?.content;
  if (!Array.isArray(blocks)) return '';
  const t = blocks.find((b) => b.type === 'text');
  return (t?.text || blocks[0]?.text || '').trim();
}

// Extrae y parsea el primer objeto JSON del texto de la respuesta. null si no hay JSON válido.
export function jsonOf(data) {
  const txt = textOf(data);
  const i = txt.indexOf('{');
  const j = txt.lastIndexOf('}');
  if (i < 0 || j < 0 || j < i) return null;
  try {
    return JSON.parse(txt.slice(i, j + 1));
  } catch {
    return null;
  }
}

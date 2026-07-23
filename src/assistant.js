// Capa conversacional: cuando el mensaje NO es un comando, responde la IA de forma
// natural, con memoria reciente de la conversación y con la agenda próxima a la vista.
import { eventsForRange, madridDateParts, TZ } from './calendar.js';
import { getCity } from './settings.js';

const histories = new Map(); // chatId -> [{ role, content }]
const MAX_TURNS = 10; // ~5 intercambios

function remember(chatId, role, content) {
  const h = histories.get(chatId) || [];
  h.push({ role, content });
  while (h.length > MAX_TURNS) h.shift();
  histories.set(chatId, h);
}

// Lista de eventos de los próximos 8 días, para que la IA pueda responder sobre la agenda.
async function upcomingSnapshot() {
  try {
    const events = await eventsForRange(madridDateParts(0), madridDateParts(8));
    if (!events.length) return 'No hay eventos en los próximos 8 días.';
    return events
      .map((it) => {
        const dt = it.ev.start?.dateTime;
        const cuando = dt
          ? new Date(dt).toLocaleString('es-ES', {
              timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
            })
          : '(todo el día)';
        return `- ${cuando}: ${it.ev.summary}`;
      })
      .join('\n');
  } catch {
    return '(no disponible ahora mismo)';
  }
}

export async function conversationalReply(chatId, text) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return 'Puedo ayudarte con tu *agenda*, *apuntar* cosas, *recordatorios* y más. Escríbeme lo que necesites 🙌';
  }

  const agenda = await upcomingSnapshot();
  const hoy = new Date().toLocaleDateString('es-ES', {
    timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  const system =
    'Eres el asistente personal por WhatsApp de un empresario (Ale) y su asistente (Jalil). ' +
    'Conversa de forma natural, cercana y útil, en español y conciso (es WhatsApp).\n' +
    `Hoy es ${hoy}. Ciudad actual: ${getCity()}.\n` +
    'Estos son sus PRÓXIMOS eventos (zona Europe/Madrid):\n' +
    `${agenda}\n\n` +
    'Reglas:\n' +
    '- Si te preguntan si algo quedó agendado, cuándo es algo, o qué tienen un día, MIRA la lista de eventos de arriba y responde con seguridad y de forma concreta.\n' +
    '- No inventes eventos que no estén en la lista.\n' +
    '- Las acciones (crear, cancelar o mover eventos; poner recordatorios; ver el clima) el usuario las hace con frases directas ("anota...", "cancela...", "mueve...", "recuérdame...", "clima"). Si te piden una acción, dilo brevemente (ej: «dímelo así: "anota cena el sábado 21h" y lo agendo»).\n' +
    '- Responde SOLO lo que te pregunten, sin relleno.';

  const history = histories.get(chatId) || [];
  const messages = [...history, { role: 'user', content: text }];

  let reply;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 600, system, messages }),
    });
    const data = await res.json();
    reply = data.content?.[0]?.text?.trim();
  } catch (e) {
    console.error('assistant error:', e.message);
  }
  if (!reply) reply = 'Perdona, no te he entendido bien 🤔. ¿Puedes decírmelo de otra forma?';

  remember(chatId, 'user', text);
  remember(chatId, 'assistant', reply);
  return reply;
}

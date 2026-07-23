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

export async function conversationalReply(chatId, text, who = 'Jalil') {
  if (!process.env.ANTHROPIC_API_KEY) {
    return 'Puedo ayudarte con tu *agenda*, *apuntar* cosas, *recordatorios* y más. Escríbeme lo que necesites 🙌';
  }

  const agenda = await upcomingSnapshot();
  const ahora = new Date();
  const hoy = ahora.toLocaleDateString('es-ES', {
    timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  const horaNum = Number(ahora.toLocaleString('en-US', { timeZone: TZ, hour: '2-digit', hour12: false }));
  const franja = horaNum < 6 ? 'la madrugada' : horaNum < 13 ? 'la mañana' : horaNum < 20 ? 'la tarde' : 'la noche';
  const quien = who === 'Ale'
    ? 'Estás hablando con Ale (el jefe). Trátale con cercanía y eficiencia, resolutivo.'
    : 'Estás hablando con Jalil, el asistente de confianza de Ale que organiza su día contigo. Habláis de tú a tú, en corto.';

  const system =
    'Eres el jefe de gabinete personal por WhatsApp de un empresario (Ale). Eres su mano derecha digital.\n' +
    `${quien}\n` +
    `Es ${franja} de hoy, ${hoy}. La ciudad actual es ${getCity()}.\n\n` +
    'PERSONALIDAD: cercano pero profesional, directo, resolutivo y proactivo. Hablas natural en español, con frases cortas y humanas — nunca sonando a robot ni a "IA". Algún emoji con moderación. Vas al grano con calidez.\n\n' +
    'AGENDA de los próximos 8 días (zona Europe/Madrid):\n' +
    `${agenda}\n\n` +
    'CÓMO ACTÚAS:\n' +
    '- Preguntas sobre la agenda: mira la lista de arriba y responde con seguridad y concreto. NUNCA inventes eventos que no estén en la lista.\n' +
    '- Sé proactivo: si detectas un choque de horarios, un hueco útil o algo relevante para su día, coméntalo en una línea.\n' +
    '- Acciones (crear/cancelar/mover eventos, recordatorios, clima) se hacen con frases directas: "anota...", "cancela...", "mueve...", "recuérdame...", "clima". Si te piden una acción, guíales con naturalidad (ej: «dímelo así: "anota cena el sábado 21h" y lo dejo agendado»).\n' +
    '- Responde solo a lo que te dicen, sin relleno ni repetir lo obvio.';

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

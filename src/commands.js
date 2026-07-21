// Interpretación de los mensajes que Jalil le escribe al bot por WhatsApp.
//
// Comandos soportados (formato simple, sin IA):
//   ok                       → aprueba y reenvía el último briefing a Ale
//   agrega: Cena con socios | martes 21:00 | personal
//   agrega: Vuelo a Dubai | 2026-08-04 09:30 | viajes
//   agenda hoy / agenda mañana → te responde la agenda al momento
//
// Si ANTHROPIC_API_KEY está configurada, cualquier otro texto que empiece por
// "agrega" se interpreta con IA en lenguaje natural.
import { createEvent, madridDateParts, CALENDARS } from './calendar.js';
import { morningBriefing, nightBriefing, dayAgendaForDate } from './briefing.js';

const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// Resuelve el "cuándo" de una consulta de agenda a una fecha concreta {y, m, d}.
// Acepta: hoy, mañana, pasado mañana, un día de la semana (jueves, viernes...),
// "DD/MM", "DD-MM", "DD de julio". Devuelve null si no lo entiende.
export function resolveAgendaDay(rest) {
  let w = (rest || '').trim().toLowerCase().replace(/^(el|del|para el)\s+/, '');
  if (!w || w === 'hoy') return madridDateParts(0);
  if (w === 'mañana' || w === 'manana') return madridDateParts(1);
  if (w === 'pasado' || w === 'pasado mañana' || w === 'pasado manana') return madridDateParts(2);

  // Día de la semana → la próxima vez que ocurra (incluye hoy)
  if (DAY_NAMES[w] !== undefined) {
    const target = DAY_NAMES[w];
    for (let off = 0; off <= 6; off++) {
      const p = madridDateParts(off);
      const dow = new Date(Date.UTC(p.y, p.m - 1, p.d, 12)).getUTCDay();
      if (dow === target) return p;
    }
  }

  // DD/MM o DD-MM (con año opcional)
  let m = w.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
  if (m) {
    let y = m[3] ? +m[3] : madridDateParts(0).y;
    if (String(y).length === 2) y += 2000;
    return { y, m: +m[2], d: +m[1] };
  }

  // "DD de mes"
  m = w.match(/^(\d{1,2})\s+de\s+([a-záéíóú]+)$/);
  if (m) {
    const mo = MONTHS_ES.indexOf(m[2]) + 1;
    if (mo > 0) return { y: madridDateParts(0).y, m: mo, d: +m[1] };
  }
  return null;
}

const DAY_NAMES = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, miércoles: 3, jueves: 4, viernes: 5, sabado: 6, sábado: 6 };

export function parseSimpleAdd(text) {
  // "agrega: TITULO | CUANDO | CALENDARIO(opcional)"
  const body = text.replace(/^agrega:?\s*/i, '');
  const parts = body.split('|').map((s) => s.trim());
  if (parts.length < 2) return null;
  const [summary, when, calRaw] = parts;
  const calKey = normalizeCal(calRaw);
  const parsed = parseWhen(when);
  if (!summary || !parsed) return null;
  return { summary, calKey, ...parsed };
}

function normalizeCal(raw) {
  const r = (raw || '').toLowerCase();
  if (r.includes('mentor') || r.includes('llamada')) return 'mentoria';
  if (r.includes('personal')) return 'personal';
  if (r.includes('viaje')) return 'viajes';
  return 'actividades';
}

function parseWhen(when) {
  const w = when.toLowerCase().trim();
  const now = madridDateParts(0);

  // "2026-08-04 09:30" o "2026-08-04"
  let m = w.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (m) {
    return build(+m[1], +m[2], +m[3], m[4], m[5]);
  }

  // "hoy 21:00" / "mañana 14:30" / "hoy" / "mañana"
  m = w.match(/^(hoy|mañana|manana)(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (m) {
    const off = m[1] === 'hoy' ? 0 : 1;
    const p = madridDateParts(off);
    return build(p.y, p.m, p.d, m[2], m[3]);
  }

  // "martes 21:00" → el próximo martes
  m = w.match(/^([a-záéíóú]+)(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (m && DAY_NAMES[m[1]] !== undefined) {
    const target = DAY_NAMES[m[1]];
    for (let off = 1; off <= 7; off++) {
      const p = madridDateParts(off);
      const dow = new Date(Date.UTC(p.y, p.m - 1, p.d, 12)).getUTCDay();
      if (dow === target) return build(p.y, p.m, p.d, m[2], m[3]);
    }
  }
  return null;
}

function build(y, m, d, hh, mm) {
  if (hh === undefined || hh === null) return { y, m, d, allDay: true };
  return { y, m, d, hh: +hh, mm: +mm, allDay: false };
}

// IA opcional para lenguaje natural ("agrega una cena con el equipo el jueves a las 9 de la noche en personal")
export async function parseWithAI(text) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const today = madridDateParts(0);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 300,
      system: `Extrae del mensaje un evento de calendario. Hoy es ${today.y}-${today.m}-${today.d} (zona Europe/Madrid). Responde SOLO JSON: {"summary":"...","y":2026,"m":7,"d":21,"hh":21,"mm":0,"allDay":false,"calKey":"actividades|mentoria|personal|viajes","durMin":60}. Si no hay hora, allDay:true y omite hh/mm.`,
      messages: [{ role: 'user', content: text }],
    }),
  });
  const data = await res.json();
  try {
    const txt = data.content?.[0]?.text || '';
    return JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
  } catch {
    return null;
  }
}

export async function handleCommand(text) {
  const t = text.trim().toLowerCase();

  if (t === 'agenda hoy') return { reply: await morningBriefing() };
  if (t === 'agenda mañana' || t === 'agenda manana') return { reply: await nightBriefing() };

  // "agenda <día>": cualquier otro día (viernes, pasado mañana, 25/07, etc.)
  if (/^agenda\b/i.test(t)) {
    const rest = text.trim().replace(/^agenda\s*/i, '');
    const dp = resolveAgendaDay(rest);
    if (dp) return { reply: await dayAgendaForDate(dp.y, dp.m, dp.d) };
    return {
      reply:
        'Dime qué día 🗓️. Ejemplos: *agenda hoy*, *agenda mañana*, *agenda pasado mañana*, *agenda viernes*, *agenda 25/07*.',
    };
  }

  if (/^agrega/i.test(text)) {
    let parsed = parseSimpleAdd(text);
    if (!parsed) parsed = await parseWithAI(text);
    if (!parsed) {
      return {
        reply: 'No entendí el evento 🤔. Formato: "agrega: Cena con socios | martes 21:00 | personal"',
      };
    }
    const ev = await createEvent(parsed);
    const cal = CALENDARS[parsed.calKey || 'actividades'];
    return {
      reply: `✅ Agregado a ${cal.label}: *${parsed.summary}* — ${parsed.allDay ? 'todo el día' : `${parsed.d}/${parsed.m} ${String(parsed.hh).padStart(2, '0')}:${String(parsed.mm).padStart(2, '0')}`}`,
    };
  }

  return null; // no es un comando conocido
}

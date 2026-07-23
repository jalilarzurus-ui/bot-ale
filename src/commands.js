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
import { createEvent, madridDateParts, madridToUtc, CALENDARS, TZ } from './calendar.js';
import { morningBriefing, nightBriefing, dayAgendaForDate, rangeAgenda } from './briefing.js';
import { addReminder } from './reminders.js';

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

const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

// Resuelve una consulta de PERIODO (semana, mes, un mes concreto) a un rango de fechas.
// Devuelve { from:{y,m,d}, to:{y,m,d}, label } o null.
export function resolveAgendaRange(rest) {
  let w = (rest || '').trim().toLowerCase().replace(/^(de|del|la|el|para|para el)\s+/, '').trim();
  const today = madridDateParts(0);
  const isNext = /(que viene|pr[oó]xim|siguiente)/.test(w);

  // Semana (lunes a domingo)
  if (/semana/.test(w)) {
    const dow = new Date(Date.UTC(today.y, today.m - 1, today.d, 12)).getUTCDay(); // 0=domingo
    const isoDow = dow === 0 ? 7 : dow; // 1=lunes..7=domingo
    const toMonday = -(isoDow - 1);
    const base = isNext ? toMonday + 7 : toMonday;
    return {
      from: madridDateParts(base),
      to: madridDateParts(base + 6),
      label: isNext ? 'la próxima semana' : 'esta semana',
    };
  }

  // Mes (este mes / mes que viene)
  if (/\bmes\b/.test(w)) {
    let mo = today.m, yr = today.y;
    if (isNext) { mo += 1; if (mo > 12) { mo = 1; yr += 1; } }
    return {
      from: { y: yr, m: mo, d: 1 },
      to: { y: yr, m: mo, d: lastDayOfMonth(yr, mo) },
      label: `${isNext ? 'el mes que viene' : 'este mes'} (${MONTHS_ES[mo - 1]})`,
    };
  }

  // Nombre de mes: "agosto", "septiembre"...
  const moIdx = MONTHS_ES.indexOf(w);
  if (moIdx >= 0) {
    const mo = moIdx + 1;
    const yr = mo < today.m ? today.y + 1 : today.y; // si ya pasó este año, el que viene
    return {
      from: { y: yr, m: mo, d: 1 },
      to: { y: yr, m: mo, d: lastDayOfMonth(yr, mo) },
      label: `${MONTHS_ES[mo - 1]} ${yr}`,
    };
  }

  return null;
}

const DAY_NAMES = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, miércoles: 3, jueves: 4, viernes: 5, sabado: 6, sábado: 6 };

// Palabras con las que Jalil puede pedir crear un evento
const ADD_TRIGGER = /^(agrega|anota|apunta|añade|ag[eé]ndame|agendame|crea|pon)\b/i;

export function parseSimpleAdd(text) {
  // "agrega: TITULO | CUANDO | CALENDARIO(opcional)"
  const body = text.replace(/^(agrega|anota|apunta|añade|ag[eé]ndame|agendame|crea|pon)\s*:?\s*/i, '');
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
// La IA extrae los datos del evento, pero NO calcula la fecha (los modelos rápidos
// fallan con fechas relativas). Devuelve la PALABRA del día ("dayText") y nuestro
// código la convierte en fecha exacta de forma determinista (resolveAgendaDay).
export async function parseWithAI(text) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
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
      system:
        'Extrae un evento de calendario del mensaje (en español). Responde SOLO con JSON, sin texto extra:\n' +
        '{"summary":"...","dayText":"...","hh":21,"mm":0,"allDay":false,"calKey":"actividades|mentoria|personal|viajes","durMin":60}\n' +
        '- summary: título corto y claro del evento.\n' +
        '- dayText: SOLO la parte del día, tal cual se dice, SIN calcular fechas. Ejemplos válidos: "hoy", "mañana", "pasado mañana", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo", "25/07", "4 de agosto". Si no se menciona día, usa "hoy".\n' +
        '- hh, mm: hora en formato 24h. Si NO hay hora, pon "allDay":true y omite hh/mm.\n' +
        '- calKey: el calendario más adecuado (mentoria = llamadas/mentorías; viajes = vuelos/viajes; personal = personal; actividades = el resto).\n' +
        '- durMin: duración en minutos (por defecto 60).',
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

// Asistente de IA de propósito general (redactar, resumir, traducir, responder).
export async function askAI(prompt) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      system:
        'Eres el asistente personal de Jalil, que gestiona la agenda y las tareas de su jefe (Ale). ' +
        'Ayuda con lo que te pida: redactar mensajes o correos (da el texto final, listo para copiar), ' +
        'resumir textos largos, traducir (español, inglés, árabe) y responder preguntas. ' +
        'Sé claro, útil y conciso: es por WhatsApp. Responde en el idioma de la petición. ' +
        'Da directamente el resultado, sin explicar tu razonamiento ni añadir preámbulos.',
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json();
  return data.content?.[0]?.text?.trim() || null;
}

// La IA extrae el recordatorio (qué + cuándo). El código calcula la hora exacta.
export async function parseReminderAI(text) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 200,
      system:
        'Extrae un recordatorio del mensaje (en español). Responde SOLO con JSON, sin texto extra:\n' +
        '{"what":"...","dayText":"...","hh":10,"mm":0,"inMinutes":null}\n' +
        '- what: qué hay que recordar, corto y claro.\n' +
        '- Si dice "en X minutos/horas" (ej: "en 30 minutos", "en 2 horas"), pon inMinutes con el total de minutos (2 horas = 120) y deja dayText, hh y mm en null.\n' +
        '- Si dice un día u hora, pon inMinutes en null, y rellena dayText SOLO con la palabra del día ("hoy","mañana","pasado mañana","lunes"..."domingo","25/07","4 de agosto") — NO calcules la fecha — y hh, mm en formato 24h. Si no se dice hora, usa hh:9, mm:0.',
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

export async function handleCommand(text, from) {
  const t = text.trim().toLowerCase();

  // "recuérdame ...": crear un recordatorio que avisa a la hora indicada
  if (/^(recu[eé]rdame|recu[eé]rda|recordar|recordatorio)\b/i.test(t)) {
    const r = await parseReminderAI(text);
    if (!r || !r.what) {
      return {
        reply:
          'No entendí el recordatorio 🤔. Ejemplos: "recuérdame llamar al proveedor mañana a las 10" o "recuérdame en 30 minutos revisar el correo".',
      };
    }
    let dueTs;
    if (r.inMinutes) {
      dueTs = Date.now() + Number(r.inMinutes) * 60000;
    } else {
      const dp = resolveAgendaDay(r.dayText || 'hoy');
      if (!dp) return { reply: 'No entendí el cuándo 🤔. Prueba "mañana a las 10" o "en 2 horas".' };
      dueTs = madridToUtc(dp.y, dp.m, dp.d, r.hh ?? 9, r.mm ?? 0).getTime();
    }
    if (dueTs < Date.now() - 60000) {
      return { reply: '⏰ Esa hora ya pasó. Dime una hora futura (ej: "mañana a las 10" o "en 2 horas").' };
    }
    addReminder({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      chatId: from,
      text: r.what,
      dueTs,
    });
    const cuando = new Date(dueTs).toLocaleString('es-ES', {
      timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
    });
    return { reply: `⏰ Hecho, te lo recuerdo: *${r.what}*\n🗓️ ${cuando}` };
  }

  // "ia ...": asistente de IA (redactar, resumir, traducir, preguntar)
  if (/^(ia|pregunta|claude)\b/i.test(t)) {
    const prompt = text.trim().replace(/^(ia|pregunta|claude)\s*:?\s*/i, '');
    if (!prompt) {
      return {
        reply:
          'Dime qué necesitas después de *ia*. Ejemplos:\n• *ia redáctame un correo al socio moviendo la reunión al viernes*\n• *ia resume esto: [pega el texto]*\n• *ia traduce al inglés: buenos días, ¿nos vemos a las 5?*',
      };
    }
    const ans = await askAI(prompt);
    return { reply: ans || '⚠️ No pude generar la respuesta ahora mismo. Reinténtalo en un momento.' };
  }

  if (t === 'agenda hoy') return { reply: await morningBriefing() };
  if (t === 'agenda mañana' || t === 'agenda manana') return { reply: await nightBriefing() };

  // "agenda <cuándo>": día suelto o periodo (semana, mes, un mes concreto...)
  if (/^agenda\b/i.test(t)) {
    const rest = text.trim().replace(/^agenda\s*/i, '');
    const range = resolveAgendaRange(rest);
    if (range) return { reply: await rangeAgenda(range.from, range.to, range.label) };
    const dp = resolveAgendaDay(rest);
    if (dp) return { reply: await dayAgendaForDate(dp.y, dp.m, dp.d) };
    return {
      reply:
        'Dime cuándo 🗓️. Ejemplos: *agenda hoy*, *agenda viernes*, *agenda pasado mañana*, *agenda 25/07*, *agenda esta semana*, *agenda próxima semana*, *agenda agosto*.',
    };
  }

  if (ADD_TRIGGER.test(t)) {
    // 1) Formato estructurado con barras: "agrega: Título | jueves 21:00 | personal"
    let parsed = parseSimpleAdd(text);
    // 2) Lenguaje natural con IA: la IA saca los datos, el código calcula la fecha.
    if (!parsed) {
      const ai = await parseWithAI(text);
      if (ai && ai.summary) {
        const dp = resolveAgendaDay(ai.dayText || 'hoy');
        if (dp) {
          const sinHora = ai.allDay || ai.hh === undefined || ai.hh === null;
          parsed = {
            summary: ai.summary,
            calKey: normalizeCal(ai.calKey),
            y: dp.y, m: dp.m, d: dp.d,
            hh: ai.hh, mm: ai.mm ?? 0,
            allDay: sinHora,
            durMin: ai.durMin || 60,
          };
        }
      }
    }
    if (!parsed) {
      return {
        reply:
          'No entendí el evento 🤔. Prueba en natural ("anota comida con el inversor el jueves 9pm personal") o con formato ("agrega: Cena | jueves 21:00 | personal").',
      };
    }
    try {
      await createEvent(parsed);
    } catch (e) {
      return {
        reply: `⚠️ Entendí *${parsed.summary}* pero no pude crearlo: ${e?.errors?.[0]?.message || e.message}`,
      };
    }
    const cal = CALENDARS[parsed.calKey || 'actividades'];
    return {
      reply: `✅ Agregado a ${cal.label}: *${parsed.summary}* — ${parsed.allDay ? 'todo el día' : `${parsed.d}/${parsed.m} ${String(parsed.hh).padStart(2, '0')}:${String(parsed.mm).padStart(2, '0')}`}`,
    };
  }

  return null; // no es un comando conocido
}

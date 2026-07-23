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
import { createEvent, deleteEvent, moveEvent, eventsForDateParts, eventsForRange, overlappingEvents, madridDateParts, madridToUtc, CALENDARS, TZ } from './calendar.js';
import { morningBriefing, nightBriefing, dayAgendaForDate, rangeAgenda, weeklyBriefing, nextUp } from './briefing.js';
import { addReminder, nextOccurrence, describeRepeat, listReminders, removeReminder, getLastFired } from './reminders.js';
import { getWeather } from './weather.js';
import { getCity, setCity, getAlertsOn, setAlertsOn, getAlertLead, setAlertLead } from './settings.js';
import { setPending } from './confirm.js';
import { anthropic, jsonOf, textOf, AI_DOWN, MODEL_FAST, MODEL_SMART } from './ai.js';

// Mensaje cuando la IA está caída/saturada (para no parecer "tonto" ni quedarse mudo).
const SATURADO = '⚠️ Mi cerebro (IA) está saturado un segundo. Reinténtalo en unos instantes, por favor 🙏';

const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// Resuelve el "cuándo" de una consulta de agenda a una fecha concreta {y, m, d}.
// Acepta: hoy, mañana, pasado mañana, un día de la semana (jueves, viernes...),
// "DD/MM", "DD-MM", "DD de julio". Devuelve null si no lo entiende.
export function resolveAgendaDay(rest) {
  let w = (rest || '').trim().toLowerCase();
  // Quitar prefijos de relleno ("el", "este", "próximo", "para el"...), hasta dos veces
  // para casos como "el próximo lunes" o "para el día 5".
  const STRIP = /^(este|esta|el|la|del|de|para|proximo|próximo|proxima|próxima)\s+/;
  w = w.replace(STRIP, '').replace(STRIP, '').trim();

  if (!w || w === 'hoy') return madridDateParts(0);
  if (w === 'mañana' || w === 'manana') return madridDateParts(1);
  if (/^pasado( ma[ñn]ana)?$/.test(w)) return madridDateParts(2);

  // "en N días" / "dentro de N días"
  let m = w.match(/^(?:en|dentro de)\s+(\d{1,3})\s+d[ií]as?$/);
  if (m) return madridDateParts(Math.min(365, +m[1]));

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
  m = w.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
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

  // "día N" o un número suelto (1-31) → ese día de este mes; si ya pasó, el mes que viene
  m = w.match(/^(?:d[ií]a\s+)?(\d{1,2})$/);
  if (m) {
    const d = +m[1];
    if (d >= 1 && d <= 31) {
      const t = madridDateParts(0);
      let y = t.y, mo = t.m;
      if (d < t.d) { mo += 1; if (mo > 12) { mo = 1; y += 1; } }
      return { y, m: mo, d: Math.min(d, lastDayOfMonth(y, mo)) };
    }
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
  const r = await anthropic({
    model: MODEL_FAST,
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
  });
  if (r.down) return AI_DOWN;
  if (!r.ok) return null;
  return jsonOf(r.data);
}

// Asistente de IA de propósito general (redactar, resumir, traducir, responder).
export async function askAI(prompt) {
  const r = await anthropic({
    model: MODEL_SMART,
    max_tokens: 1024,
    system:
      'Eres el asistente personal de Jalil, que gestiona la agenda y las tareas de su jefe (Ale). ' +
      'Ayuda con lo que te pida: redactar mensajes o correos (da el texto final, listo para copiar), ' +
      'resumir textos largos, traducir (español, inglés, árabe) y responder preguntas. ' +
      'Sé claro, útil y conciso: es por WhatsApp. Responde en el idioma de la petición. ' +
      'Da directamente el resultado, sin explicar tu razonamiento ni añadir preámbulos.',
    messages: [{ role: 'user', content: prompt }],
  });
  if (!r.ok) return null;
  return textOf(r.data) || null;
}

// La IA extrae el recordatorio (qué + cuándo). El código calcula la hora exacta.
export async function parseReminderAI(text) {
  const r = await anthropic({
    model: MODEL_FAST,
    max_tokens: 220,
    system:
      'Extrae un recordatorio del mensaje (en español). Responde SOLO con JSON, sin texto extra:\n' +
      '{"what":"...","dayText":"...","hh":10,"mm":0,"inMinutes":null,"repeat":null,"dow":null,"dom":null}\n' +
      '- what: qué hay que recordar, corto y claro.\n' +
      '- repeat: null si es una sola vez. "diario" si dice "cada día"/"todos los días". "semanal" si dice "cada lunes"/"todos los martes"... "mensual" si dice "cada día X del mes"/"el X de cada mes"/"todos los meses el X".\n' +
      '- dow: SOLO para "semanal", el día como número (0=domingo,1=lunes,2=martes,3=miércoles,4=jueves,5=viernes,6=sábado).\n' +
      '- dom: SOLO para "mensual", el número de día del mes (1-31).\n' +
      '- hh, mm: hora del aviso en 24h (si no se dice, hh:9, mm:0). En recurrentes, dayText puede ir null.\n' +
      '- Si dice "en X minutos/horas" (una sola vez), pon inMinutes con el total de minutos (2 horas = 120) y el resto null.\n' +
      '- Si es una sola vez con día concreto, rellena dayText con la palabra del día ("hoy","mañana","lunes"..."domingo","25/07","4 de agosto") — NO calcules la fecha.',
    messages: [{ role: 'user', content: text }],
  });
  if (r.down) return AI_DOWN;
  if (!r.ok) return null;
  return jsonOf(r.data);
}

// Normaliza texto (minúsculas, sin acentos) para comparar títulos de eventos
function norm(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function fmtEventLine(it) {
  const dt = it.ev.start?.dateTime;
  const hora = dt
    ? new Date(dt).toLocaleTimeString('es-ES', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })
    : 'todo el día';
  return `${it.ev.summary} (${hora})`;
}

// Línea de evento con fecha completa (para búsquedas: no sabes el día)
function fmtEventFull(it) {
  const dt = it.ev.start?.dateTime;
  const cuando = dt
    ? new Date(dt).toLocaleString('es-ES', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
    : new Date(`${it.ev.start?.date}T00:00:00`).toLocaleDateString('es-ES', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }) + ' (todo el día)';
  const cal = CALENDARS[it.calKey];
  return `${cal?.emoji ? cal.emoji + ' ' : ''}*${it.ev.summary}* — ${cuando}${cal ? ` (${cal.label})` : ''}`;
}

// Menú de ayuda: qué sabe hacer el bot (lenguaje natural, no hace falta memorizar)
function helpMenu() {
  return [
    '🤖 *Esto es lo que puedo hacer* (háblame natural, no hace falta memorizar):',
    '',
    '🗓️ *Agenda*',
    '• "agenda hoy" · "agenda mañana" · "agenda viernes" · "agenda esta semana"',
    '• "resumen semana" — la semana que viene de un vistazo',
    '• "qué sigue" — lo próximo en tu agenda',
    '• "¿cuándo es el vuelo?" — busco un evento aunque no sepas el día',
    '',
    '➕ *Crear y cambiar eventos*',
    '• "agenda comida con el inversor el jueves a las 2"',
    '• "mueve la reunión del viernes a las 5" · "cancela la comida del jueves"',
    '  (antes de borrar o mover te pido confirmación; y aviso si hay choque de horario)',
    '',
    '⏰ *Recordatorios*',
    '• "recuérdame llamar al proveedor mañana a las 10" · "...en 30 min"',
    '• "recuérdame cada lunes a las 9 repartir bonos" (recurrentes 🔁)',
    '• "mis recordatorios" · "cancela recordatorio 2" · "pospón 1 hora"',
    '• Te aviso solo ~30 min antes de cada evento ("avisos 15", "avisos off")',
    '',
    '🌦️ *Extras*',
    '• "clima" · "ciudad Dubái" · "ia redáctame un correo..." (redactar/traducir/resumir)',
    '• Puedes mandarme *notas de voz* y te confirmo qué entendí 🎤',
  ].join('\n');
}

// Interpreta un retraso en minutos de frases como "1 hora", "30 min", "media hora",
// "un cuarto de hora", "2h", o un número suelto (= minutos). Devuelve null si no hay nada.
function parseDelayMin(s) {
  const w = (s || '').toLowerCase();
  if (/media\s+hora/.test(w)) return 30;
  if (/(un\s+)?cuarto(\s+de\s+hora)?/.test(w)) return 15;
  let total = 0, found = false;
  const h = w.match(/(\d+)\s*(?:h|horas?)\b/);
  if (h) { total += Number(h[1]) * 60; found = true; }
  const m = w.match(/(\d+)\s*(?:m|min|minutos?)\b/);
  if (m) { total += Number(m[1]); found = true; }
  if (!found && /\b(una|1)\s+horas?\b/.test(w)) { total = 60; found = true; }
  if (!found) {
    const n = w.match(/(\d+)/); // número suelto → minutos
    if (n) { total = Number(n[1]); found = true; }
  }
  return found ? Math.min(total, 24 * 60) : null;
}

// Busca eventos por palabra clave en una ventana de días (por defecto ~3 meses)
export async function searchEvents(keyword, days = 92) {
  const k = norm(keyword).trim();
  if (!k) return [];
  const events = await eventsForRange(madridDateParts(0), madridDateParts(days));
  return events.filter((it) => norm(it.ev.summary).includes(k));
}

// La IA extrae la intención de gestionar un evento (cancelar o mover).
export async function parseManageAI(text) {
  const r = await anthropic({
    model: MODEL_FAST,
    max_tokens: 200,
    system:
      'El usuario quiere CANCELAR o MOVER un evento de su calendario. Responde SOLO con JSON:\n' +
      '{"action":"cancel","keyword":"...","dayText":"...","newDayText":null,"newHh":null,"newMm":null}\n' +
      '- action: "cancel" si dice cancelar/borrar/eliminar/quitar/anular; "move" si dice mover/cambiar/reprogramar.\n' +
      '- keyword: palabra(s) clave para encontrar el evento (ej: "comida", "reunión con Juan").\n' +
      '- dayText: el día ACTUAL del evento (hoy/mañana/pasado mañana/lunes..domingo/25-07/4 de agosto), SIN calcular fecha. Si no se dice, "hoy".\n' +
      '- Solo para "move": newDayText (nuevo día si cambia, o null si es el mismo día) y newHh/newMm (nueva hora en 24h). Para "cancel", deja esos tres en null.',
    messages: [{ role: 'user', content: text }],
  });
  if (r.down) return AI_DOWN;
  if (!r.ok) return null;
  return jsonOf(r.data);
}

export async function handleCommand(text, from) {
  const t = text.trim().toLowerCase();
  // Versión sin acentos: evita el fallo de \b tras vocal acentuada al final ("menú", "qué").
  const tn = t.normalize('NFD').replace(/[̀-ͯ]/g, '');

  // Gestión de recordatorios: LISTAR ("mis recordatorios") y CANCELAR ("cancela recordatorio 2").
  // Va antes que la gestión de eventos para que "cancela recordatorio ..." no se tome por un evento.
  {
    const mencionaRec = /recordatorios?\b/i.test(t);
    const esCancelRec = /^(cancela|borra|elimina|quita|anula|olvida)\b/i.test(t) && mencionaRec;
    const esListarRec = /^(mis|ver|lista|listar|cu[aá]les|qu[eé])\b.*recordatorios?\b/i.test(t) || /^recordatorios\b/i.test(t);

    if (esCancelRec) {
      const rs = listReminders(from);
      if (!rs.length) return { reply: '📭 No tienes recordatorios pendientes.' };
      // Por número: "cancela recordatorio 2"
      const numMatch = t.match(/\b(\d{1,2})\b/);
      let target = null;
      if (numMatch) {
        const idx = Number(numMatch[1]) - 1;
        if (idx < 0 || idx >= rs.length) {
          return { reply: `Solo tienes ${rs.length} recordatorio(s). Escribe "mis recordatorios" para ver la lista con sus números.` };
        }
        target = rs[idx];
      } else {
        // Por palabra clave: quitar mando y palabras vacías, buscar en el texto
        const kw = norm(text)
          .replace(/^(cancela|borra|elimina|quita|anula|olvida)\s+/, '')
          .replace(/\b(el|la|los|las|mi|mis|de|del|un|una|numero|num|no|n|recordatorio|recordatorios)\b/g, ' ')
          .replace(/\s+/g, ' ').trim();
        if (!kw) {
          return { reply: '¿Cuál recordatorio borro? Dime el número (ej: "cancela recordatorio 2") o una palabra de su texto. Escribe "mis recordatorios" para verlos.' };
        }
        const hits = rs.filter((r) => norm(r.text).includes(kw));
        if (!hits.length) return { reply: `No encontré ningún recordatorio con "${kw}". Escribe "mis recordatorios" para ver la lista.` };
        if (hits.length > 1) {
          return { reply: `Hay varios con "${kw}":\n${hits.map((r) => '• ' + r.text).join('\n')}\nDime el número (mira "mis recordatorios").` };
        }
        target = hits[0];
      }
      removeReminder(target.id);
      return { reply: `🗑️ Recordatorio borrado: *${target.text}*${target.repeat ? ' 🔁' : ''}` };
    }

    if (esListarRec) {
      const rs = listReminders(from);
      if (!rs.length) return { reply: '📭 No tienes recordatorios pendientes.\nCrea uno con "recuérdame llamar al proveedor mañana a las 10".' };
      const lines = rs.map((r, i) => {
        const cuando = new Date(r.dueTs).toLocaleString('es-ES', {
          timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
        });
        return `${i + 1}. *${r.text}* → ${cuando}${r.repeat ? ' 🔁 (' + describeRepeat(r.repeat) + ')' : ''}`;
      });
      return { reply: `📋 Tus recordatorios (${rs.length}):\n${lines.join('\n')}\n\nPara borrar uno: "cancela recordatorio 2".` };
    }
  }

  // POSPONER el último recordatorio que sonó: "pospón 1 hora", "recuérdamelo en 30 min", "más tarde".
  if (/^(pospon|pospón|posponer|recu[eé]rdamelo|m[aá]s tarde|luego)\b/i.test(t)) {
    const last = getLastFired(from);
    if (!last) {
      return { reply: 'No tengo ningún recordatorio reciente que posponer 🤔. Crea uno con "recuérdame ..." o dime "recuérdame X en 30 min".' };
    }
    const min = parseDelayMin(t) ?? 15;
    const dueTs = Date.now() + min * 60000;
    addReminder({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, chatId: from, text: last, dueTs });
    const cuando = new Date(dueTs).toLocaleTimeString('es-ES', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
    const cuanto = min >= 60 && min % 60 === 0 ? `${min / 60} h` : `${min} min`;
    return { reply: `⏰ Vale, te lo recuerdo otra vez en *${cuanto}*: *${last}* (a las ${cuando}).` };
  }

  // BUSCAR eventos por palabra clave ("¿cuándo es el vuelo?", "busca la reunión con Juan").
  // No calcula fecha: escanea los próximos ~3 meses. Va antes que crear/gestionar.
  {
    const clean = text.trim().replace(/^[¿¡\s]+/, '');
    const mBusca = clean.match(/^(?:b[uú]sca(?:me)?|encuentra|encu[eé]ntrame)\s+(.+)/i);
    const mCuando = clean.match(/^cu[aá]ndo\s+(?:es|era|ser[aá]|tengo|ten[ií]a|hay|me toca|toca)?\s*(.+?)[?!.]*$/i);
    const kwRaw = (mBusca && mBusca[1]) || (mCuando && mCuando[1]);
    if (kwRaw) {
      const keyword = kwRaw.trim()
        .replace(/[?¿!.]+$/, '')
        .replace(/^(el|la|los|las|mi|mis|un|una|de|del)\s+/i, '')
        .trim();
      if (keyword.length >= 3 && !/^recordatori/i.test(keyword)) {
        const hits = await searchEvents(keyword);
        if (hits.length) {
          const lines = hits.slice(0, 12).map((it) => '• ' + fmtEventFull(it));
          const extra = hits.length > 12 ? `\n… y ${hits.length - 12} más.` : '';
          const cab = hits.length === 1 ? '🔍 Encontré esto:' : `🔍 Encontré ${hits.length} coincidencias:`;
          return { reply: `${cab}\n${lines.join('\n')}${extra}` };
        }
        // Sin resultados: si fue búsqueda EXPLÍCITA ("busca..."), lo decimos;
        // si fue una pregunta "cuándo...", dejamos que responda la IA (no secuestramos la charla).
        if (mBusca) return { reply: `🔍 No encontré ningún evento con "*${keyword}*" en los próximos ~3 meses.` };
      }
    }
  }

  // "cancela/mueve ..." : gestionar un evento existente (cancelar o mover)
  if (/^(cancela|borra|elimina|quita|anula|mueve|reprograma|cambia)\b/i.test(t)) {
    const p = await parseManageAI(text);
    if (p === AI_DOWN) return { reply: SATURADO };
    if (!p || !p.keyword) {
      return {
        reply: 'Dime qué evento y de qué día 🗓️. Ej: "cancela la comida del jueves" o "mueve la reunión del viernes a las 5".',
      };
    }
    const dp = resolveAgendaDay(p.dayText || 'hoy');
    if (!dp) return { reply: 'No entendí el día del evento 🤔.' };
    const { events } = await eventsForDateParts(dp.y, dp.m, dp.d);
    const k = norm(p.keyword);
    const matches = events.filter((it) => norm(it.ev.summary).includes(k));
    if (matches.length === 0) {
      return { reply: `No encontré ningún evento de "${p.keyword}" el ${dp.d}/${dp.m} 🤔.` };
    }
    if (matches.length > 1) {
      return {
        reply: `Encontré varios el ${dp.d}/${dp.m}:\n${matches.map((it) => '• ' + fmtEventLine(it)).join('\n')}\nSé más específico (nombre u hora) para elegir cuál.`,
      };
    }
    const it = matches[0];
    if (p.action === 'move') {
      const target = p.newDayText ? resolveAgendaDay(p.newDayText) : dp;
      if (!target) return { reply: 'No entendí el nuevo día 🤔.' };
      if (p.newHh === undefined || p.newHh === null) return { reply: '¿A qué hora lo muevo? Ej: "a las 5".' };
      let durMin = 60;
      if (it.ev.start?.dateTime && it.ev.end?.dateTime) {
        durMin = Math.max(15, Math.round((new Date(it.ev.end.dateTime) - new Date(it.ev.start.dateTime)) / 60000));
      }
      const nuevaHora = `${String(p.newHh).padStart(2, '0')}:${String(p.newMm ?? 0).padStart(2, '0')}`;
      // ¿La nueva hora choca con otra cosa? (ignorando el propio evento que movemos)
      const clashes = await overlappingEvents(target.y, target.m, target.d, p.newHh, p.newMm ?? 0, durMin, it.ev.id).catch(() => []);
      // No movemos de golpe: pedimos confirmación.
      setPending(from, {
        describe: `mover "${it.ev.summary}"`,
        exec: async () => {
          try {
            await moveEvent(it.calKey, it.ev.id, target.y, target.m, target.d, p.newHh, p.newMm ?? 0, durMin);
          } catch (e) {
            return `⚠️ No pude moverlo: ${e?.errors?.[0]?.message || e.message}`;
          }
          return `📅 Movido: *${it.ev.summary}* → ${target.d}/${target.m} ${nuevaHora} (${CALENDARS[it.calKey].label})`;
        },
      });
      const aviso = clashes.length
        ? `\n⚠️ Ojo: a esa hora ya tienes *${clashes.map((c) => `${c.summary} (${c.hora})`).join(', ')}*.`
        : '';
      return {
        reply: `¿Muevo *${it.ev.summary}* a *${target.d}/${target.m} a las ${nuevaHora}*? (${CALENDARS[it.calKey].label})${aviso}\nResponde *sí* para confirmar o *no* para dejarlo.`,
      };
    }
    // Cancelar: pedimos confirmación antes de borrar.
    setPending(from, {
      describe: `cancelar "${it.ev.summary}"`,
      exec: async () => {
        try {
          await deleteEvent(it.calKey, it.ev.id);
        } catch (e) {
          return `⚠️ No pude cancelarlo: ${e?.errors?.[0]?.message || e.message}`;
        }
        return `🗑️ Cancelado: *${it.ev.summary}* — ${dp.d}/${dp.m} (${CALENDARS[it.calKey].label})`;
      },
    });
    return {
      reply: `¿Seguro que cancelo *${it.ev.summary}* del *${dp.d}/${dp.m}*? (${CALENDARS[it.calKey].label})\nResponde *sí* para confirmar o *no* para dejarlo.`,
    };
  }

  // "ciudad ..." / "estamos en ...": fija la ciudad actual (para el clima del daily)
  if (/^(ciudad|estamos en|estoy en)\b/i.test(t)) {
    const city = text.trim().replace(/^(ciudad|estamos en|estoy en)\s*:?\s*/i, '').trim();
    if (!city) return { reply: `📍 Ciudad actual: *${getCity()}*.\nPara cambiarla: "ciudad Dubái".` };
    setCity(city);
    return { reply: `📍 Anotado, ahora estáis en *${city}*. El clima del daily usará esta ciudad.` };
  }

  // "clima" / "tiempo": clima actual de la ciudad fijada (o de la que indiques)
  if (/^(clima|tiempo|el tiempo)\b/i.test(t)) {
    const arg = text.trim().replace(/^(clima|tiempo|el tiempo)\s*(en|de)?\s*:?\s*/i, '').trim();
    const w = await getWeather(arg || getCity());
    if (!w) return { reply: 'No pude obtener el clima 🤔. Prueba con otra ciudad.' };
    return { reply: `${w.emoji} *${w.tempC}°C*, ${w.desc} en ${w.city}` };
  }

  // "recuérdame ...": crear un recordatorio que avisa a la hora indicada
  if (/^(recu[eé]rdame|recu[eé]rda|recordar|recordatorio)\b/i.test(t)) {
    const r = await parseReminderAI(text);
    if (r === AI_DOWN) return { reply: SATURADO };
    if (!r || !r.what) {
      return {
        reply:
          'No entendí el recordatorio 🤔. Ejemplos: "recuérdame llamar al proveedor mañana a las 10" o "recuérdame en 30 minutos revisar el correo".',
      };
    }
    // Recurrente ("cada día/lunes/5 del mes"): se reprograma solo tras cada aviso.
    const mapRepeat = { diario: 'daily', semanal: 'weekly', mensual: 'monthly' };
    if (r.repeat && mapRepeat[r.repeat]) {
      const repeat = {
        type: mapRepeat[r.repeat],
        hh: r.hh ?? 9,
        mm: r.mm ?? 0,
        ...(r.repeat === 'semanal' ? { dow: Number(r.dow) } : {}),
        ...(r.repeat === 'mensual' ? { dom: Number(r.dom) } : {}),
      };
      if (repeat.type === 'weekly' && !(repeat.dow >= 0 && repeat.dow <= 6)) {
        return { reply: 'No entendí qué día de la semana 🤔. Ej: "recuérdame cada lunes a las 9 repartir bonos".' };
      }
      if (repeat.type === 'monthly' && !(repeat.dom >= 1 && repeat.dom <= 31)) {
        return { reply: 'No entendí qué día del mes 🤔. Ej: "recuérdame el día 5 de cada mes a las 9 pagar la cuota".' };
      }
      const dueTs = nextOccurrence(repeat, Date.now());
      if (!dueTs) return { reply: 'No pude calcular la repetición 🤔. Prueba de nuevo con el día y la hora.' };
      addReminder({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        chatId: from,
        text: r.what,
        dueTs,
        repeat,
      });
      const prox = new Date(dueTs).toLocaleString('es-ES', {
        timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
      });
      return { reply: `🔁 Recordatorio recurrente activado: *${r.what}*\n📅 ${describeRepeat(repeat)}\n➡️ Próximo aviso: ${prox}` };
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

  // "qué sigue" / "lo siguiente" / "ahora" → el próximo evento desde ahora
  if (/^(que sigue|lo que sigue|lo siguiente|que viene|siguiente evento|proximo evento|que tengo ahora|que hay ahora)\b/.test(tn) || tn === 'siguiente' || tn === 'ahora') {
    return { reply: await nextUp() };
  }

  // "ayuda" / "menú" → qué sabe hacer el bot (útil ahora que Ale también lo usa)
  if (/^(ayuda|menu|comandos|help|que (puedes|sabes) hacer)\b/.test(tn) || tn === '?') {
    return { reply: helpMenu() };
  }

  // "resumen semana" / "resumen" / "semana que viene" → semana entera de un vistazo
  if (/^(resumen|semana que viene)\b/i.test(t) || t === 'semana') {
    return { reply: await weeklyBriefing() };
  }

  // "avisos" : controlar los avisos automáticos antes de cada evento
  if (/^avisos?\b/i.test(t)) {
    const rest = t.replace(/^avisos?\s*/i, '').trim();
    if (/^(off|no|desactiva|apaga|quita)/.test(rest)) {
      setAlertsOn(false);
      return { reply: '🔕 Avisos antes de eventos *desactivados*. Actívalos con "avisos on".' };
    }
    if (/^(on|si|sí|activa|enciende)/.test(rest)) {
      setAlertsOn(true);
      return { reply: `🔔 Avisos *activados*. Te aviso ${getAlertLead()} min antes de cada evento.` };
    }
    const num = rest.match(/(\d{1,3})/);
    if (num) {
      const min = Math.min(240, Math.max(1, Number(num[1])));
      setAlertLead(min);
      setAlertsOn(true);
      return { reply: `🔔 Hecho. Te avisaré *${min} min* antes de cada evento.` };
    }
    const estado = getAlertsOn() ? `activados (${getAlertLead()} min antes)` : 'desactivados';
    return { reply: `🔔 Avisos antes de eventos: *${estado}*.\nCambia con "avisos 15" (minutos), "avisos off" o "avisos on".` };
  }

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
      if (ai === AI_DOWN) return { reply: SATURADO };
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
    // Antes de crear, miramos si choca con algo ya agendado (solo si tiene hora).
    let clashes = [];
    if (!parsed.allDay) {
      clashes = await overlappingEvents(parsed.y, parsed.m, parsed.d, parsed.hh, parsed.mm, parsed.durMin).catch(() => []);
    }
    try {
      await createEvent(parsed);
    } catch (e) {
      return {
        reply: `⚠️ Entendí *${parsed.summary}* pero no pude crearlo: ${e?.errors?.[0]?.message || e.message}`,
      };
    }
    const cal = CALENDARS[parsed.calKey || 'actividades'];
    let reply = `✅ Agregado a ${cal.label}: *${parsed.summary}* — ${parsed.allDay ? 'todo el día' : `${parsed.d}/${parsed.m} ${String(parsed.hh).padStart(2, '0')}:${String(parsed.mm).padStart(2, '0')}`}`;
    if (clashes.length) {
      reply += `\n\n⚠️ *Ojo, se pisa con:* ${clashes.map((c) => `${c.summary} (${c.hora})`).join(', ')}. Si quieres lo movemos.`;
    }
    return { reply };
  }

  return null; // no es un comando conocido
}

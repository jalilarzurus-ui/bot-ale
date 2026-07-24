// Asistente conversacional con "manos": un agente de IA que además de conversar
// puede EJECUTAR acciones (crear/mover/cancelar eventos, poner recordatorios)
// mediante herramientas. Reutiliza la lógica determinista ya existente (las fechas
// las calcula el código, nunca la IA).
import {
  eventsForRange, eventsForDateParts, createEvent, deleteEvent, moveEvent, overlappingEvents, findDuplicate,
  recreateEvent, restoreEventTimes, madridDateParts, madridToUtc, TZ, CALENDARS,
} from './calendar.js';
import { setLastAction } from './undo.js';
import { addTask, listTasks, removeTask } from './tasks.js';
import { getCity } from './settings.js';
import { addReminder, listReminders, removeReminder, nextOccurrence, describeRepeat } from './reminders.js';
import { getWeather } from './weather.js';
import { resolveAgendaDay, resolveAgendaRange } from './commands.js';
import { setPending } from './confirm.js';
import { anthropic, MODEL_SMART } from './ai.js';

const histories = new Map(); // chatId -> [{ role, content }]
const MAX_TURNS = 10;

function remember(chatId, role, content) {
  const h = histories.get(chatId) || [];
  h.push({ role, content });
  while (h.length > MAX_TURNS) h.shift();
  histories.set(chatId, h);
}

function norm(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function validCal(k) {
  return ['actividades', 'mentoria', 'personal', 'viajes'].includes(k) ? k : 'actividades';
}

function fmtEventList(events) {
  if (!events.length) return 'Sin eventos.';
  return events
    .map((it) => {
      const dt = it.ev.start?.dateTime;
      const cuando = dt
        ? new Date(dt).toLocaleString('es-ES', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
        : '(todo el día)';
      return `- ${cuando}: ${it.ev.summary} [${CALENDARS[it.calKey].label}]`;
    })
    .join('\n');
}

async function upcomingSnapshot() {
  try {
    const events = await eventsForRange(madridDateParts(0), madridDateParts(8));
    return events.length ? fmtEventList(events) : 'No hay eventos en los próximos 8 días.';
  } catch {
    return '(no disponible ahora mismo)';
  }
}

// --------- Herramientas que el agente puede usar ---------
const TOOLS = [
  {
    name: 'crear_evento',
    description: 'Crea un evento nuevo en el calendario.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Título del evento' },
        dayText: { type: 'string', description: 'Día en palabras (hoy, mañana, pasado mañana, lunes..domingo, 25/07, 4 de agosto). NO calcules la fecha.' },
        hh: { type: 'integer', description: 'Hora en 24h. Omitir si es de todo el día.' },
        mm: { type: 'integer', description: 'Minutos (0 si no se dice).' },
        allDay: { type: 'boolean', description: 'true si es de todo el día (sin hora).' },
        calKey: { type: 'string', enum: ['actividades', 'mentoria', 'personal', 'viajes'], description: 'mentoria=llamadas/mentorías; viajes=vuelos/viajes; personal=personal; actividades=el resto.' },
        durMin: { type: 'integer', description: 'Duración en minutos (por defecto 60).' },
      },
      required: ['summary', 'dayText'],
    },
  },
  {
    name: 'mover_evento',
    description: 'Mueve un evento existente a otra fecha u hora.',
    input_schema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Palabra clave para encontrar el evento (ej: "comida", "reunión con Juan").' },
        dayText: { type: 'string', description: 'Día ACTUAL del evento, en palabras. NO calcules la fecha.' },
        newDayText: { type: 'string', description: 'Nuevo día si cambia (en palabras). Omitir si es el mismo día.' },
        newHh: { type: 'integer', description: 'Nueva hora en 24h.' },
        newMm: { type: 'integer', description: 'Nuevos minutos (0 si no se dice).' },
      },
      required: ['keyword', 'dayText', 'newHh'],
    },
  },
  {
    name: 'cancelar_evento',
    description: 'Cancela/borra un evento existente.',
    input_schema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Palabra clave para encontrar el evento.' },
        dayText: { type: 'string', description: 'Día del evento, en palabras. NO calcules la fecha.' },
      },
      required: ['keyword', 'dayText'],
    },
  },
  {
    name: 'poner_recordatorio',
    description: 'Pone un recordatorio que avisará a la persona a la hora indicada. Puede ser una sola vez o recurrente (cada día, cada X día de la semana, o cada X día del mes).',
    input_schema: {
      type: 'object',
      properties: {
        what: { type: 'string', description: 'Qué recordar.' },
        dayText: { type: 'string', description: 'Día en palabras (omitir si usas inMinutes o repeat).' },
        hh: { type: 'integer', description: 'Hora en 24h (por defecto 9 si no se dice).' },
        mm: { type: 'integer' },
        inMinutes: { type: 'integer', description: 'Minutos desde ahora, para "en X minutos/horas" (solo una vez).' },
        repeat: { type: 'string', enum: ['diario', 'semanal', 'mensual'], description: 'Solo si es recurrente: "diario"=cada día; "semanal"=cada X día de la semana (usa dow); "mensual"=cada X día del mes (usa dom).' },
        dow: { type: 'integer', description: 'Solo para repeat="semanal": día de la semana (0=domingo,1=lunes,2=martes,3=miércoles,4=jueves,5=viernes,6=sábado).' },
        dom: { type: 'integer', description: 'Solo para repeat="mensual": día del mes (1-31).' },
      },
      required: ['what'],
    },
  },
  {
    name: 'consultar_agenda',
    description: 'Consulta los eventos de un día o periodo concreto (útil para fechas fuera de los próximos 8 días).',
    input_schema: {
      type: 'object',
      properties: {
        cuando: { type: 'string', description: 'Ej: "25/07", "4 de agosto", "agosto", "semana que viene", "lunes".' },
      },
      required: ['cuando'],
    },
  },
  {
    name: 'buscar_evento',
    description: 'Busca un evento por palabra clave en los próximos ~3 meses, SIN saber el día. Úsalo para preguntas tipo "¿cuándo es el vuelo?", "¿cuándo tengo la reunión con Juan?".',
    input_schema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Palabra(s) clave del evento a buscar (ej: "vuelo", "reunión Juan").' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'ver_recordatorios',
    description: 'Lista los recordatorios pendientes del usuario.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'cancelar_recordatorio',
    description: 'Cancela un recordatorio pendiente que coincida con una palabra clave.',
    input_schema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Palabra clave del recordatorio a cancelar (ej: "llamada", "correo").' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'apuntar_pendiente',
    description: 'Apunta un PENDIENTE / tarea SIN hora concreta (algo que hay que hacer y el bot recordará cada día hasta marcarlo hecho). Úsalo para "tengo que...", "apúntame que...", cosas sin hora fija. Si tiene hora concreta, usa poner_recordatorio.',
    input_schema: {
      type: 'object',
      properties: { tarea: { type: 'string', description: 'Qué hay que hacer, corto y claro.' } },
      required: ['tarea'],
    },
  },
  {
    name: 'ver_pendientes',
    description: 'Lista los pendientes/tareas sin hora del usuario.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'completar_pendiente',
    description: 'Marca un pendiente como hecho (por palabra clave).',
    input_schema: {
      type: 'object',
      properties: { keyword: { type: 'string', description: 'Palabra clave del pendiente a dar por hecho.' } },
      required: ['keyword'],
    },
  },
  {
    name: 'consultar_clima',
    description: 'Consulta el clima actual de la ciudad actual o de una ciudad concreta.',
    input_schema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'Ciudad (omitir para usar la ciudad actual).' },
      },
    },
  },
];

// --------- Ejecución de cada herramienta (código determinista) ---------
async function executeTool(name, input, ctx) {
  try {
    if (name === 'crear_evento') {
      const dp = resolveAgendaDay(input.dayText || 'hoy');
      if (!dp) return 'No entendí el día. Pide una aclaración.';
      const allDay = input.allDay || input.hh === undefined || input.hh === null;
      const durMin = input.durMin || 60;
      // ¿Ya existe idéntico? No duplicar.
      const dup = await findDuplicate(input.summary, dp.y, dp.m, dp.d, input.hh, input.mm ?? 0, allDay).catch(() => null);
      if (dup) return `YA EXISTE ese evento ("${input.summary}") a esa hora. NO lo crees de nuevo; avísale al usuario de que ya lo tenía.`;
      // Mirar choques antes de crear (solo si tiene hora).
      const clashes = allDay ? [] : await overlappingEvents(dp.y, dp.m, dp.d, input.hh, input.mm ?? 0, durMin).catch(() => []);
      const calKeyC = validCal(input.calKey);
      const createdEv = await createEvent({
        calKey: calKeyC, summary: input.summary,
        y: dp.y, m: dp.m, d: dp.d, hh: input.hh, mm: input.mm ?? 0,
        durMin, allDay,
      });
      setLastAction(ctx.chatId, {
        describe: `crear "${input.summary}"`,
        undo: async () => {
          try { await deleteEvent(calKeyC, createdEv.id); }
          catch (e) { return `⚠️ No pude deshacer: ${e?.errors?.[0]?.message || e.message}`; }
          return `↩️ Deshecho: quité *${input.summary}*.`;
        },
      });
      const cuando = allDay ? `${dp.d}/${dp.m} (todo el día)` : `${dp.d}/${dp.m} a las ${String(input.hh).padStart(2, '0')}:${String(input.mm ?? 0).padStart(2, '0')}`;
      const aviso = clashes.length
        ? ` AVISA al usuario de que se solapa con: ${clashes.map((c) => `${c.summary} (${c.hora})`).join(', ')}.`
        : '';
      return `OK. Evento creado: "${input.summary}" el ${cuando} en ${CALENDARS[validCal(input.calKey)].label}.${aviso}`;
    }

    if (name === 'cancelar_evento' || name === 'mover_evento') {
      const dp = resolveAgendaDay(input.dayText || 'hoy');
      if (!dp) return 'No entendí el día del evento. Pide una aclaración.';
      const { events } = await eventsForDateParts(dp.y, dp.m, dp.d);
      const matches = events.filter((it) => norm(it.ev.summary).includes(norm(input.keyword)));
      if (!matches.length) return `No encontré ningún evento de "${input.keyword}" el ${dp.d}/${dp.m}. Pregunta al usuario para precisar.`;
      if (matches.length > 1) return `Hay varios el ${dp.d}/${dp.m}: ${matches.map((it) => it.ev.summary).join('; ')}. Pide al usuario que precise cuál (nombre u hora).`;
      const it = matches[0];
      if (name === 'cancelar_evento') {
        setPending(ctx.chatId, {
          describe: `cancelar "${it.ev.summary}"`,
          exec: async () => {
            try { await deleteEvent(it.calKey, it.ev.id); }
            catch (e) { return `⚠️ No pude cancelarlo: ${e?.errors?.[0]?.message || e.message}`; }
            setLastAction(ctx.chatId, {
              describe: `cancelar "${it.ev.summary}"`,
              undo: async () => {
                try { await recreateEvent(it.calKey, it.ev); }
                catch (e) { return `⚠️ No pude deshacer: ${e?.errors?.[0]?.message || e.message}`; }
                return `↩️ Deshecho: restauré *${it.ev.summary}*.`;
              },
            });
            return `🗑️ Cancelado: "${it.ev.summary}" del ${dp.d}/${dp.m}.`;
          },
        });
        return `CONFIRMACIÓN NECESARIA: no está cancelado todavía. Pide al usuario que confirme que cancele "${it.ev.summary}" del ${dp.d}/${dp.m} respondiendo "sí".`;
      }
      // mover
      const target = input.newDayText ? resolveAgendaDay(input.newDayText) : dp;
      if (!target) return 'No entendí el nuevo día. Pide una aclaración.';
      if (input.newHh === undefined || input.newHh === null) return 'Falta la nueva hora. Pregunta al usuario.';
      let durMin = 60;
      if (it.ev.start?.dateTime && it.ev.end?.dateTime) {
        durMin = Math.max(15, Math.round((new Date(it.ev.end.dateTime) - new Date(it.ev.start.dateTime)) / 60000));
      }
      const nuevaHora = `${String(input.newHh).padStart(2, '0')}:${String(input.newMm ?? 0).padStart(2, '0')}`;
      const clashes = await overlappingEvents(target.y, target.m, target.d, input.newHh, input.newMm ?? 0, durMin, it.ev.id).catch(() => []);
      const origStart = it.ev.start;
      const origEnd = it.ev.end;
      setPending(ctx.chatId, {
        describe: `mover "${it.ev.summary}"`,
        exec: async () => {
          try { await moveEvent(it.calKey, it.ev.id, target.y, target.m, target.d, input.newHh, input.newMm ?? 0, durMin); }
          catch (e) { return `⚠️ No pude moverlo: ${e?.errors?.[0]?.message || e.message}`; }
          setLastAction(ctx.chatId, {
            describe: `mover "${it.ev.summary}"`,
            undo: async () => {
              try { await restoreEventTimes(it.calKey, it.ev.id, origStart, origEnd); }
              catch (e) { return `⚠️ No pude deshacer: ${e?.errors?.[0]?.message || e.message}`; }
              return `↩️ Deshecho: devolví *${it.ev.summary}* a su hora original.`;
            },
          });
          return `📅 Movido: "${it.ev.summary}" a ${target.d}/${target.m} ${nuevaHora}.`;
        },
      });
      const choque = clashes.length ? ` AVISA de que a esa hora ya hay: ${clashes.map((c) => `${c.summary} (${c.hora})`).join(', ')}.` : '';
      return `CONFIRMACIÓN NECESARIA: no está movido todavía. Pide al usuario que confirme mover "${it.ev.summary}" a ${target.d}/${target.m} a las ${nuevaHora} respondiendo "sí".${choque}`;
    }

    if (name === 'poner_recordatorio') {
      // Recurrente: se reprograma solo tras cada aviso.
      const mapRepeat = { diario: 'daily', semanal: 'weekly', mensual: 'monthly' };
      if (input.repeat && mapRepeat[input.repeat]) {
        const repeat = {
          type: mapRepeat[input.repeat],
          hh: input.hh ?? 9,
          mm: input.mm ?? 0,
          ...(input.repeat === 'semanal' ? { dow: Number(input.dow) } : {}),
          ...(input.repeat === 'mensual' ? { dom: Number(input.dom) } : {}),
        };
        if (repeat.type === 'weekly' && !(repeat.dow >= 0 && repeat.dow <= 6)) return 'Falta qué día de la semana. Pregunta al usuario.';
        if (repeat.type === 'monthly' && !(repeat.dom >= 1 && repeat.dom <= 31)) return 'Falta qué día del mes. Pregunta al usuario.';
        const due = nextOccurrence(repeat, Date.now());
        if (!due) return 'No pude calcular la repetición. Pide una aclaración.';
        const idR = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        addReminder({ id: idR, chatId: ctx.chatId, text: input.what, dueTs: due, repeat });
        setLastAction(ctx.chatId, { describe: 'poner recordatorio', undo: async () => { removeReminder(idR); return `↩️ Deshecho: quité el recordatorio *${input.what}*.`; } });
        const prox = new Date(due).toLocaleString('es-ES', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
        return `OK. Recordatorio recurrente: "${input.what}" (${describeRepeat(repeat)}). Próximo aviso: ${prox}.`;
      }

      let dueTs;
      let cuandoTxt;
      if (input.inMinutes) {
        dueTs = Date.now() + Number(input.inMinutes) * 60000;
      } else {
        const dp = resolveAgendaDay(input.dayText || 'hoy');
        if (!dp) return 'No entendí el cuándo del recordatorio. Pide una aclaración.';
        dueTs = madridToUtc(dp.y, dp.m, dp.d, input.hh ?? 9, input.mm ?? 0).getTime();
      }
      if (dueTs < Date.now() - 60000) return 'Esa hora ya pasó. Pide una hora futura.';
      const idR = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      addReminder({ id: idR, chatId: ctx.chatId, text: input.what, dueTs });
      setLastAction(ctx.chatId, { describe: 'poner recordatorio', undo: async () => { removeReminder(idR); return `↩️ Deshecho: quité el recordatorio *${input.what}*.`; } });
      cuandoTxt = new Date(dueTs).toLocaleString('es-ES', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
      return `OK. Recordatorio puesto: "${input.what}" para ${cuandoTxt}.`;
    }

    if (name === 'consultar_agenda') {
      const range = resolveAgendaRange(input.cuando);
      if (range) {
        const events = await eventsForRange(range.from, range.to);
        return `Eventos de ${range.label}:\n${fmtEventList(events)}`;
      }
      const dp = resolveAgendaDay(input.cuando);
      if (!dp) return 'No entendí la fecha.';
      const { events } = await eventsForDateParts(dp.y, dp.m, dp.d);
      return `Eventos del ${dp.d}/${dp.m}:\n${fmtEventList(events)}`;
    }

    if (name === 'buscar_evento') {
      const k = norm(input.keyword || '');
      if (!k) return 'Falta la palabra clave de búsqueda.';
      const events = await eventsForRange(madridDateParts(0), madridDateParts(92));
      const hits = events.filter((it) => norm(it.ev.summary).includes(k));
      if (!hits.length) return `No encontré ningún evento con "${input.keyword}" en los próximos ~3 meses.`;
      return `Encontrados (${hits.length}):\n${fmtEventList(hits.slice(0, 12))}`;
    }

    if (name === 'ver_recordatorios') {
      const rs = listReminders(ctx.chatId);
      if (!rs.length) return 'No hay recordatorios pendientes.';
      return 'Recordatorios pendientes:\n' + rs.map((r) =>
        `- "${r.text}" → ${new Date(r.dueTs).toLocaleString('es-ES', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}${r.repeat ? ' 🔁 (' + describeRepeat(r.repeat) + ')' : ''}`,
      ).join('\n');
    }

    if (name === 'cancelar_recordatorio') {
      const rs = listReminders(ctx.chatId).filter((r) => norm(r.text).includes(norm(input.keyword)));
      if (!rs.length) return `No hay ningún recordatorio de "${input.keyword}".`;
      if (rs.length > 1) return `Hay varios recordatorios de "${input.keyword}": ${rs.map((r) => r.text).join('; ')}. Pide al usuario que precise cuál.`;
      removeReminder(rs[0].id);
      return `OK. Recordatorio cancelado: "${rs[0].text}".`;
    }

    if (name === 'apuntar_pendiente') {
      const txt = (input.tarea || '').trim();
      if (!txt) return 'Falta qué apuntar.';
      const task = addTask(ctx.chatId, txt);
      setLastAction(ctx.chatId, { describe: 'apuntar pendiente', undo: async () => { removeTask(task.id); return `↩️ Deshecho: quité el pendiente *${txt}*.`; } });
      return `OK. Apuntado en pendientes: "${txt}". Se lo recordaré cada día hasta que lo dé por hecho.`;
    }

    if (name === 'ver_pendientes') {
      const ts = listTasks(ctx.chatId);
      if (!ts.length) return 'No hay pendientes. Todo al día.';
      return 'Pendientes:\n' + ts.map((x, i) => `${i + 1}. ${x.text}`).join('\n');
    }

    if (name === 'completar_pendiente') {
      const ts = listTasks(ctx.chatId).filter((x) => norm(x.text).includes(norm(input.keyword)));
      if (!ts.length) return `No hay ningún pendiente con "${input.keyword}".`;
      if (ts.length > 1) return `Hay varios pendientes con "${input.keyword}": ${ts.map((x) => x.text).join('; ')}. Pide al usuario que precise cuál.`;
      removeTask(ts[0].id);
      return `OK. Pendiente hecho: "${ts[0].text}".`;
    }

    if (name === 'consultar_clima') {
      const w = await getWeather(input.city || getCity());
      if (!w) return 'No pude obtener el clima.';
      return `${w.emoji} ${w.tempC}°C, ${w.desc} en ${w.city}.`;
    }

    return 'Herramienta desconocida.';
  } catch (e) {
    return `Error al ejecutar: ${e?.errors?.[0]?.message || e.message}`;
  }
}

async function callClaude(system, messages) {
  // Cerebro "listo" (Sonnet) para conversar y ejecutar con criterio.
  // Reintenta ante picos transitorios de la IA (429/529/5xx/red).
  return anthropic({ model: MODEL_SMART, max_tokens: 1024, system, tools: TOOLS, messages });
}

export async function conversationalReply(chatId, text, who = 'Jalil') {
  if (!process.env.ANTHROPIC_API_KEY) {
    return 'Puedo ayudarte con tu *agenda*, *apuntar* cosas, *recordatorios* y más. Escríbeme lo que necesites 🙌';
  }

  const [agenda, clima] = await Promise.all([
    upcomingSnapshot(),
    getWeather(getCity()).then((w) => (w ? `${w.emoji} ${w.tempC}°C, ${w.desc} en ${w.city}` : '')).catch(() => ''),
  ]);
  const recs = listReminders(chatId);
  const recsTxt = recs.length
    ? recs.map((r) => `- "${r.text}" → ${new Date(r.dueTs).toLocaleString('es-ES', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`).join('\n')
    : 'Ninguno.';
  const tareas = listTasks(chatId);
  const tareasTxt = tareas.length ? tareas.map((x) => `- ${x.text}`).join('\n') : 'Ninguno.';
  const ahora = new Date();
  const hoy = ahora.toLocaleDateString('es-ES', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const horaNum = Number(ahora.toLocaleString('en-US', { timeZone: TZ, hour: '2-digit', hour12: false }));
  const franja = horaNum < 6 ? 'la madrugada' : horaNum < 13 ? 'la mañana' : horaNum < 20 ? 'la tarde' : 'la noche';
  const quien = who === 'Ale'
    ? 'Estás hablando con Ale (el jefe). Trátale con cercanía y eficiencia.'
    : 'Estás hablando con Jalil, el asistente de confianza de Ale que organiza su día contigo. Habláis de tú a tú, en corto.';

  const system =
    'Eres el jefe de gabinete personal por WhatsApp de un empresario (Ale). Eres su mano derecha digital, y puedes ACTUAR (crear/mover/cancelar eventos, poner/cancelar recordatorios, apuntar/completar pendientes) usando tus herramientas.\n' +
    `${quien}\n` +
    `Es ${franja} de hoy, ${hoy}. Ciudad actual: ${getCity()}.${clima ? ' Clima ahora: ' + clima + '.' : ''}\n\n` +
    'PERSONALIDAD: cercano pero profesional, directo, resolutivo y proactivo. Español natural, frases cortas y humanas, nunca sonando a robot. Algún emoji con moderación.\n\n' +
    'AGENDA de los próximos 8 días (Europe/Madrid):\n' +
    `${agenda}\n\n` +
    `RECORDATORIOS PENDIENTES:\n${recsTxt}\n\n` +
    `PENDIENTES SIN HORA (tareas por hacer):\n${tareasTxt}\n\n` +
    'CÓMO ACTÚAS:\n' +
    '- Cuando te pidan crear/mover/cancelar un evento o poner un recordatorio, HAZLO con la herramienta correspondiente (no te limites a decir cómo). Pasa el día en palabras (hoy, mañana, jueves, 25/07...) — el sistema calcula la fecha exacta.\n' +
    '- Si algo tiene HORA concreta → recordatorio (poner_recordatorio). Si es algo que hay que hacer SIN hora fija ("tengo que...", "apúntame que...") → pendiente (apuntar_pendiente). Cuando digan que ya hicieron algo, usa completar_pendiente.\n' +
    '- Si falta un dato imprescindible (p. ej. la hora, o qué evento exacto cuando hay varios), pregunta en una línea en vez de adivinar.\n' +
    '- Para preguntas sobre la agenda, usa la lista de arriba; para fechas lejanas usa consultar_agenda. NUNCA inventes eventos.\n' +
    '- Sé proactivo: si ves un choque de horarios o algo relevante, coméntalo brevemente.\n' +
    '- Tras hacer una acción, confírmalo en una frase corta y natural. Responde solo a lo que te piden, sin relleno.';

  const messages = [...(histories.get(chatId) || []), { role: 'user', content: text }];

  let finalText = '';
  let failed = false;
  try {
    for (let i = 0; i < 5; i++) {
      const r = await callClaude(system, messages);
      if (!r.ok || !r.data?.content) { failed = true; break; }
      const resp = r.data;
      messages.push({ role: 'assistant', content: resp.content });
      const toolUses = resp.content.filter((b) => b.type === 'tool_use');
      const textOut = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      if (resp.stop_reason !== 'tool_use' || !toolUses.length) {
        finalText = textOut;
        break;
      }
      const results = [];
      for (const tu of toolUses) {
        const out = await executeTool(tu.name, tu.input, { chatId });
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: out });
      }
      messages.push({ role: 'user', content: results });
    }
  } catch (e) {
    console.error('assistant agent error:', e.message);
    failed = true;
  }

  // Nunca fingir que hicimos algo: si la IA falló, dilo con honestidad.
  if (!finalText) {
    finalText = failed
      ? '⚠️ Mi cerebro (IA) está saturado un segundo. Reinténtalo en unos instantes, por favor 🙏'
      : 'Hecho ✅';
  }
  remember(chatId, 'user', text);
  remember(chatId, 'assistant', finalText);
  return finalText;
}

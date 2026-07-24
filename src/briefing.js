// Redacción de los mensajes de briefing (formato WhatsApp)
import { eventsForDay, eventsForDateParts, eventsForRange, madridDateParts, madridToUtc, TZ } from './calendar.js';
import { getWeather } from './weather.js';
import { getCity } from './settings.js';
import { listReminders } from './reminders.js';
import { listTasks } from './tasks.js';

const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// Recordatorios fijos que van en el DAILY de la mañana (junto a la agenda).
// Para cambiarlos, edita esta lista (Jalil solo tiene que pedírmelo).
const DAILY_REMINDERS = [
  'Repartir bonos',
  'Llamadas producto y contenido',
  'Chequear análisis competencia producto',
  'Escuchar audio actualización de Juanber y audio actualización de Alfo',
];

function fmtDate({ y, m, d }) {
  const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  return `${DAYS[dow]}, ${d} de ${MONTHS[m - 1]}`;
}

function fmtHour(ev) {
  if (!ev.start?.dateTime) return null; // evento de día completo
  const dt = new Date(ev.start.dateTime);
  const s = dt.toLocaleTimeString('en-US', {
    timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true,
  });
  return s.replace(/\s/g, ' ');
}

function eventLine({ emoji, ev }) {
  const h = fmtHour(ev);
  const tag = emoji ? ` ${emoji}` : '';
  return h ? `• ${h} — ${ev.summary}${tag}` : `• Todo el día — ${ev.summary}${tag}`;
}

export async function morningBriefing() {
  const today = await eventsForDay(0);
  const tomorrow = await eventsForDay(1);

  const lines = ['*Buenos días* 🌅', `*Hoy — ${fmtDate(today.dateParts)}*`];
  if (today.events.length === 0) {
    lines.push('Hoy sin agenda programada 👌');
  } else {
    for (const item of today.events) lines.push(eventLine(item));
  }
  const t = tomorrow.events[0];
  lines.push(`*Mañana:* ${t ? `${t.ev.summary}${fmtHour(t.ev) ? `, ${fmtHour(t.ev)}` : ''}` : 'sin agenda'}`);
  return lines.join('\n');
}

// DAILY de la mañana = clima + agenda del día + recordatorios fijos (se envía a Ale a las 7:00)
export async function morningDaily() {
  const agenda = await morningBriefing();
  const recordatorios = ['📋 *Recordatorios del día:*', ...DAILY_REMINDERS.map((r) => `• ${r}`)].join('\n');

  let clima = '';
  try {
    const w = await getWeather(getCity());
    if (w) clima = `${w.emoji} ${w.tempC}°C, ${w.desc} en ${w.city}\n\n`;
  } catch {
    // si el clima falla, el daily sale igual sin él
  }

  return `${clima}${agenda}\n\n${recordatorios}`;
}

export async function nightBriefing() {
  const tomorrow = await eventsForDay(1);
  const lines = ['*Buenas noches* 🌙', `*Mañana — ${fmtDate(tomorrow.dateParts)}*`];
  if (tomorrow.events.length === 0) {
    lines.push('Sin agenda programada 👌');
  } else {
    for (const item of tomorrow.events) lines.push(eventLine(item));
  }
  lines.push('Descansa 💪');
  return lines.join('\n');
}

// Resumen de la semana que viene (próximos 7 días, desde mañana), agrupado por día.
// Se envía a Jalil los domingos por la noche para planificar con Ale, y con "resumen semana".
export async function weeklyBriefing() {
  const from = madridDateParts(1);
  const to = madridDateParts(7);
  const events = await eventsForRange(from, to);
  const lines = [`*🗓️ Resumen de la semana* (${fmtDate(from)} → ${fmtDate(to)})`];
  if (events.length === 0) {
    lines.push('\nSemana despejada, nada programado 👌');
    return lines.join('\n');
  }
  lines.push(`Tienes *${events.length}* ${events.length === 1 ? 'cosa' : 'cosas'} en agenda:`);
  let curKey = '';
  for (const item of events) {
    const dp = eventDateParts(item.ev);
    const key = `${dp.y}-${dp.m}-${dp.d}`;
    if (key !== curKey) {
      curKey = key;
      lines.push(`\n*${fmtDate(dp)}*`);
    }
    lines.push(eventLine(item));
  }
  return lines.join('\n');
}

// "Mi día" — panel único de hoy para una persona: clima + agenda + recordatorios de hoy + pendientes.
export async function myDay(chatId) {
  const now = Date.now();
  const t = madridDateParts(0);
  const endToday = madridToUtc(t.y, t.m, t.d, 23, 59).getTime();
  const [today, clima] = await Promise.all([
    eventsForDay(0),
    getWeather(getCity()).then((w) => (w ? `${w.emoji} ${w.tempC}°C, ${w.desc} en ${w.city}` : '')).catch(() => ''),
  ]);

  const lines = [`☀️ *Tu día — ${fmtDate(today.dateParts)}*`];
  if (clima) lines.push(clima);

  lines.push('', '🗓️ *Agenda*');
  if (!today.events.length) lines.push('• Sin eventos hoy 👌');
  else for (const it of today.events) lines.push(eventLine(it));

  const rs = listReminders(chatId)
    .filter((r) => r.dueTs >= now - 60000 && r.dueTs <= endToday)
    .sort((a, b) => a.dueTs - b.dueTs);
  if (rs.length) {
    lines.push('', '⏰ *Recordatorios de hoy*');
    for (const r of rs) {
      const hora = new Date(r.dueTs).toLocaleTimeString('es-ES', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
      lines.push(`• ${hora} — ${r.text}${r.repeat ? ' 🔁' : ''}`);
    }
  }

  const ts = listTasks(chatId);
  if (ts.length) {
    lines.push('', '📝 *Pendientes*');
    ts.forEach((x, i) => lines.push(`${i + 1}. ${x.text}`));
  }

  return lines.join('\n');
}

// "¿Qué sigue?" — el próximo evento desde ahora (hoy; si ya no queda, el primero de mañana).
export async function nextUp() {
  const now = Date.now();
  const today = await eventsForDay(0);
  const upcoming = today.events.filter((it) => {
    const dt = it.ev.start?.dateTime;
    return dt && new Date(dt).getTime() > now;
  });
  if (upcoming.length) {
    const it = upcoming[0];
    const dt = new Date(it.ev.start.dateTime);
    const hora = dt.toLocaleTimeString('es-ES', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
    const mins = Math.round((dt.getTime() - now) / 60000);
    const enTxt = mins < 60 ? `en ${mins} min` : `en ${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}min` : ''}`;
    const tag = it.emoji ? ` ${it.emoji}` : '';
    return `⏭️ *Lo siguiente:* ${it.ev.summary}${tag} — hoy a las ${hora} (${enTxt}).`;
  }
  const tm = await eventsForDay(1);
  const t = tm.events.find((it) => it.ev.start?.dateTime) || tm.events[0];
  if (t) {
    const dt = t.ev.start?.dateTime;
    const hora = dt ? new Date(dt).toLocaleTimeString('es-ES', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) : null;
    return `Hoy ya no queda nada 👌. Lo siguiente es *mañana*: ${t.ev.summary}${hora ? ` a las ${hora}` : ' (todo el día)'}.`;
  }
  return 'No tienes nada próximo en la agenda 👌.';
}

// Agenda de una fecha concreta (para consultas "agenda viernes", "agenda 25/07", etc.)
export async function dayAgendaForDate(y, m, d) {
  const { dateParts, events } = await eventsForDateParts(y, m, d);
  const lines = [`*Agenda — ${fmtDate(dateParts)}*`];
  if (events.length === 0) {
    lines.push('Sin agenda ese día 👌');
  } else {
    for (const item of events) lines.push(eventLine(item));
  }
  return lines.join('\n');
}

// Fecha (año, mes, día en Madrid) de un evento, para agrupar por día
function eventDateParts(ev) {
  const iso = ev.start?.dateTime || `${ev.start?.date}T12:00:00`;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const [y, m, d] = fmt.format(new Date(iso)).split('-').map(Number);
  return { y, m, d };
}

// Agenda de un periodo (semana, mes, un mes concreto...), agrupada por día
export async function rangeAgenda(from, to, label) {
  const events = await eventsForRange(from, to);
  const lines = [`*Agenda — ${label}*`];
  if (events.length === 0) {
    lines.push('Nada programado en ese periodo 👌');
    return lines.join('\n');
  }
  let curKey = '';
  for (const item of events) {
    const dp = eventDateParts(item.ev);
    const key = `${dp.y}-${dp.m}-${dp.d}`;
    if (key !== curKey) {
      curKey = key;
      lines.push(`\n*${fmtDate(dp)}*`);
    }
    lines.push(eventLine(item));
  }
  return lines.join('\n');
}

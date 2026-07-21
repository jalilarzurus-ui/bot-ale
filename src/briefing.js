// Redacción de los mensajes de briefing (formato WhatsApp)
import { eventsForDay, TZ } from './calendar.js';

const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

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

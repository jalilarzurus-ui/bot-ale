// Acceso a Google Calendar con una Service Account.
// IMPORTANTE: Jalil debe compartir cada calendario con el email de la service account
// (permiso "Hacer cambios en eventos" para poder crear).
import { google } from 'googleapis';

export const TZ = 'Europe/Madrid';

function getClient() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.JWT(
    creds.client_email,
    undefined,
    creds.private_key,
    ['https://www.googleapis.com/auth/calendar'],
  );
  return google.calendar({ version: 'v3', auth });
}

export const CALENDARS = {
  actividades: { id: process.env.CAL_ACTIVIDADES, label: 'Actividades', emoji: '' },
  mentoria: { id: process.env.CAL_MENTORIA, label: 'Mentoría/Llamada', emoji: '📞' },
  personal: { id: process.env.CAL_PERSONAL, label: 'Personal', emoji: '' },
  viajes: { id: process.env.CAL_VIAJES, label: 'Viaje', emoji: '✈️' },
};

// --- utilidades de zona horaria (sin dependencias externas) ---

// Partes de fecha (año, mes, día) de "ahora + offset días" en Madrid
export function madridDateParts(dayOffset = 0) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const base = new Date(Date.now() + dayOffset * 24 * 3600 * 1000);
  const [y, m, d] = fmt.format(base).split('-').map(Number);
  return { y, m, d };
}

// Instante UTC correspondiente a una hora local de Madrid
export function madridToUtc(y, m, d, hh = 0, mm = 0) {
  let guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  for (let i = 0; i < 3; i++) {
    const local = new Date(new Date(guess).toLocaleString('en-US', { timeZone: TZ }));
    const wanted = new Date(y, m - 1, d, hh, mm, 0);
    const diff = wanted.getTime() - new Date(local.getFullYear(), local.getMonth(), local.getDate(), local.getHours(), local.getMinutes(), 0).getTime();
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

// Devuelve los eventos de una fecha concreta (año, mes, día en Madrid) de TODOS los calendarios
export async function eventsForDateParts(y, m, d) {
  const cal = getClient();
  const timeMin = madridToUtc(y, m, d, 0, 0).toISOString();
  const timeMax = madridToUtc(y, m, d, 23, 59).toISOString();

  const all = [];
  for (const [key, c] of Object.entries(CALENDARS)) {
    if (!c.id) continue;
    const res = await cal.events.list({
      calendarId: c.id,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      timeZone: TZ,
    });
    for (const ev of res.data.items || []) {
      all.push({ calKey: key, emoji: c.emoji, ev });
    }
  }
  all.sort((a, b) => startMs(a.ev) - startMs(b.ev));
  return { dateParts: { y, m, d }, events: all };
}

// Devuelve los eventos de un día relativo (0 = hoy, 1 = mañana, hora Madrid)
export async function eventsForDay(dayOffset = 0) {
  const { y, m, d } = madridDateParts(dayOffset);
  return eventsForDateParts(y, m, d);
}

// Devuelve todos los eventos entre dos fechas (inclusive), de TODOS los calendarios, ordenados
export async function eventsForRange(from, to) {
  const cal = getClient();
  const timeMin = madridToUtc(from.y, from.m, from.d, 0, 0).toISOString();
  const timeMax = madridToUtc(to.y, to.m, to.d, 23, 59).toISOString();

  const all = [];
  for (const [key, c] of Object.entries(CALENDARS)) {
    if (!c.id) continue;
    const res = await cal.events.list({
      calendarId: c.id,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      timeZone: TZ,
    });
    for (const ev of res.data.items || []) {
      all.push({ calKey: key, emoji: c.emoji, ev });
    }
  }
  all.sort((a, b) => startMs(a.ev) - startMs(b.ev));
  return all;
}

export async function createEvent({ calKey, summary, y, m, d, hh, mm, durMin = 60, allDay = false }) {
  const cal = getClient();
  const c = CALENDARS[calKey] || CALENDARS.actividades;
  let resource;
  if (allDay) {
    const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    resource = { summary, start: { date }, end: { date } };
  } else {
    const start = madridToUtc(y, m, d, hh, mm);
    const end = new Date(start.getTime() + durMin * 60000);
    resource = {
      summary,
      start: { dateTime: start.toISOString(), timeZone: TZ },
      end: { dateTime: end.toISOString(), timeZone: TZ },
    };
  }
  const res = await cal.events.insert({ calendarId: c.id, resource });
  return res.data;
}

// Borra un evento por su id
export async function deleteEvent(calKey, eventId) {
  const cal = getClient();
  const c = CALENDARS[calKey] || CALENDARS.actividades;
  await cal.events.delete({ calendarId: c.id, eventId });
}

// Cambia la fecha/hora de un evento existente (mover/reprogramar)
export async function moveEvent(calKey, eventId, y, m, d, hh, mm, durMin = 60) {
  const cal = getClient();
  const c = CALENDARS[calKey] || CALENDARS.actividades;
  const start = madridToUtc(y, m, d, hh, mm);
  const end = new Date(start.getTime() + durMin * 60000);
  const res = await cal.events.patch({
    calendarId: c.id,
    eventId,
    resource: {
      start: { dateTime: start.toISOString(), timeZone: TZ },
      end: { dateTime: end.toISOString(), timeZone: TZ },
    },
  });
  return res.data;
}

// Devuelve los eventos CON HORA que se solapan con la franja [inicio, inicio+durMin)
// en la fecha dada. Ignora los de todo el día y, opcionalmente, un evento por id
// (útil al MOVER: no queremos que un evento choque consigo mismo).
export async function overlappingEvents(y, m, d, hh, mm, durMin = 60, ignoreId = null) {
  if (hh === undefined || hh === null) return []; // evento de todo el día: sin solape de hora
  const S = madridToUtc(y, m, d, hh, mm).getTime();
  const E = S + durMin * 60000;
  const { events } = await eventsForDateParts(y, m, d);
  const out = [];
  for (const it of events) {
    if (ignoreId && it.ev.id === ignoreId) continue;
    const sdt = it.ev.start?.dateTime;
    const edt = it.ev.end?.dateTime;
    if (!sdt || !edt) continue; // evento de todo el día existente: no bloquea una franja
    const s = new Date(sdt).getTime();
    const e = new Date(edt).getTime();
    if (s < E && S < e) {
      const hora = new Date(sdt).toLocaleTimeString('es-ES', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
      out.push({ summary: it.ev.summary, hora, calKey: it.calKey });
    }
  }
  return out;
}

function startMs(ev) {
  return new Date(ev.start?.dateTime || `${ev.start?.date}T00:00:00`).getTime();
}

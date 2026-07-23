// Bot Ale — briefing diario por WhatsApp con filtro de aprobación de Jalil
// Flujo: 7:00 → briefing a Jalil → Jalil responde "ok" → se reenvía a Ale.
//        21:30 → resumen nocturno a Jalil → "ok" → a Ale.
//        Jalil también puede escribir "agrega: ..." para crear eventos.
import express from 'express';
import cron from 'node-cron';
import { morningDaily, nightBriefing, weeklyBriefing } from './briefing.js';
import { sendText, flushQueue, getMedia } from './whatsapp.js';
import { transcribe } from './transcribe.js';
import { handleCommand } from './commands.js';
import { conversationalReply } from './assistant.js';
import { dueReminders, removeReminders, updateReminderDue, nextOccurrence, setLastFired } from './reminders.js';
import { getPending, clearPending, isYes, isNo } from './confirm.js';
import { eventsForDay, CALENDARS, TZ } from './calendar.js';
import { getAlertsOn, getAlertLead } from './settings.js';

const app = express();
app.use(express.json());

const JALIL = process.env.JALIL_PHONE;
const ALE = process.env.ALE_PHONE;

// Último briefing pendiente de aprobación (el "filtro de Jalil")
let pendingForAle = null;

// ---------- Tareas programadas (hora Madrid) ----------
// 7:00 → daily con la agenda del día (para enviar a Ale).
// 23:00 → agenda del día siguiente, antes de dormir.
cron.schedule('0 7 * * *', () => runBriefing('morning'), { timezone: 'Europe/Madrid' });
cron.schedule('0 23 * * *', () => runBriefing('night'), { timezone: 'Europe/Madrid' });
// Domingo 20:00 → resumen de la semana que viene (para planificar con Ale).
cron.schedule('0 20 * * 0', () => runBriefing('week'), { timezone: 'Europe/Madrid' });

// Recordatorios: cada minuto, avisa de los que ya toca.
cron.schedule('* * * * *', async () => {
  try {
    const due = dueReminders(Date.now());
    if (!due.length) return;
    const done = [];
    for (const r of due) {
      try {
        await sendText(r.chatId, `⏰ *Recordatorio:* ${r.text}`);
        setLastFired(r.chatId, r.text); // por si quiere "posponer" el que acaba de sonar
      } catch (e) {
        console.error('reminder send error:', e.message);
      }
      if (r.repeat) {
        // recurrente: reprogramar al siguiente aviso en vez de borrarlo
        const next = nextOccurrence(r.repeat, Date.now());
        if (next) updateReminderDue(r.id, next);
        else done.push(r.id);
      } else {
        done.push(r.id); // de una sola vez: se quita
      }
    }
    removeReminders(done);
  } catch (e) {
    console.error('reminder cron error:', e.message);
  }
});

// Avisos automáticos antes de cada evento: cada 5 min mira la agenda de hoy y avisa
// a Jalil de lo que empieza dentro de los próximos N minutos (por defecto 30). Una sola vez por evento.
const alerted = new Set(); // ids de eventos ya avisados
let alertedDay = '';
cron.schedule('*/5 * * * *', async () => {
  try {
    if (!getAlertsOn()) return;
    // Reset diario del registro de avisados (para no crecer sin fin)
    const dayKey = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
    if (dayKey !== alertedDay) { alerted.clear(); alertedDay = dayKey; }

    const leadMs = getAlertLead() * 60000;
    const now = Date.now();
    const { events } = await eventsForDay(0);
    for (const it of events) {
      const dt = it.ev.start?.dateTime;
      if (!dt) continue; // eventos de todo el día no llevan aviso "en X min"
      const startMs = new Date(dt).getTime();
      const diff = startMs - now;
      // Aún no empezó y arranca dentro de la ventana de aviso
      if (diff > 0 && diff <= leadMs && !alerted.has(it.ev.id)) {
        alerted.add(it.ev.id);
        const mins = Math.max(1, Math.round(diff / 60000));
        const hora = new Date(dt).toLocaleTimeString('es-ES', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
        const cal = CALENDARS[it.calKey];
        const tag = cal?.emoji ? ` ${cal.emoji}` : '';
        try {
          await sendText(JALIL, `⏰ *En ${mins} min:* ${it.ev.summary} (${hora})${tag}`);
        } catch (e) {
          console.error('alert send error:', e.message);
          alerted.delete(it.ev.id); // si falló el envío, permitir reintento en la próxima pasada
        }
      }
    }
  } catch (e) {
    console.error('event alert cron error:', e.message);
  }
});

async function runBriefing(kind) {
  try {
    const msg = kind === 'morning' ? await morningDaily()
      : kind === 'week' ? await weeklyBriefing()
      : await nightBriefing();
    pendingForAle = msg;
    const header = kind === 'morning' ? '🌅 Daily de hoy (agenda).'
      : kind === 'week' ? '🗓️ Resumen de la semana que viene.'
      : '🌙 Agenda de mañana.';
    await sendText(JALIL, `${header} Responde *ok* para enviárselo a Ale, o *no* para descartarlo:\n\n${msg}`);
    console.log(`[${kind}] briefing enviado a Jalil`);
  } catch (e) {
    console.error(`[${kind}] error:`, e.message);
    try { await sendText(JALIL, `⚠️ Error generando el briefing: ${e.message}`); } catch {}
  }
}

// ---------- Webhook de WhatsApp ----------
// Verificación inicial (Meta llama con GET)
app.get('/webhook', (req, res) => {
  if (
    req.query['hub.mode'] === 'subscribe' &&
    req.query['hub.verify_token'] === process.env.WEBHOOK_VERIFY_TOKEN
  ) {
    return res.send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

// Mensajes entrantes
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // responder rápido a Meta
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    if (!msg) return;
    const from = msg.from;

    // El mensaje puede ser texto o una NOTA DE VOZ (audio): la transcribimos.
    let text;
    if (msg.type === 'text') {
      text = msg.text.body.trim();
    } else if (msg.type === 'audio') {
      try {
        const { buffer, mimeType } = await getMedia(msg.audio.id);
        text = await transcribe(buffer, mimeType);
      } catch (e) {
        console.error('audio error:', e.message);
      }
      if (!text) {
        await flushQueue(from);
        await sendText(from, '🎤 No pude entender el audio. ¿Me lo repites o lo escribes?');
        return;
      }
    } else {
      return; // otros tipos (imágenes, etc.) se ignoran por ahora
    }

    // abrir ventana de 24h: entregar mensajes retenidos
    await flushQueue(from);

    // Eco de voz: si vino por audio, confirmamos qué entendimos (para cazar errores de
    // transcripción antes de actuar). Los audios los manda sobre todo Ale.
    if (msg.type === 'audio') {
      await sendText(from, `🎤 Entendí: "${text}"`);
    }

    // ¿Hay una acción peligrosa a medias (cancelar/mover evento) esperando "sí"?
    const pend = getPending(from);
    if (pend) {
      if (isYes(text)) {
        clearPending(from);
        const res = await pend.exec();
        await sendText(from, res);
        if (from === ALE) await sendText(JALIL, `📩 Ale confirmó (${pend.describe}): ${res}`);
        return;
      }
      if (isNo(text)) {
        clearPending(from);
        await sendText(from, '👍 Vale, lo dejo como está. No toqué nada.');
        return;
      }
      // Cualquier otra cosa: olvidamos el pendiente y seguimos con el mensaje normal.
      clearPending(from);
    }

    // Envolvemos el procesamiento: pase lo que pase, el usuario SIEMPRE recibe respuesta.
    // (Regla de oro: el bot nunca se queda mudo.)
    try {
      if (from === JALIL) {
        const t = text.toLowerCase();
        if (t === 'ok' || t === 'ok!' || t === '👍') {
          if (pendingForAle) {
            await sendText(ALE, pendingForAle);
            await sendText(JALIL, '✅ Enviado a Ale.');
            pendingForAle = null;
          } else {
            await sendText(JALIL, 'No hay ningún briefing pendiente de aprobar.');
          }
          return;
        }
        if (t === 'no') {
          pendingForAle = null;
          await sendText(JALIL, '🗑️ Descartado. No se envió nada a Ale.');
          return;
        }
        const cmd = await handleCommand(text, from);
        if (cmd?.reply) {
          await sendText(JALIL, cmd.reply);
          return;
        }
        // No es un comando: responde la IA de forma natural (conversación + agenda).
        await sendText(JALIL, await conversationalReply(from, text, 'Jalil'));
      } else if (from === ALE) {
        // Ale tiene acceso completo (agenda, crear eventos, asistente IA). Jalil se entera de todo.
        // (No puede aprobar briefings: 'ok'/'no' solo se manejan en la rama de Jalil.)
        const cmd = await handleCommand(text, from);
        if (cmd?.reply) {
          await sendText(ALE, cmd.reply);
          await sendText(JALIL, `📩 Ale usó el bot: "${text}"`);
          return;
        }
        // No es un comando: la IA le responde de forma natural, y avisamos a Jalil.
        await sendText(ALE, await conversationalReply(from, text, 'Ale'));
        await sendText(JALIL, `💬 Ale le escribió al bot: "${text}"`);
      }
    } catch (e) {
      console.error('handler error:', e.message);
      // Fallback: avisar al usuario (nunca silencio) y a Jalil del fallo.
      try {
        await sendText(from, '⚠️ Uf, algo se me cruzó procesando eso. ¿Me lo repites en un momento? Si sigue, avísame.');
        if (from === ALE) await sendText(JALIL, `⚠️ Falló procesar un mensaje de Ale ("${text}"): ${e.message}`);
      } catch (e2) {
        console.error('fallback send error:', e2.message);
      }
    }
  } catch (e) {
    console.error('webhook error:', e.message);
  }
});

// Disparos manuales / desde el cron externo (protegidos con el mismo token).
// Acepta GET y POST para que servicios como cron-job.org funcionen con su método por defecto (GET).
app.all('/run/:kind', async (req, res) => {
  if (req.query.token !== process.env.WEBHOOK_VERIFY_TOKEN) return res.sendStatus(403);
  await runBriefing(req.params.kind === 'night' ? 'night' : 'morning');
  res.json({ ok: true });
});

app.get('/', (_req, res) => res.send('Bot Ale funcionando ✅'));

app.listen(process.env.PORT || 3000, () => console.log('Bot Ale escuchando'));

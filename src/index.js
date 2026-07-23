// Bot Ale — briefing diario por WhatsApp con filtro de aprobación de Jalil
// Flujo: 7:00 → briefing a Jalil → Jalil responde "ok" → se reenvía a Ale.
//        21:30 → resumen nocturno a Jalil → "ok" → a Ale.
//        Jalil también puede escribir "agrega: ..." para crear eventos.
import express from 'express';
import cron from 'node-cron';
import { morningDaily, nightBriefing } from './briefing.js';
import { sendText, flushQueue } from './whatsapp.js';
import { handleCommand } from './commands.js';
import { dueReminders, removeReminders } from './reminders.js';

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

// Recordatorios: cada minuto, avisa de los que ya toca.
cron.schedule('* * * * *', async () => {
  try {
    const due = dueReminders(Date.now());
    if (!due.length) return;
    const done = [];
    for (const r of due) {
      try {
        await sendText(r.chatId, `⏰ *Recordatorio:* ${r.text}`);
      } catch (e) {
        console.error('reminder send error:', e.message);
      }
      done.push(r.id); // se quita aunque falle el envío, para no repetir
    }
    removeReminders(done);
  } catch (e) {
    console.error('reminder cron error:', e.message);
  }
});

async function runBriefing(kind) {
  try {
    const msg = kind === 'morning' ? await morningDaily() : await nightBriefing();
    pendingForAle = msg;
    const header = kind === 'morning' ? '🌅 Daily de hoy (agenda).' : '🌙 Agenda de mañana.';
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
    if (!msg || msg.type !== 'text') return;
    const from = msg.from;
    const text = msg.text.body.trim();

    // abrir ventana de 24h: entregar mensajes retenidos
    await flushQueue(from);

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
      await sendText(
        JALIL,
        'Comandos: *ok* (aprobar y enviar a Ale) · *no* (descartar) · *agenda hoy* · *agenda mañana* · *agrega: Título | martes 21:00 | personal*',
      );
    } else if (from === ALE) {
      // Ale tiene acceso completo (agenda, crear eventos, asistente IA). Jalil se entera de todo.
      // (No puede aprobar briefings: 'ok'/'no' solo se manejan en la rama de Jalil.)
      const cmd = await handleCommand(text, from);
      if (cmd?.reply) {
        await sendText(ALE, cmd.reply);
        await sendText(JALIL, `📩 Ale usó el bot: "${text}"`);
        return;
      }
      // No es un comando conocido: bienvenida/ayuda + aviso a Jalil.
      await sendText(
        ALE,
        '👋 ¡Hola Ale! Soy tu asistente. Puedo ayudarte con:\n\n📅 *Tu agenda* — "agenda hoy", "agenda viernes", "agenda esta semana", "agenda agosto"...\n➕ *Apuntar cosas* — "anota comida con el equipo el jueves a las 3pm"\n🤖 *Asistente IA* (escribe *ia* delante) — "ia redáctame un correo...", "ia traduce al inglés: ...", "ia resume esto: ..."\n\nEscríbeme lo que necesites, cuando quieras 🙌',
      );
      await sendText(JALIL, `💬 Ale escribió al bot: "${text}"`);
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

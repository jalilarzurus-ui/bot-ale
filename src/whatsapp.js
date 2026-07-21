// Envío de mensajes por la WhatsApp Cloud API oficial de Meta
const API = 'https://graph.facebook.com/v20.0';

const pendingByPhone = new Map(); // cola de mensajes retenidos por ventana de 24h cerrada

export async function sendText(to, body) {
  const res = await fetch(`${API}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body },
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    const code = data?.error?.code;
    // 131047 / 131026: fuera de la ventana de 24h → guardar y avisar con plantilla
    if (code === 131047 || code === 131026) {
      queueMessage(to, body);
      await sendTemplate(to, 'hello_world'); // reemplazar por plantilla propia cuando esté aprobada
      return { queued: true };
    }
    throw new Error(`WhatsApp API error: ${JSON.stringify(data)}`);
  }
  return data;
}

export async function sendTemplate(to, templateName, langCode = 'en_US') {
  const res = await fetch(`${API}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: { name: templateName, language: { code: langCode } },
    }),
  });
  const data = await res.json();
  if (!res.ok) console.error('Template error:', JSON.stringify(data));
  return data;
}

export function queueMessage(phone, body) {
  const list = pendingByPhone.get(phone) || [];
  list.push(body);
  pendingByPhone.set(phone, list);
}

// Cuando la persona escribe, la ventana de 24h se abre: entregamos lo retenido
export async function flushQueue(phone) {
  const list = pendingByPhone.get(phone) || [];
  pendingByPhone.delete(phone);
  for (const body of list) {
    await sendText(phone, body);
  }
  return list.length;
}

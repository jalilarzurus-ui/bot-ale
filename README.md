# Bot Ale — Briefing diario por WhatsApp 🌅

Sistema que cada día a las **7:00** y a las **21:30** (hora Madrid) lee los 4 calendarios de Ale,
redacta el briefing y lo envía al **WhatsApp de Jalil**. Jalil responde **ok** y el bot se lo
reenvía a **Ale** automáticamente. Nada llega a Ale sin aprobación de Jalil.

Además, Jalil puede escribirle al bot por WhatsApp:

- `ok` — aprueba el briefing pendiente y se lo envía a Ale
- `no` — descarta el briefing pendiente
- `agenda hoy` / `agenda mañana` — pide la agenda al momento
- `agrega: Cena con socios | martes 21:00 | personal` — crea un evento en el calendario
  (calendarios: `actividades`, `mentoria`, `personal`, `viajes`; si no se indica, va a `actividades`)

---

## Puesta en marcha (una sola vez, ~45 min)

### Paso 1 — WhatsApp Cloud API (Meta) · ~20 min

1. Entra en https://developers.facebook.com → "My Apps" → **Create App** → tipo **Business**.
2. En el panel de la app, añade el producto **WhatsApp**.
3. En **WhatsApp → API Setup** verás:
   - un **número de prueba** gratuito (sirve para siempre con hasta 5 destinatarios),
   - el **Phone Number ID** → cópialo a `WHATSAPP_PHONE_NUMBER_ID`,
   - la lista de destinatarios: **añade y verifica tu número y el de Ale** (les llega un código).
4. Token permanente (el temporal caduca en 24 h):
   - https://business.facebook.com → Configuración del negocio → **Usuarios del sistema** → crear
     usuario de sistema (rol Admin) → **Generar token** → selecciona tu app y los permisos
     `whatsapp_business_messaging` y `whatsapp_business_management` → copia el token a `WHATSAPP_TOKEN`.
5. Tanto tú como Ale: guardad el número de prueba en contactos y **enviadle un "hola"** por
   WhatsApp (esto abre la ventana de 24 h para que el bot pueda escribiros).

### Paso 2 — Google Calendar (Service Account) · ~10 min

1. https://console.cloud.google.com → crea un proyecto (ej. "bot-ale").
2. **APIs y servicios → Biblioteca** → busca "Google Calendar API" → **Habilitar**.
3. **APIs y servicios → Credenciales → Crear credenciales → Cuenta de servicio** → nombre "bot-ale".
4. Entra en la cuenta de servicio → **Claves → Agregar clave → JSON** → se descarga un archivo.
   Copia TODO su contenido (una línea) a `GOOGLE_SERVICE_ACCOUNT_JSON`.
5. Copia el **email** de la cuenta de servicio (algo como `bot-ale@....iam.gserviceaccount.com`)
   y en Google Calendar **comparte los 4 calendarios** con ese email con permiso
   **"Hacer cambios en eventos"** (igual que compartiste con Ale, pero con este permiso).

### Paso 3 — Desplegar en Render (gratis) · ~10 min

1. Sube esta carpeta a un repositorio de GitHub (privado).
2. https://render.com → **New → Web Service** → conecta el repo.
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: **Free**
3. En **Environment**, añade todas las variables del archivo `.env.example` con tus valores.
4. Deploy. Cuando esté verde, copia la URL (ej. `https://bot-ale.onrender.com`).

> ⚠️ El plan Free de Render "duerme" el servicio tras 15 min sin tráfico y los cron internos no
> disparan dormidos. Solución gratis: en https://cron-job.org crea 2 avisos que llamen a
> `https://TU-URL.onrender.com/run/morning?token=TU_WEBHOOK_VERIFY_TOKEN` a las 7:00 (Madrid) y
> `/run/night?token=...` a las 21:30. Así el briefing dispara aunque el servicio duerma.
> (Alternativa: instancia de pago de Render ~7 USD/mes y los cron internos funcionan solos.)

### Paso 4 — Conectar el webhook · ~5 min

1. En Meta: **WhatsApp → Configuration → Webhook** → Edit:
   - Callback URL: `https://TU-URL.onrender.com/webhook`
   - Verify token: el mismo valor que pusiste en `WEBHOOK_VERIFY_TOKEN`
2. **Verify and save** → en "Webhook fields" suscríbete a **messages**.

### Paso 5 — Probar

1. Abre `https://TU-URL.onrender.com/` → debe decir "Bot Ale funcionando ✅".
2. Dispara una prueba: `curl -X POST "https://TU-URL.onrender.com/run/morning?token=TU_TOKEN"`
   → te debe llegar el briefing a tu WhatsApp.
3. Responde `ok` → le debe llegar a Ale. 🎉

---

## Producción "pro" (más adelante)

- Sustituir el número de prueba por un **número real** del negocio (requiere verificación del
  negocio en Meta). Todo el código sirve igual, solo cambia el `WHATSAPP_PHONE_NUMBER_ID`.
- Crear una **plantilla** aprobada ("Tu briefing está listo") para cuando la ventana de 24 h esté
  cerrada; hoy el código usa `hello_world` como aviso de respaldo.
- Añadir `ANTHROPIC_API_KEY` para crear eventos hablándole al bot en lenguaje natural.

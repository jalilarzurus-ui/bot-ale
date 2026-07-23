// Transcribe audio a texto usando la API de Groq (Whisper). Gratis y rápido.
export async function transcribe(buffer, mimeType = 'audio/ogg') {
  if (!process.env.GROQ_API_KEY) return null;
  try {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mimeType }), 'audio.ogg');
    form.append('model', 'whisper-large-v3-turbo');
    form.append('language', 'es');
    form.append('response_format', 'json');

    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: form,
    });
    const data = await res.json();
    return data.text ? data.text.trim() : null;
  } catch (e) {
    console.error('transcribe error:', e.message);
    return null;
  }
}

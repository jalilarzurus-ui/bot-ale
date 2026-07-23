// Clima actual de una ciudad usando Open-Meteo (gratis, sin API key).
// Geocodifica el nombre de la ciudad → lat/lon, y consulta el tiempo actual.

const WMO = {
  0: ['☀️', 'despejado'],
  1: ['🌤️', 'mayormente despejado'],
  2: ['⛅', 'parcialmente nublado'],
  3: ['☁️', 'nublado'],
  45: ['🌫️', 'niebla'], 48: ['🌫️', 'niebla'],
  51: ['🌦️', 'llovizna ligera'], 53: ['🌦️', 'llovizna'], 55: ['🌦️', 'llovizna intensa'],
  56: ['🌧️', 'llovizna helada'], 57: ['🌧️', 'llovizna helada'],
  61: ['🌧️', 'lluvia ligera'], 63: ['🌧️', 'lluvia'], 65: ['🌧️', 'lluvia fuerte'],
  66: ['🌧️', 'lluvia helada'], 67: ['🌧️', 'lluvia helada'],
  71: ['🌨️', 'nieve ligera'], 73: ['🌨️', 'nieve'], 75: ['🌨️', 'nieve intensa'],
  77: ['🌨️', 'aguanieve'],
  80: ['🌦️', 'chubascos'], 81: ['🌦️', 'chubascos'], 82: ['⛈️', 'chubascos fuertes'],
  85: ['🌨️', 'chubascos de nieve'], 86: ['🌨️', 'chubascos de nieve'],
  95: ['⛈️', 'tormenta'], 96: ['⛈️', 'tormenta con granizo'], 99: ['⛈️', 'tormenta con granizo'],
};

export async function getWeather(city) {
  try {
    const g = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=es&format=json`,
    );
    const gd = await g.json();
    const loc = gd?.results?.[0];
    if (!loc) return null;

    const w = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,weather_code&timezone=auto`,
    );
    const wd = await w.json();
    const cur = wd?.current;
    if (!cur) return null;

    const [emoji, desc] = WMO[cur.weather_code] || ['🌡️', 'tiempo variable'];
    return { city: loc.name, tempC: Math.round(cur.temperature_2m), emoji, desc };
  } catch (e) {
    console.error('weather error:', e.message);
    return null;
  }
}

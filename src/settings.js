// Ajustes persistentes del bot (por ahora: la ciudad actual para el clima).
import fs from 'fs';

const FILE = process.env.SETTINGS_FILE
  || (fs.existsSync('/data') ? '/data/settings.json' : './settings-local.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

let settings = load();

function persist() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(settings));
  } catch (e) {
    console.error('settings save error:', e.message);
  }
}

export function getCity() {
  return settings.city || 'Marbella';
}

export function setCity(city) {
  settings.city = city;
  persist();
}

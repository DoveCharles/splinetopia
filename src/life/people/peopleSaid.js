// ============================================================ what someone's said and thought lately
// The last SAID_MAX real lines and thoughts per person (logged from updatePeople in people.js), for the person card's
// Social tab. Only lines actually voiced or shown are logged, so only those said near the camera.

export const SAID_MAX = 20;
const logs = new Map(); // id → [{ text, thought }], oldest first
const listeners = [];

export function logLine(p, line) {
  if (!line?.text) return;
  let log = logs.get(p.id);
  if (!log) logs.set(p.id, log = []);
  log.push({ text: line.text, thought: !!line.thought });
  if (log.length > SAID_MAX) log.shift();
  listeners.forEach(listener => listener(p));
}
export const recentLines = p => logs.get(p?.id) ?? [];
/** `listener(person)` after each line logged. */
export const onLineLogged = listener => { listeners.push(listener); };
/** Forgets everyone not in `living` (a Set of ids). */
export function forgetLinesExcept(living) { logs.forEach((_, id) => { if (!living.has(id)) logs.delete(id); }); }

// ============================================================ entries with traits
// The shared reader for lines in the .txt files that describe things (people/*.txt, cars.txt, ...). A line is an entry: its
// text, then optional {brackets} holding traits (`speed = 2`, `solo`), rules (`limit = 1a`) and `choiceweight = n`, and
// <categories> it's also said as (see speech/about.txt). `Card text | spoken text` gives it a second wording for speech.
// Every kind shares the trait table in core/traits.js.
import { TRAITS, TRAIT_MACROS, modifierLines } from './traits.js';

const warned = new Set();
function warnOnce(message) {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}

const RULES = ['limit'];

// Every trait at its starting value.
export const startingTraits = (table = TRAITS) => Object.fromEntries(Object.entries(table).map(([key, trait]) => [key, trait.base]));

// An entry from one line: { text, said, traits: [[name, value]], rules: [[name, value]], weight, categories }. `said` is
// the wording after a `|` (null without one). A trait without a value is 1. `file` names the file in warnings.
const TRAILING = /(?:\{([^{}]*)\}|<([a-z0-9_,\s]*)>)\s*$/i;
export function entryOf(line, { traits: table = TRAITS, file }) {
  const traits = [];
  const rules = [];
  const categories = [];
  let text = line, group, weight = 1, appeal = null;
  while ((group = text.match(TRAILING))) {
    text = text.slice(0, group.index).trimEnd();
    if (group[2] != null) { categories.unshift(...group[2].split(',').map(name => name.trim().toLowerCase()).filter(Boolean)); continue; }
    const found = [];
    const foundRules = [];
    const splitParts = list => list.split(/[,;]/).filter(part => part.trim());
    // a shorthand (TRAIT_MACROS) is kept, followed by the parts it stands for
    const parts = splitParts(group[1]).flatMap(part => {
      const macro = TRAIT_MACROS[part.split('=')[0].trim().toLowerCase()];
      return macro ? [part, ...splitParts(macro)] : [part];
    });
    parts.forEach(part => {
      if (!part.trim()) return;
      const [rawKey, rawValue] = part.split('=');
      const key = rawKey.trim().toLowerCase(), value = rawValue == null ? 1 : parseFloat(rawValue);
      if (key === 'choiceweight') {
        if (Number.isInteger(value) && value >= 0) { weight = value; return; }
        warnOnce(`Kallipolis: in ${file}, "${part.trim()}" (after "${text}") needs a whole number of 0 or more`);
        return;
      }
      if (key === 'appeal' && Number.isFinite(value)) { appeal = value; return; } // (speech only: how liked it is generally)
      if (RULES.includes(key)) { foundRules.push([key, rawValue == null ? '' : rawValue.trim()]); return; }
      if (table[key] && Number.isFinite(value)) { found.push([key, value]); return; }
      warnOnce(`Kallipolis: in ${file}, "${part.trim()}" (after "${text}") isn't a known trait — see core/traits.js`);
    });
    traits.unshift(...found);
    rules.unshift(...foundRules);
  }
  const bar = text.indexOf('|'), said = bar < 0 ? null : text.slice(bar + 1).trim() || null;
  if (bar >= 0) text = text.slice(0, bar).trim();
  return { text, said, traits, weight, rules, categories, appeal };
}
// An entry with no traits, for placeholder text.
export const plainEntry = text => ({ text, said: null, traits: [], weight: 1, rules: [], categories: [], appeal: null });
// An entry repeated `weight` times (so a random pick favours it); none if the weight is 0.
export const weighted = entry => Array.from({ length: entry.weight }, () => entry);

// A file of [heading] lists, one entry per line: blank lines and # lines are skipped, except trait table rows at the top
// ("#   speed   1   ..."), whose start column sets the starting value of that trait (on/off for switches).
//
// Two headings are special. `[distribution]` says how many of each counted attribute a thing gets — the rows are counts,
// not entries (see DEFAULT_COUNTS), and it applies to every thing in the file alike. `settings` names `key = value` lines
// that are settings rather than card text (buildings' `enterable`), kept as the text they were written as; `attributes`
// names the ones that are card text. With neither given, every line in a section is an entry.
//
// A section's lines are `attribute = value`, and it's the value that's the entry, so `name = Train` gives the text
// "Train" (and `loves = Shoooom {choiceweight = 2}` carries that weight). Lines with no `=` are entries whole — the lists
// in people's files, which have no attributes to name.
//
// Returns { sections, starts: { trait: value }, distribution: [[count…, weight]] or null }, where a section is an object
// of its attributes, each holding the entries written for that attribute — `sections.taxi.loves` is every love a taxi
// could have, in the order the file gave them, so a reader picks one by number. `settings` (buildings' `enterable`) are
// kept beside them as the text they were written as. A file that writes lines with no `=` at all — the people/*.txt lists —
// has them all under the heading's own name instead: `sections['boy names']`.
// A setting like `enterable = yes`, or an attribute line, split into its key and everything after the `=`. Null when the
// line isn't one: `Alfie {agemult = 0.8}` and `😀 {mood = 0.6}` are whole entries carrying a trait, and the `=` in their
// brackets mustn't make them look like attributes.
function pairOf(line) {
  const match = line.match(/^([a-z][a-z0-9]*)\s*=\s*(.*)$/i);
  if (!match) return null;
  const rest = match[2];
  // only bails when a second `=` sits before the trailing bracket (rest itself reads like "key = value [...]"); a bracket
  // with no `=` at all — a valueless trait such as {legendary} or {keysmash} — must not trip this, or the line's entry
  // ends up filed under the wrong attribute and vanishes from its list (see core/type-text.js's `of`)
  if (rest.endsWith('}') && rest.indexOf('=') !== -1 && rest.lastIndexOf('{') > rest.indexOf('=')) return null;
  return { key: match[1].toLowerCase(), value: rest };
}

const TRAIT_ROW = /^#\s+([a-z]+)\s+(-?\d*\.?\d+|on|off)\s/i;
const DISTRIBUTION = 'distribution';
export function parseSections(text, { traits: table = TRAITS, file, attributes = null, settings = [] } = {}) {
  const sections = {}, starts = {};
  let distribution = null, current = null;
  text.split(/\r?\n/).forEach(raw => {
    const line = raw.trim();
    const row = line.match(TRAIT_ROW), key = row && row[1].toLowerCase();
    if (row && table[key]) {
      const value = row[2].toLowerCase(), trait = table[key];
      starts[key] = Math.max(trait.min, Math.min(trait.max, value === 'on' ? 1 : value === 'off' ? 0 : parseFloat(value)));
    }
    if (!line || line.startsWith('#')) return;
    const heading = line.match(/^\[([^[\]]+)\]$/);
    if (heading) {
      current = heading[1].trim().toLowerCase();
      if (current === DISTRIBUTION) { distribution = []; return; }
      sections[current] = sections[current] || {};
      return;
    }
    if (!current) return;
    if (current === DISTRIBUTION) {
      const counts = parseCounts(line);
      if (counts) distribution.push(counts);
      else warnOnce(`Kallipolis: in ${file}, "${line}" under [${DISTRIBUTION}] isn't counts and a weight (see core/entries.js)`);
      return;
    }
    const pair = pairOf(line), pairKey = pair && pair.key;
    // an attribute line is an entry in its value alone, so `name = Train` and `loves = Shoooom {choiceweight = 2}` read
    // as "Train" and "Shoooom" with that trait; a line with no `=` (the people/*.txt lists) is the whole entry
    const entry = entryOf(pair ? pair.value : line, { traits: table, file });
    if (!entry.text) return;
    if (pair && attributes && !attributes.includes(pairKey) && !settings.includes(pairKey)) {
      warnOnce(`Kallipolis: in ${file}, "${line}" isn't an "attribute = value" line (${attributes.concat(settings).join(', ')}) under a [section]`);
      return;
    }
    // `group` is the attribute the line belongs to: its own name where that's one of the reader's, else the heading (which
    // is what a file of plain lists, like people's, ends up using for every line under it)
    const group = pair ? (pairKey === current ? 'lines' : pairKey) : current;
    // a setting like `enterable = yes` is kept as a plain entry, so the reader reads it the same way as any other value
    const kept = pair && settings.includes(pairKey) ? plainEntry(pair.value) : entry;
    (sections[current][group] = sections[current][group] || []).push(...weighted(kept));
  });
  return { sections, starts, distribution };
}

// The traits a set of entries give, combined and kept to each trait's range. `start` is the value each trait starts at.
export function combineTraits(entries, table = TRAITS, start = startingTraits(table)) {
  const traits = { ...start };
  entries.forEach(entry => entry.traits.forEach(([key, value]) => {
    const { combine } = table[key];
    traits[key] = combine === 'add' ? traits[key] + value : combine === 'on' ? (value > 0 ? 1 : traits[key]) : traits[key]*value;
  }));
  Object.entries(table).forEach(([key, trait]) => { traits[key] = Math.max(trait.min, Math.min(trait.max, traits[key])); });
  return traits;
}

// ---- how many of each: picking several entries per attribute
// How many of a counted attribute a thing gets when its file doesn't say: mostly one of each, sometimes two of one and
// none of the other. One count per counted attribute, then how likely that row is relative to the others (see
// pickCounts) — so a file only needs its own table where it wants a different spread (people's loves and hates — people/about.txt —
// cars' loves and hates and so on all get this one).
export const DEFAULT_COUNTS = [[1, 1, 0.6], [2, 0, 0.1], [0, 2, 0.1], [2, 1, 0.1], [1, 2, 0.1]];
const limitsOf = entry => entry.rules.filter(([key]) => key === 'limit').map(([, value]) => ({ rule: value.slice(0, -1), polarity: value.slice(-1) }));
// An entry with more text than this is long, and a thing can have only one long entry among its loves and hates (they
// don't fit a card side by side).
const LONG_ENTRY_LENGTH = 30;
const isLong = entry => entry.text.length > LONG_ENTRY_LENGTH;
// Two entries clash when they hold the same limit on opposite sides (1a and 1b), or are both long.
export function clash(a, b) {
  if (isLong(a) && isLong(b)) return true;
  const bLimits = limitsOf(b);
  return limitsOf(a).some(x => bLimits.some(y => x.rule === y.rule && x.polarity !== y.polarity));
}
export const isSolo = entry => entry.traits.some(([key, value]) => key === 'solo' && value > 0);
// The rarity tier an entry's own traits mark it as (core/traits.js's legendary and terrible), for card colouring
// (ui/entity-card.js): 'legendary', 'terrible', or null for anything else. Legendary wins if an entry somehow carries both.
const hasTrait = (entry, key) => entry.traits.some(([k, value]) => k === key && value > 0);
export const tierOf = entry => hasTrait(entry, 'legendary') ? 'legendary' : hasTrait(entry, 'terrible') ? 'terrible' : null;
// An entry's modifiers as card lines (see modifierLines in core/traits.js), for the drop-down under it (ui/entity-card.js).
export const modifiersOf = entry => modifierLines(entry.traits);

// `table` is rows of [count, count, ..., weight]: one count per attribute, then how likely the row is relative to the
// others. Returns the counts of the row that `roll` (0 to 1) lands on.
export function pickCounts(table, roll) {
  const total = table.reduce((sum, row) => sum + row[row.length - 1], 0);
  let reached = 0;
  const row = table.find(candidate => roll*total < (reached += candidate[candidate.length - 1])) ?? table[0];
  return row.slice(0, -1);
}

// One counts row of a [distribution]: "1, 1" or "2, 0 @ 3" as [1, 1, 3] — the counts, then their weight (1 by
// default). `columns` is how many counts the row should have; 0 takes however many it's written with. Null if it isn't
// whole numbers (one per column) and an optional weight, so the caller can say so.
export function parseCounts(value, columns = 0) {
  const match = value.match(/^([\d\s,]+?)\s*(?:@\s*(\d*\.?\d+))?$/);
  if (!match) return null;
  const numbers = match[1].split(',').map(part => parseInt(part, 10));
  return (columns ? numbers.length === columns : numbers.length >= 1) && numbers.every(Number.isInteger)
    ? [...numbers, match[2] ? parseFloat(match[2]) : 1]
    : null;
}

// Adds entries from `list` to `mine` until it has `count`. `sides` holds every list of chosen entries (`mine` among them):
// an entry is skipped if it has the same text as, or a limit clashing with, any of them. A solo entry is never added to a
// non-empty list, and a list holding one stops there, so the result can end lower than `count`. Gives up after 50 tries.
export function addEntries(mine, list, count, rng, sides) {
  const target = mine.some(isSolo) ? 1 : count;
  for (let tries = 0; mine.length < target && tries < 50; tries++) {
    const entry = list[Math.floor(rng()*list.length)];
    if (isSolo(entry) && mine.length) continue;
    if (sides.flat().every(other => other.text !== entry.text && !clash(entry, other))) mine.push(entry);
  }
}

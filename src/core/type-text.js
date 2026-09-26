import { mulberry32 } from './math.js';
import { DEFAULT_COUNTS, parseSections, entryOf, plainEntry, weighted, combineTraits, pickCounts, addEntries, clash, tierOf, modifiersOf } from './entries.js';

// ============================================================ what a kind of thing is like
// The reader for the files saying what each kind of thing is like on its card (see ui/entity-card.js): assets/text/cars.txt by
// vehicle type, assets/text/buildings.txt by kind of building, assets/text/trains.txt by carriage. They're all one format, so
// they're all read here: a [section] per kind, with `attribute = value` lines under it, any of which can be given several
// times to have each thing of that kind pick one. A kind falls back along a chain — itself, then whatever `fallbacks`
// says it belongs to, then [default] — so a section need only say what it does differently.
// Attribute values are entries (see core/entries.js): they can carry {traits}, `limit` rules and `choiceweight`.
//
// `attributes` are the row keys the file fills in (see TEXT_ROWS), `settings` any lines that aren't card text (buildings'
// `enterable`), and `placeholder` what to use until the file has loaded, or if it can't be. Any trait in core/traits.js
// can go on a value; `of` returns the combined traits of what a thing picked, as `traits`.
//
// `counted` lists attributes that can have several values at once (a car loving two things, say). Each is then returned
// as a list, and the file sets how many with `counts = a, b @ weight` lines (one number per counted attribute, in
// `counted` order; the weight is relative and defaults to 1): `counts = 1, 1 @ 6` and `counts = 2, 0 @ 1` make one in
// seven things love two and hate none. Without `counts` lines every counted attribute has one value.
export function loadTypeText(url, { attributes, settings = [], fallbacks = {}, placeholder = {}, counted = [] }) {
  const file = url.split('/').pop();
  let types = Object.fromEntries(Object.entries(placeholder).map(([kind, type]) => [
    kind, Object.fromEntries(Object.entries(type).map(([key, values]) => [key, attributes.includes(key) ? values.map(plainEntry) : values])),
  ]));
  // how many of each counted attribute a thing gets: the file's own [distribution], or the shared spread people's
  // loves and hates get (see DEFAULT_COUNTS). Kept out of the sections above: it applies to every kind in the file alike.
  let distribution = null;

  fetch(url)
    .then(response => { if (!response.ok) throw new Error(`${response.status} ${response.statusText}`); return response.text(); })
    .then(text => {
      const parsed = parseSections(text, { file, attributes, settings });
      types = parsed.sections;
      distribution = parsed.distribution;
      // a distribution with the wrong number of columns is no use: say so and fall back to the shared one
      if (distribution && counted.length && distribution.some(row => row.length !== counted.length + 1)) {
        console.warn(`Kallipolis: in ${file}, [distribution] rows need ${counted.length} counts and a weight; using the default spread instead`);
        distribution = null;
      }
    })
    .catch(err => console.warn(`Kallipolis: ${url} failed to load; those get placeholder cards`, err));

  // what a kind falls back to, nearest first
  function chainFor(kind) {
    const key = (kind || '').toLowerCase();
    return [types[key], types[fallbacks[key]], types.default].filter(Boolean);
  }
  return {
    // What a thing's card says: `kind` is what it is, and `number` its own number among others of its kind, which decides
    // which it gets of an attribute given several times. A kind nothing names falls back to being called by its own name.
    // Counted attributes come back as lists of text, the rest as text; `traits` is the combined traits of what was picked, and
    // a counted attribute also gets its own `<attribute>Tier` list (tierOf) alongside its text, entry for entry.
    of(kind, number = 1) {
      const chain = chainFor(kind);
      const entriesFor = attribute => chain.map(t => t[attribute]).find(v => v && v.length);
      const firstFor = attribute => { const entries = entriesFor(attribute); return entries && entries[(number - 1) % entries.length]; };
      const picked = [], said = {};
      attributes.filter(attribute => !counted.includes(attribute)).forEach(attribute => {
        const entry = firstFor(attribute);
        said[attribute] = entry ? entry.text : attribute === 'name' && kind ? kind : '';
        if (entry) picked.push(entry);
      });
      const base = [...picked];
      if (counted.length) {
        const rng = mulberry32(number*104729 + 31);
        // the file's own [distribution] where it has one, then the shared spread, then one each where there are more
        // counted attributes than a two-column table can describe
        const counts = distribution ? pickCounts(distribution, rng())
          : counted.length === 2 ? pickCounts(DEFAULT_COUNTS, rng())
          : counted.map(() => 1);
        // the first of each, unless it clashes with one already chosen; addEntries then fills the rest from the others
        const chosen = counted.map(() => []);
        counted.forEach((attribute, i) => {
          const first = counts[i] >= 1 && firstFor(attribute);
          if (first && !chosen.flat().some(other => clash(first, other))) chosen[i].push(first);
        });
        counted.forEach((attribute, i) => { if (entriesFor(attribute)) addEntries(chosen[i], entriesFor(attribute), counts[i], rng, chosen); });
        // `<attribute>Tier` runs alongside it: which of its entries are legendary or terrible (see tierOf), for the card to
        // colour that row (ui/entity-card.js) — null for an entry that's neither. `<attribute>Mods` likewise: each entry's
        // modifier lines (see modifiersOf), for the drop-down under its row.
        counted.forEach((attribute, i) => {
          said[attribute] = chosen[i].map(entry => entry.text);
          said[attribute + 'Tier'] = chosen[i].map(tierOf);
          said[attribute + 'Mods'] = chosen[i].map(modifiersOf);
          picked.push(...chosen[i]);
        });
      }
      // baseTraits: the kind's own and its mood's alone, before loves and hates (for the car Details window: life/car-details.js)
      return { ...said, traits: combineTraits(picked), baseTraits: combineTraits(base) };
    },
    // Every value a kind gives for a setting (see `settings`), as text: its own, else the nearest in the chain that has any.
    // For settings that are lists rather than yes or no (cars' `plate`).
    listOf(kind, setting) {
      const said = chainFor(kind).map(t => t[setting]).find(v => v && v.length);
      return said ? said.map(entry => (entry.text ?? entry).trim()) : [];
    },
    // A number setting (see `settings`): the nearest in the chain that says anything, as a number (`60%` reads as 0.6), or
    // `fallback` where nothing is said or it isn't a number.
    numberOf(kind, setting, fallback) {
      const said = chainFor(kind).map(t => t[setting]).find(v => v && v.length);
      const text = said ? String(said[said.length - 1].text ?? said[said.length - 1]).trim() : '';
      const value = parseFloat(text)/(text.endsWith('%') ? 100 : 1);
      return Number.isFinite(value) ? value : fallback;
    },
    // A yes/no setting (see `settings`): whether the nearest thing in the chain that says anything says yes. Nothing
    // said is no, so a setting only turns on where it's been thought about. The setting is kept as an entry, so it's the
    // entry's text that's read: `enterable = yes` is an entry saying "yes".
    says(kind, setting) {
      const said = chainFor(kind).map(t => t[setting]).find(v => v && v.length);
      const last = said && said[said.length - 1];
      return !!last && /^(yes|true|on|1)$/i.test((last.text ?? last).trim());
    },
  };
}

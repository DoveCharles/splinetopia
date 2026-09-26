// ============================================================ who likes whom
// A score per pair (keyed by person id, one-sided: a → b can differ from b → a). First contact seeds it from shared
// and clashing loves/hates; chats, fights and what they see move it. The person card's Social tab ranks it (ranked).

const TASTE_SHARED = 6, TASTE_CLASH = 8; // per love/hate in common, per love of one that the other hates
const MAX_KNOWN = 64; // pairs kept per person; the weakest feelings are forgotten past it
const PRUNE_EVERY = 30; // seconds between dropping the gone (see pruneGone)

// how much each thing moves the score
export const RELATE = { chat: 6, circle: 3, roomChat: 4, badChat: -15 };
// felt (see feel in people.js): towards whoever did it
const FELT = { punched: -30, hitbycar: -15 };
// seen (see notice in people.js): towards whoever did it
const SAW = { punch: -6, beatentodeath: -20, killedbycar: -12 };

const scores = new Map(); // id → Map(otherId → score)
const met = new Map();    // id → Set of ids they've finished a conversation with (introduced; both ways)
let prunedAt = 0;

const isPerson = q => !!q && typeof q.id === 'number' && 'walkCycle' in q;
const lowered = list => (list ?? []).map(s => String(s).toLowerCase());
function tasteBetween(a, b) {
  const aLoves = new Set([...lowered(a.loves), ...lowered(a.lovedWords)]), aHates = new Set([...lowered(a.hates), ...lowered(a.hatedWords)]);
  const bLoves = new Set([...lowered(b.loves), ...lowered(b.lovedWords)]), bHates = new Set([...lowered(b.hates), ...lowered(b.hatedWords)]);
  let shared = 0, clash = 0;
  bLoves.forEach(x => { if (aLoves.has(x)) shared++; if (aHates.has(x)) clash++; });
  bHates.forEach(x => { if (aHates.has(x)) shared++; if (aLoves.has(x)) clash++; });
  return shared*TASTE_SHARED - clash*TASTE_CLASH;
}

function forgetWeakest(known) {
  let weakest = null, least = Infinity;
  known.forEach((score, id) => { if (Math.abs(score) < least) { least = Math.abs(score); weakest = id; } });
  known.delete(weakest);
}

/** Moves how `p` feels about `other` by `delta`, seeding it from their tastes the first time. */
export function relate(p, other, delta) {
  if (!isPerson(p) || !isPerson(other) || p === other) return;
  let known = scores.get(p.id);
  if (!known) scores.set(p.id, known = new Map());
  known.set(other.id, (known.get(other.id) ?? tasteBetween(p, other)) + delta);
  if (known.size > MAX_KNOWN) forgetWeakest(known);
}
export function relateBoth(a, b, delta) { relate(a, b, delta); relate(b, a, delta); }
/** Everyone in `members` towards everyone else in it. */
export function relateAll(members, delta) {
  members.forEach(a => members.forEach(b => { if (a !== b) relate(a, b, delta); }));
}
/** How `p` feels about `other` (undefined if they've never had cause to). */
export const feelingFor = (p, other) => scores.get(p?.id)?.get(other?.id);
/** Whether two have been introduced: finished a conversation together (see introduceAll). */
export const introduced = (a, b) => !!met.get(a?.id)?.has(b?.id);
/** Everyone in `members` introduced to everyone else in it. */
export function introduceAll(members) {
  members.forEach(a => members.forEach(b => {
    if (a === b || !isPerson(a) || !isPerson(b)) return;
    let known = met.get(a.id);
    if (!known) met.set(a.id, known = new Set());
    known.add(b.id);
  }));
}
export function relateFelt(p, what, by) { if (FELT[what]) relate(p, by, FELT[what]); }
export function relateSaw(q, what, by) { if (SAW[what]) relate(q, by, SAW[what]); }

/**
 * `p`'s top `count` friends (score > 0, highest first) and enemies (score < 0, lowest first), among those in `byId`
 * (id → person, the living).
 */
export function ranked(p, byId, count = 3) {
  const friends = [], enemies = [];
  scores.get(p?.id)?.forEach((score, id) => {
    const q = byId.get(id);
    if (!q) return;
    if (score > 0) insertTop(friends, { person: q, score }, (x, y) => x.score > y.score, count);
    else if (score < 0) insertTop(enemies, { person: q, score }, (x, y) => x.score < y.score, count);
  });
  return { friends, enemies };
}
function insertTop(list, item, before, count) {
  let i = list.length;
  while (i > 0 && before(item, list[i - 1])) i--;
  if (i >= count) return;
  list.splice(i, 0, item);
  if (list.length > count) list.pop();
}

/** Drops scores held by or about anyone no longer in `people`, every PRUNE_EVERY seconds. `extra` is called with the living ids too. */
export function pruneGone(people, now, extra = null) {
  if (now - prunedAt < PRUNE_EVERY) return;
  prunedAt = now;
  const living = new Set(people.map(q => q.id));
  [scores, met].forEach(all => all.forEach((known, id) => {
    if (!living.has(id)) { all.delete(id); return; }
    known.forEach((_, other) => { if (!living.has(other)) known.delete(other); });
  }));
  extra?.(living);
}

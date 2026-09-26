import { mulberry32 } from '../core/math.js';
import { DEFAULT_COUNTS, startingTraits, plainEntry, parseSections, combineTraits, pickCounts, addEntries, clash, tierOf, modifiersOf } from '../core/entries.js';
import { TRAITS } from '../core/traits.js';

const LETTERS = ['A.','B.','C.','D.','E.','F.','G.','H.','I.','J.','K.','L.','M.','N.','O.','P.','Q.','R.','S.','T.','U.','V.','W.','X.','Y.','Z.','Ñ.']
const ROMAN_NUMERALS = [ 'II', 'III','II', 'III', 'IV', 'V','VI','VII','VII','IX']

// ============================================================ who people are
// Everyone in the crowd has a name, an age, a mood, and loves and hates, picked from the lists in assets/text/people/ (one
// file per list; see PEOPLE_FILES). The picks are the same every time for the same person id (see peopleIdSeq in
// people.js — not their place in the crowd, which just changes who's currently standing in that slot), and any traits
// they carry change how that person behaves (see the list in people/about.txt, and people.js). person-card.js displays a
// profile.
// How many loves and hates each person gets is the shared spread in core/entries.js (DEFAULT_COUNTS), the same one every
// other kind falls back to.
const PEOPLE_TEXT_DIR = 'assets/text/people/';
// The files, and the [heading] each is read under: they're joined into one text in this order and read as ever by
// parseSections. about.txt has no heading of its own — it's the notes, the trait table and the [distribution]. Unisex
// names go into both the boy and girl names.
const PEOPLE_FILES = [
  { file: 'about' },
  { file: 'boynames', heading: 'Boy names' }, { file: 'unisexnames', heading: 'Boy names' },
  { file: 'girlnames', heading: 'Girl names' }, { file: 'unisexnames', heading: 'Girl names' },
  { file: 'surnames', heading: 'Surnames' }, { file: 'nicknames', heading: 'Nicknames' }, { file: 'moods', heading: 'Moods' },
  { file: 'loves', heading: 'Loves' }, { file: 'hates', heading: 'Hates' },
];
// the value everyone starts with, by trait: each trait's base until the files load, then whatever its trait table's start
// column says (see parseSections) — updated in place, so people holding it see the file's values
export const DEFAULT_TRAITS = startingTraits();

let version = 0; // counts up each time the people files load, so what was worked out from it can be worked out again
const listeners = [];
// how many loves and hates a person gets, until about.txt says (its [distribution]) — the shared spread
let counts = DEFAULT_COUNTS;

// the lists, by their headings in PEOPLE_FILES (matched the way parseSections keys them: lowercase) — these stand in until
// it's loaded, or if it can't be
const lists = { 'boy names': ['Dave'], 'girl names': ['Linda'], 'surnames': ['Smith'], 'nicknames': ['The Bug'], 'moods': ['😐'], 'loves': ['A nice walk'], 'hates': ['Puddles'] };
Object.keys(lists).forEach(key => { lists[key] = lists[key].map(plainEntry); });

// one file's text; a missing one is warned about and read as empty, so the rest still load
const readPeopleFile = file => fetch(`${PEOPLE_TEXT_DIR}${file}.txt`)
  .then(response => { if (!response.ok) throw new Error(`${response.status} ${response.statusText}`); return response.text(); })
  .catch(err => { console.warn(`Kallipolis: ${PEOPLE_TEXT_DIR}${file}.txt failed to load; left out`, err); return ''; });

const fileNames = [...new Set(PEOPLE_FILES.map(part => part.file))];
Promise.all(fileNames.map(readPeopleFile))
  .then(texts => {
    const textOf = Object.fromEntries(fileNames.map((file, i) => [file, texts[i]]));
    // (each heading once, with every file under it one after another)
    const parts = [];
    PEOPLE_FILES.forEach(({ file, heading }) => {
      const last = parts[parts.length - 1];
      if (heading && last?.heading === heading) last.texts.push(textOf[file]);
      else parts.push({ heading, texts: [textOf[file]] });
    });
    const text = parts.map(({ heading, texts }) => (heading ? `[${heading}]\n` : '') + texts.join('\n')).join('\n');
    const { sections, starts, distribution } = parseSections(text, { file: 'people/*.txt' });
    Object.assign(DEFAULT_TRAITS, starts);
    // how many loves and hates each person gets: the file's own [distribution], or the shared spread (see DEFAULT_COUNTS)
    counts = distribution && distribution.length ? distribution : DEFAULT_COUNTS;
    Object.keys(lists).forEach(key => { const section = sections[key]; if (section && section[key] && section[key].length) lists[key] = section[key]; });
    version++;
    listeners.forEach(listener => listener());
  })
  .catch(err => console.warn('Kallipolis: the people files failed to load; people get placeholder names', err));

export const profilesVersion = () => version;
// Fills an entry's [placeholders] for a card, once speech has loaded (life/speech-text.js hands it over): (entry, rng) →
// { card, said, words }. Until then entries show as written.
let fillEntry = null;
export function setEntryFiller(fill) {
  fillEntry = fill;
  version++;
  listeners.forEach(listener => listener());
}
// `listener` is called whenever the people files have loaded
export function onProfilesLoaded(listener) { listeners.push(listener); }

// Someone's name, age, mood, loves and hates (lists; from people/loves.txt and hates.txt), and the traits those give them — a man's name from the boy names and
// a woman's from the girl names (either, for the cuboid people, who have no sex). `id` is their person id (see peopleIdSeq
// in people.js), not their place in the crowd — so the same id always comes back as the same person, wherever they're standing.
export function profileOf(id, isMan) {
  const rng = mulberry32(48271 + id*7919);
  const pick = list => list[Math.floor(rng()*list.length)];
  const man = isMan == null ? rng() < 0.5 : isMan;
  const name = pick(lists[man ? 'boy names' : 'girl names']);
  let age = 18 + Math.floor(rng()*65);
  const mood = pick(lists.moods);
  const firstLove = pick(lists.loves);

  // (gives up after 50 tries, leaving no first hate, if nothing in the list goes with what they enjoy)
  let hates, incompatible = true;
  for (let tries = 0; incompatible && tries < 50; tries++) {
    hates = pick(lists.hates);
    incompatible = clash(firstLove, hates);
  }

  // The counts and any extra picks use their own random stream, so adding to the picks made on `rng` above does not change
  // the names, ages and moods of existing people. Keep new random draws for a profile on `extra`, not `rng`.
  const extra = mulberry32(90173 + id*6151);
  const [loveCount, hateCount] = pickCounts(counts, extra());
  const loves = loveCount >= 1 ? [firstLove] : [], hated = hateCount >= 1 && !incompatible ? [hates] : [];
  addEntries(loves, lists.loves, loveCount, extra, [loves, hated]);
  addEntries(hated, lists.hates, hateCount, extra, [loves, hated]);

  const traits = combineTraits([name, mood, ...loves, ...hated], TRAITS, DEFAULT_TRAITS);

  const nameRoll = rng();

  let fullname = traits.nickname ? pick(lists['nicknames']).text :                                    //nickname only - requires trait
    nameRoll>0.9 ? `${name.text} '${pick(lists['nicknames']).text}' ${pick(lists['surnames']).text}`: //full name w/ nickname, 10%
    nameRoll>0.3 ? `${name.text} ${pick(lists['surnames']).text}`:                                    //full name no nickname, 60%
      nameRoll>0.2? `${name.text} ${pick(LETTERS)} ${pick(lists['surnames']).text}`:                 //full name, abr middle, 10%
        nameRoll>0.115?`'${pick(lists['nicknames']).text}' ${pick(lists['surnames']).text}`:           //nickname surname, 8.5%
          nameRoll>0.2?`${name.text} '${pick(lists['nicknames']).text}'`:                            //forename nickname, 8.5%
            `${name.text} ${pick(ROMAN_NUMERALS)}`;                                               //forename numeral, 2%

  //unknown entities have hidden traits
  // (UNKNOWN) people hide every love, every hate, or both — never neither. A hidden side that has no entries shows a single
  // (UNKNOWN), with no tier (nothing to colour gold or dark reddish-brown while it's a mystery).
  // (placeholders filled on their own stream, so filling doesn't change anything else picked)
  const fillRng = mulberry32(60013 + id*3371);
  const filledOf = entry => fillEntry ? fillEntry(entry, fillRng) : { card: entry.text, said: entry.said ?? entry.text, words: [] };
  const lovesFilled = loves.map(filledOf), hatesFilled = hated.map(filledOf);
  let loveTexts = lovesFilled.map(filled => filled.card), hateTexts = hatesFilled.map(filled => filled.card);
  let loveTiers = loves.map(tierOf), hateTiers = hated.map(tierOf);
  let loveMods = loves.map(modifiersOf), hateMods = hated.map(modifiersOf);
  if (name.text === '(UNKNOWN)') {
    fullname = '(UNKNOWN)';
    const hidden = texts => texts.length ? texts.map(() => '(UNKNOWN)') : ['(UNKNOWN)'];
    const lovesHidden = rng() > 0.5;
    const hatesHidden = !lovesHidden || rng() > 0.5;
    if (lovesHidden) { loveTexts = hidden(loveTexts); loveTiers = loveTexts.map(() => null); loveMods = loveTexts.map(() => []); }
    if (hatesHidden) { hateTexts = hidden(hateTexts); hateTiers = hateTexts.map(() => null); hateMods = hateTexts.map(() => []); }
  }

  age = Math.round(Math.max(18, age*traits.agemult)) //no minors!

  // `loves` and `hates` are lists of text; at most one is ever empty. `lovesTier`/`hatesTier` run alongside, entry for
  // entry (see tierOf): 'legendary' or 'terrible' or null, for the card to colour that entry's row (ui/entity-card.js).
  // `lovesMods`/`hatesMods` likewise: each entry's modifier lines (see modifiersOf) — none for a hidden (UNKNOWN) one.
  // `lovesSaid`/`hatesSaid`: the same, worded for speech (never hidden); `lovedWords`/`hatedWords`: words filled into them
  return { name: fullname, age, mood: mood.text, loves: loveTexts, hates: hateTexts,
    lovesSaid: lovesFilled.map(filled => filled.said), hatesSaid: hatesFilled.map(filled => filled.said),
    lovedWords: lovesFilled.flatMap(filled => filled.words), hatedWords: hatesFilled.flatMap(filled => filled.words), lovesTier: loveTiers, hatesTier: hateTiers, lovesMods: loveMods, hatesMods: hateMods, traits: traits};
}

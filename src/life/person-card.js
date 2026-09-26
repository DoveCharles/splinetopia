import * as THREE from 'three';
import { App } from '../core/shared.js';
import { scene, renderer } from '../core/scene.js';
import { HEADSHOT_LAYER, personModel, isGone, inRoom } from './people/people.js';
import { personDoing } from './people/peopleTracking.js';
import { profileOf, onProfilesLoaded } from './profiles.js';
import { strikeLightning } from './lightning.js';
import { makeCard } from '../ui/entity-card.js';
import { personKey, reviveFavoritesAs } from '../ui/favorites.js';
import { garbles, garbled } from '../ui/garble.js';
import { ranked } from './people/peopleRelations.js';
import { recentLines, onLineLogged } from './people/peopleSaid.js';

// ============================================================ person cards
// Who someone is, in a card at the bottom right while the camera follows them (see "following someone" in people.js): their
// name, age, mood, loves and hates, from assets/text/people/*.txt (see profiles.js). The same person always gets the same
// card. The card itself is the shared one in ui/entity-card.js; people are the one kind of thing whose text doesn't come
// from a [section] file, since people/*.txt does rather more (weighted lines, traits) than the rest.
//
// Up to two are open: a name clicked in the Social tab opens the other beside it. The camera follows the focused one;
// clicking a card focuses it (App.followPerson), and closing the focused one hands focus to the other.
// (someone with the scramble or keysmash trait has the text on their card garbled, name and age aside: see ui/garble.js)

const HEADSHOT_SIZE = 120; // pixels across (shown half that, sharp on high-density screens)
const HEADSHOT_INTERVAL = 1/15, OTHER_HEADSHOT_INTERVAL = 1/4; // (the unfocused card's face is redrawn less often)
const OTHER_POLL = 500; // ms between the unfocused card's status checks
const BESIDE_GAP = 10; // px between the two cards
const SOCIAL_TOP = 3, SOCIAL_REFRESH = 1000;
const PLACEHOLDER_EFFECTS = Array.from({ length: 3 }, () => ({ icon: '💊', title: 'Placeholder' }));
const clearColor = new THREE.Color();

const windows = [makePersonWindow('person-card'), makePersonWindow('person-card-2')];
let focused = null; // the window the camera follows
let keepOnHide = null; // (a window left open through stopFollowingPerson: see closeWindow)
const openWindows = () => windows.filter(w => w.shown);
const otherThan = w => windows.find(x => x !== w);

function makePersonWindow(id) {
  const w = { shown: null }; // shown: { index, id, isMan, traits, seed, beside }
  const card = w.card = makeCard({
    id,
    title: 'Ped',
    health: true,
    tabs: ['Overview', 'Pockets', 'Needs', 'Social'],
    effects: true,
    onClose: () => closeWindow(w),
    // the headshot itself: into their head (see possession.js)
    thumb: { title: 'Possess them', onClick: () => { if (w.shown) App.possessPerson(w.shown.index); } },
    // the Smite button, under their headshot: a bolt of lightning comes down on them (see lightning.js) and they explode
    // (see killPerson in people.js), and the card goes
    kill: { title: 'Strike them down', onClick: () => {
      const p = personOf(w);
      if (!p) return;
      strikeLightning({ x: p.x, y: p.y, z: p.z });
      App.killPerson(w.shown.index);
    } },
  });
  // clicking anywhere on it (but its close box) focuses its person
  card.el.addEventListener('pointerdown', e => {
    if (!w.shown || w === focused || e.target.closest('.win3-sysbox, .card-close')) return;
    if (w.shown.beside) App.followPersonInside(w.shown.index); else App.followPerson(w.shown.index);
  });
  card.setEffects(PLACEHOLDER_EFFECTS);

  // ---- the headshot: a live close-up of their face, beside their name — drawn a few times a second (people.js hands over
  // where their head is and which way it faces) from a camera just in front of it that sees only the people, on a clear
  // background, into a render target of its own, copied onto the card's canvas once the GPU has the pixels (read back
  // asynchronously: a plain readPixels waits for the whole frame to finish drawing)
  w.target = new THREE.WebGLRenderTarget(HEADSHOT_SIZE, HEADSHOT_SIZE);
  w.camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
  w.camera.layers.set(HEADSHOT_LAYER);
  w.canvas = card.canvas;
  w.context = w.canvas.getContext('2d');
  w.image = w.context.createImageData(HEADSHOT_SIZE, HEADSHOT_SIZE);
  w.pixels = new Uint8Array(HEADSHOT_SIZE*HEADSHOT_SIZE*4);
  w.drawnAt = -Infinity; w.lightsOnLayer = false; w.reading = false;

  // ---- the Social tab: top friends and enemies (peopleRelations.js), re-ranked every SOCIAL_REFRESH while open, and their
  // recent lines (peopleSaid.js), newest first, updated as they're said. A name opens that person in the other card.
  const pane = card.tabPane('social');
  pane.innerHTML = '<div class="pc-rel"><div class="pc-rel-col pc-rel-friends"><div class="pc-rel-head">Friends</div></div>'
    + '<div class="pc-rel-col pc-rel-enemies"><div class="pc-rel-head">Enemies</div></div></div>'
    + '<div class="pc-said"><div class="pc-said-head">Recent thoughts</div><div class="pc-said-list"></div></div>';
  const slots = col => Array.from({ length: SOCIAL_TOP }, () => {
    const slot = document.createElement('div');
    slot.className = 'pc-rel-name';
    slot.addEventListener('click', () => { if (slot.person) openBeside(w, slot.person); });
    pane.querySelector(col).append(slot);
    return slot;
  });
  w.friendSlots = slots('.pc-rel-friends'); w.enemySlots = slots('.pc-rel-enemies');
  w.saidList = pane.querySelector('.pc-said-list');
  w.socialTimer = null; w.socialShown = '';
  card.onTab(() => refreshSocial(w));
  return w;
}

// whoever's in the window's slot, if it's still the person it opened on (see peopleIdSeq in people.js)
function personOf(w) {
  const p = w.shown && App.people[w.shown.index];
  return p && p.id === w.shown.id ? p : null;
}
const isManAt = i => personModel ? personModel.isMan[i] === 1 : null;

// Fills window `w` with the person at `index`. `beside`: picked in a building's room, so the card sits to the left of the
// building's, without its Smite button (see followPersonInside in people/peopleTracking.js)
function fill(w, index, isMan, beside = false) {
  const { card } = w;
  // whoever's actually standing in that slot right now, not the slot itself — see peopleIdSeq in people.js
  const id = App.people[index]?.id ?? index, profile = profileOf(id, isMan);
  const { traits } = profile, again = w.shown?.index === index; // (again: people/*.txt just loaded, under an open card)
  w.shown = { index, id, isMan, traits, seed: profile.age, beside };
  card.el.classList.toggle('pc-beside', beside);
  card.relabel(garbles(traits) ? text => garbled(text, traits, profile.age) : null); // (the headings too: "Loves", "Hates", the title...)
  // loves and hates are lists: one line per entry, and an empty list hides its row. The traits aren't shown: they're what
  // the person does, not what the card says about them.
  card.show({ name: profile.name, age: profile.age, mood: profile.mood,
    loves: garbled(profile.loves, traits, profile.age), hates: garbled(profile.hates, traits, profile.age),
    lovesTier: profile.lovesTier, hatesTier: profile.hatesTier, lovesMods: profile.lovesMods, hatesMods: profile.hatesMods });
  // (no headshot of a cuboid person, before the people model has loaded)
  w.context.clearRect(0, 0, HEADSHOT_SIZE, HEADSHOT_SIZE);
  w.canvas.hidden = isMan == null;
  w.drawnAt = -Infinity;
  w.lightsOnLayer = false;
  if (again) setDoing(w, w.doing, w.away); else setDoing(w, null);
  if (App.people[index]) card.setFavorite(personFavorite(App.people[index].id));
  card.bindHealth(App.people[index] ?? null, 'person');
  w.socialShown = '';
  refreshSocial(w);
}
function hideWindow(w) {
  w.shown = null;
  w.placedBeside = false;
  w.card.hide();
  refreshSocial(w);
  if (focused === w) focused = null;
}

// (followPerson/followPersonInside): a person already in a window just takes the focus; anyone else fills the focused one
function showPersonCard(index, isMan, beside = false) {
  const open = windows.find(w => w.shown?.index === index && personOf(w));
  if (open) { open.card.el.classList.toggle('pc-beside', beside); open.shown.beside = beside; focusWindow(open); return; }
  const w = focused ?? openWindows()[0] ?? windows[0];
  fill(w, index, isMan, beside);
  focusWindow(w);
}
function focusWindow(w) {
  focused = w;
  syncOtherPoll();
}
function hidePersonCard() {
  windows.forEach(w => { if (w !== keepOnHide) hideWindow(w); });
}
// the × on a window: the other (if open) takes over the camera, and takes the closed one's place if that wasn't itself
// opened beside; else the camera's let go
function closeWindow(w) {
  const other = otherThan(w);
  if (other.shown && !w.placedBeside) takePlace(other, w);
  if (w !== focused || !other.shown || !personOf(other)) { if (w === focused) App.stopFollowingPerson(); else hideWindow(w); syncOtherPoll(); return; }
  keepOnHide = other;
  App.stopFollowingPerson();
  keepOnHide = null;
  if (other.shown.beside) App.followPersonInside(other.shown.index); else App.followPerson(other.shown.index);
}
// a name in `from`'s Social tab: that person in the other window, beside `from`
function openBeside(from, person) {
  const index = App.people.indexOf(person);
  if (index < 0 || windows.some(w => personOf(w) === person)) return;
  const w = otherThan(from), wasOpen = !!w.shown;
  fill(w, index, isManAt(index));
  if (!wasOpen) { placeBeside(w.card.el, from.card.el); w.placedBeside = true; }
  syncOtherPoll();
}
// `w` slides (RESIZE-style translate, no layout per frame) into where `from` is: its dragged place, or the default one
const SNAP_TIME = 180;
function takePlace(w, from) {
  const el = w.card.el, place = from.card.el.style, before = el.getBoundingClientRect();
  if (place.left || place.top || place.right || place.bottom || place.transform) {
    Object.assign(el.style, { left: place.left, top: place.top, right: place.right, bottom: place.bottom, transform: place.transform });
  } else w.card.resetPlace();
  el.classList.toggle('pc-beside', from.card.el.classList.contains('pc-beside'));
  w.placedBeside = false;
  const after = el.getBoundingClientRect();
  el.animate([{ translate: `${before.left - after.left}px ${before.bottom - after.bottom}px` }, { translate: '0 0' }], { duration: SNAP_TIME, easing: 'ease-out' });
}
// to the left of `anchor`, bottoms lined up (to its right if there's no room)
function placeBeside(el, anchor) {
  const a = anchor.getBoundingClientRect(), width = el.offsetWidth;
  const left = a.left - BESIDE_GAP - width >= 0 ? a.left - BESIDE_GAP - width : Math.min(a.right + BESIDE_GAP, innerWidth - width);
  Object.assign(el.style, { left: left + 'px', right: 'auto', top: 'auto', bottom: innerHeight - a.bottom + 'px' });
}

// ---- what they're up to (see personDoing in people/peopleTracking.js), and whether they're `away` — indoors, out of
// sight, so the headshot greys over. The focused window is told (setPersonCardDoing, from showFollowedDoing); the other
// checks every OTHER_POLL, and closes if its person's gone.
function setDoing(w, doing, away = false) {
  w.doing = doing; w.away = away;
  w.card.set('status', doing == null ? null : garbled(doing, w.shown?.traits ?? {}, w.shown?.seed));
  w.canvas.classList.toggle('pc-away', away);
}
function setPersonCardDoing(doing, away = false) { if (focused) setDoing(focused, doing, away); }
let otherPoll = null;
function syncOtherPoll() {
  const want = openWindows().some(w => w !== focused);
  if (want && !otherPoll) otherPoll = setInterval(pollOthers, OTHER_POLL);
  if (!want && otherPoll) { clearInterval(otherPoll); otherPoll = null; }
}
function pollOthers() {
  openWindows().forEach(w => {
    if (w === focused) return;
    const p = personOf(w);
    if (!p || p.mode === 'dead') { hideWindow(w); syncOtherPoll(); return; }
    const doing = personDoing(p), away = isGone(p) && !!p.indoors && !inRoom(p);
    if (doing !== w.doing || away !== w.away) setDoing(w, doing, away);
  });
}

// ---- headshots (called from updatePeople in people.js with the person alone on the model): `index` defaults to the
// followed person's; otherHeadshotIndex says which unfocused window's person is due a redraw, if any
function drawPersonHeadshot(view, index = focused?.shown?.index) {
  const w = windows.find(x => x.shown?.index === index);
  if (!w || w.canvas.hidden || w.reading) return;
  const now = performance.now()/1000;
  if (now - w.drawnAt < (w === focused ? HEADSHOT_INTERVAL : OTHER_HEADSHOT_INTERVAL)) return;
  w.drawnAt = now;
  // the lights light them there too (put on the layer each time the card opens, to catch any added since)
  if (!w.lightsOnLayer) { scene.traverse(o => { if (o.isLight) o.layers.enable(HEADSHOT_LAYER); }); w.lightsOnLayer = true; }
  const camera = w.camera;
  camera.position.copy(view.head).addScaledVector(view.forward, view.distance);
  camera.up.copy(view.up);
  camera.lookAt(view.head);
  camera.near = view.distance*0.3;
  camera.updateProjectionMatrix();
  // drawn with the shadows as the view last drew them, and a clear background, then everything put back
  const target = renderer.getRenderTarget(), shadows = renderer.shadowMap.autoUpdate, clearAlpha = renderer.getClearAlpha();
  renderer.getClearColor(clearColor);
  renderer.shadowMap.autoUpdate = false;
  renderer.setClearColor(0x000000, 0);
  renderer.setRenderTarget(w.target);
  renderer.render(scene, camera);
  renderer.setRenderTarget(target);
  renderer.setClearColor(clearColor, clearAlpha);
  renderer.shadowMap.autoUpdate = shadows;
  w.reading = true;
  renderer.readRenderTargetPixelsAsync(w.target, 0, 0, HEADSHOT_SIZE, HEADSHOT_SIZE, w.pixels)
    .then(() => copyHeadshot(w), () => {}).finally(() => { w.reading = false; });
}
function otherHeadshotIndex() {
  const now = performance.now()/1000;
  const w = openWindows().find(x => x !== focused && !x.reading && !x.canvas.hidden && now - x.drawnAt >= OTHER_HEADSHOT_INTERVAL && personOf(x));
  return w ? w.shown.index : -1;
}
function copyHeadshot(w) {
  if (!w.shown) return;
  // (an empty frame — someone off screen isn't drawn: see personOnScreen in peopleModel.js — keeps the last face)
  let seen = false;
  for (let k = 3; k < w.pixels.length && !seen; k += 4) seen = w.pixels[k] > 0;
  if (!seen) return;
  // (the render target's rows run bottom to top)
  const rowBytes = HEADSHOT_SIZE*4;
  for (let y=0;y<HEADSHOT_SIZE;y++) w.image.data.set(w.pixels.subarray((HEADSHOT_SIZE - 1 - y)*rowBytes, (HEADSHOT_SIZE - y)*rowBytes), y*rowBytes);
  w.context.putImageData(w.image, 0, 0);
}

// ---- the Social tab's drawing
const socialOpen = w => !!w.shown && w.card.activeTab() === 'social';
function refreshSocial(w) {
  const open = socialOpen(w);
  if (open && !w.socialTimer) w.socialTimer = setInterval(() => drawRelations(w), SOCIAL_REFRESH);
  if (!open && w.socialTimer) { clearInterval(w.socialTimer); w.socialTimer = null; }
  if (open) { drawRelations(w); drawLines(w); }
}
function drawRelations(w) {
  const p = personOf(w);
  const byId = new Map(App.people.map(q => [q.id, q]));
  const { friends, enemies } = p ? ranked(p, byId, SOCIAL_TOP) : { friends: [], enemies: [] };
  const key = [...friends, ...enemies].map(r => r.person.id + ':' + Math.round(r.score)).join(',') + '|' + friends.length;
  if (key === w.socialShown) return;
  w.socialShown = key;
  const fillSlots = (slots, list) => slots.forEach((slot, i) => {
    const rel = list[i], name = document.createElement('span'), points = document.createElement('span');
    name.className = 'pc-rel-who'; points.className = 'pc-rel-points';
    name.textContent = rel?.person.name ?? '—';
    if (rel) { const score = Math.round(rel.score); points.textContent = (score > 0 ? '+' : '') + score; }
    slot.replaceChildren(name, points);
    slot.person = rel?.person ?? null;
    slot.title = rel ? rel.person.name + ' — open their window' : '';
    slot.classList.toggle('pc-rel-empty', !rel);
  });
  fillSlots(w.friendSlots, friends);
  fillSlots(w.enemySlots, enemies);
}
function drawLines(w) {
  const lines = recentLines(personOf(w));
  w.saidList.replaceChildren(...lines.slice().reverse().map(({ text, thought }) => {
    const line = document.createElement('div');
    line.className = 'pc-said-line' + (thought ? ' pc-said-thought' : '');
    line.textContent = thought ? text : '“' + text + '”';
    return line;
  }));
  if (!lines.length) w.saidList.textContent = 'Nothing yet';
}
onLineLogged(p => windows.forEach(w => { if (socialOpen(w) && p === personOf(w)) drawLines(w); }));

// (once people/*.txt has loaded, the cards show what it says)
onProfilesLoaded(() => openWindows().forEach(w => fill(w, w.shown.index, w.shown.isMan, w.shown.beside)));

// a person as a favorite: kept in the project by their id, not their place in the crowd (see peopleIdSeq in
// life/people/people.js) — they're never killed while hearted (see ui/favorites.js), so wherever they're currently
// standing is found again by searching for their id, not assumed to be a fixed slot
function personFavorite(id) {
  return { key: personKey(id), kind: 'Person', saved: { id }, spares: true,
    follow: () => { const i = App.people.findIndex(q => q.id === id); if (i < 0) return false; App.followPerson(i); return true; } };
}
// `saved.index` is a save from before people had their own persistent id, back when their place in the crowd was who
// they were: treating that old slot number as their id is the closest guess at reviving the right person
reviveFavoritesAs('Person', saved => Number.isInteger(saved.id) ? personFavorite(saved.id)
  : Number.isInteger(saved.index) && saved.index >= 0 ? personFavorite(saved.index) : null);

Object.assign(App, { showPersonCard, hidePersonCard, drawPersonHeadshot, otherHeadshotIndex, setPersonCardDoing });

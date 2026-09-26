import { App, S } from '../../core/shared.js';
import { feel, witness, voiceOfPerson, beginFleeing, buildingLabel, clipNamed, followed, groups, hasClip, moonwalkTurn, headingTo, indoorsCount, isGone, isOpenGround, modelScale, people, peopleNav, peopleNavBuiltAt, peopleRng, personModel, pickFrom, pickWeighted, playOnce, randomSpotIn, riderFollowed, setIndoorsCount, setRiderFollowed, sitWeight, walkableUpTo, weightOf, wrapAngle } from './people.js';
import { CHAT_GAP, CIRCLE_MAX, CIRCLE_RADIUS, GRASS_SITS, LIE_DOWNS } from './peopleModel.js';
import { roomLayoutOf } from '../../buildings/footprints.js';
import { updateBuying } from './peopleStalls.js';
import { placeAtVertex, reseatPerson, updateCrossing, wanderInto, walkwayPoint } from './peoplePathing.js';
import * as THREE from 'three';
import { controls } from '../../core/camera-controls.js';
import { profileOf, profilesVersion } from '../profiles.js';
import { carriageSpot, getTrainShuttles, holdTrain, getTrainStations, trainStationsVersion } from '../../trains/trains.js';
import { isBloodlusting, punchSpill } from './peopleBlood.js';
import { puffSmoke } from '../giblets.js';
import { playSound } from '../../audio/sfx.js';
import { exclaim } from '../../audio/voices.js';
import { PUNCH_MIN_PUSH, followPerson, followPersonInside, personHeight, stopFollowingPerson } from './peopleTracking.js';
import { openRoomDoor, roomBeyondDoor, roomDoorway, roomHolds, roomRoute, roomSeats, roomSpot, roomVisit, someoneHome, watchingTV } from '../../buildings/interior.js';
import { clearMeal, giveSnack, mealFinished, serveMeal } from './peopleHolding.js';
import { crawlOffRoad, updateCrawl } from './peopleRoad.js';
import { REVIVE_SHAKE_TIME } from '../revive.js';
import { strikeLightning } from '../lightning.js';
import { damage, heal } from '../../core/health.js';
import { RELATE, relateAll, relateBoth, introduceAll } from './peopleRelations.js';

// ---- what people get up to besides walking about.
//
// p.act names it: 'chat' (two people meeting, head on along a walkway or one crossing to another in a plaza or park: they
// wave, talk a while, wave goodbye), 'bench' (a plaza bench), 'circle' (park grass, others joining to talk), 'lie' (park
// grass, only with nobody else about).
//
// People talking are a group and take turns, looking at whoever is talking. Someone standing about for a while fidgets
// now and then (Idle2/Idle3).
/**
 * Take a group out of the ones going on.
 * @param {object} g - the group
 * @returns {void}
 */
function removeGroup(g) {
  const k = groups.indexOf(g);
  if (k >= 0) groups.splice(k, 1);
}

/**
 * End a conversation between two, and set them both carrying on. Ended badly (a rude line: {end = bad} in the speech
 * files, see g.ending), each may go for the other — BAD_END_PUNCH × their aggression — rather than wave.
 * @param {object} g - the group
 * @param {'bad'|null} [how] - how it ended
 * @returns {void}
 */
const BAD_END_PUNCH = 0.2; // chance, per unit of aggression, of going for the other after a conversation ends badly
const SCORE_RELATE = 3;    // how far each point of a conversation's score ({score} lines: g.score) moves how they feel about each other
const talked = (g, delta) => { relateAll(g.members, delta + (g.score ?? 0)*SCORE_RELATE); introduceAll(g.members); };
function endChat(g, how = null) {
  removeGroup(g);
  if (how === 'bad') talked(g, RELATE.badChat); else if (g.stage !== 'gather') talked(g, RELATE.chat);
  const chatGroup = g.members.splice(0);
  chatGroup.forEach(m => { m.group = null; finishActivity(m); });
  if (how !== 'bad' || chatGroup.length !== 2 || !hasClip('Punch') || !hasClip('Fall')) return;
  chatGroup.forEach((m, i) => {
    const other = chatGroup[1 - i];
    if (!m.attack && isFairGame(other) && peopleRng() < BAD_END_PUNCH*m.traits.aggression) goAfter(m, other, false, true);
  });
}

/**
 * A conversation's end, once a line that ends it has been said (g.ending, set by audio/dictionary.js): two chatting
 * wave goodbye (ended well) or walk off, maybe fighting (badly); whoever said it leaves a circle; a room chat stops.
 * @param {object} g - the group
 * @returns {boolean} whether it's ended
 */
function endedByLine(g) {
  const ending = g.ending;
  if (!ending) return false;
  g.ending = null; g.speaker = null;
  if (g.kind === 'room') endRoomChat(g);
  else if (g.kind === 'circle') { if (g.members.includes(ending.by)) leaveCircle(ending.by, ending.how); }
  else if (ending.how === 'bad') endChat(g, 'bad');
  else wave(g, 'bye');
  return true;
}

/**
 * Someone arriving at a circle: those sat in it look round at them, and one who isn't mid-line greets them
 * (greetings.txt — see p.greetTo and audio/dictionary.js), straight away if nobody's talking, else next turn.
 * @param {Person} p - who's joining
 * @returns {void}
 */
const GREET_WAIT = 5; // seconds a greeting can wait for its turn before it's dropped
function welcome(p) {
  const g = p.group, seated = g.members.filter(m => m !== p && m.stage === 'sit');
  seated.forEach(m => { if (!m.saying) m.lookAt = p; });
  const free = seated.filter(m => !m.saying && !m.closing);
  if (!free.length) return;
  const greeter = pickFrom(free);
  greeter.greetTo = { who: p, until: performance.now()/1000 + GREET_WAIT };
  if (!g.speaker?.saying) { g.speaker = greeter; g.turnIn = 2; closeNow(greeter); }
}

/**
 * Someone getting up to leave a circle after saying a closer: they wave to whoever's left, or, on a rude one
 * ({end = bad}), just go — see brawl.
 * @param {Person} p
 * @param {'good'|'bad'} how
 * @returns {void}
 */
function leaveCircle(p, how) {
  p.closing = false;
  p.leftBadly = how === 'bad';
  if (p.stage === 'sit') { p.stage = 'rise'; p.pose = 'Idle'; p.lookAt = null; } else finishActivity(p);
}
/**
 * After someone leaves a circle badly: they roll BAD_END_PUNCH × aggression against each still in it and go after
 * everyone rolled, one after another (p.attackQueue, see endAttack); each of them rolls the same against the leaver.
 * @param {Person} p - who left
 * @param {Person[]} others - who was still in the circle
 * @returns {void}
 */
// (still sat in the circle counts: they're got up when the punch comes — see updateAttack)
const inReach = m => isFairGame(m) || (m.act === 'circle' && m.stage === 'sit' && !m.punched);
function brawl(p, others) {
  p.leftBadly = false;
  others.forEach(m => relateBoth(p, m, RELATE.badChat));
  if (!hasClip('Punch') || !hasClip('Fall')) return;
  const targets = others.filter(m => inReach(m) && peopleRng() < BAD_END_PUNCH*p.traits.aggression);
  for (let i = targets.length - 1; i > 0; i--) { const j = Math.floor(peopleRng()*(i + 1)); [targets[i], targets[j]] = [targets[j], targets[i]]; }
  if (targets.length && !p.attack) { goAfter(p, targets.shift(), false, true); p.attackQueue = targets; }
  others.forEach(m => {
    if (m.attack || !isFairGame(p) || peopleRng() >= BAD_END_PUNCH*m.traits.aggression) return;
    finishActivity(m); // (up off the grass to go for them)
    goAfter(m, p, false, true);
  });
}

/**
 * Take a person out of the group they're in, ending a conversation between two if that's what it was.
 * @param {Person} p - the person
 * @returns {void}
 */
function leaveGroup(p) {
  const g = p.group;
  if (!g) return;
  p.group = null;
  g.members.splice(g.members.indexOf(p), 1);
  if (g.speaker === p) g.speaker = null;
  g.members.forEach(m => { if (m.lookAt === p) m.lookAt = null; });
  if (g.kind === 'circle') { g.members.forEach(m => relateBoth(p, m, RELATE.circle + (g.score ?? 0)*SCORE_RELATE)); introduceAll([p, ...g.members]); }
  // a conversation between two ends when either goes; a circle carries on while anyone's left in it
  if (g.kind === 'chat') endChat(g); else if (g.kind === 'room') endRoomChat(g); else if (!g.members.length) removeGroup(g);
}

/**
 * Stop whatever a person's doing, back to standing.
 * @param {Person} p - the person
 * @returns {void}
 */
export function endActivity(p) {
  leaveGroup(p);
  endAttack(p);
  releasePunched(p);
  if (p.seat) { p.seat.by = null; p.seat = null; }
  p.act = null; p.stage = ''; p.spot = null; p.faceTo = null; p.lookAt = null; p.pose = 'Idle'; p.seatLift = 0;
}

/**
 * Stop whatever a person's doing and set them carrying on: off somewhere nearby, or on along their walkway — and not
 * stopping to talk again for a while.
 * @param {Person} p - the person
 * @returns {void}
 */
function finishActivity(p) {
  endActivity(p);
  if (p.mode === 'wander') { const s = randomSpotIn(peopleNav.areas[p.area], p); p.tx = s.x; p.tz = s.z; p.wait = 0.3 + peopleRng()*1.5; }
  p.chatCooldown = 30 + peopleRng()*60;
}

/**
 * Start two people talking.
 * @param {Person} a - the one waited on, if the other is walking over
 * @param {Person} b - the other
 * @param {boolean} approach - whether the second walks over to the first first, who waits for them
 * @returns {object} the group they're talking in
 */
function startChat(a, b, approach) {
  const g = { kind: 'chat', members: [a, b], stage: 'gather', timer: 25, speaker: null, turnIn: 0 };
  groups.push(g);
  [a, b].forEach(m => { endActivity(m); m.act = 'chat'; m.group = g; m.wait = 0; });
  a.lookAt = b; b.lookAt = a;
  if (!approach) wave(g, 'greet');
  return g;
}

/**
 * Have both of a conversation wave, hello or goodbye, standing still for it.
 * @param {object} g - the group
 * @param {string} stage - the stage to put them into ('greet' or 'bye')
 * @returns {void}
 */
function wave(g, stage) {
  g.stage = stage;
  g.timer = hasClip('Wave') ? clipNamed('Wave').duration : 1;
  g.members.forEach(m => playOnce(m, 'Wave'));
}

/**
 * Send someone hanging out in a plaza or park over to someone else standing about there, to talk.
 * @param {Person} p - the person
 * @param {Hangout} area - the hangout they're in
 * @returns {boolean} whether anyone was found to go over to
 */
export function goChat(p, area) {
  if (!personModel) return false;
  let friend = null, best = 25;
  for (let k=0;k<10;k++) {
    const q = people[Math.floor(peopleRng()*people.length)], d = Math.hypot(q.x - p.x, q.z - p.z);
    if (q !== p && q.mode === 'wander' && q.area === p.area && !q.act && !q.fright && !q.oneShot && !q.moving && !q.attack && !q.punched && q.traits.chatty > 0 && d < best
      && !p.traits.smells && !q.traits.smells
      && walkableUpTo(area, p, q.x, q.z).clear) { friend = q; best = d; }
  }
  if (!friend) return false;
  startChat(friend, p, true);
  const gap = CHAT_GAP*S.peopleSize, d = Math.max(best, 1e-3);
  p.tx = friend.x + (p.x - friend.x)/d*gap; p.tz = friend.z + (p.z - friend.z)/d*gap;
  if (!area.inside(p.tx, p.tz)) { p.tx = p.x; p.tz = p.z; }
  return true;
}

/**
 * Have two people meeting head on along a walkway (on the same side of it) now and then stop to talk — though never too
 * many at once.
 * @param {number} dt - seconds since the last frame
 * @returns {void}
 */
export function meetOnWalkways(dt) {
  const cells = new Map(), CELL = 2;
  let talking = 0;
  people.forEach(p => {
    p.chatCooldown -= dt;
    if (p.mode !== 'line') return;
    if (p.act) { talking++; return; }
    const key = Math.floor(p.x/CELL) + ',' + Math.floor(p.z/CELL);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(p);
  });
  if (!hasClip('Wave') || talking > people.length*0.15) return;
  const reach = 1.6*S.peopleSize;
  people.forEach(p => {
    if (p.mode !== 'line' || p.act || p.fright || p.crossStage || p.attack || p.punched || p.chatCooldown > 0 || (p.chatCheckIn -= dt) > 0) return;
    p.chatCheckIn = 0.4 + peopleRng()*0.8;
    const cx = Math.floor(p.x/CELL), cz = Math.floor(p.z/CELL);
    for (let ox=-1;ox<=1;ox++) for (let oz=-1;oz<=1;oz++) for (const q of cells.get((cx+ox) + ',' + (cz+oz)) || []) {
      if (q === p || q.act || q.fright || q.crossStage || q.attack || q.punched || q.chatCooldown > 0 || q.li !== p.li || q.dir === p.dir || p.traits.smells || q.traits.smells) continue;
      // still coming towards each other, and close
      if ((q.u - p.u)*p.dir < 0 || Math.hypot(q.x - p.x, q.z - p.z) > reach) continue;
      if (peopleRng() < 0.35*p.traits.chatty*q.traits.chatty) startChat(p, q, false); else p.chatCooldown = q.chatCooldown = 10;
      return;
    }
  });
}

/**
 * Move who's speaking in a conversation on: the more talkative someone is, the more of the turns they take, and the
 * longer they go on.
 * @param {object} g - the group
 * @param {Person[]} talkers - those in it who can talk
 * @param {number} dt - seconds since the last frame
 * @returns {void}
 */
function takeTurns(g, talkers, dt) {
  g.turnIn -= dt;
  // (a real line isn't cut off: the turn waits for it; one waiting for a reply hands the turn on soon after — see audio/dictionary.js)
  if (g.speaker?.saying && talkers.includes(g.speaker)) g.turnIn = Math.max(g.turnIn, 0.1);
  else if (g.talk && g.talk.by === g.speaker) g.turnIn = Math.min(g.turnIn, 0.4);
  if (!talkers.includes(g.speaker) || g.turnIn <= 0) {
    // the more talkative someone is, the more of the turns they take, and the longer they go on
    const others = talkers.filter(m => m !== g.speaker);
    g.speaker = others.find(m => m.closing || (m.greetTo && performance.now()/1000 < m.greetTo.until)) ?? others[pickWeighted(others, m => m.traits.talkative)]; // (someone leaving a circle gets to say goodbye)
    g.turnIn = (1.5 + peopleRng()*4)*Math.sqrt(g.speaker.traits.talkative);
    g.speaker.lookAt = pickFrom(talkers.filter(m => m !== g.speaker));
  }
  talkers.forEach(m => { if (m !== g.speaker) m.lookAt = g.speaker; });
}

/**
 * Run the conversations: two standing come together, wave hello, take turns talking a while, wave goodbye and go; a
 * circle on the grass talks among whoever's sat down in it.
 * @param {number} dt - seconds since the last frame
 * @returns {void}
 */
const CLOSE_WAIT = 4; // seconds, after a conversation's time is up, for someone to say a closer before they just wave
// (whoever's to say the closer drops the babble they're partway through, so it comes at once — see linePause in audio/dictionary.js)
const closeNow = p => { if (p && !p.saying) { p.phrase = null; p.talkIn = 0; } };
export function updateGroups(dt) {
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const g = groups[gi];
    if (g.kind === 'room') { roomChat(g, dt); continue; }
    if (g.kind === 'circle') {
      const seated = g.members.filter(m => m.stage === 'sit');
      if (seated.some(m => m.traits.smells)) { g.members.filter(m => !m.traits.smells).forEach(finishActivity); continue; } // (someone who smells sat down: everyone else gets up and goes)
      if (endedByLine(g)) continue;
      if (seated.length >= 2) takeTurns(g, seated, dt); else g.speaker = null;
      continue;
    }
    const [a, b] = g.members;
    g.timer -= dt;
    if (g.stage === 'gather') {
      a.faceTo = headingTo(a, b);
      if (Math.hypot(b.tx - b.x, b.tz - b.z) < 0.3) wave(g, 'greet');
      else if (g.timer <= 0) { endChat(g); continue; }
    } else if (g.stage === 'greet') {
      if (g.timer <= 0) { g.stage = 'talk'; g.timer = (8 + peopleRng()*22)*(a.traits.patience + b.traits.patience)/2; }
    } else if (g.stage === 'talk') {
      if (endedByLine(g)) continue;
      takeTurns(g, g.members, dt);
      // time's up: someone says a closer (closers.txt — polite from the patient, rude from the impatient: see
      // audio/dictionary.js), which ends it; if nobody does within CLOSE_WAIT, they just wave
      if (g.timer <= 0 && !g.wantsEnd) { g.wantsEnd = true; g.timer = CLOSE_WAIT; closeNow(g.speaker); }
      else if (g.timer <= 0 && !g.speaker?.saying) { g.speaker = null; wave(g, 'bye'); }
    } else if (g.timer <= 0) {
      endChat(g);
      continue;
    }
    if (g.stage !== 'gather') { a.faceTo = headingTo(a, b); b.faceTo = headingTo(b, a); }
  }
}

/**
 * Run the crowd for one frame: keep the numbers right, rebuild the walkways when the map has changed, and move everyone
 * — walking, crossing, talking, sitting, punching, riding the trains, going indoors, being possessed — then write it all
 * out to the instanced meshes and the shader's attributes, and put the camera where it's following.
 *
 * The dt is clamped, so a tab left in the background doesn't teleport everyone across the map on the frame it comes back.
 * @param {number} t - the time now, in seconds
 * @returns {void}
 */

/** Where on the ground to check for room, around a spot (see clearGround). */
const GROUND_PROBES = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * Work out whether there's room on the grass: in the park all round a spot, off any walkway cutting through it (people
 * sit and lie down on the ground beside a path, never on it), and clear of the tree trunks.
 * @param {Hangout} area - the hangout
 * @param {number} x - the middle of the spot
 * @param {number} z
 * @param {number} r - how much room they need all round it
 * @returns {boolean} whether it's clear
 */
function clearGround(area, x, z, r) {
  for (const [dx, dz] of GROUND_PROBES) {
    const px = x + dx*r, pz = z + dz*r;
    if (!area.inside(px, pz) || peopleNav.onPath(px, pz)) return false;
  }
  return area.trees.every(tree => Math.hypot(tree.x - x, tree.z - z) > tree.r + r);
}

/**
 * Send someone in a plaza to a free bench seat nearby, or someone in a park or on a beach to the ground, to join a
 * circle there with room in it or to start one.
 * @param {Person} p - the person
 * @param {Hangout} area - the hangout they're in
 * @returns {boolean} whether somewhere was found
 */
export function goSit(p, area) {
  if (!personModel) return false;
  if (area.kind === 'plaza') {
    // (only people about the size the benches are made for)
    if (!hasClip('Sit1') || !area.seats.length || Math.abs(S.peopleSize*p.traits.size - 1) > 0.3) return false;
    let seat = null, best = 40;
    for (let k=0;k<10;k++) {
      const free = area.seats[Math.floor(peopleRng()*area.seats.length)], d = Math.hypot(free.x - p.x, free.z - p.z);
      if (!free.by && d < best) { seat = free; best = d; }
    }
    if (!seat) return false;
    seat.by = p;
    Object.assign(p, { seat, act: 'bench', stage: 'go', timer: 30, wait: 0 });
    return true;
  }
  const sits = GRASS_SITS.filter(hasClip);
  if (!isOpenGround(area) || !sits.length) return false;
  const radius = CIRCLE_RADIUS*S.peopleSize;
  const circle = groups.find(g => g.kind === 'circle' && g.area === area && g.members.length < CIRCLE_MAX && Math.hypot(g.cx - p.x, g.cz - p.z) < 30
    && (p.traits.smells || !g.members.some(m => m.traits.smells))); // (nobody joins a circle with someone who smells in it)
  let spot = null;
  if (circle && peopleRng() < 0.85) {
    // the place round the circle furthest from anyone already there
    for (let k=0;k<12;k++) {
      const angle = (k + peopleRng()*0.5)/12*Math.PI*2, x = circle.cx + Math.sin(angle)*radius, z = circle.cz + Math.cos(angle)*radius;
      const gap = Math.min(...circle.members.map(m => Math.abs(wrapAngle(angle - m.circleAngle))));
      if (gap > 0.9 && (!spot || gap > spot.gap) && clearGround(area, x, z, 0.35*S.peopleSize)
        && walkableUpTo(area, p, x, z).clear) spot = { x, z, angle, gap };
    }
    if (!spot) return false;
    circle.members.push(p);
    p.group = circle;
  } else {
    // an open patch of grass, away from other circles and anyone lying down
    for (let k=0;k<10 && !spot;k++) {
      const patch = randomSpotIn(area, p), angle = peopleRng()*Math.PI*2;
      const cx = patch.x - Math.sin(angle)*radius, cz = patch.z - Math.cos(angle)*radius;
      if (clearGround(area, cx, cz, radius + 0.5*S.peopleSize) && !groups.some(g => g.kind === 'circle' && Math.hypot(g.cx - cx, g.cz - cz) < 5)
        && !people.some(q => q.act === 'lie' && Math.hypot(q.x - cx, q.z - cz) < 4)) spot = { x: patch.x, z: patch.z, angle, cx, cz };
    }
    if (!spot) return false;
    p.group = { kind: 'circle', area, members: [p], speaker: null, turnIn: 0, cx: spot.cx, cz: spot.cz };
    groups.push(p.group);
  }
  Object.assign(p, { act: 'circle', stage: 'go', spot: { x: spot.x, z: spot.z }, circleAngle: spot.angle, sitClip: pickFrom(sits), timer: 40, wait: 0 });
  return true;
}

/**
 * Send someone in a park or on a beach with nobody else about to a patch of ground to lie down on.
 * @param {Person} p - the person
 * @param {Hangout} area - the hangout they're in
 * @returns {boolean} whether somewhere was found
 */
export function goLieDown(p, area) {
  const poses = LIE_DOWNS.filter(hasClip);
  if (!personModel || !isOpenGround(area) || !poses.length) return false;
  const size = S.peopleSize, near = 8*size;
  if (people.some(q => q !== p && q.mode === 'wander' && q.area === p.area && Math.abs(q.x - p.x) < near && Math.abs(q.z - p.z) < near)) return false;
  for (let k=0;k<10;k++) {
    const patch = randomSpotIn(area, p), heading = peopleRng()*Math.PI*2, fx = Math.sin(heading), fz = Math.cos(heading);
    // room from their head (behind where their pelvis goes) to their feet
    if (![-0.5, 0, 0.5, 0.9].every(d => clearGround(area, patch.x + fx*d*size, patch.z + fz*d*size, 0.45*size))) continue;
    Object.assign(p, { act: 'lie', stage: 'go', spot: { x: patch.x, z: patch.z, heading }, lieClip: pickFrom(poses), timer: 30, wait: 0 });
    return true;
  }
  return false;
}

/**
 * Work out where someone sitting or lying down, or talking in a plaza or park, should walk to, if anywhere.
 *
 * Sitting or lying down goes: walking there ('go'), turning the right way ('turn'), waving hello to a circle ('greet'),
 * sitting or lying ('sit') for a while, getting up ('rise'), and waving goodbye to a circle ('bye').
 * @param {Person} p - the person
 * @param {Hangout} area - the hangout they're in
 * @param {number} dt - seconds since the last frame
 * @returns {?{x: number, y: number, z: number}} where to head (null to stay put)
 */
export function updateActivity(p, area, dt) {
  if (p.act === 'buy') return updateBuying(p, dt, area.y);
  if (p.act === 'chat') return p.group.stage === 'gather' && p === p.group.members[1] ? { x: p.tx, y: area.y, z: p.tz } : null;
  // where they sit or lie, and facing which way: in front of a bench seat, facing out into the plaza (sitting shifts them
  // back onto it); a place in a circle, facing its middle; or a patch of grass
  let spot = p.spot, facing, poseName;
  if (p.act === 'bench') {
    const seat = p.seat, reach = -clipNamed('Sit1').pelvisZ*modelScale(p);
    spot = { x: seat.x + seat.nx*reach, z: seat.z + seat.nz*reach };
    facing = Math.atan2(seat.nx, seat.nz);
    poseName = 'Sit1';
  } else if (p.act === 'circle') {
    facing = headingTo(spot, { x: p.group.cx, z: p.group.cz });
    poseName = p.sitClip;
  } else {
    facing = spot.heading;
    poseName = p.lieClip;
  }
  switch (p.stage) {
    case 'go':
      p.timer -= dt;
      if (p.timer <= 0) { finishActivity(p); return null; } // can't get there
      if (Math.hypot(spot.x - p.x, spot.z - p.z) > 0.25) return { x: spot.x, y: area.y, z: spot.z };
      p.stage = 'turn';
      // falls through
    case 'turn':
      p.faceTo = facing;
      if (Math.abs(wrapAngle(facing - p.heading)) > 0.15) break;
      if (p.act === 'circle' && p.group.members.some(m => m.stage === 'sit')) welcome(p);
      if (p.act === 'circle' && hasClip('Wave') && p.group.members.some(m => m.stage === 'sit')) { playOnce(p, 'Wave'); p.stage = 'greet'; break; }
      // falls through
    case 'greet':
      if (p.oneShot) break;
      p.stage = 'sit';
      p.pose = poseName;
      p.timer = ((p.act === 'circle' ? 25 : 15) + peopleRng()*45)*p.traits.patience;
      if (p.act === 'bench') p.seatLift = p.seat.y - area.y - clipNamed('Sit1').seatY*modelScale(p);
      // falls through
    case 'sit':
      p.timer -= dt;
      if (p.closing && p.saying) p.timer = Math.max(p.timer, 0.5); // (their goodbye isn't cut short)
      // (time up in a circle with others to talk to: first a turn to say a closer — closers.txt, see audio/dictionary.js,
      // which leaves through endedByLine — for up to CLOSE_WAIT; then they just get up)
      if (p.timer <= 0 && p.act === 'circle' && !p.closing && p.group?.members.filter(m => m.stage === 'sit').length >= 2) {
        p.closing = true; p.timer = CLOSE_WAIT;
        if (!p.group.speaker?.saying) { p.group.speaker = p; p.group.turnIn = CLOSE_WAIT; closeNow(p); } // (their turn now, to say it)
      }
      else if (p.timer <= 0) { p.closing = false; p.stage = 'rise'; p.pose = 'Idle'; p.lookAt = null; }
      break;
    case 'rise':
      if (weightOf(p, clipNamed('Idle')) < 1) break;
      if (p.act === 'circle' && !p.leftBadly && hasClip('Wave') && p.group.members.some(m => m !== p && m.stage === 'sit')) { playOnce(p, 'Wave'); p.stage = 'bye'; break; }
      {
        const leftBehind = p.act === 'circle' && p.leftBadly ? p.group.members.filter(m => m !== p) : null;
        finishActivity(p);
        if (leftBehind) brawl(p, leftBehind);
      }
      return null;
    case 'bye':
      if (!p.oneShot) { finishActivity(p); return null; }
      break;
  }
  // on a bench, sitting down shifts them back onto the seat, and getting up forward off it — as far as sitting puts their
  // pelvis behind their feet, so that their feet stay put
  if (p.act === 'bench') {
    const w = weightOf(p, clipNamed('Sit1'));
    p.x = spot.x + (p.seat.x - spot.x)*w; p.z = spot.z + (p.seat.z - spot.z)*w;
  }
  return null;
}

//  ============== Punching  ============== 
// Someone (more often the more aggression they have) picks on someone near them — on the same walkway, or in
// the same plaza or park — goes up to them, to talk distance, punches them, and walks off.
//
// The victim notices them at the last moment, turns to face them, and is knocked flat on their back; they lie there a
// while, then get up where they fell.
const PUNCH_RATE = 1/8;        // the chance a second of picking on someone, per unit of aggression
const PUNCH_REACH = 8;          // how far off (at people size 1) the one they pick on can be
const PUNCH_NOTICE = 2.5;       // how near they come before they're noticed
export const PUNCH_CHASE_SPEED = 1.5;  // how much faster than they walk they go after them
const PUNCH_CHASE_MAX = 10;     // seconds before they give up on catching them
const BYSTANDER_RADIUS = 7, BYSTANDER_SHARE = 0.5; // how near (at people size 1) someone has to be to a punch to join in, and their chance as a share of the victim's
const DOWN_TIME_SCALE = 0.7;    // how long someone lies there once knocked flat, as a share of the usual 3 to 7 seconds
const DODGE_SMOKE_PUFFS = 6; // the puffs of smoke left where someone dodged from
const DODGE_LEAP_DISTANCE = 4; // how far someone with the dodge trait leaps back from a punch
const BLOODLUST_DODGE_BONUS = 0.3; // added to the dodge chance of anyone bloodlusting (covered in blood, with the bloodlust trait)
const RETALIATE_CHANCE = 0.1;   // the chance, per unit of aggression, that someone punched goes after whoever did it when they get up (or else runs)
export const PUNCH_HIT_TIME = 0.5;    // how far into the Punch animation the fist lands, in seconds
let reach = PUNCH_REACH*S.peopleSize;
/**
 * Whether someone going about their business might punch or be punched.
 * @param {Person} q - the person
 * @returns {boolean} whether they're fair game
 */
export const isFairGame = q => (q.mode === 'line' || q.mode === 'wander') && !q.act && !q.fright && !q.stun && !q.please && !q.jc && !q.crossStage
  && !q.attack && !q.punched && !q.oneShot;
/**
 * Let everyone who might pick a fight this frame think about it.
 * @param {number} dt - seconds since the last frame
 * @returns {void}
 */
export function pickFights(dt) {
  if (!hasClip('Punch') || !hasClip('Fall')) return;
  reach = PUNCH_REACH*S.peopleSize;
  people.forEach(p => {
    throwPunch(dt, p)
  });
}

/**
 * Give someone the chance to pick on someone near them, and set them going after whoever they pick.
 * @param {number} dt - seconds since the last frame
 * @param {Person} p - the person
 * @param {boolean} [isForced] - whether the punch is called for rather than rolled for (the game's doing)
 * @param {Person} [forcedVictim] - who to go for, when it is
 * @returns {void}
 */
export function throwPunch(dt, p, isForced, forcedVictim) {
  const { aggression } = p.traits;
  dt = isForced? p.punchCooldown : dt; //force punch roll if forced
  if ( !isForced && (aggression-1 <= 0 || (p.punchCooldown -= dt*aggression/3) > 0 || !isFairGame(p))) return;
  if (isForced) dt = 1;
  if (peopleRng() > dt*PUNCH_RATE*aggression/4){
    p.punchCooldown = 20 + peopleRng()*20;
    return;
  } 
  
  let victim;
  if (forcedVictim) {
    victim = forcedVictim;
  } else {
    // anyone near enough: along the same walkway (not across the block it runs round), or in the same hangout
    const nav = p.mode === 'line' ? peopleNav.lines[p.li] : null;
    const along = q => { const d = Math.abs(q.u - p.u); return nav.loop ? Math.min(d, nav.total - d) : d; };
    const near = people.filter(q => q !== p && q.mode === p.mode && Math.abs(q.x - p.x) < reach && Math.abs(q.z - p.z) < reach
      && Math.hypot(q.x - p.x, q.z - p.z) < reach && (nav ? q.li === p.li && along(q) < reach : q.area === p.area) && isFairGame(q));
    if (!near.length) { p.punchCooldown = 2 + peopleRng()*3; return; }
    victim = pickFrom(near);
  }
  goAfter(p, victim);
  p.punchCooldown = 20 + peopleRng()*20;
}

/**
 * Set someone going after someone to punch them: up to them, to talk distance, then a punch (see updateAttack).
 * @param {Person} p - the one who'll punch
 * @param {Person} victim - who they're going after
 * @param {boolean} [revenge] - whether it's for a punch thrown at them or someone else, which nobody else then takes up
 * @param {boolean} [social] - whether a conversation gone bad started it (see endChat, brawl): bystanders only talk about it
 * @returns {void}
 */
export function goAfter(p, victim, revenge = false, social = false) {
  p.attack = { target: victim, stage: 'chase', timer: PUNCH_CHASE_MAX*(revenge ? p.traits.patience : 1), revenge, social }; // (how long they'll chase someone for revenge goes by their patience)
  p.lookAt = victim;
  if (!victim.punched) victim.punched = { by: p, stage: 'marked', timer: 0 }; // (several can be after one person: the first to reach them lands it)
}

/** How far, as a multiple of the gap they stand at, a controlled person can get from whoever's punching them before the punch lands and still not be hit. */
const PUNCH_MISS_FACTOR = 1.5;

/** How long someone stands staring down whoever they've just knocked flat, in seconds. */
const PUNCH_STARE_TIME = 1.5;

/**
 * Move someone punching on, each frame.
 * @param {Person} p - the person punching
 * @param {number} dt - seconds since the last frame
 * @returns {?{x: number, y: number, z: number}} where they should walk to (null to stand still)
 */
export function updateAttack(p, dt) {
  const a = p.attack, t = a.target;
  a.timer -= dt;
  if (a.stage === 'chase') {
    if ((t.punched?.by !== p && t.punched?.stage !== 'marked') || a.timer <= 0 || !(t.mode === 'line' || t.mode === 'wander' || t.mode === 'leaving' || t.mode === 'possessed') || t.jc) {
      if (a.timer <= 0) { feel(p, 'gaveup', t); p.attackQueue = null; } // (ran out of chase: for what they say, see life/speech-text.js)
      endAttack(p); return null;
    }
    const d = Math.hypot(t.x - p.x, t.z - p.z), gap = CHAT_GAP*S.peopleSize;
    if (t.mode !== 'possessed' && t.punched.stage === 'marked' && d < PUNCH_NOTICE*S.peopleSize) { // (whoever's being controlled isn't braced, and keeps their freedom until the fist lands)
      t.punched = null;
      endActivity(t);
      t.oneShot = null; t.wait = 0;
      t.punched = { by: p, stage: 'brace', timer: 0 };
      t.faceTo = headingTo(t, p); t.lookAt = p;
    }
    if (d > gap + 0.1) return { x: t.x + (p.x - t.x)/d*gap, y: t.y, z: t.z + (p.z - t.z)/d*gap };
    a.stage = 'punch';
    a.chaseLeft = a.timer; // (what's left of the chase, if the punch misses)
    a.timer = PUNCH_HIT_TIME;
    playOnce(p, 'Punch');
    swingSound(p);
  }
  if (a.stage === 'punch') {
    if (t.punched?.by !== p) { endAttack(p); return null; } // (someone else got there first: it's over)
    p.faceTo = headingTo(p, t);
    if (a.timer > 0) return null;
    if (t.mode === 'possessed' && Math.hypot(t.x - p.x, t.z - p.z) > CHAT_GAP*S.peopleSize*PUNCH_MISS_FACTOR) { // (walked out of reach: it misses, and they're chased on)
      a.stage = 'chase';
      a.timer = a.chaseLeft;
      return null;
    }
    if (t.punched?.by === p && !dodgePunch(t, p)) {
      knockDown(t, p);
      if (t.mode !== 'possessed') App.pushPerson?.(t, t.x - p.x, t.z - p.z, PUNCH_MIN_PUSH*p.traits.speed*p.traits.size);
    }
    a.stage = 'stare';
    a.timer = PUNCH_STARE_TIME;
  }
  if (a.stage === 'stare') {
    p.faceTo = headingTo(p, t); // keep looking down at them while it plays out
    if (a.timer > 0) return null;
    a.stage = 'follow';
  }
  // the stare's over, they walk off
  if (!p.oneShot) {
    endAttack(p);
    if (p.mode === 'line') {
      const nav = peopleNav.lines[p.li], k = Math.max(0, Math.min(nav.pts.length - 2, p.seg)), from = nav.pts[k], to = nav.pts[k + 1];
      if (((to.x - from.x)*(t.x - p.x) + (to.z - from.z)*(t.z - p.z))*p.dir > 0) p.dir = -p.dir;
    } else if (p.mode === 'wander') {
      const area = peopleNav.areas[p.area];
      let best = null;
      for (let k=0;k<8;k++) {
        const spot = randomSpotIn(area, p), d = Math.hypot(spot.x - t.x, spot.z - t.z);
        if (!best || d > best.d) best = { ...spot, d };
      }
      p.tx = best.x; p.tz = best.z; p.wait = 0;
    }
  }
  return null;
}

/**
 * Stop someone going after whoever they were going to punch — who, if they hadn't been hit yet, carries on as they were.
 * @param {Person} p - the person punching
 * @returns {void}
 */
function endAttack(p) {
  const a = p.attack;
  if (!a) return;
  p.attack = null;
  p.lookAt = null; p.faceTo = null;
  const t = a.target;
  if (t.punched?.by === p && (t.punched.stage === 'marked' || t.punched.stage === 'brace')) { t.punched = null; t.faceTo = null; t.lookAt = null; }
  // (anyone left in their queue — see brawl — is next, unless they've been knocked down themselves)
  while (p.attackQueue?.length && !p.punched && p.mode !== 'dead') {
    const next = p.attackQueue.shift();
    if (inReach(next) && !next.punched) { goAfter(p, next, false, a.social); return; }
  }
  p.attackQueue = null;
}

/**
 * Let someone being punched off it (to do something else): whoever was coming for them gives up, and if they were
 * falling they stand straight back up.
 * @param {Person} p - the person being punched
 * @returns {void}
 */
function releasePunched(p) {
  const k = p.punched;
  if (!k) return;
  p.punched = null;
  if (k.by.attack?.target === p) endAttack(k.by);
  if (k.stage === 'fall') p.oneShot = null;
}

/**
 * The whoosh of a fist swung, as it comes through, a moment before it lands (PUNCH_HIT_TIME into the Punch animation).
 * @param {Person} p - whoever's swinging
 * @returns {void}
 */
export function swingSound(p) {
  playSound('whoosh', { x: p.x, y: p.y + personHeight(p)*0.75, z: p.z }, 1, Math.max(0, PUNCH_HIT_TIME - 0.15));
}

/**
 * Land the punch: knock them flat on their back, facing whoever hit them.
 * They cry out as they go (whatever knocked them down), and a fist landing is heard.
 * @param {Person} t - the one being hit
 * @param {Person} p - the one hitting them
 * @returns {void}
 */
const FALL_DAMAGE = 5, CRITICAL_PUNCH_DAMAGE = 10, VAMPIRE_CRITICAL_HEAL = 5; // (a critical punch is one that draws blood: see punchSpill)
const REVENGE_TIME = 120; // seconds after being punched that punching the puncher back counts as revenge
export function knockDown(t, p) {
  const critical = !!p.traits && punchSpill(t, p) && people.includes(p); // (a car's knock can spill blood too, but isn't a punch)
  const head = { x: t.x, y: t.y + personHeight(t)*0.9, z: t.z };
  if (people.includes(p)) playSound('punch', { ...head, y: t.y + personHeight(t)*0.75 });
  exclaim(head, voiceOfPerson(t));
  t.punched.stage = 'fall';
  t.heading = headingTo(t, p);
  t.faceTo = null; t.lookAt = null;
  playOnce(t, 'Fall');
  t.pose = 'Fallen';
  bystandersReactToPunch(t, p);
  if (people.includes(p)) { // (for what people say: see life/speech-text.js) — punching back whoever last punched you is revenge
    if (p.felt?.what === 'punched' && p.felt.by === t && performance.now()/1000 - p.felt.at < REVENGE_TIME) feel(p, 'revenge', t);
    feel(t, 'punched', p);
    witness(t, 'punch', p);
  }
  if (critical && p.traits.vampire) heal(p, VAMPIRE_CRITICAL_HEAL);
  damage(t, FALL_DAMAGE + (critical ? CRITICAL_PUNCH_DAMAGE : 0), { from: p });
}

/**
 * Let someone with the dodge trait, at that chance, leap back out of a punch, then go after whoever threw it.
 * @param {Person} t - the one about to be hit
 * @param {{x: number, z: number}} from - whoever is punching them
 * @returns {boolean} whether they got clear (the punch misses)
 */
export function dodgePunch(t, from) {
  const chance = t.traits.dodge + (isBloodlusting(t) ? BLOODLUST_DODGE_BONUS : 0);
  if (chance <= 0 || isGone(t) || peopleRng() >= chance) return false;
  const attacker = from.traits ? from : null;
  if (t.punched?.by === from && (t.punched.stage === 'marked' || t.punched.stage === 'brace')) t.punched = null;
  endActivity(t);
  t.stun = t.fright = t.please = null; t.oneShot = null; t.wait = 0;
  t.crossStage = null; t.jc = null;
  puffSmoke({ x: t.x, y: t.y, z: t.z }, 1.7*t.height*S.peopleSize, DODGE_SMOKE_PUFFS); // (where they leapt from)
  App.pushPerson?.(t, t.x - from.x, t.z - from.z, DODGE_LEAP_DISTANCE*Math.max(1, t.traits.size));
  if (t.mode !== 'possessed') { t.heading = t.faceTo = headingTo(t, from); t.lookAt = attacker; } // (leaping back, still facing them)
  if (attacker && (t.mode === 'line' || t.mode === 'wander' || t.mode === 'leaving')) goAfter(t, attacker, true);
  return true;
}

/**
 * Everyone near someone who's just been punched by a person (out to start something) reacts at once: half the victim's own chance (see reactToPunch),
 * less for anyone more evil, to go after whoever did it, and otherwise they run from them.
 * @param {Person} victim - who was hit
 * @param {object} puncher - whoever hit them (anything but a person is ignored)
 * @returns {void}
 */
function bystandersReactToPunch(victim, puncher) {
  if (!puncher?.traits || puncher.attack?.revenge || (puncher.punched && puncher.punched.stage !== 'marked')) return; // (a revenge punch is answered by no one but whoever it hit: see reactToPunch)
  if (puncher.attack?.social) return; // (a row that came to blows: those near only see it and talk about it — witness, in knockDown — or whole parks would be forever running)
  const radius = BYSTANDER_RADIUS*S.peopleSize;
  people.forEach(q => {
    if (q === victim || q === puncher || isGone(q) || q.punched || q.attack || !['line', 'wander', 'leaving'].includes(q.mode)) return;
    if (Math.hypot(q.x - victim.x, q.z - victim.z) > radius) return;
    const chance = RETALIATE_CHANCE*q.traits.aggression*BYSTANDER_SHARE/Math.max(0.25, 1 + (q.traits.evil ?? 0));
    endActivity(q);
    q.stun = q.fright = q.please = null; q.oneShot = null; q.wait = 0;
    if (q.mode !== 'leaving' && peopleRng() < chance) goAfter(q, puncher, true);
    else beginFleeing(q, { x: puncher.x, z: puncher.z });
  });
}

/** The modes whose people can't be knocked over: anyone dead, not yet placed, out of sight, on a train or drowned. */
const UNREACHABLE_MODES = ['dead', 'none', 'indoors', 'train', 'drowning'];
/**
 * Whether someone can be knocked over by a blow they didn't see coming: anyone in view, the one being controlled included,
 * whatever they're in the middle of or feeling (walking, leaving a plaza, sitting, chatting, lying down, crossing a road, frightened, stunned,
 * delighted, about to be punched by someone else), unless they're already down or getting up.
 * @param {Person} q - the person
 * @returns {boolean} whether a blow would land
 */
export const canBeKnockedOver = q => !UNREACHABLE_MODES.includes(q.mode) && !q.water && (!q.punched || q.punched.stage === 'marked' || q.punched.stage === 'brace');

/**
 * Knock someone over as if they'd been punched, by whatever is at `from` ({ x, z }): flat on their back, facing it, out
 * of whatever they were doing (see canBeKnockedOver).
 * @param {Person} t - the one being hit
 * @param {{x: number, z: number}} from - where the blow came from
 * @returns {boolean} whether they went down
 */
export function knockOver(t, from) {
  if (isGone(t) || !canBeKnockedOver(t) || !hasClip('Fall')) return false;
  releasePunched(t); // (whoever was coming to punch them gives up)
  if (t.act || t.attack) finishActivity(t);
  t.fright = t.stun = t.please = null;
  t.crossStage = null; t.jc = null; // (a car yielding to them stops)
  t.punched = { by: from, stage: 'brace', timer: 0 };
  knockDown(t, from);
  return true;
}

/**
 * Move someone who's been knocked flat on their back to where the fall leaves them: to where their pelvis landed, as
 * for anyone lying down, the pose drawn set back from there by as much (so nothing moves).
 * @param {Person} p - the person
 * @returns {void}
 */
export function landFall(p) {
  const fallen = clipNamed('Fallen'), s = modelScale(p), sin = Math.sin(p.heading), cos = Math.cos(p.heading);
  const offX = fallen.pelvisX*s, offZ = fallen.pelvisZ*s;
  p.x += offX*cos + offZ*sin; p.z += offZ*cos - offX*sin;
  p.clipA = p.clipB = fallen; p.fade = 1;
  p.punched.stage = 'down';
  p.punched.timer = p.punched.revive ? REVIVE_SHAKE_TIME : (3 + peopleRng()*4)*DOWN_TIME_SCALE;
  if (p.mode === 'wander') { p.tx = p.x; p.tz = p.z; }
}

/**
 * Put someone already on the ground (lying, crawling, or getting up) back flat on their back in the Fallen pose, for
 * REVIVE_SHAKE_TIME (see reviveInstead in people.js).
 * @param {Person} p - the person
 * @returns {void}
 */
export function holdDown(p) {
  p.clipA = p.clipB = clipNamed('Fallen'); p.fade = 1;
  p.oneShot = null;
  p.pose = 'Fallen';
  p.punched.stage = 'down';
  p.punched.timer = REVIVE_SHAKE_TIME;
}
/**
 * Move someone who's been punched on, each frame: lying there a while, then getting up.
 * @param {Person} p - the person
 * @param {number} dt - seconds since the last frame
 * @returns {void}
 */
export function updatePunched(p, dt) {
  const k = p.punched;
  if (k.revive) { // (dead, shaking, until the bolt brings them back: see reviveInstead in people.js)
    if (k.stage === 'down' && (k.timer -= dt) <= 0) { strikeLightning({ x: p.x, y: p.y, z: p.z }); witness(p, 'resurrected'); k.stage = 'rise'; p.pose = 'Idle'; }
    else if (k.stage === 'rise' && weightOf(p, clipNamed('Idle')) >= 1) { p.punched = null; p.wait = 0.5; }
    return;
  }
  if (k.stage === 'down' && (k.timer -= dt) <= 0) { if (!crawlOffRoad(p)) { k.stage = 'rise'; p.pose = 'Idle'; } } // (out on the road, they crawl off it first: see peopleRoad.js)
  else if (k.stage === 'crawl') updateCrawl(p, dt);
  else if (k.stage === 'rise' && weightOf(p, clipNamed('Idle')) >= 1) { p.punched = null; p.wait = 0.5 + peopleRng(); reactToPunch(p, k.by); }
}

/**
 * Someone who's just got up after being punched by a person: in proportion to their aggression, they go after whoever
 * did it, and otherwise run from them. (Knocked over by anything else — a bee — they carry on.)
 * @param {Person} p - the person who was punched
 * @param {object} by - whoever knocked them over
 * @returns {void}
 */
function reactToPunch(p, by) {
  if (!by?.traits || isGone(by)) return;
  const canFight = (p.mode === 'line' || p.mode === 'wander') && (!by.punched || by.punched.stage === 'marked') && ['line', 'wander', 'leaving', 'possessed'].includes(by.mode);
  if (canFight && !hidingFromSun(p) && (p.traits.vampire || peopleRng() < RETALIATE_CHANCE*p.traits.aggression)) {
    goAfter(p, by, true);
  } else {
    beginFleeing(p, { x: by.x, z: by.z });
  }
}

export const RIDE_CHANCE = 0.05;
/** How far beyond a station's sides a walkway can pass and still lead up to it. */
const STATION_REACH = 4;
/** How long someone waits on a platform, and rides, before giving up on it. */
const TRAIN_WAIT_MAX = 120, TRAIN_RIDE_MAX = 240;
/** What each station's foot leads to, and which station is nearest each walkway point and hangout (see stationLinks). */
let stationLinksCache = null, stationLinksKey = '';
/**
 * Work out what each station's foot leads to, again when the walkways or the trains change: for each station node,
 * { area (the hangout it stands in, or -1), vertex ({ li, vi }, the nearest walkway point, or null) } — and the other
 * way, the station near each walkway point ('li:vi') and those in each hangout (by index).
 * @returns {{ground: Map<*, *>, byVertex: Map<string, *>, byArea: Map<number, *>}} the links
 */
export function stationLinks() {
  const key = peopleNavBuiltAt + ':' + trainStationsVersion();
  if (stationLinksCache && key === stationLinksKey) return stationLinksCache;
  stationLinksKey = key;
  const { areas, lines, grid, CELL } = peopleNav, links = { ground: new Map(), byVertex: new Map(), byArea: new Map() };
  const nearest = new Map(); // 'li:vi' -> its distance to the station it's been given
  getTrainStations().forEach(st => {
    const area = areas.findIndex(a => st.x >= a.minX && st.x <= a.maxX && st.z >= a.minZ && st.z <= a.maxZ && a.inside(st.x, st.z));
    const reach = st.halfW + STATION_REACH, span = Math.ceil(reach/CELL);
    const cx = Math.floor(st.x/CELL), cz = Math.floor(st.z/CELL);
    let vertex = null;
    for (let ox=-span;ox<=span;ox++) for (let oz=-span;oz<=span;oz++) (grid.get((cx+ox) + ',' + (cz+oz)) || []).forEach(({ li, vi }) => {
      if (lines[li].blocked && lines[li].blocked[vi]) return; // (not out on a road)
      const q = lines[li].pts[vi], d = Math.hypot(q.x - st.x, q.z - st.z), k = li + ':' + vi;
      if (d > reach) return;
      if (!vertex || d < vertex.d) vertex = { li, vi, d };
      if (!nearest.has(k) || d < nearest.get(k)) { nearest.set(k, d); links.byVertex.set(k, st.nodeId); }
    });
    if (area < 0 && !vertex) return;
    links.ground.set(st.nodeId, { area, vertex });
    if (area >= 0) { if (!links.byArea.has(area)) links.byArea.set(area, []); links.byArea.get(area).push(st.nodeId); }
  });
  return (stationLinksCache = links);
}

/**
 * Send someone off to the foot of a station to ride its trains.
 * @param {Person} p - the person
 * @param {*} node - the station's node id
 * @param {{x: number, y: number, z: number}} from - where they are now
 * @returns {void}
 */
export function goRideTrain(p, node, from) {
  endActivity(p);
  p.crossStage = null; p.jc = null; p.wait = 0;
  p.mode = 'train';
  p.train = { node, stage: 'approach', target: { x: from.x, y: from.y, z: from.z }, side: 1, along: 0, lineId: null, timer: 0 };
}

/**
 * Someone let go of (see unpossessPerson in peopleTracking.js) inside a station, its lift or a carriage: riding the trains
 * on from there as anyone does — aboard, riding it on; in a lift, down it and away; on a platform, waiting for the next
 * carriage; anywhere else in the station, out the way they'd come in.
 * @param {Person} p - the person
 * @param {number} i - their index in people
 * @param {{kind: string, node?: *, side?: number, lineId?: *, u?: number, v?: number, yaw?: number}} f - where they were standing (p.footing)
 * @returns {boolean} whether they're riding on (false: they're somewhere this can't pick up from)
 */
export function resumeTrainRide(p, i, f) {
  const shuttle = f.kind === 'carriage' && getTrainShuttles().find(s => s.lineId === f.lineId);
  const node = shuttle ? shuttle.stopNode : f.node, st = node != null ? getTrainStations().get(node) : null;
  if (!shuttle && !st) return false;
  goRideTrain(p, node ?? null, p);
  const ride = p.train;
  if (shuttle) {
    ride.lineId = f.lineId;
    ride.spot = { across: f.u, along: f.v, turn: wrapAngle(p.heading - f.yaw) };
    aboard(p, i, shuttle);
    return true;
  }
  if (f.kind === 'lift') {
    ride.side = f.side; ride.stage = 'liftRide'; ride.lift = { from: 'top', to: 'bottom' };
    return true;
  }
  const dx = p.x - st.x, dz = p.z - st.z, a = dx*st.right.x + dz*st.right.z, b = dx*st.forward.x + dz*st.forward.z;
  ride.side = a < 0 ? -1 : 1;
  if (Math.abs(a) < st.halfW - 0.5) { ride.stage = 'wait'; ride.along = Math.max(-st.alongMax, Math.min(st.alongMax, b)); }
  else { ride.stage = 'exit'; ride.target = st.spot(ride.side*st.landing, 0); }
  return true;
}

/**
 * Move someone riding the trains on, each frame: to the foot of the station, up onto its landing, in to wait on the
 * platform, then aboard the first carriage to stop there, and back out again at the other end.
 * @param {Person} p - the person
 * @param {number} i - their index in people
 * @param {number} dt - seconds since the last frame
 * @returns {?{x: number, y: number, z: number}} where they should walk to (null to stand still, or aboard)
 */
export function updateTrainRider(p, i, dt) {
  const ride = p.train, st = getTrainStations().get(ride.node), reached = () => Math.hypot(ride.target.x - p.x, ride.target.z - p.z) < 0.35;
  ride.timer += dt;
  if (ride.stage === 'ride') {
    const shuttle = getTrainShuttles().find(s => s.lineId === ride.lineId);
    if (!shuttle) { gotOff(p, i); dropToGround(p); return null; } // (their line's gone)
    // standing in the carriage where they got on, turned the way they chose, carried along with it
    ride.spot ??= placeAboard();
    const at = carriageSpot(shuttle, ride.spot.across, ride.spot.along);
    p.x = at.x; p.y = at.y; p.z = at.z; p.heading = at.yaw + ride.spot.turn;
    const stop = shuttle.arrived && getTrainStations().get(shuttle.stopNode);
    if (stop && stationLinks().ground.has(stop.nodeId) && (stop.networkStations <= 2 || peopleRng() < 1/stop.networkStations || ride.timer > TRAIN_RIDE_MAX)) {
      // off here: out through the carriage's door onto the platform, beside the track, to walk out the way they'd have
      // come in
      ride.node = stop.nodeId; ride.stage = 'alight'; ride.side = peopleRng() < 0.5 ? -1 : 1; ride.timer = 0;
      const door = carriageDoor(shuttle, stop, ride.side);
      ride.door = door.inside;
      ride.route = [door.inside, door.outside, stop.spot(ride.side*(stop.radius + 1.6), (peopleRng()*2 - 1)*Math.min(2, stop.alongMax))];
      ride.target = ride.route.shift();
      gotOff(p, i);
      return ride.target;
    }
    return null;
  }
  if (ride.stage === 'alight') {
    // (the carriage waits until they're off: see holdTrain)
    if (ride.route.length) holdTrain(ride.lineId);
    if (!reached()) return underfoot(p, ride);
    const shuttle = ride.route.length === 2 && getTrainShuttles().find(s => s.lineId === ride.lineId);
    if (shuttle && shuttle.stopNode === ride.node && shuttle.doors < 2) return underfoot(p, ride); // (at the door, until it's open)
    if (ride.route.length) { ride.target = ride.route.shift(); return underfoot(p, ride); }
    const out = getTrainStations().get(ride.node);
    if (!out) { dropToGround(p); return null; }
    ride.stage = 'exit'; ride.route = null;
    ride.target = out.spot(ride.side*out.landing, 0);
    return underfoot(p, ride);
  }
  if (ride.stage === 'board') {
    // in through the carriage's door to somewhere to stand — the carriage waiting for them (see holdTrain), unless it's
    // waited as long as it will: then they're aboard if they'd got in, or back to waiting if not
    const shuttle = getTrainShuttles().find(s => s.lineId === ride.lineId);
    if (!shuttle || shuttle.stopNode !== ride.node) {
      if (shuttle && ride.inside) return aboard(p, i, shuttle);
      ride.stage = 'wait'; ride.timer = 0; ride.lineId = null;
      return null;
    }
    holdTrain(ride.lineId);
    if (!reached()) return underfoot(p, ride);
    if (ride.route.length === 2 && shuttle.doors < 2) return underfoot(p, ride); // (at the door, until it's open)
    if (!ride.route.length) return aboard(p, i, shuttle);
    ride.inside = ride.route.length === 2; // (past the door, from here on)
    ride.target = ride.route.shift();
    return underfoot(p, ride);
  }
  if (!st) { dropToGround(p); return null; } // (the station's gone from under them)
  // anyone by one of its doorways, on the way in or out, has its doors slide open for them
  [1, -1].forEach(side => { const d = st.spot(side*st.halfW, 0); if (Math.hypot(d.x - p.x, d.z - p.z) < 2.6 && Math.abs(d.y - p.y) < 1.5) st.openDoor(side); });
  const lift = ride.lift && st.lifts.find(l => l.side === ride.side);
  if (ride.lift && !lift) { landAtStation(p, ride.node); return null; } // (the station's come down to the ground under them)
  if (ride.stage === 'approach') {
    if (!reached()) return ride.target;
    // to whichever of its doors is nearer: up in its lift if it has them, walking straight up onto a landing that's
    // on the ground, or up onto the landing in a step
    const plus = st.spot(st.landing, 0), minus = st.spot(-st.landing, 0);
    ride.side = Math.hypot(plus.x - p.x, plus.z - p.z) <= Math.hypot(minus.x - p.x, minus.z - p.z) ? 1 : -1;
    const landing = ride.side > 0 ? plus : minus;
    const byLift = st.lifts.find(l => l.side === ride.side);
    if (byLift) {
      ride.lift = { from: 'bottom', to: 'top' };
      ride.stage = 'liftWait';
      ride.target = byLift.spot(LIFT_WAIT_OUT, (peopleRng()*2 - 1)*0.6, byLift.bottom);
      return ride.target;
    }
    if (Math.abs(landing.y - p.y) < 0.8) { ride.stage = 'toLanding'; ride.target = landing; return ride.target; }
    p.x = landing.x; p.y = landing.y; p.z = landing.z;
    return onLanding(p, st);
  }
  if (ride.stage === 'toLanding') return reached() ? onLanding(p, st) : ride.target;
  if (ride.stage === 'liftWait') {
    // at the lift's doorway, calling it, until it's there with its doorway open — then in
    lift.call(ride.lift.from);
    if (!reached()) return ride.target;
    if (!lift.openAt(ride.lift.from)) { p.faceTo = headingTo(p, lift.spot(0, 0, 0)); return null; }
    p.faceTo = null;
    ride.stage = 'liftIn';
    ride.target = lift.spot((peopleRng()*2 - 1)*0.45, (peopleRng()*2 - 1)*(lift.width - 0.6), ride.lift.from === 'top' ? lift.top : lift.bottom);
  }
  if (ride.stage === 'liftIn') {
    lift.call(ride.lift.to);
    if (!lift.openAt(ride.lift.from)) { ride.stage = 'liftRide'; return null; } // (it's gone: carried along from wherever they'd got to)
    lift.wait();
    if (!reached()) return ride.target;
    ride.stage = 'liftRide';
    // facing the doorway they'll step out of
    p.faceTo = headingTo(p, ride.lift.to === 'top' ? st.spot(0, 0) : lift.spot(5, 0, 0));
  }
  if (ride.stage === 'liftRide') {
    lift.call(ride.lift.to);
    p.y = lift.y;
    if (!lift.openAt(ride.lift.to)) return null;
    p.faceTo = null;
    ride.stage = 'liftOut';
    ride.target = ride.lift.to === 'top' ? st.spot(ride.side*st.landing, 0) : lift.spot(LIFT_WAIT_OUT + 0.6, (peopleRng()*2 - 1)*0.8, lift.bottom);
  }
  if (ride.stage === 'liftOut') {
    if (lift.openAt(ride.lift.to)) lift.wait();
    if (!reached()) return ride.target;
    const up = ride.lift.to === 'top';
    ride.lift = null;
    if (up) return onLanding(p, st);
    return leaveOnFoot(p, st);
  }
  if (ride.stage === 'leave') return reached() ? (landAtStation(p, ride.node, true), null) : ride.target;
  if (ride.stage === 'enter') {
    // (anyone on their way in to wait, while a carriage is stopped here, is waited for too)
    const here = getTrainShuttles().find(s => s.stopNode === ride.node && st.lineIds.includes(s.lineId));
    if (here) holdTrain(here.lineId);
    if (!reached()) return ride.target;
    ride.stage = 'wait'; ride.timer = 0;
    p.faceTo = headingTo(p, st.spot(0, ride.along)); // (towards the track)
    return null;
  }
  if (ride.stage === 'wait') {
    const shuttle = getTrainShuttles().find(s => s.stopNode === ride.node && st.lineIds.includes(s.lineId));
    if (shuttle) {
      // over to its door, and in
      p.faceTo = null; p.oneShot = null;
      ride.stage = 'board'; ride.lineId = shuttle.lineId; ride.timer = 0; ride.inside = false;
      ride.spot = placeAboard();
      const door = carriageDoor(shuttle, st, ride.side);
      ride.door = door.inside;
      ride.route = [door.inside, carriageSpot(shuttle, ride.spot.across, ride.spot.along)];
      ride.target = door.outside;
      holdTrain(ride.lineId);
      return ride.target;
    } else if (ride.timer > TRAIN_WAIT_MAX) {
      // fed up of waiting: back out
      p.faceTo = null;
      ride.stage = 'exit'; ride.target = st.spot(ride.side*st.landing, 0);
    }
    return null;
  }
  // 'exit': out to the landing, then down to the station's foot — in its lift if it has one this side, walking off
  // a landing that's on the ground, or down off it in a step
  if (!reached()) return ride.target;
  const down = st.lifts.find(l => l.side === ride.side);
  if (down) {
    ride.lift = { from: 'top', to: 'bottom' };
    ride.stage = 'liftWait';
    ride.target = st.spot(ride.side*(st.halfW + 1.2), (peopleRng()*2 - 1)*0.8);
    return ride.target;
  }
  if (Math.abs(ride.target.y - (stationFoot(ride.node)?.y ?? ride.target.y)) < 0.8) return leaveOnFoot(p, st);
  landAtStation(p, ride.node);
  return null;
}

/** How far out from the middle of a lift's shaft people wait for it at the ground. */
const LIFT_WAIT_OUT = 2;

/**
 * Someone just up onto a station's landing (ride.side's): on in through its doors, to somewhere along the platform.
 * @param {Person} p - the person
 * @param {*} st - the station
 * @returns {{x: number, y: number, z: number}} where they should walk to
 */
function onLanding(p, st) {
  const ride = p.train;
  ride.stage = 'enter';
  ride.along = (peopleRng()*2 - 1)*st.alongMax;
  ride.target = st.spot(ride.side*(st.radius + 0.8 + peopleRng()*1.2), ride.along);
  return ride.target;
}

/**
 * Where on the ground a station leads to (see stationLinks): the walkway point by it, or the station's own spot in the
 * hangout it stands in — or null if it leads nowhere.
 * @param {*} node - the station's node id
 * @returns {?{x: number, y: number, z: number}} the spot
 */
function stationFoot(node) {
  const foot = stationLinks().ground.get(node), st = getTrainStations().get(node);
  if (!foot || !st) return null;
  if (foot.vertex) {
    // (the walkway's points are only x/z: its height is the line's, or the ramp's at that point)
    const line = peopleNav.lines[foot.vertex.li], q = line.pts[foot.vertex.vi];
    return { x: q.x, y: line.ys ? line.ys[foot.vertex.vi] : line.y, z: q.z };
  }
  return { x: st.x, y: peopleNav.areas[foot.area].y, z: st.z };
}

/**
 * Someone back on the ground by a station (out of its lift, or off a landing that's on the ground): walking over to the
 * walkway it leads to — or, standing in a hangout, just carrying on about it from where they are.
 * @param {Person} p - the person
 * @param {*} st - the station
 * @returns {?{x: number, y: number, z: number}} where they should walk to
 */
function leaveOnFoot(p, st) {
  const foot = stationLinks().ground.get(st.nodeId);
  if (!foot || !foot.vertex) { landAtStation(p, st.nodeId, true); return null; }
  p.train.stage = 'leave';
  p.train.target = stationFoot(st.nodeId);
  return p.train.target;
}

/**
 * Someone who's walked into a carriage (or was far enough in when it left): riding it from here, stood where they chose.
 * @param {Person} p - the person
 * @param {number} i - their index in people
 * @param {*} shuttle - the carriage's shuttle
 * @returns {null} (aboard, they're placed rather than walking)
 */
function aboard(p, i, shuttle) {
  const ride = p.train;
  ride.stage = 'ride'; ride.timer = 0; ride.route = null; ride.inside = false;
  if (followed === i) { stopFollowingPerson(); App.followTrainLine?.(shuttle.lineId); setRiderFollowed(i); }
  return null;
}

/**
 * A carriage's door on one side, stopped at a station: just inside it, at the edge of its standing room halfway along,
 * and just outside it on the platform — facing the station's entrance on `side`.
 * @param {*} shuttle - the carriage's shuttle
 * @param {*} st - the station
 * @param {number} side - which side of the track (as the station's entrances go)
 * @returns {{inside: {x: number, y: number, z: number}, outside: {x: number, y: number, z: number}}} the two spots
 */
/**
 * Someone crossing between a platform and a carriage's door: stood on whatever's under them there (the deck, the
 * boarding ramp, the carriage's floor: see floorAt in trains.js), heading on for their target.
 * @param {Person} p - the person
 * @param {*} ride - their ride (p.train)
 * @returns {{x: number, y: number, z: number}} where they should walk to
 */
function underfoot(p, ride) {
  const st = getTrainStations().get(ride.node);
  if (!st || !ride.door) return ride.target;
  p.y = st.floorAt(p.x, p.z, ride.door);
  return { x: ride.target.x, y: p.y, z: ride.target.z };
}

function carriageDoor(shuttle, st, side) {
  const outside = st.spot(side*(st.radius + 0.6), 0);
  const a = carriageSpot(shuttle, 1, 0), b = carriageSpot(shuttle, -1, 0);
  const inside = Math.hypot(a.x - outside.x, a.z - outside.z) < Math.hypot(b.x - outside.x, b.z - outside.z) ? a : b;
  return { inside: { x: inside.x, y: inside.y, z: inside.z }, outside };
}

/**
 * Somewhere to stand in a carriage (see carriageSpot in trains.js): in the standing room between the seats — kept off the
 * very middle, where the camera rides — facing a window, or up or down the carriage.
 * @returns {{across: number, along: number, turn: number}} where, from -1 to 1 each way, and which way from the carriage's heading
 */
function placeAboard() {
  const turn = Math.floor(peopleRng()*4)*Math.PI/2 + (peopleRng() - 0.5)*0.6;
  return { across: peopleRng()*2 - 1, along: (peopleRng() < 0.5 ? -1 : 1)*(0.4 + 0.6*peopleRng()), turn };
}

/**
 * Put the camera back onto someone who's just got off a train, if it came along for the ride and is still on it.
 * @param {Person} p - the person
 * @param {number} i - their index in people
 * @returns {void}
 */
function gotOff(p, i) {
  if (riderFollowed !== i) return;
  setRiderFollowed(-1);
  if (App.followedTrainLine?.() !== p.train.lineId) return;
  App.stopFollowingTrain();
  followPerson(i);
}

/**
 * Bring someone down from a station's landing to its foot: onto the walkway there (heading either way), or into the
 * hangout it's in — or, already down on the ground (`walked`), carrying on about the hangout from where they are.
 * @param {Person} p - the person
 * @param {*} node - the station's node id
 * @param {boolean} [walked] - whether they're already on the ground there
 * @returns {void}
 */
function landAtStation(p, node, walked = false) {
  const foot = stationLinks().ground.get(node), st = getTrainStations().get(node);
  p.train = null;
  p.faceTo = null;
  p.trainCooldown = 40 + peopleRng()*50;
  if (foot && foot.vertex) {
    placeAtVertex(p, foot.vertex.li, foot.vertex.vi, peopleRng() < 0.5 ? -1 : 1);
    const at = walkwayPoint(p);
    p.x = at.x; p.y = at.y; p.z = at.z;
  } else if (foot) {
    const area = peopleNav.areas[foot.area];
    wanderInto(p, foot.area, st);
    if (!walked) { p.x = p.tx; p.z = p.tz; }
    p.y = area.y;
  } else {
    p.mode = 'line';
    dropToGround(p);
  }
}

/**
 * Put someone straight onto the nearest walkway or hangout below, the station or line they were on having gone.
 * @param {Person} p - the person
 * @returns {void}
 */
function dropToGround(p) {
  p.train = null;
  p.faceTo = null;
  p.trainCooldown = 40 + peopleRng()*50;
  p.mode = 'line';
  reseatPerson(p);
  if (p.mode === 'line') { const at = walkwayPoint(p); p.x = at.x; p.y = at.y; p.z = at.z; }
  else if (p.mode === 'wander') { p.x = p.tx; p.z = p.tz; p.y = peopleNav.areas[p.area].y; }
}

/** What the followed carriage's card was last told, so it's only told again when it changes. */
let passengersKey = null;
/**
 * Tell the followed carriage's card who's aboard, by name, with whoever the camera came aboard with picked out. Clicking
 * one of the others makes them the one it came aboard with instead, so it gets off with them (see gotOff).
 * @returns {void}
 */
export function showPassengers() {
  const line = App.followedTrainLine?.();
  const riders = [];
  if (line && S.peopleEnabled) people.forEach((p, i) => { if (p.mode === 'train' && p.train.stage === 'ride' && p.train.lineId === line) riders.push(i); });
  const key = line + '|' + riders.join(',') + '|' + riderFollowed + '|' + profilesVersion() + '|' + !!personModel;
  if (key === passengersKey || !App.setTrainCardPassengers) return;
  passengersKey = key;
  App.setTrainCardPassengers(
    riders.map(i => profileOf(people[i].id, personModel ? personModel.isMan[i] === 1 : null).name),
    riders.indexOf(riderFollowed),
    at => { setRiderFollowed(riders[at]); },
  );
}

// ============== Going Indoors ============== 
// Someone walking past a building's door (buildingDoors) sometimes goes in — up to the door, inside
// for up to INDOORS_MAX_HOURS of the day's clock (measured at the World panel's day length, whether or not it is running) —
// then back out the same door and on along the walkway they left.
//
// Offices, warehouses and factories (see roomLayoutOf) are homes the other way about: by day people go in for a working day, and after dark hardly
// anyone does — and whoever's still at work heads out within an hour or so of it getting dark, bar the odd one working late.
//
// p.indoors: { building, stage ('approach' → 'inside' → 'exit'), back (the walkway point they came from), hoursLeft }
/** The chance of going in, at each walkway point with a door onto it: by day, and after dark (see enterChance). */
const ENTER_CHANCE = 0.1, ENTER_CHANCE_NIGHT = 0.7;
/** The share of the crowd who are night owls: out and about after dark like any other time. */
const NIGHT_OWLS = 0.15;
const isNight = () => S.sunElevation < 0;
/** Vampires' hours indoors, on the day's clock: in by VAMPIRE_IN_AT, not out again till VAMPIRE_OUT_AT. */
const VAMPIRE_IN_AT = 5.5, VAMPIRE_OUT_AT = 18.5;
/**
 * Whether a vampire must be indoors now: they head in at the first door they come to (see walkAlong, and
 * hideFromSun in people.js) and don't come out till VAMPIRE_OUT_AT.
 * @param {Person} p - the person
 * @returns {boolean} whether they must be in
 */
export const hidingFromSun = p => !!p.traits.vampire && S.timeOfDay >= VAMPIRE_IN_AT && S.timeOfDay < VAMPIRE_OUT_AT;
/** When a vampire still out gives up looking for a door and vanishes into the nearest building (vanishIndoors). */
const VAMPIRE_POOF_AT = 6.5;
export const outOfTime = p => hidingFromSun(p) && S.timeOfDay >= VAMPIRE_POOF_AT;
/**
 * A vampire caught out: gone in a puff of smoke, and in at the nearest building's door in another.
 * @param {Person} p - the vampire
 * @returns {boolean} whether there was a building to go to
 */
export function vanishIndoors(p) {
  let best = null;
  for (const nav of peopleNav.lines) nav.vertices.forEach((vertex, vi) => {
    const building = vertex.building;
    if (!building) return;
    const d = Math.hypot(building.door.x - p.x, building.door.z - p.z);
    if (!best || d < best.d) best = { d, building, at: nav.pts[vi] };
  });
  if (!best) return false;
  const { building, at } = best, puff = 1.7*p.height*S.peopleSize;
  puffSmoke({ x: p.x, y: p.y, z: p.z }, puff, DODGE_SMOKE_PUFFS);
  p.fright = null; p.sunRun = false;
  goIndoors(p, building, { x: at.x, y: at.y ?? building.y, z: at.z });
  p.x = building.door.x; p.z = building.door.z; p.y = building.y;
  puffSmoke({ x: p.x, y: p.y, z: p.z }, puff, DODGE_SMOKE_PUFFS);
  return true;
}
/** Whether this person's a night owl — always the same ones, by their id. */
const nightOwl = p => ((Math.imul(p.id, 2654435761) >>> 0)/2**32) < NIGHT_OWLS;
/** The chance of going in at an office's door: by day, and after dark. */
const OFFICE_ENTER_CHANCE = 0.25, OFFICE_ENTER_CHANCE_NIGHT = 0.005;
/** How long a day at the office lasts, in hours of the day's clock; and how long after dark those still in stay on. */
const OFFICE_MIN_HOURS = 4, OFFICE_MAX_HOURS = 10, OFFICE_LEAVE_HOURS = 1.5;
/** The share of the crowd who work late: in an office after dark, they stay the rest of their day. */
const WORKS_LATE = 0.04;
const worksLate = p => ((Math.imul(p.id + 7, 2246822519) >>> 0)/2**32) < WORKS_LATE;
const isWorkplace = building => !['home', 'pub'].includes(roomLayoutOf(building.kind, building.number));
// (a pub's a visit like a home's, but a shorter one — an hour or four — and nobody's in it long without a pint in hand:
// see aboutTheRoom)
const isPub = building => roomLayoutOf(building.kind, building.number) === 'pub';
const PUB_MIN_HOURS = 1, PUB_MAX_HOURS = 4;
/** Seconds between one pint finished and the next got in, in a pub. */
const PUB_ROUND_MIN = 15, PUB_ROUND_MAX = 60;
/**
 * The chance of this person going in at a door they're passing: after dark, most are heading home and take the first
 * one — unless it's a workplace (see roomLayoutOf), which by day draws people in and after dark hardly anyone.
 * @param {Person} p - the person
 * @param {object} building - the building (see buildingDoors)
 * @returns {number} the chance
 */
export const enterChance = (p, building) => isWorkplace(building)
  ? (isNight() ? OFFICE_ENTER_CHANCE_NIGHT : OFFICE_ENTER_CHANCE)
  : isNight() && !nightOwl(p) ? ENTER_CHANCE_NIGHT : ENTER_CHANCE;
/** How long a visit lasts, in hours of the day's clock. */
const INDOORS_MIN_HOURS = 2, INDOORS_MAX_HOURS = 14;
/** The most of the crowd that may be indoors (or on their way in) at once, as a share of the people alive: by day, and
 * after dark (the sun below the horizon), when most are home. */
const INDOORS_MAX_SHARE = 0.3, INDOORS_MAX_SHARE_NIGHT = 0.9;
const indoorsMaxShare = () => isNight() ? INDOORS_MAX_SHARE_NIGHT : INDOORS_MAX_SHARE;
/** Seconds after coming out before they'd go in anywhere again. */
export const INDOORS_COOLDOWN = 30;
/**
 * Whether this person may go indoors right now.
 * @param {Person} p - the person
 * @returns {boolean} whether they may
 */

export const mayGoIndoors = p => p.indoorsCooldown <= 0 && !p.act && !p.attack && !p.punched && !p.fright && indoorsCount < people.length*indoorsMaxShare();
/**
 * Send someone in at a building's door, for anything up to INDOORS_MAX_HOURS of the day's clock.
 * @param {Person} p - the person
 * @param {object} building - the building they're going into (see buildingDoors)
 * @param {{x: number, y: number, z: number}} from - the walkway point they came off
 * @returns {void}
 */
export function goIndoors(p, building, from) {
  endActivity(p);
  p.crossStage = null; p.jc = null; p.wait = 0;
  p.mode = 'indoors';
  // mostly a quick visit, now and then most of the day — or at work, a working day
  const hours = isWorkplace(building) ? OFFICE_MIN_HOURS + (OFFICE_MAX_HOURS - OFFICE_MIN_HOURS)*peopleRng()
    : isPub(building) ? PUB_MIN_HOURS + (PUB_MAX_HOURS - PUB_MIN_HOURS)*peopleRng()
    : INDOORS_MIN_HOURS + (INDOORS_MAX_HOURS - INDOORS_MIN_HOURS)*peopleRng()**2;
  p.indoors = { building, stage: 'approach', back: { x: from.x, y: from.y, z: from.z }, hoursLeft: hours };
  p.inRoom = null;
  setIndoorsCount(indoorsCount + 1);
}

/**
 * Move someone going into, being in, or coming out of a building on, each frame.
 * @param {Person} p - the person
 * @param {number} i - their index in people (for the camera's sake)
 * @param {number} dt - seconds since the last frame
 * @returns {?{x: number, y: number, z: number}} where they should walk to (null to stand still, or to be inside)
 */
export function updateIndoors(p, i, dt) {
  const visit = p.indoors, { door } = visit.building;
  if (visit.stage === 'approach') {
    if (Math.hypot(door.x - p.x, door.z - p.z) >= 0.35) return { x: door.x, y: visit.building.y, z: door.z };
    visit.stage = 'inside';
    visit.justIn = true; // (so if the camera's in there, they're seen coming in: see aboutTheRoom)
    p.faceTo = null; p.lookAt = null; p.oneShot = null;
    // (with the camera following them, it goes in after them, their card beside the building's — and back out with them,
    // as they're the one it's waiting on: see followPersonInside)
    if (followed === i) { if (App.enterBuildingWith?.(visit.building.key)) followPersonInside(i); else lookAtBuilding(visit.building); }
    return null;
  }
  if (visit.stage === 'inside') {
    visit.hoursLeft -= dt*24/(Math.max(0.1, S.dayLengthMinutes)*60);
    // (at work after dark, home soon — each in their own time, and not those working late, or the bench's guests)
    if (isNight() && isWorkplace(visit.building) && !worksLate(p) && !visit.goingHome && Number.isFinite(visit.hoursLeft)) {
      visit.goingHome = true;
      visit.hoursLeft = Math.min(visit.hoursLeft, OFFICE_LEAVE_HOURS*peopleRng());
    }
    // (time's up, but not partway through a video: they sit it out, get up, and only then go)
    const arriving = visit.justIn;
    visit.justIn = false;
    if (visit.hoursLeft > 0 || p.inRoom?.watched != null || hidingFromSun(p)) return aboutTheRoom(p, visit, dt, arriving);
    // (with the camera in there too, off out of the room first, and the door heard shutting behind them)
    if (roomHolds(visit.building.key) && p.inRoom?.visit === roomVisit() && !p.inRoom.gone) return leaveRoom(p, dt);
    // back out, at the door, facing the walkway
    visit.stage = 'exit';
    standUp(p);
    p.inRoom = null; p.faceTo = null;
    p.x = door.x; p.z = door.z; p.y = visit.building.y;
    p.heading = headingTo(p, visit.back) + moonwalkTurn(p);
    if (followed === i) lookAtPerson(p);
    // and out with whoever the building's card was told to wait on: the camera leaves the building for them
    if (awaited === i) { awaited = -1; App.stopFollowingBuilding?.(); followPerson(i); }
    return visit.back;
  }
  // 'exit': back to the walkway, then on along it, whichever way
  if (Math.hypot(visit.back.x - p.x, visit.back.z - p.z) >= 0.35) return visit.back;
  p.indoors = null;
  p.indoorsCooldown = INDOORS_COOLDOWN*(0.5 + peopleRng());
  p.mode = 'line';
  p.dir = peopleRng() < 0.5 ? -1 : 1;
  reseatPerson(p);
  return null;
}

/**
 * Someone whose visit's over, in the room with the camera: up off their seat if they're on one, then across the room to
 * its doorway (roomDoorway) and out through its door, which opens for them as they get to it and shuts behind them.
 * @param {Person} p - the person
 * @param {number} dt - seconds since the last frame
 * @returns {?{x: number, y: number, z: number}} where they should walk to, or null to stand where they are (and once
 *   they're out of the room, p.inRoom.gone)
 */
function leaveRoom(p, dt) {
  const here = p.inRoom;
  if (here.seat) {
    // (sat down: getting up first, as they would anyway)
    if (here.stage === 'sit') { leaveGroup(p); here.stage = 'rise'; p.pose = 'Idle'; }
    if (here.stage !== 'rise') standUp(p);
    else if (sitting(p, here, dt), here.seat) return null;
  }
  if (!here.leaving) {
    if (p.group?.kind === 'room') leaveGroup(p);
    const door = roomDoorway();
    here.leaving = true;
    here.route = [...(roomRoute(p, door) ?? [door]), roomBeyondDoor()];
    here.timer = 30; // (and if they can't get there, gone anyway)
    p.faceTo = null; p.lookAt = null;
  }
  here.timer -= dt;
  if (here.route && Math.hypot(here.route[0].x - p.x, here.route[0].z - p.z) < 1.5 && here.route.length <= 2) openRoomDoor();
  if (here.route && here.timer > 0) {
    const next = walkRoute(p, here);
    if (next) return next;
  }
  here.gone = true;
  return null;
}

/**
 * Someone inside a building while the camera's in there too (see buildings/interior.js): somewhere in its one room — put
 * there the first frame the room's there to be in (now and then already sat down), or if they've only just come in, in
 * through its door (roomBeyondDoor, the door opening for them) and over to somewhere in it; and after that standing about, now
 * and then going over to somewhere else in it, round the furniture, or to sit on the sofa or a chair a while. The room's
 * no bigger than a room, so they amble rather than stride.
 * @param {Person} p - the person
 * @param {object} visit - their p.indoors
 * @param {number} dt - seconds since the last frame
 * @param {boolean} [arriving] - whether they've only this moment come in the building's door
 * @returns {?{x: number, y: number, z: number}} where they should walk to, or null to stand where they are
 */
function aboutTheRoom(p, visit, dt, arriving = false) {
  if (!roomHolds(visit.building.key)) { standUp(p); p.inRoom = null; return null; }
  someoneHome();
  if (arriving) {
    standUp(p);
    const door = roomDoorway(), beyond = roomBeyondDoor();
    openRoomDoor();
    p.x = beyond.x; p.y = beyond.y; p.z = beyond.z;
    const spot = roomSpot(peopleRng), inside = roomRoute(door, spot), route = inside && [door, ...inside];
    if (!route) { p.x = spot.x; p.y = spot.y; p.z = spot.z; } // (no way in from there past the furniture: just there)
    p.inRoom = { visit: roomVisit(), route, wait: peopleRng()*4, seat: null, stage: '' };
    p.heading = route ? headingTo(p, route[0]) : peopleRng()*Math.PI*2;
  } else if (p.inRoom?.visit !== roomVisit()) {
    standUp(p);
    const at = roomSpot(peopleRng);
    p.x = at.x; p.y = at.y; p.z = at.z;
    p.heading = peopleRng()*Math.PI*2;
    p.inRoom = { visit: roomVisit(), route: null, wait: peopleRng()*4, seat: null, stage: '' };
    // (some already sat down: straight onto the seat, as if they'd been there a while)
    const seat = peopleRng() < ROOM_SIT_ALREADY ? freeSeat(p) : null;
    if (seat) {
      takeSeat(p, seat);
      const stand = standingSpot(p, seat);
      p.x = stand.x; p.z = stand.z;
      p.heading = Math.atan2(seat.nx, seat.nz);
      p.inRoom.stage = 'turn';
    }
  }
  if (S.encourageTV && noSofaFor !== roomVisit() && p.mode !== 'possessed') sendToSofa(p);
  const here = p.inRoom;
  // in a pub, a pint: one in hand from the start, and another a while after each is finished
  if (isPub(visit.building) && !p.snack && (here.round = (here.round ?? 0) - dt) <= 0) {
    giveSnack(p, 'beer');
    here.round = PUB_ROUND_MIN + (PUB_ROUND_MAX - PUB_ROUND_MIN)*peopleRng();
  }
  if (here.seat) return sitting(p, here, dt);
  if (p.group?.kind === 'room') return here.route ? walkRoute(p, here) : null;
  if (here.route) {
    const next = here.route[0];
    if (Math.hypot(next.x - p.x, next.z - p.z) >= 0.3) return next;
    here.route.shift();
    if (here.route.length) return here.route[0];
    here.route = null;
    here.wait = (3 + peopleRng()*10)*p.traits.patience;
    p.faceTo = peopleRng()*Math.PI*2; // (somewhere to look, once they're there)
  } else if ((here.wait -= dt) <= 0 && !p.oneShot) {
    here.wait = 1 + peopleRng()*2; // (tried again in a moment, if there's no getting there)
    if (peopleRng() < ROOM_CHAT_CHANCE*p.traits.chatty && goChatInRoom(p)) return here.route[0];
    const seat = peopleRng() < ROOM_SIT_CHANCE ? freeSeat(p) : null;
    if (seat) {
      const route = roomRoute(p, standingSpot(p, seat));
      if (route) { takeSeat(p, seat); here.route = route; here.stage = 'go'; here.timer = 25; p.faceTo = null; return route[0]; }
    }
    here.route = roomRoute(p, roomSpot(peopleRng));
    if (here.route) p.faceTo = null;
  }
  return null;
}
/** The chance, each time someone in a room moves on, that it's to sit down, and that they're sat down already when it's first shown. */
const ROOM_SIT_CHANCE = 0.45, ROOM_SIT_ALREADY = 0.4;
/**
 * Encourage To Watch TV (Options > Game, S.encourageTV): whenever nobody's on the sofa — straight away on coming in,
 * then SOFA_REFILL_AFTER seconds after the last watcher got up — whoever's handled next drops what they're doing and is
 * sat straight down on it, so the TV comes on (again). Not whoever got up off it in the last SOFA_REST seconds. Whatever
 * their size (freeSeat's size limit is skipped). A sofa seat marked as someone's isn't counted taken unless they're
 * really on it or on their way (`seatHeld`). A room it can't work in is logged once and left alone that visit.
 * @param {Person} p - the person
 * @returns {void}
 */
function sendToSofa(p) {
  const sofa = roomSeats().filter(seat => seat.sofa);
  const why = !sofa.length ? 'this room has no sofa seats' : !personModel || !hasClip('Sit1') ? 'no sitting animation loaded' : null;
  if (why) { noSofaFor = roomVisit(); console.info(`Kallipolis: Encourage To Watch TV — ${why}`); return; }
  const now = performance.now();
  if (sofa.some(seat => seat.by !== p && seatHeld(seat))) { sofaFilled = { visit: roomVisit(), emptyAt: null }; return; }
  if (sofaFilled?.visit === roomVisit()) {
    sofaFilled.emptyAt ??= now;
    if (now - sofaFilled.emptyAt < SOFA_REFILL_AFTER*1000) return;
  }
  if (now - (p.inRoom.leftSofaAt ?? -Infinity) < SOFA_REST*1000) return;
  const seat = sofa[0];
  sofaFilled = { visit: roomVisit(), emptyAt: null };
  standUp(p);
  leaveGroup(p);
  p.oneShot = null;
  if (seat.by && seat.by !== p) seat.by = null;
  takeSeat(p, seat);
  const stand = standingSpot(p, seat);
  p.x = stand.x; p.z = stand.z;
  p.heading = Math.atan2(seat.nx, seat.nz);
  Object.assign(p.inRoom, { stage: 'turn', route: null });
}
/** The sizes (People size slider included) that sit on the furniture by choice; the sofa's filled whatever the size. */
const SEAT_SIZE_MIN = 0.5, SEAT_SIZE_MAX = 2.4;
/** Seconds the sofa stays empty before someone else is sat on it, and before whoever got up off it can be again. */
const SOFA_REFILL_AFTER = 4, SOFA_REST = 30;
// whether a seat's really someone's: they're still in the room with it as theirs (not gone, or moved on without saying)
const seatHeld = seat => !!seat.by && seat.by.inRoom?.seat === seat && seat.by.inRoom.visit === roomVisit();
// the visit the sofa was last filled in, and since when it's been empty; the visit sendToSofa can't work in
let sofaFilled = null, noSofaFor = null;
/**
 * A seat in the room nobody's on or heading for, if there is one — and if they're about the size the furniture's made for.
 * @param {Person} p - the person
 * @returns {?object} the seat (see roomSeats)
 */
function freeSeat(p) {
  const size = S.peopleSize*p.traits.size;
  if (!personModel || !hasClip('Sit1') || size < SEAT_SIZE_MIN || size > SEAT_SIZE_MAX) return null;
  const free = roomSeats().filter(seat => !seatHeld(seat));
  return free.length ? free[Math.floor(peopleRng()*free.length)] : null;
}
function takeSeat(p, seat) {
  seat.by = p;
  p.inRoom.seat = seat;
}
/**
 * Where to stand to sit down on a seat: in front of it, as far as sitting puts their pelvis behind their feet (as on a
 * bench: see updateActivity).
 * @param {Person} p - the person
 * @param {object} seat - the seat (see roomSeats)
 * @returns {{x: number, y: number, z: number}} the spot, in the world
 */
function standingSpot(p, seat) {
  const reach = -clipNamed('Sit1').pelvisZ*modelScale(p);
  return { x: seat.x + seat.nx*reach, y: p.y, z: seat.z + seat.nz*reach };
}
/**
 * Up off wherever they're sitting in the room, if they are, and the seat let go of.
 * @param {Person} p - the person
 * @returns {void}
 */
function standUp(p) {
  const seat = p.inRoom?.seat;
  if (p.group?.kind === 'room') leaveGroup(p);
  if (seat && seat.by === p) seat.by = null;
  clearMeal(p);
  if (p.inRoom) {
    if (seat?.sofa) p.inRoom.leftSofaAt = performance.now();
    if (seat?.sofa && p.inRoom.watched != null) feel(p, 'watchedtv'); // (for what they say: see life/speech-text.js)
    p.inRoom.seat = null; p.inRoom.watched = null;
  }
  p.pose = 'Idle'; p.seatLift = 0; p.faceTo = null;
}
/**
 * Someone in a room with a seat to sit on: walking over ('go'), turning round ('turn'), sitting a while ('sit'), then
 * getting up ('rise') — sitting down shifting them back onto it and getting up forward off it, as on a bench.
 * @param {Person} p - the person
 * @param {object} here - their p.inRoom
 * @param {number} dt - seconds since the last frame
 * @returns {?{x: number, y: number, z: number}} where they should walk to, or null
 */
function sitting(p, here, dt) {
  const seat = here.seat, stand = standingSpot(p, seat), facing = Math.atan2(seat.nx, seat.nz);
  switch (here.stage) {
    case 'go':
      if ((here.timer -= dt) <= 0) { standUp(p); here.route = null; here.wait = 2; return null; } // can't get there
      if (here.route?.length) {
        const next = here.route[0];
        if (Math.hypot(next.x - p.x, next.z - p.z) >= (here.route.length > 1 ? 0.3 : 0.15)) return next;
        here.route.shift();
        if (here.route.length) return here.route[0];
      }
      here.route = null;
      here.stage = 'turn';
      // falls through
    case 'turn':
      p.faceTo = facing;
      if (Math.abs(wrapAngle(facing - p.heading)) > 0.15 || p.oneShot) break;
      here.stage = 'sit';
      p.pose = deskPose(seat);
      if (p.pose === 'Eating') serveMeal(p, seat.diner.top);                 // (a plate on the table and a fork in hand)
      here.timer = (20 + peopleRng()*60)*p.traits.patience;
      here.spell = spellAt(p.pose);
      p.seatLift = seat.y - p.y - clipNamed('Sit1').seatY*modelScale(p);
      // falls through
    case 'sit': {
      // (on the sofa, with a video on: up once it's over, however long that is — or, if the player won't say, as anywhere else)
      const on = seat.sofa ? watchingTV() : null;
      if (on > 0 && here.watched == null) here.watched = on;
      here.timer -= dt;
      // (now and then a word with whoever's sat next to them — at the next desk, hands still on the keys, or on the sofa
      // or a chair beside them at home)
      if (!p.group && (here.chatIn = (here.chatIn ?? peopleRng()*SEAT_CHAT_EVERY) - dt) <= 0) {
        here.chatIn = SEAT_CHAT_EVERY*(0.5 + peopleRng());
        if (peopleRng() < SEAT_CHAT_CHANCE*p.traits.chatty) chatWhileSat(p);
      }
      // (at a desk, typing a while, then sat back a moment, then at it again)
      if (seat.desk && !p.group && (here.spell -= dt) <= 0) { p.pose = p.pose === 'Typing' ? 'Sit1' : deskPose(seat); here.spell = spellAt(p.pose); }
      // (dinner over: the plate cleared away, and a little while sat at the table after)
      if (p.pose.startsWith('Eating') && mealFinished(p)) {
        clearMeal(p);
        p.pose = 'Sit1';
        here.timer = Math.min(here.timer, SAT_AFTER_MEAL*p.traits.patience);
      }
      if (here.watched != null && on !== -1 ? on !== here.watched : here.timer <= 0) { leaveGroup(p); clearMeal(p); here.stage = 'rise'; p.pose = 'Idle'; }
      break;
    }
    case 'rise':
      if (weightOf(p, clipNamed('Idle')) < 1) break;
      standUp(p);
      here.wait = (2 + peopleRng()*6)*p.traits.patience;
      return null;
  }
  const w = sitWeight(p);
  p.x = stand.x + (seat.x - stand.x)*w; p.z = stand.z + (seat.z - stand.z)*w;
  return null;
}
/** How long someone at a desk keeps typing, and sits back between, in seconds: [shortest, longest]. */
const TYPING_SPELL = [8, 40], SAT_BACK_SPELL = [3, 12];
/** How long someone lingers at the table once their dinner's gone, in seconds. */
const SAT_AFTER_MEAL = 12;
/** How someone sits on a seat: typing, at a desk (if the model can), eating, at a dining table, else sat back. */
const deskPose = seat => seat.desk && hasClip('Typing') ? 'Typing'
  : seat.diner && hasClip('Eating') ? 'Eating' : 'Sit1';
/** The same pose with their hands still, for talking to whoever's sat beside them. */
const pausedPose = pose => (pose === 'Typing' || pose === 'Eating') && hasClip(`${pose}Paused`) ? `${pose}Paused` : pose;
/** How long a spell of a pose at a desk lasts, at random. */
const spellAt = pose => { const [lo, hi] = pose === 'Typing' ? TYPING_SPELL : SAT_BACK_SPELL; return lo + peopleRng()*(hi - lo); };

// ---- talking in a room.
//
// A room chat is a group of kind 'room' (see updateGroups): two standing about, one walking over to the other ('gather')
// then the two talking face to face ('talk'); or two sat side by side — at desks, on the sofa, on chairs (sat: true) —
// straight to talking, their heads turned to each other and whoever was typing stopped, hands left on the keys
// (TypingPaused), until it's over.
// Nobody's waved at or punched: it just ends, and they get on with what they were doing.
/** The chance, each time someone standing in a room moves on, that it's over to talk to someone (times how chatty they are). */
const ROOM_CHAT_CHANCE = 0.35;
/** How often someone sat down thinks about a word with whoever's sat near, in seconds (about), and the chance they do (times how chatty). */
const SEAT_CHAT_EVERY = 8, SEAT_CHAT_CHANCE = 0.3;
/** How far away someone sat can be to talk to from a seat, in metres. */
const SEAT_CHAT_REACH = 2.6;
/** How long a room chat goes on, in seconds: [shortest, longest], standing and sat (times how patient they are). */
const ROOM_CHAT_SPELL = [8, 25], SEAT_CHAT_SPELL = [4, 12];
/** Whether someone's in the same room as the camera now and free to be talked to. */
const freeInRoom = (q, p) => q !== p && q.mode === 'indoors' && q.inRoom?.visit === roomVisit() && !q.inRoom.leaving && !q.group && q.chatCooldown <= 0
  && !q.oneShot && q.traits.chatty > 0;
/**
 * Walk someone in a room along their route.
 * @param {Person} p - the person
 * @param {object} here - their p.inRoom
 * @returns {?{x: number, y: number, z: number}} the next point on it, or null (and the route gone) once they're there
 */
function walkRoute(p, here) {
  const next = here.route[0];
  if (Math.hypot(next.x - p.x, next.z - p.z) >= 0.25) return next;
  here.route.shift();
  if (here.route.length) return here.route[0];
  here.route = null;
  return null;
}
/**
 * Send someone standing in a room over to someone else standing about in it, to talk.
 * @param {Person} p - the person
 * @returns {boolean} whether anyone was found to go over to, and a way there (then in p.inRoom.route)
 */
function goChatInRoom(p) {
  if (p.chatCooldown > 0) return false;
  const friends = people.filter(q => freeInRoom(q, p) && !q.inRoom.seat && !q.inRoom.route);
  if (!friends.length) return false;
  const q = pickFrom(friends), gap = CHAT_GAP*S.peopleSize, away = Math.atan2(p.x - q.x, p.z - q.z);
  // (to talking distance on their side of them, or failing that a little round either way)
  for (const turn of [0, 0.6, -0.6, 1.2, -1.2]) {
    const to = { x: q.x + Math.sin(away + turn)*gap, y: q.y, z: q.z + Math.cos(away + turn)*gap };
    const route = roomRoute(p, to);
    if (!route) continue;
    p.inRoom.route = route; p.faceTo = null;
    q.faceTo = headingTo(q, p);
    const g = { kind: 'room', members: [p, q], stage: 'gather', timer: 20, speaker: null, turnIn: 0 };
    groups.push(g);
    [p, q].forEach(m => { m.group = g; });
    p.lookAt = q; q.lookAt = p;
    return true;
  }
  return false;
}
/**
 * Have someone sat down — typing or sat back at a desk, on the sofa, on a chair — turn to whoever's sat near them, if
 * anyone is, for a word.
 * @param {Person} p - the person
 * @returns {void}
 */
function chatWhileSat(p) {
  if (p.chatCooldown > 0) return;
  const q = people.find(q => freeInRoom(q, p) && q.inRoom.seat && q.inRoom.stage === 'sit'
    && Math.hypot(q.x - p.x, q.z - p.z) < SEAT_CHAT_REACH);
  if (!q) return;
  const [lo, hi] = SEAT_CHAT_SPELL;
  const g = { kind: 'room', sat: true, members: [p, q], stage: 'talk', speaker: null, turnIn: 0,
    timer: (lo + peopleRng()*(hi - lo))*(p.traits.patience + q.traits.patience)/2 };
  groups.push(g);
  [p, q].forEach(m => { m.group = g; m.pose = pausedPose(m.pose); });
}
/**
 * Run a room chat for a frame (see "talking in a room"), ending it if either of them has gone.
 * @param {object} g - the group
 * @param {number} dt - seconds since the last frame
 * @returns {void}
 */
function roomChat(g, dt) {
  const [a, b] = g.members;
  if (!g.members.every(m => m.mode === 'indoors' && m.inRoom?.visit === roomVisit() && m.group === g)) { endRoomChat(g); return; }
  g.timer -= dt;
  if (g.stage === 'gather') {
    b.faceTo = headingTo(b, a);
    if (a.inRoom.route) { if (g.timer <= 0) endRoomChat(g); return; }
    const [lo, hi] = ROOM_CHAT_SPELL;
    g.stage = 'talk';
    g.timer = (lo + peopleRng()*(hi - lo))*(a.traits.patience + b.traits.patience)/2;
  }
  if (endedByLine(g)) return;
  takeTurns(g, g.members, dt);
  if (!g.sat) { a.faceTo = headingTo(a, b); b.faceTo = headingTo(b, a); }
  if (g.timer <= 0) endRoomChat(g);
}
/**
 * End a room chat: both back to what they were doing (typing again, at a desk), and not talking again for a while.
 * @param {object} g - the group
 * @returns {void}
 */
function endRoomChat(g) {
  removeGroup(g);
  if (g.stage !== 'gather') talked(g, RELATE.roomChat);
  g.members.splice(0).forEach(m => {
    m.group = null; m.lookAt = null;
    m.chatCooldown = 15 + peopleRng()*30;
    const here = m.inRoom;
    if (!here) return;
    if (m.pose === 'TypingPaused') { m.pose = 'Typing'; here.spell = spellAt('Typing'); }
    else if (m.pose === 'EatingPaused') m.pose = 'Eating';
    if (!here.seat) { here.route = null; here.wait = (1 + peopleRng()*4)*m.traits.patience; }
  });
}

/** What the followed building's card was last told, so it's only told again when it changes. */
let inhabitantsKey = null;
/** Whoever indoors the camera's waiting on, or -1. */
export let awaited = -1;
/** Set whenever the camera starts or stops waiting on someone indoors (see showInhabitants). */
export function setAwaited(v) { awaited = v; }
/**
 * Tell the followed building's card who's inside, by name (see building-card.js). Clicking one of them waits on that one
 * — the camera leaves the building with them when they come back out the door (see awaited), the way it gets off a train
 * with whoever it came aboard with. From inside the room, it brings up their card too (see followPersonInside).
 * @returns {void}
 */
export function showInhabitants() {
  const key = App.followedBuildingKey?.();
  const inside = [];
  if (key && S.peopleEnabled) people.forEach((p, i) => { if (p.mode === 'indoors' && p.indoors.stage === 'inside' && p.indoors.building.key === key) inside.push(i); });
  if (!inside.includes(awaited)) awaited = -1; // (the building let go of, or whoever it was gone some other way)
  const shownKey = key + '|' + inside.join(',') + '|' + awaited + '|' + profilesVersion() + '|' + !!personModel;
  if (shownKey === inhabitantsKey || !App.setBuildingCardInhabitants) return;
  inhabitantsKey = shownKey;
  if (key) App.setBuildingCardInhabitants(
    inside.map(i => profileOf(people[i].id, personModel ? personModel.isMan[i] === 1 : null).name),
    inside.indexOf(awaited),
    at => { if (App.isInsideBuilding()) followPersonInside(inside[at]); else awaited = inside[at]; },
  );
}

/**
 * Move the camera, following someone who's gone indoors, back far enough to take in the building they're in.
 * @param {object} b - the building (see buildingDoors)
 * @returns {void}
 */
function lookAtBuilding(b) {
  controls.goalRadius = Math.max(controls.goalRadius, Math.min(400, (b.size + b.height)*1.6));
}

/**
 * Swoop the camera back in on someone who's come out of a building.
 * @param {Person} p - the person
 * @returns {void}
 */
function lookAtPerson(p) {
  controls.goalRadius = Math.max(controls.minRadius, Math.min(controls.goalRadius, personHeight(p)*9));
}

/**
 * Whether this person is walking over a road (see updateCrossing) — treated like someone standing in the middle of it
 * ('mid') by checkYield in life/traffic/lanes.js: out on the live lanes, not on a sidewalk.
 * @param {Person} p - the person
 * @returns {boolean} whether they're in the road
 */






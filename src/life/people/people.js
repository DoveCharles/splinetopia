import { App, S } from '../../core/shared.js';
import { mulberry32 } from '../../core/math.js';
import { buildingName } from '../../buildings/building-types.js';
import { isInsideBuilding, roomHolds, roomVisit } from '../../buildings/interior.js';
import * as THREE from 'three';
import { scene, camera } from '../../core/scene.js';
import { controls } from '../../core/camera-controls.js';
import { blastFx, explode } from '../giblets.js';
import { blasts, PERSON_BLAST_SCALE } from '../traffic/state.js';
import { canRespawn, PERSON_SHAKE, shake } from '../revive.js';
import { throwBodyParts } from './peopleGibs.js';
import { babble, nextSyllable, hearDistance } from '../../audio/voices.js';
import { sayLine, shoutLine, reactAloud, lineMouth, stopLine, linePause } from '../../audio/dictionary.js';
import { pickThought, pickReaction } from '../speech-text.js';
import { babbleLine, hasBubble, speechBubble } from '../../ui/speech-bubbles.js';
import { footstep } from '../../audio/footsteps.js';
import { ear } from '../../audio/sfx.js';
import { keyClick } from '../../audio/typing.js';
import { mealCue, snackClip, snackClipName, updateHeld } from './peopleHolding.js';
import { controlInput, possession } from '../possession.js';
import { DEFAULT_TRAITS, profileOf, profilesVersion } from '../profiles.js';
import { BLINK_DURATION, FADE_POSE, FADE_QUICK, FADE_SNACK, FIDGETS, GRASS_SITS, LOOK_MAX_TILT, LOOK_MAX_TURN, PERSON_BAKE_FPS, PERSON_TRAIT_COLORS } from './peopleModel.js';
import { navRebuildOnHold } from '../../roads/roads.js';
import { getTrainStations } from '../../trains/trains.js';
import { closestPointOnSegment } from '../../buildings/footprints.js';
import { MELODIES } from '../../audio/melodies.js';
import { favoritePeople, isFavoritePerson } from '../../ui/favorites.js';
import { registerHealthKind } from '../../core/health.js';
import { CROSS_SPEED_MULT, ROADSAFETY_RADIUS, buildPeopleNav, joinWalkway, maybeCrossRoad, rebuildPeopleNavDebug, reseatPerson, spawnPerson, updateCrossing, walkAlong, walkwayPoint } from './peoplePathing.js';
import { hidingFromSun, outOfTime, vanishIndoors } from './peopleActivities.js';
import { PUNCH_CHASE_SPEED, awaited, setAwaited, endActivity, goChat, goLieDown, goRideTrain, goSit, knockOver, holdDown, landFall, meetOnWalkways, pickFights, showInhabitants, showPassengers, stationLinks, updateActivity, updateAttack, updateGroups, updateIndoors, updatePunched, updateTrainRider } from './peopleActivities.js';
import { holdDrowned, inWater, turnInWater, updateWater, wouldWade, onWater } from './peopleWater.js';
import { turnCrawling } from './peopleRoad.js';
import { drinking, goBuy, hasStallIn, maybeBuyOnWalkway, updateBuying } from './peopleStalls.js';
import { sway, updateDrunk } from './peopleDrunk.js';
import { avoidSmells, updateFlies } from './peopleSmell.js';
import { bloodBurst, bloodFear, bloodSpeed, bloodlustSpeed, isBloodlusting, updateArrivingBlood, updateBlood } from './peopleBlood.js';
import { followPersonAt, followPerson, followPersonInside, followedInside, headshotOf, personHeight, pickPerson, placePossessedCamera, possessPerson, punchFromPossession, stopFollowingPerson, unpossessPerson, updateSwing, walkPossessed, cancelSwing, showFollowedDoing } from './peopleTracking.js';
export { loadPersonModel } from './peopleModel.js';

// The shapes these modules pass around — Person, NavLine, NavVertex, Hangout, PersonModel, Segment and SegmentHit —
// are declared in peopleTypes.js. That file is deliberately not a module, so its typedefs are global and every file
// in here can name them in JSDoc without importing anything.


export const PEOPLE_MAX = 2000;
export const PERSON_WALK_SPEED = 1.4;   // world units per second at speed 1
/** Moonwalkers (the backwards trait) face the way they're going, the walk played in reverse — or, false, face away and step backwards. */
export const MOONWALK_FACING_FORWARD = true;
/** How far a moonwalker faces round from the way they're going. */
export const moonwalkTurn = p => p.traits.backwards && !MOONWALK_FACING_FORWARD ? Math.PI : 0;
/** How often, at least, the walkways are resampled to a point — for entrances and for re-seating people. */
export const PEOPLE_NAV_SPACING = 4;
S.peopleEnabled = false, S.peopleAmount = 300, S.peopleSpeed = 1, S.peopleSize = 1, S.showRoadsafetyDebug = false, S.showPeopleNavDebug = false, S.peopleFrozen = null;
// Everyone's permanent identity — who they are, not where they're standing. Their place in the crowd (their index in
// `people`) is just whichever render slot they're currently using, and gets reused once they're gone; their id (see
// peopleIdSeq, same convention as roadNodeSeq and the other counters in core/state.js) is what their name, age, traits
// and looks are seeded from instead (see refreshTraits below and assignAppearance in peopleModel.js), so someone new
// moving into a dead person's old slot doesn't raise them from the dead. Kept in the project (see project/save-load.js),
// so ids never collide across a reload.
S.peopleIdSeq = 1;
export let peopleNav = null, peopleNavBuiltAt = -Infinity, peopleNavDebugBuiltAt = -Infinity, lastPeopleTime = null;
export const people = [];
export const peopleRng = mulberry32(90210);
/** The camera layer the people (and the lights) are also on, for the person card's headshot to draw them alone. */
export const HEADSHOT_LAYER = 3;
export let personModel = null; // { mesh, anim, look, hair, wornLayers, isMan, height, minY, clips, stride } once loaded
/**
 * Pick one of `items` at random, weighted.
 * @param {Array<*>} items - what to pick from
 * @param {function(*): number} weightOf - how much each item weighs
 * @returns {number} the index of the one picked
 */
export function pickWeighted(items, weightOf) {
  const total = items.reduce((sum, item) => sum + weightOf(item), 0);
  let r = peopleRng()*total;
  for (let i=0;i<items.length;i++) { r -= weightOf(items[i]); if (r <= 0) return i; }
  return items.length - 1;
}

/**
 * Work out how far along the straight walk from `from` to (x, z) someone gets while staying in the hangout, and whether
 * that's all the way. Water is no part of a hangout (see buildPeopleNav), and people walk straight at where they're
 * going, so this is what keeps them out of a pond: they stop at the bank and set off again from there.
 * @param {Hangout} area - the hangout they're walking in
 * @param {{x: number, z: number}} from - where they're setting off
 * @param {number} x - where they're heading
 * @param {number} z
 * @returns {{x: number, z: number, d: number, clear: boolean}} as far as they get, how far that is, and whether it's the whole way
 */
/** The hangout's ground for someone: waterwalking/aqua people walk its water too (area.insideWet, see buildPeopleNav). */
export const insideFor = (area, who) => who?.traits && onWater(who) ? area.insideWet : area.inside;

export function walkableUpTo(area, from, x, z) {
  const inside = insideFor(area, from), dx = x - from.x, dz = z - from.z, len = Math.hypot(dx, dz), steps = Math.max(1, Math.ceil(len/1.5));
  let last = 0;
  for (let k=1;k<=steps;k++) {
    const frac = k/steps;
    if (!inside(from.x + dx*frac, from.z + dz*frac)) return { x: from.x + dx*last, z: from.z + dz*last, d: len*last, clear: false };
    last = frac;
  }
  return { x, z, d: len, clear: true };
}

/**
 * Work out where someone should actually head for a spot they've picked out in their hangout.
 * @param {Hangout} area - the hangout
 * @param {{x: number, z: number}} from - where they're setting off
 * @param {number} x - the spot they picked
 * @param {number} z
 * @returns {?{x: number, z: number}} the spot itself when the walk there is clear, else as far along the way as they get
 * before the water, or null when that's nowhere at all
 */
export function reachableSpot(area, from, x, z) {
  const reach = walkableUpTo(area, from, x, z);
  return reach.clear || reach.d > 0.5 ? { x: reach.x, z: reach.z } : null;
}

/** How long a swim lasts, seconds (× patience); how many spots are tried for one. */
const SWIM_TIME = [8, 25], SWIM_TRIES = 24, SWIM_WEIGHT = 0.25; // (…; how likely a swim is next, beside the other choices' weights)
/**
 * Waterwalking/aqua people off for a swim: a spot on the water in or off their hangout (area.insideWet but not inside),
 * reached without leaving it. p.swimming 'going' → 'in' on arrival (held SWIM_TIME) → cleared (see updatePeople).
 * @returns {boolean} whether there was one
 */
function goSwim(p, area) {
  const box = area.wetBox;
  for (let k=0;k<SWIM_TRIES;k++) {
    const x = box.minX + peopleRng()*(box.maxX - box.minX), z = box.minZ + peopleRng()*(box.maxZ - box.minZ);
    if (area.inside(x, z) || !area.insideWet(x, z) || !walkableUpTo(area, p, x, z).clear) continue;
    p.tx = x; p.tz = z; p.swimming = 'going';
    return true;
  }
  return false;
}

/** Held at the water's edge: a hangout wanderer picks somewhere else; one mid-activity gives it up after BANK_GIVE_UP seconds. */
const BANK_GIVE_UP = 2;
function stopAtBank(p, dt) {
  if (p.mode !== 'wander') return;
  p.swimming = null;
  if (!p.act) { p.tx = p.x; p.tz = p.z; return; }
  p.bankHeld = (p.bankHeld ?? 0) + dt;
  if (p.bankHeld > BANK_GIVE_UP) { p.bankHeld = 0; endActivity(p); p.tx = p.x; p.tz = p.z; }
}

/**
 * Pick a random spot inside a hangout — near `near` if one can be found there, and one they can walk to from `from`
 * (where they're setting off, `near` by default) without crossing water. Where nothing in reach is clear, the furthest
 * they can get along the way to one — up to the bank — so someone by a pond still works their way round it.
 * @param {Hangout} area - the hangout
 * @param {?{x: number, z: number}} [near] - roughly where to look, or null for anywhere in the hangout
 * @param {{x: number, z: number}} [from] - where they're setting off (near, by default)
 * @returns {{x: number, z: number}} the spot
 */
export function randomSpotIn(area, near, from) {
  const start = from || near, inside = insideFor(area, start), box = inside === area.insideWet ? area.wetBox : area;
  let best = null;
  for (let k=0;k<24;k++) {
    const x = near && k < 12 ? near.x + (peopleRng()-0.5)*24 : box.minX + peopleRng()*(box.maxX-box.minX);
    const z = near && k < 12 ? near.z + (peopleRng()-0.5)*24 : box.minZ + peopleRng()*(box.maxZ-box.minZ);
    if (!inside(x, z)) continue;
    if (!start) return { x, z };
    const reach = walkableUpTo(area, start, x, z);
    if (reach.clear) return { x, z };
    if (reach.d > 0.5 && (!best || reach.d > best.d)) best = reach;
  }
  if (best) return { x: best.x, z: best.z };
  return start ? { x: start.x, z: start.z } : { x: (area.minX+area.maxX)/2, z: (area.minZ+area.maxZ)/2 };
}
/**
 * Count how many of an ascending list come below a limit.
 * @param {number[]} sorted - the values, ascending
 * @param {number} limit - the value to count below
 * @returns {number} how many are below it
 */
export function countBelow(sorted, limit) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < limit) lo = mid + 1; else hi = mid; }
  return lo;
}
/** The conversations going on: { kind: 'chat' (two, standing) or 'circle' (sat on the grass), members, speaker, turnIn, … }. */
export const groups = [];
/**
 * Look up the baked animation of this name.
 * @param {string} name - the animation's name (see PERSON_CLIPS)
 * @returns {?object} the baked animation, or null before the model's loaded
 */
export const clipNamed = name => personModel ? personModel.clips[name] : null;

/**
 * Whether the model has this animation at all.
 * @param {string} name - the animation's name (see PERSON_CLIPS)
 * @returns {boolean} whether it's there and not missing
 */
export const hasClip = name => { const clip = clipNamed(name); return !!clip && !clip.missing; };

/**
 * Pick one of a list at random.
 * @param {Array<*>} list - what to pick from
 * @returns {*} the one picked
 */
export const pickFrom = list => list[Math.floor(peopleRng()*list.length)];

/**
 * Wrap an angle into -π…π.
 * @param {number} a - the angle
 * @returns {number} the same angle, wrapped
 */
export const wrapAngle = a => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Which way one point is from another, in radians.
 * @param {{x: number, z: number}} p - the point looking
 * @param {{x: number, z: number}} q - the point looked at
 * @returns {number} the heading
 */
export const headingTo = (p, q) => Math.atan2(q.x - p.x, q.z - p.z);

/**
 * How much the model is scaled to be this person's height.
 * @param {Person} p - the person
 * @returns {number} the scale
 */
export const modelScale = p => 1.7*p.height*S.peopleSize/personModel.height;

/**
 * How much of a person's pose is `clip`, part-way through blending from one animation into the next — counting any version
 * of it (Idle with a coffee in hand is still Idle: see snackClips in peopleModel.js).
 * @param {Person} p - the person
 * @param {object} clip - the animation to weigh
 * @returns {number} from 0 to 1
 */
export const weightOf = (p, clip) => (p.clipA === clip || p.clipA?.base === clip ? p.fade : 0) + (p.clipB === clip || p.clipB?.base === clip ? 1 - p.fade : 0);
/**
 * How far into sitting on a seat someone is: sat back (Sit1), at a keyboard (Typing, TypingPaused) or at their dinner
 * (Eating, EatingPaused), all sat the same way, from 0 to 1.
 * @param {Person} p - the person
 * @returns {number}
 */
export const sitWeight = p => personModel ? ['Sit1', 'Typing', 'TypingPaused', 'Eating', 'EatingPaused'].reduce((w, name) => w + weightOf(p, personModel.clips[name]), 0) : 0;

/**
 * Work out the row of the bone texture a person's at in an animation: along the walk by how far they've walked, round a
 * looping one by the time, and through one playing once by how long it's played.
 * @param {Person} p - the person
 * @param {object} clip - the animation
 * @returns {number} the row
 */
export function clipRow(p, clip) {
  if ((clip.base ?? clip).name === 'Walk') return clip.start + p.walkCycle*clip.frames;
  if (clip.loop) return clip.start + (p.idleTime*PERSON_BAKE_FPS) % clip.frames;
  return clip.start + Math.min(clip.frames - 1, p.shotTime*PERSON_BAKE_FPS);
}

/**
 * Start a person blending into an animation from the one they're in — or back, if they're still blending out of it.
 * @param {Person} p - the person
 * @param {object} clip - the animation to blend into
 * @returns {void}
 */
export function setClip(p, clip) {
  if (p.clipA === clip) return;
  p.rowB = clipRow(p, p.clipA);
  p.fade = p.clipB === clip ? 1 - p.fade : 0;
  p.fadeTime = clip.pose || p.clipA.pose ? FADE_POSE : clip.base || p.clipA.base ? FADE_SNACK : FADE_QUICK;
  p.clipB = p.clipA;
  p.clipA = clip;
}

// The one-off clips that swing the right hand about, and what someone with a snack in it plays instead: the same with
// the left hand (see `mirror` in PERSON_CLIPS), their right arm still holding it (WaveLeftBeer…).
const WITH_HAND_FULL = { Idle2: 'Idle2Left', Wave: 'WaveLeft' };
/**
 * Play an animation through once — or hold its single pose, for the poses (see PERSON_CLIPS).
 * @param {Person} p - the person
 * @param {string} name - the animation's name
 * @returns {void}
 */
export function playOnce(p, name) {
  if (p.snack && name in WITH_HAND_FULL) name = WITH_HAND_FULL[name] + snackClipName(p);
  if (!name || !hasClip(name)) return;
  p.oneShot = clipNamed(name);
  p.shotTime = 0;
  p.shotRate = 1; // (how many times faster than normal it plays; set again after this call to speed one up)
}
/** The index in people of whoever the camera's following, or -1. */
export let followed = -1;
/** Someone the camera was following when they got on a train, to follow again when they get off, or -1. */
export let riderFollowed = -1;
/**
 * Whether this person is out of sight — nowhere, dead, shut in a train or in a building.
 * @param {Person} p - the person
 * @returns {boolean} whether they're gone
 */
export const isGone = p => p.mode === 'none' || p.mode === 'dead' || aboard(p)
  || (p.mode === 'indoors' && p.indoors.stage === 'inside');
/**
 * Whether this person is riding in a train carriage — standing in it, and drawn there (see updateTrainRider), though they
 * count as gone for everything else.
 * @param {Person} p - the person
 * @returns {boolean} whether they're aboard
 */
export const aboard = p => p.mode === 'train' && p.train.stage === 'ride';
/**
 * Whether this person is drawn: not gone, or gone only into the room the camera's in or onto a train.
 * @param {Person} p - the person
 * @returns {boolean} whether they're drawn
 */
export const isDrawn = p => !isGone(p) || inRoom(p) || aboard(p);
/**
 * Whether this person is inside the building the camera's gone into, and so drawn in its room (see buildings/interior.js)
 * though they count as gone for everything else.
 * @param {Person} p - the person
 * @returns {boolean} whether they're in the room
 */
const FOOTFALLS = 0.13, STEPS_PER_CYCLE = 4; // how far through the walk cycle a foot first comes down, and how many times
// one does in a cycle: the Walk clip is two full strides, left, right, left, right, each foot reaching furthest forward there
// Someone's voice (see audio/voices.js), the same every time for the same person: its pitch, lower for a man than a woman
// and for someone taller; its formants, likewise lower, and shifted either way on their own, apart from the pitch, so two
// voices at one pitch can still sound nothing alike; how sharp those formants ring, from breathy to nasal; and the tune
// they talk in (see audio/melodies.js).
function voiceOf(p, i) {
  const own = mulberry32(i*7919 + 13), isMan = personModel?.isMan[i] === 1, tall = Math.sqrt(Math.max(0.5, p.height));
  const pitch = (isMan ? 150 : 250)/tall*(0.85 + 0.3*own());
  const formant = (isMan ? 1 : 1.15)/Math.sqrt(tall)*(0.8 + 0.42*own());
  const sharpness = 3 + 9*own();
  return { pitch, formant, sharpness, melody: Math.floor(own()*MELODIES.length), isMan };
}
/** Someone's voice (see voiceOf), for a sound made outside the frame loop: a cry as they're hit, say. */
export const voiceOfPerson = p => voiceOf(p, people.indexOf(p));
export const inRoom = p => p.mode === 'indoors' && p.indoors.stage === 'inside' && !!p.inRoom
  && p.inRoom.visit === roomVisit() && roomHolds(p.indoors.building.key);
export let indoorsCount = 0;
/**
 * What a building's called on the card of whoever's in it: its kind's name and its own number (see building-types.js).
 * @param {object} b - the building (see buildingDoors)
 * @returns {string} the label
 */

export const buildingLabel = b => buildingName(b.kind, b.number, b.height) + ' #' + b.number;


export function setPersonModel(m) { personModel = m; }
export function setPeopleNav(nav) { peopleNav = nav; }
export function setPeopleNavBuiltAt(t) { peopleNavBuiltAt = t; }
export function setPeopleNavDebugBuiltAt(t) { peopleNavDebugBuiltAt = t; }
export function setLastPeopleTime(t) { lastPeopleTime = t; }
export function setFollowed(i) { followed = i; }
export function setRiderFollowed(i) { riderFollowed = i; }
export function setIndoorsCount(n) { indoorsCount = n; }

/**
 * Whether this is a hangout people sit and lie down on the ground in, rather than on benches.
 * @param {Hangout} area - the hangout
 * @returns {boolean} whether it's open ground
 */
export const isOpenGround = area => area.kind === 'park' || area.kind === 'beach';

// ============================================== PEOPLE ==============================================
// People are cuboids in random colors, drawn as one instanced mesh — replaced by the models in "the people model" below
// once they load.
//
// Most walk the walkways (the sidewalks either side of sidewalk roads, and paths), through junctions, turning off at
// links and back at dead ends. A walker passing a plaza, park or beach sometimes wanders in, drifts between spots (often
// to someone already there), waits, then leaves by the nearest walkway.
//
// The walkways are rebuilt when the roads or zones change (see buildPeopleNav), and anyone on a moved walkway is
// re-seated on the nearest one.
export const peopleMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ roughness: 0.8 }), PEOPLE_MAX);
peopleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
{
  const color = new THREE.Color();
  for (let i=0;i<PEOPLE_MAX;i++) peopleMesh.setColorAt(i, color.setHSL(peopleRng(), 0.45 + peopleRng()*0.4, 0.42 + peopleRng()*0.25));
}
peopleMesh.count = 0;
peopleMesh.frustumCulled = false;
peopleMesh.castShadow = true; peopleMesh.receiveShadow = true;
peopleMesh.visible = false;
peopleMesh.name = 'People';
scene.add(peopleMesh);

// Debug wireframes (World → Peds → Roadsafety radius (debug)): a sphere around each person showing how far they check for
// traffic before crossing (see ROADSAFETY_RADIUS below), and a box around them showing the hitbox a car's run-over check
// uses (see runOverPeople in life/traffic/collisions.js) — off by default, and only kept up to date while the toggle's on.
export const roadsafetyDebugMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: 0x3ddc97, wireframe: true, transparent: true, opacity: 0.35 }), PEOPLE_MAX);
roadsafetyDebugMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
roadsafetyDebugMesh.count = 0;
roadsafetyDebugMesh.frustumCulled = false;
roadsafetyDebugMesh.visible = false;
roadsafetyDebugMesh.name = 'RoadsafetyDebug';
scene.add(roadsafetyDebugMesh);
// (the half-sphere for someone waiting in the road)
export const roadsafetyHalfDebugMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 12, 0, Math.PI), roadsafetyDebugMesh.material, PEOPLE_MAX);
roadsafetyHalfDebugMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
roadsafetyHalfDebugMesh.count = 0;
roadsafetyHalfDebugMesh.frustumCulled = false;
roadsafetyHalfDebugMesh.visible = false;
roadsafetyHalfDebugMesh.name = 'RoadsafetyHalfDebug';
scene.add(roadsafetyHalfDebugMesh);
export const pedHitboxDebugMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshBasicMaterial({ color: 0xffd23d, wireframe: true }), PEOPLE_MAX);
pedHitboxDebugMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
pedHitboxDebugMesh.count = 0;
pedHitboxDebugMesh.frustumCulled = false;
pedHitboxDebugMesh.visible = false;
pedHitboxDebugMesh.name = 'PedHitboxDebug';
scene.add(pedHitboxDebugMesh);
// The walkway lines, rebuilt whenever the nav is: cyan along each ring and path, red where a path crosses a road (and
// nobody walks there), yellow across a zebra crossing, white joining a path to the sidewalk it meets.
export const peopleNavDebugMesh = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthTest: false }));
peopleNavDebugMesh.frustumCulled = false;
peopleNavDebugMesh.visible = false;
peopleNavDebugMesh.renderOrder = 999;
peopleNavDebugMesh.name = 'PeopleNavDebug';
scene.add(peopleNavDebugMesh);
/**
 * Push the people settings into the World panel's controls and their value readouts.
 * @returns {void}
 */
export function syncPeopleUI() {
  document.getElementById('s-people').classList.toggle('on', S.peopleEnabled);
  document.getElementById('people-settings').style.display = S.peopleEnabled ? 'block' : 'none';
  document.getElementById('s-roadsafety-debug').classList.toggle('on', S.showRoadsafetyDebug);
  document.getElementById('s-peoplenav-debug').classList.toggle('on', S.showPeopleNavDebug);
  document.getElementById('s-peopleamount').value = S.peopleAmount;
  document.getElementById('dv-peopleamount').textContent = String(Math.round(S.peopleAmount));
  document.getElementById('s-peoplespeed').value = S.peopleSpeed;
  document.getElementById('dv-peoplespeed').textContent = S.peopleSpeed.toFixed(1);
  document.getElementById('s-peoplesize').value = S.peopleSize;
  document.getElementById('dv-peoplesize').textContent = S.peopleSize.toFixed(1);
  document.getElementById('s-traffic').value = S.trafficAmount;
  document.getElementById('dv-traffic').textContent = String(Math.round(S.trafficAmount));
}


/**
 * Make a person with their traits and state at their starting values.
 * @param {number} [id] - their person id: a specific one to revive (someone hearted and saved, whose slot a reload
 *   hasn't reached yet — see updatePeople), or left out for a fresh one
 * @returns {Person} the person
 */
export function newPerson(id = S.peopleIdSeq++) {
  const baseHeight = 0.85 + peopleRng()*0.27; // (their height, before their size trait)
  return { id, x:0, y:0, z:0, heading: peopleRng()*Math.PI*2, stride: 0.8 + peopleRng()*0.4, baseHeight, height: baseHeight, phase: peopleRng()*10,
    mode: 'none', li: 0, u: 0, dir: 1, seg: 0, lat: 0, area: -1, tx: 0, tz: 0, wait: 0, exit: null, moving: false, stepped: 0,
    // the model's animation: how far through the walk (in whole cycles) and the looping ones (in seconds) they are; the
    // animation they're in (clipA) and the one they're blending out of (clipB, held at row rowB), how far they've blended and
    // how long it takes; the pose they're in when they're not walking, and one playing through once (and for how long it has);
    // how tall their pose leaves them; the time to their next blink and since their last;
    //
    // which way they're looking (their head turned and tilted, the way it's turning to, and the time until they glance
    // somewhere else); and how long they've stood about, and how long until they fidget
    walkCycle: peopleRng(), idleTime: peopleRng()*10, clipA: null, clipB: null, rowB: 0, fade: 1, fadeTime: FADE_QUICK,
    pose: 'Idle', oneShot: null, shotTime: 0, heightScale: 1, blinkIn: peopleRng()*6, blinkAge: BLINK_DURATION,
    lookTurn: 0, lookTilt: 0, lookTurnTo: 0, lookTiltTo: 0, lookIn: peopleRng()*4, stillFor: 0, fidgetAfter: 2 + peopleRng()*5,
    // what they're doing besides walking about (see "what people get up to"): act 'chat', 'bench', 'circle' or 'lie', how
    // far along it they are (stage) and for how long (timer); where they're sitting or lying (spot, seat, the pose — sitClip
    // or lieClip — and circleAngle round a circle); the group they're talking in; the way they should face and who they're
    // looking at; how far up onto a bench seat they sit;
    //
    // and their mouth — how open it's going to (talkTo, until talkIn) and their expression (emotionTo, until emotionIn)
    act: null, stage: '', timer: 0, spot: null, seat: null, sitClip: null, lieClip: null, circleAngle: 0, group: null,
    faceTo: null, lookAt: null, seatLift: 0, chatCheckIn: peopleRng(), chatCooldown: peopleRng()*20,
    talk: 0, talkTo: 0, talkIn: 0, emotion: 0, emotionTo: 0, emotionIn: 0,
    // and their eyes: how shocked, happy, angry and sad they look
    eyes: [0, 0, 0, 0],
    // their traits, from what they were picked in people/*.txt (see refreshTraits)
    traits: DEFAULT_TRAITS, traitsKey: '',
    // how they're taking someone blowing up nearby, if they are (see frightenBystanders)
    fright: null,
    stun: null,
    please: null,
    // crossing a road (see updateCrossing): where they are on it (null if they aren't), the way over, how long until they
    // next consider crossing mid-block, and linkCooldown, which stops them turning off at another junction straight after one
    crossStage: null, jc: null, crossCheckIn: peopleRng()*5, linkCooldown: 0,
    // riding the trains (see "riding the trains"): where they are in it (null if they aren't), and how long until they
    // consider riding again
    train: null, trainCooldown: 20 + peopleRng()*40, snack: null, buy: null, snackCooldown: peopleRng()*30,
    // going into a building (see "going indoors"): where they are in it (null if they aren't), and how long until they
    // consider going into one again
    indoors: null, inRoom: null, indoorsCooldown: 10 + peopleRng()*30,
    // punching (see "punching"): who they're going for, how far along it they are, how long until they consider it again,
    // and being punched themselves
    attack: null, punchCooldown: 10 + peopleRng()*30, punched: null };
}

/**
 * Work out a person's traits, from the entries picked for them in people/*.txt (see profiles.js) by their id — who they
 * are, not where they're standing (see the note on peopleIdSeq above). Worked out again whenever people/*.txt loads,
 * and once the model's loaded and says whether they're a man (which decides their name, and so the rest of their
 * picks; sex is still tied to their render slot, not their id — see assignAppearance in peopleModel.js).
 * @param {Person} p - the person
 * @param {number} i - their place in the crowd, just to look up their slot's sex
 * @returns {void}
 */
export function refreshTraits(p, i) {
  const isMan = personModel ? personModel.isMan[i] === 1 : null, key = profilesVersion() + ':' + isMan;
  if (p.traitsKey === key) return;
  p.traitsKey = key;
  const profile = profileOf(p.id, isMan);
  p.traits = profile.traits;
  p.height = p.baseHeight*p.traits.size;
  p.age = profile.age;
  p.name = profile.name; // (for their card, and for naming them in the morality notices when they die)
  p.loves = profile.lovesSaid; p.hates = profile.hatesSaid; // (for what they say: see life/speech-text.js)
  p.lovedWords = profile.lovedWords; p.hatedWords = profile.hatedWords;
  p.isMan = isMan; // (null for the cuboid people; for {man} in what they say)
}

export const FRIGHT_RADIUS = 14, FLEE_SPEED = 2.3;
// The whites of the eyes of vampires move this share of the way to yellow to start with, and again for each 100 years of age;
// the blazed trait moves them BLAZED_EYE_RED of the way to red. (Bloodlust's eyes are in peopleBlood.js.)
const VAMPIRE_EYE_TINT = 0.2, VAMPIRE_EYE_COLOR = new THREE.Color(0xffc40c),
   BLAZED_EYE_RED = 0.05, EYE_RED_COLOR = new THREE.Color(0xff0000);
// Vampires' skin moves 10% of the way to the colour for every 100 years of age, counting from the first (so it starts out 10% grey).
const VAMPIRE_SKIN_COLOR = new THREE.Color(0xd3d3d3), VAMPIRE_PALE_PER_CENTURY = 0.1;
const BUBBLE_HEIGHT = 2; // how high over their feet (× height, × people size) a speech bubble's tail points (see ui/speech-bubbles.js)
const BUBBLE_CHAIR_DROP = 0.5, BUBBLE_GROUND_DROP = 0.8; // how much lower (same units) sat on a seat, and sat on the ground
// Someone on their own may think something (thoughts.txt: see life/speech-text.js) as they fidget with one of
// THINK_FIDGETS — THINK_CHANCE of the time (× chat speed), and no sooner than THINK_REST after their last (a rest of their
// own, started at random, so people don't all think together) — shown in a bubble for THOUGHT_TIME, only within
// Options > Speech > Bubble distance of the camera. (What they've just seen or felt, they react to aloud: see reactAloud.)
// Returns the thought while it shows.
const THINK_FIDGETS = FIDGETS, THINK_CHANCE = 0.35, THOUGHT_TIME = 4, THINK_REST = [20, 60];
function thoughtOf(p, dt) {
  const now = performance.now()/1000;
  if (p.thought && now < p.thoughtUntil) return p.thought;
  p.thought = null;
  const near = Math.hypot(p.x - camera.position.x, p.y - camera.position.y, p.z - camera.position.z) <= (S.bubbleDistance ?? 35);
  const show = text => { p.thought = { text, thought: true }; p.thoughtUntil = now + THOUGHT_TIME; return p.thought; };
  const fidgeted = p.fidgetThought;
  p.fidgetThought = false;
  p.nextThoughtAt ??= now + THINK_REST[0] + peopleRng()*(THINK_REST[1] - THINK_REST[0]);
  if (!fidgeted || now < p.nextThoughtAt || !near || peopleRng() >= THINK_CHANCE*(S.chatSpeed ?? 1)) return null;
  p.nextThoughtAt = now + (THINK_REST[0] + peopleRng()*(THINK_REST[1] - THINK_REST[0]))/(S.chatSpeed ?? 1);
  const thought = pickThought(p);
  return thought ? show(thought.text) : null;
}
// where someone's speech bubble points: over their head, lower as they sit (on a seat, raised by seatLift, or on the ground)
function bubbleAt(p) {
  const chair = sitWeight(p), ground = personModel ? GRASS_SITS.reduce((w, name) => w + weightOf(p, personModel.clips[name]), 0) : 0;
  const up = (BUBBLE_HEIGHT - chair*BUBBLE_CHAIR_DROP - ground*BUBBLE_GROUND_DROP)*p.height*S.peopleSize + p.seatLift*chair;
  return { x: p.x, y: p.y + up, z: p.z };
}
const LYING_CLEARANCE = 1; // how near (at people size 1) anyone walks to someone lying on the ground
/**
 * Have everyone around someone blowing up notice it: the nearer they are, the sooner, and they run off for a while.
 * @param {Person} victim - whoever it is
 * @returns {void}
 */
function frightenBystanders(victim, source = null) {
  const reach = FRIGHT_RADIUS*S.peopleSize, from = source ?? { x: victim.x, z: victim.z };
  people.forEach(p => {
    if (p === victim || isGone(p)) return;
    const d = Math.hypot(p.x - victim.x, p.z - victim.z);
    if (d <= reach) p.fright = { stage: 'notice', timer: 0.15 + d/reach*0.6 + peopleRng()*0.3, from };
  });
}

/**
 * Have everyone around someone blowing up notice it and stand dazed, rather than running off.
 * @param {Person} victim - whoever it is
 * @returns {void}
 */
function stunBystanders(victim, source = null) {
  const reach = FRIGHT_RADIUS*S.peopleSize, from = source ?? { x: victim.x, z: victim.z };
  people.forEach(p => {
    if (p === victim || isGone(p)) return;
    const d = Math.hypot(p.x - victim.x, p.z - victim.z);
    if (d <= reach) p.stun = { stage: 'notice', timer: 0.15 + d/reach*0.6 + peopleRng()*0.3, from };
  });
}

/**
 * Have everyone around someone blowing up notice it and beam, rather than running off.
 * @param {Person} victim - whoever it is
 * @returns {void}
 */
function pleaseBystanders(victim, source = null) {
  const reach = FRIGHT_RADIUS*S.peopleSize, from = source ?? { x: victim.x, z: victim.z };
  people.forEach(p => {
    if (p === victim || isGone(p)) return;
    const d = Math.hypot(p.x - victim.x, p.z - victim.z);
    if (d <= reach) p.please = { stage: 'notice', timer: 0.15 + d/reach*0.6 + peopleRng()*0.3, from };
  });
}

/** How evil someone has to be to count as guilty rather than innocent, and as villainous rather than guilty. */
const EVIL_GUILTY_ABOVE = 0.05, EVIL_VILLAINOUS_ABOVE = 0.35;
/**
 * What someone counts as, by how evil they are: an innocent, a bad sort, or a villain. The thresholds the crowd's
 * reaction and the morality meter both go by, so the two always agree.
 * @param {Person} p - the person
 * @returns {'innocent'|'guilty'|'villainous'} what they count as
 */
export function standingOf(p) {
  // the traits they're actually going about with, which are picked for their own sex (see refreshTraits); an evil
  // score they somehow never got counts as innocent
  const evil = p.traits.evil ?? 0;
  return evil > EVIL_VILLAINOUS_ABOVE ? 'villainous' : evil > EVIL_GUILTY_ABOVE ? 'guilty' : 'innocent';
}
// ---------------------------------------------------------- what people see and feel, for what they say
// (see {seen} and {felt} in assets/text/speech/about.txt, and life/speech-text.js). p.seen is the last thing someone saw
// happen to someone else, p.felt the last thing that happened to them; each is kept SEEN_TIME, and said or thought
// about once, straight away. A lesser sight doesn't replace a greater one still fresh (SEEN_RANK); the same sight of the
// same person isn't seen again while it's fresh, so something that goes on (walking on water, a smell) counts once.
const WITNESS_RADIUS = 20; // how near (× people size) someone has to be to see something happen
const SEEN_RANK = { killedbycar: 3, beatentodeath: 3, smited: 3, drowned: 3, exploded: 3, resurrected: 2, punch: 1, knockedbycar: 1, waterwalking: 0, smelly: 0 };
const NOTICED_FOR = 60; // seconds a sight stays fresh (as SEEN_TIME in life/speech-text.js)
const MAX_WITNESSES = 5;  // how many of the nearest see something happen (not a whole park at once)
const REACT_SPREAD = 2.5; // seconds over which those who saw it get round to reacting, each at a random moment
const insideOf = q => q.mode === 'indoors' && q.indoors.stage === 'inside' ? q.indoors.building : null;
/**
 * One person taking in something that happened to someone else.
 * @param {Person} q - who saw it
 * @param {Person} who - who it happened to
 * @param {string} what - what (a key of SEEN_RANK)
 * @param {?Person} [by] - who did it, if a person
 * @returns {void}
 */
export function notice(q, who, what, by = null) {
  const at = performance.now()/1000, old = q.seen, fresh = old && at - old.at < NOTICED_FOR;
  if (fresh && (SEEN_RANK[old.what] > SEEN_RANK[what] || (old.what === what && old.who === who))) return;
  // (no more than MAX_WITNESSES notice the same thing about the same person while it's fresh — a smell, walking on water)
  const tally = who.noticed?.what === what && at - who.noticed.since < NOTICED_FOR ? who.noticed : (who.noticed = { what, since: at, count: 0 });
  if (tally.count >= MAX_WITNESSES) return;
  tally.count++;
  q.seen = { what, at, who, by, after: at + Math.random()*REACT_SPREAD };
}
/**
 * The MAX_WITNESSES nearest, on the same side of any walls (or anywhere in the same building), see something happen.
 * @param {Person} who - who it happened to
 * @param {string} what - what (a key of SEEN_RANK)
 * @param {?Person} [by] - who did it, if a person (who doesn't count as seeing it)
 * @returns {void}
 */
export function witness(who, what, by = null) {
  const reach = WITNESS_RADIUS*S.peopleSize, building = insideOf(who), near = [];
  people.forEach(q => {
    if (q === who || q === by || q.mode === 'dead' || q.mode === 'drowning' || q.mode === 'none' || aboard(q)) return;
    if (insideOf(q) !== building) return;
    const d = Math.hypot(q.x - who.x, q.z - who.z);
    if (building || d <= reach) near.push({ q, d });
  });
  near.sort((a, b) => a.d - b.d).slice(0, MAX_WITNESSES).forEach(({ q }) => notice(q, who, what, by));
}
/**
 * Something happening to someone: punched, hitbycar, or revenge (they punched back whoever last punched them).
 * @param {Person} p
 * @param {string} what
 * @param {?Person} [by] - who did it (for revenge, who they got back at)
 * @returns {void}
 */
export function feel(p, what, by = null) { p.felt = { what, at: performance.now()/1000, by }; }
/**
 * How the people around someone take their death: an innocent's leaves them horrified, a bad sort's stops them in
 * their tracks, and a villain's delights them. Called for every death, whoever caused it — the Smite button, or a car
 * running them over (see runOverPeople in life/traffic/collisions.js) — so any way an NPC dies is reacted to the same.
 * @param {Person} victim - whoever was killed
 * @param {?{x: number, z: number}} [source] - what killed them, which they look at and run from (a car), else the victim
 * @returns {void}
 */
function bystandersReactToDeath(victim, source = null) {
  // (measured from the victim; looked at and run from the source)
  const standing = standingOf(victim), from = source ? { x: source.x, z: source.z } : null;
  if (standing === 'villainous') pleaseBystanders(victim, from);
  else if (standing === 'guilty') stunBystanders(victim, from);
  else frightenBystanders(victim, from);
}

/**
 * Move one of someone's reactions to a blast on a stage: noticing turns them to look at it, looking hands over to
 * whatever that reaction does about it, and anything else lets them go.
 * @param {Person} p - the person
 * @param {number} dt - seconds since the last frame
 * @param {'fright'|'stun'|'please'} key - which reaction, on the person
 * @param {function(Person, object): void} onResolve - what to do once they've looked
 * @returns {void}
 */
function updateEffect(p, dt, key, onResolve) {
  const state = p[key];
  state.timer -= dt;
  if (state.timer > 0) return;
  if (state.stage === 'notice') {
    endActivity(p);
    p.oneShot = null; p.wait = 0;
    p.faceTo = headingTo(p, state.from);
    p.lookAt = state.from;
    state.stage = 'look';
    state.timer = 0.5 + peopleRng()*0.7;
  } else if (state.stage === 'look') {
    onResolve(p, state);
  } else {
    p[key] = null;
  }
}

/**
 * Run someone's fright, each frame: gazing in shock, then running off more than twice as fast.
 * @param {Person} p - the person
 * @param {number} dt - seconds since the last frame
 * @returns {void}
 */
export function updateFright(p, dt) {
  updateEffect(p, dt, 'fright', (p, fright) => beginFleeing(p, fright.from));
}

/** How long, in seconds, someone runs off from whatever frightened them. */
const FLEE_TIME = 10;
// Someone in a hangout who's fled FLEE_REPEAT_COUNT times within FLEE_REPEAT_WINDOW seconds, or for FLEE_AREA_TIME seconds
// in all while in it, makes for its exit furthest from the danger instead of running about inside it (see wantsOut).
const FLEE_REPEAT_COUNT = 3, FLEE_REPEAT_WINDOW = 60, FLEE_AREA_TIME = 15;
/** Whether someone fleeing in a hangout has had enough of it and should leave. */
const wantsOut = p => (p.fleeStarts?.length ?? 0) >= FLEE_REPEAT_COUNT || (p.fleeInArea ?? 0) >= FLEE_AREA_TIME;
/**
 * Set someone running off, more than twice as fast as they walk, away from `from` ({ x, z }) for FLEE_TIME seconds.
 * @param {Person} p - the person
 * @param {{x: number, z: number}} from - what they're running from
 * @returns {void}
 */
const FLEE_TALK_AGAIN = 12, FLEE_TALK_WITHIN = 2; // seconds before someone who's fled calls out again as they start another
// flight, and how long after bolting they'll still call out (waiting for a turn to speak: see shoutLine)
export function beginFleeing(p, from) {
  p.fright = { stage: 'flee', timer: FLEE_TIME, from };
  // (something called out as they bolt, from fleeing.txt — not every time, for those who keep running: see the talk below)
  const fleeNow = performance.now()/1000;
  if (!(fleeNow - (p.fledTalkAt ?? -Infinity) < FLEE_TALK_AGAIN)) { p.fledTalkAt = fleeNow; p.fleeTalkUntil = fleeNow + FLEE_TALK_WITHIN; }
  const now = lastPeopleTime ?? 0;
  p.fleeStarts = (p.fleeStarts ?? []).filter(t => now - t < FLEE_REPEAT_WINDOW);
  p.fleeStarts.push(now);
  p.faceTo = null; p.lookAt = null;
  // away from whatever frightened them: turn round, if they're on a walkway
  if (p.mode === 'line') {
    const nav = peopleNav.lines[p.li], k = Math.max(0, Math.min(nav.pts.length - 2, p.seg)), a = nav.pts[k], b = nav.pts[k + 1];
    if (((b.x - a.x)*(from.x - p.x) + (b.z - a.z)*(from.z - p.z))*p.dir > 0) p.dir = -p.dir;
  } else if (p.mode === 'wander') {
    const area = peopleNav.areas[p.area];
    if (!(wantsOut(p) && leaveArea(p, area, from))) fleeWithin(p, area);
  }
}
/**
 * A vampire out while the sun's up (see hidingFromSun): running scared, SUN_RUN_BOOST faster still, for the nearest door
 * along their walkway — out of a hangout first, and onto other walkways at every turning if theirs has no door
 * (walkAlong) — and in at the first door they reach. Still out at 6:30, they vanish into the nearest building
 * (vanishIndoors). Once inside, calm.
 * Checked every frame: anything else they're doing is dropped; a fight, being knocked down or a road crossing is
 * waited out, then the run (or vanishing) starts again. Only a flee marked `sun` counts as already running for cover.
 * @param {Person} p - the vampire
 * @returns {void}
 */
function hideFromSun(p) {
  if (p.mode === 'indoors') {
    if (p.indoors.stage === 'inside' && p.sunRun) { p.sunRun = false; p.fright = null; }
    return;
  }
  const knockedDown = p.punched && p.punched.stage !== 'marked'; // ('marked': only someone coming for them)
  if (knockedDown || inWater(p) || !(p.mode === 'line' || p.mode === 'wander' || p.mode === 'leaving')) return;
  if (outOfTime(p) && vanishIndoors(p)) return;
  if (p.attack || p.jc) return;
  if (p.act) endActivity(p);
  p.sunRun = true;
  if (p.mode === 'wander') { leaveArea(p, peopleNav.areas[p.area]); return; }
  if (p.fright?.stage === 'flee' && p.fright.sun) return;
  // (on a walkway: towards its nearest door, if it has one, running from just behind them)
  if (p.mode === 'line') {
    const nav = peopleNav.lines[p.li];
    let nearest = null;
    nav.vertices.forEach((vertex, vi) => {
      if (vertex.building && (nearest == null || Math.abs(nav.cum[vi] - p.u) < Math.abs(nearest - p.u))) nearest = nav.cum[vi];
    });
    if (nearest != null && Math.abs(nearest - p.u) > 0.01) p.dir = Math.sign(nearest - p.u);
    const k = Math.max(0, Math.min(nav.pts.length - 2, p.seg)), a = nav.pts[k], b = nav.pts[k + 1], len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    beginFleeing(p, { x: p.x - (b.x - a.x)/len*p.dir, z: p.z - (b.z - a.z)/len*p.dir });
  } else {
    beginFleeing(p, { x: p.x - Math.sin(p.heading), z: p.z - Math.cos(p.heading) });
  }
  p.fright.sun = true;
}
/** How much faster than fleeing a vampire runs for cover from the sun. */
const SUN_RUN_BOOST = 1.5;
/**
 * Send someone in a hangout out of it: onto the walkway at one of its entrances — the nearest of a few, or, running from
 * `from`, whichever takes them furthest from it — as mode 'leaving'. Entrances reached over dry ground come first.
 * @param {Person} p - the person
 * @param {Hangout} area - the hangout they're in
 * @param {?{x: number, z: number}} [from] - what they're running from, if anything
 * @returns {boolean} whether it has an entrance to leave by
 */
function leaveArea(p, area, from = null) {
  if (!area.exits.length) return false;
  const candidates = from ? area.exits : Array.from({ length: 6 }, () => area.exits[Math.floor(peopleRng()*area.exits.length)]);
  let exit = null;
  for (const e of candidates) {
    const d = Math.hypot(e.x - p.x, e.z - p.z);
    // (fleeing: far from the danger, less how far off it is; otherwise just near)
    const score = from ? Math.hypot(e.x - from.x, e.z - from.z) - d : -d;
    // Uses the entrance's own position, not the walkway point: a walkway lies outside the hangout, so a walk to
    // that point never reads as clear ground.
    const dry = walkableUpTo(area, p, e.x, e.z).clear;
    if (!exit || (dry !== exit.dry ? dry : score > exit.score)) exit = { ...e, score, dry };
  }
  // Joins the walkway at the point where it passes the entrance.
  joinWalkway(p, exit.li, peopleNav.lines[exit.li].cum[exit.vi], peopleRng() < 0.5 ? -1 : 1);
  p.exit = walkwayPoint(p);
  p.mode = 'leaving'; p.wait = 0;
  p.fleeInArea = 0; p.swimming = null;
  return true;
}

/**
 * Run someone's stun, each frame: gazing in shock, then standing dazed.
 * @param {Person} p - the person
 * @param {number} dt - seconds since the last frame
 * @returns {void}
 */
export function updateStun(p, dt) {
  updateEffect(p, dt, 'stun', (p, stun) => {
    // 'held' is the stage updatePeople freezes them on: dazed where they stand, looking, and not fleeing
    stun.stage = 'held';
    stun.timer = stun.hold ?? 3 + peopleRng()*2; // (`hold`, where whatever stunned them says how long)
  });
}

/**
 * Run someone's delight, each frame: gazing at whatever pleased them, then holding still and beaming.
 * @param {Person} p - the person
 * @param {number} dt - seconds since the last frame
 * @returns {void}
 */
export function updatePlease(p, dt) {
  updateEffect(p, dt, 'please', (p, please) => {
    // the same hold as stun, but beaming: see pleased in updatePeople
    please.stage = 'held';
    please.timer = 2 + peopleRng()*2;
    if (hasClip('Wave')) playOnce(p, 'Wave'); // a wave at whatever pleased them
  });
}
/**
 * Pick somewhere in a plaza or park to run to, as far as can be found from whatever frightened them.
 * @param {Person} p - the person
 * @param {Hangout} area - the hangout they're in
 * @returns {void}
 */
export function fleeWithin(p, area) {
  let best = null;
  for (let k=0;k<12;k++) {
    const spot = randomSpotIn(area, null, p), d = Math.hypot(spot.x - p.fright.from.x, spot.z - p.fright.from.z);
    if (!best || d > best.d) best = { x: spot.x, z: spot.z, d };
  }
  p.tx = best.x; p.tz = best.z; p.wait = 0; p.swimming = null;
}
/**
 * Kill someone: explode them into giblets in their own colors, and mark them dead - gone from the crowd, with whoever
 * they were talking to carrying on without them. Whoever isn't hearted stays dead only until the crowd next wants
 * their spot: then someone new, with their own name and face, takes it (see updatePeople) - they don't come back.
 * The people around them take it according to how evil they were (see bystandersReactToDeath), the same however they
 * died. The explosive go up too, killing whoever's near. Someone with a respawn left lies shaking instead (reviveInstead).
 * @param {number} i - their index in people
 * @param {'player'|'car'} [by] - who did it, for the morality meter: the Smite button, or a car that ran them over
 * @param {?{x: number, y: number, z: number}} [momentum] - the velocity of whatever hit them, which their giblets keep
 * @param {number} [throwScale] - how much further than `momentum` alone their giblets are thrown (the blood splashed on others goes by `momentum`)
 * @param {?{x: number, z: number}} [source] - what killed them (a car), for the people around to run from
 * @returns {void}
 */
// `source` for damage (core/health.js) may carry killPerson's own: { by, momentum, throwScale, from }
registerHealthKind('person', {
  max: 100,
  die: (p, source) => killPerson(people.indexOf(p), source?.by ?? 'player', source?.momentum ?? null, source?.throwScale ?? 1, source?.from ?? null,
    source?.cause ?? (people.includes(source?.from) ? 'beatentodeath' : 'smited')),
  alive: p => p.mode !== 'dead' && p.mode !== 'none' && p.mode !== 'drowning', // (hearted, revived, or aboard a train)
});
function killPerson(i, by = 'player', momentum = null, throwScale = 1, source = null, cause = 'smited') {
  const p = people[i];
  if (!p || isGone(p) || isFavoritePerson(p.id) || p.punched?.revive) return; // (the hearted can't be killed: see ui/favorites.js; nor can the shaking, see below)
  if (canRespawn(p) && reviveInstead(p, source ?? (momentum ? { x: p.x - momentum.x, z: p.z - momentum.z } : null))) return;
  // one of six events: what the victim counted as, and which of the two ways they died (see morality.txt)
  App.recordMoralityEvent?.(`${standingOf(p)} peds killed by ${by === 'car' ? 'cars' : 'player'}`, p.name);
  if (followed === i) stopFollowingPerson();
  if (awaited === i) setAwaited(-1);
  endActivity(p);
  p.crossStage = null; // don't leave a car yielding forever for someone who can no longer finish crossing
  p.jc = null;
  // their own body parts, where the model's loaded and they're near enough to see it, else chunks in all their colors
  const thrown = momentum && throwScale !== 1 ? { x: momentum.x*throwScale, y: momentum.y*throwScale, z: momentum.z*throwScale } : momentum;
  const at = { x: p.x, y: p.y, z: p.z }, parts = throwBodyParts(personModel, i, at, thrown);
  const colors = { skin: new THREE.Color(0xf2d33c), top: new THREE.Color(), pants: new THREE.Color(), shoes: new THREE.Color(0x222226), hair: null, eyes: !parts };
  const colorFrom = (part, color) => {
    const o = ((2 + PERSON_TRAIT_COLORS.indexOf(part))*PEOPLE_MAX + i)*4, data = personModel.traitData;
    return color.setRGB(data[o], data[o+1], data[o+2]);
  };
  if (personModel) colorFrom('Skin', colors.skin);
  if (parts) colors.skin = colors.top = colors.pants = colors.shoes = null;
  else if (personModel) {
    colorFrom('Top', colors.top); colorFrom('Pants', colors.pants); colorFrom('Shoes', colors.shoes);
    if (personModel.wornLayers.some(layer => layer.look === 'hair' && layer.of[i] >= 0)) colors.hair = colorFrom('Hair', new THREE.Color());
  } else {
    peopleMesh.getColorAt(i, colors.top);
    colors.pants.copy(colors.top);
  }
  Object.values(colors).forEach(color => color?.isColor && color.lerp(new THREE.Color(0x550000), 0.4)); //make gibs darker, less saturated
  explode(at, 1.7*p.height*S.peopleSize, colors, thrown);
  bystandersReactToDeath(p, source);
  witness(p, cause);
  p.mode = 'dead';
  if (p.traits.explosive) { // (a blast killing whoever's around, on the next traffic update: see blasts in life/traffic/state.js)
    blastFx(at, 1.7*p.height*S.peopleSize, 1.5);
    blasts.push({ ...at, scale: PERSON_BLAST_SCALE });
  }
  p.train = null;
  p.indoors = null;
  p.moving = false;
  bloodBurst(p, momentum); // (whoever's near, or in the way of what killed them, is splashed)
}
/**
 * Someone with a respawn left, killed: knocked flat instead (or held there, if they're already down), marked `revive`,
 * so they lie shaking for REVIVE_SHAKE_TIME until lightning strikes them and they get up unharmed (see updatePunched).
 * @param {Person} p - the person
 * @param {?{x: number, z: number}} from - what killed them, to fall away from
 * @returns {boolean} false where they can't be laid down (no model yet, indoors, on a train): they die after all
 */
function reviveInstead(p, from) {
  if (!hasClip('Fall')) return false;
  const k = p.punched;
  if (k && k.stage !== 'marked' && k.stage !== 'brace') { // (already down: fallen, lying, crawling or getting up)
    if (k.stage !== 'fall') holdDown(p);
  } else if (!knockOver(p, from ?? { x: p.x + Math.sin(p.heading), z: p.z + Math.cos(p.heading) })) return false;
  p.revived = true;
  p.punched.revive = true;
  return true;
}
/**
 * Count someone who's drowned (see peopleWater.js) once their body has sunk away: the morality notice, the people around
 * taking it as they would any death, and gone from the crowd — as killPerson, without the blood or giblets.
 * @param {number} i - their index in people
 * @returns {void}
 */
export function drownedPerson(i) {
  const p = people[i];
  App.recordMoralityEvent?.(`${standingOf(p)} peds killed by player`, p.name);
  if (followed === i) stopFollowingPerson();
  if (awaited === i) setAwaited(-1);
  bystandersReactToDeath(p);
  witness(p, 'drowned');
  p.water = null;
  p.mode = 'dead';
  p.train = null;
  p.indoors = null;
  p.moving = false;
}
/**
 * Take someone out of the crowd without killing them, for a crowd thinned past them that has to reach further on for
 * someone hearted: out of sight, as the dead are (so everything that passes over the dead passes over them), until the
 * crowd grows back over them and they're spawned again (see updatePeople).
 * @param {number} i - their index in people
 * @returns {void}
 */
function benchPerson(i) {
  const p = people[i];
  if (followed === i) stopFollowingPerson();
  if (awaited === i) setAwaited(-1);
  if (riderFollowed === i) setRiderFollowed(-1);
  endActivity(p);
  p.crossStage = null; p.jc = null;
  p.mode = 'dead';
  p.benched = true;
  p.train = null;
  p.indoors = null;
  p.moving = false;
}
/**
 * Whether this person is walking over a road (see updateCrossing) — treated like someone standing in the middle of it
 * ('mid') by checkYield in life/traffic/lanes.js: out on the live lanes, not on a sidewalk.
 * @param {Person} p - the person
 * @returns {boolean} whether they're in the road
 */
export function isPedInDanger(p) {
  return p.crossStage === 'jcross' || p.crossStage === 'half1' || p.crossStage === 'half2' || (p.mode === 'possessed' && p.onRoad);
}
const PUSH_DECAY = 6; // per second: how fast a push slows, so it covers its distance in about half a second
/**
 * Shove someone `distance` along (dirX, dirZ): they're sent off fast, easing to a stop, rather than jumping. A wanderer's
 * destination moves with them.
 * @param {Person} p - the person
 * @param {number} dirX - direction, not necessarily unit length
 * @param {number} dirZ
 * @param {number} distance - how far they end up moved, in world units
 * @returns {void}
 */
function pushPerson(p, dirX, dirZ, distance) {
  const len = Math.hypot(dirX, dirZ);
  if (len < 1e-6 || distance <= 0) return;
  const speed = distance*PUSH_DECAY/len; // (the distance covered is the starting speed over the decay rate)
  p.push = { x: (p.push?.x ?? 0) + dirX*speed, z: (p.push?.z ?? 0) + dirZ*speed };
}
function stepPush(p, dt) {
  p.x += p.push.x*dt; p.z += p.push.z*dt;
  const slowing = Math.exp(-PUSH_DECAY*dt);
  p.push.x *= slowing; p.push.z *= slowing;
  if (p.mode === 'wander') { p.tx = p.x; p.tz = p.z; }
  if (Math.hypot(p.push.x, p.push.z) < 0.05) p.push = null;
}

/**
 * What the people module hands the rest of the app: the World panel's controls, picking and following someone, possessing
 * them, swinging a punch and killing them — and, for poking at from the browser console, the crowd and its conversations.
 */
Object.assign(App, { witnessPerson: witness, feelPerson: feel, pushPerson, syncPeopleUI, pickPerson, followPersonAt, followPerson, followPersonInside, stopFollowingPerson, possessPerson, unpossessPerson, punchFromPossession, killPerson, knockOverPerson: knockOver, personHeight, people, peopleGroups: groups });

/**
 * Run the crowd for one frame: keep the numbers right, rebuild the walkways when the map has changed, and move everyone
 * — walking, crossing, talking, sitting, punching, riding the trains, going indoors, being possessed — then write it all
 * out to the instanced meshes and the shader's attributes, and put the camera where it's following.
 *
 * The dt is clamped, so a tab left in the background doesn't teleport everyone across the map on the frame it comes back.
 * @param {number} t - the time now, in seconds
 * @returns {void}
 */
export function updatePeople(t) {
  const dt = lastPeopleTime == null ? 0 : Math.min(0.1, Math.max(0, t - lastPeopleTime));
  setLastPeopleTime(t);
  if (followed >= 0 && (!S.peopleEnabled || S.interactionMode !== 'move')) stopFollowingPerson();
  if (followedInside && !App.isInsideBuilding()) stopFollowingPerson(); // (picked in a room since left)
  peopleMesh.visible = S.peopleEnabled && !personModel;
  if (personModel) [personModel, ...personModel.hair].forEach(part => { part.mesh.visible = S.peopleEnabled; });
  peopleNavDebugMesh.visible = S.peopleEnabled && S.showPeopleNavDebug;
  if (!S.peopleEnabled) { showPassengers(); showInhabitants(); updateFlies(0); return; }
  // (everyone held still where they are while the held-items debug window poses someone: see ui/held-debug.js)
  if (S.peopleFrozen) { S.peopleFrozen(); return; }
  if (!peopleNav || (S.peopleNavDirty && t - peopleNavBuiltAt > 0.25 && !navRebuildOnHold())) {
    S.peopleNavDirty = false;
    setPeopleNavBuiltAt(t);
    // whatever anyone was doing stops, as the benches and grass they were using may have gone
    groups.length = 0;
    people.forEach(p => { p.group = null; p.crossStage = null; p.jc = null; p.faceTo = null; endActivity(p); });
    setPeopleNav(buildPeopleNav());
    people.forEach(reseatPerson);
  }
  if (S.showPeopleNavDebug && peopleNavDebugBuiltAt !== peopleNavBuiltAt) { setPeopleNavDebugBuiltAt(peopleNavBuiltAt); rebuildPeopleNavDebug(); }
  // (the hearted are never let go of: the crowd reaches at least as far as the last of them, and anyone past `wanted`
  // who isn't hearted is benched — out of sight, as the dead are, until the crowd grows back over them. See
  // ui/favorites.js. Anyone killed and not hearted is out for good: once their spot is wanted again, someone new is
  // born into it below — a fresh id, so they don't come back as themselves. See newPerson, and assignAppearance in
  // peopleModel.js. A hearted id missing from the crowd altogether — a reload hasn't reached their spot yet — is
  // revived into a new spot with their own saved id, rather than waiting to be spawned like anyone else.)
  const wanted = Math.min(PEOPLE_MAX, Math.round(S.peopleAmount));
  const presentIds = new Set(people.map(p => p.id));
  const missingFavoriteIds = favoritePeople().filter(id => !presentIds.has(id));
  let highestFavoriteSlot = -1;
  for (let i = 0; i < people.length; i++) if (isFavoritePerson(people[i].id)) highestFavoriteSlot = i;
  const kept = Math.min(PEOPLE_MAX, Math.max(wanted, highestFavoriteSlot + 1, people.length + missingFavoriteIds.length));
  while (people.length < kept) {
    const p = newPerson(missingFavoriteIds.shift()); // (a hearted id waiting to be found again, else a fresh one)
    personModel?.assignAppearance(people.length, p.id);
    spawnPerson(p);
    people.push(p);
  }
  while (people.length > kept) endActivity(people.pop());
  for (let i = wanted; i < people.length; i++) if (!people[i].benched && !isFavoritePerson(people[i].id)) benchPerson(i);
  for (let i = 0; i < Math.min(wanted, people.length); i++) {
    const p = people[i];
    if (p.benched) { p.benched = false; p.mode = 'none'; } // (the same person, off the bench: spawned again below)
    else if (p.mode === 'dead' && !isFavoritePerson(p.id)) { people[i] = newPerson(); personModel?.assignAppearance(i, people[i].id); } // (someone new, spawned again below)
  }
  if (followed >= people.length) stopFollowingPerson();
  if (riderFollowed >= people.length) setRiderFollowed(-1);
  peopleMesh.count = people.length;
  roadsafetyDebugMesh.visible = roadsafetyHalfDebugMesh.visible = pedHitboxDebugMesh.visible = S.showRoadsafetyDebug;
  if (S.showRoadsafetyDebug) roadsafetyDebugMesh.count = roadsafetyHalfDebugMesh.count = pedHitboxDebugMesh.count = people.length;
  setIndoorsCount(people.reduce((n, p) => n + (p.mode === 'indoors' ? 1 : 0), 0));
  if (personModel) {
    personModel.mesh.count = people.length;
    personModel.hair.forEach(style => { style.mesh.count = countBelow(style.members, people.length); });
    updateGroups(dt);
    meetOnWalkways(dt);
    pickFights(dt);
  }
  avoidSmells(dt); // (everyone keeps clear of anyone who smells: see peopleSmell.js)
  updateFlies(dt);
  // whoever's been knocked down and is still on the ground (or getting up): nobody walks into them
  updateArrivingBlood(dt);
  const lyingDown = people.filter(q => q.punched && q.punched.stage !== 'marked' && q.punched.stage !== 'brace');
  const matrix = new THREE.Matrix4(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3(), position = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  people.forEach((p, i) => {
    const wasX = p.x, wasZ = p.z; // (for how fast they were going, should they walk into the water: see updateWater)
    if (p.mode === 'none' && (peopleNav.lines.length || peopleNav.areas.length)) spawnPerson(p);
    refreshTraits(p, i);
    if (p.blood) updateBlood(p, dt, i);
    p.trainCooldown -= dt;
    p.snackCooldown -= dt;
    p.indoorsCooldown -= dt;
    const possessed = p.mode === 'possessed';
    if (p.push) stepPush(p, dt);
    if (possessed) p.fright = p.stun = p.please = null;
    if (p.fright) updateFright(p, dt);
    // terrified: never stop fleeing — each flee ended starts another, from just behind them, so they carry on the way they were going
    if (p.traits.terrified && (p.mode === 'line' || p.mode === 'wander') && !p.fright && !p.punched && !inWater(p)) beginFleeing(p, { x: p.x - Math.sin(p.heading), z: p.z - Math.cos(p.heading) });
    if (!possessed && hidingFromSun(p)) hideFromSun(p);
    else if (p.sunRun) p.sunRun = false;
    //attempting to give additional reactions to npc death depending on how evil they are
    if (p.stun) updateStun(p, dt); //Should freeze bystanders and turn them to face, currently interrupts their actions without freezing or turning
    if (p.please) updatePlease(p, dt); // (the same hold as stun, read as delight: see pleased below)
    if (p.punched) updatePunched(p, dt);
    // frozen in place: fright's 'look' stage, or stun/please's 'held' stage. only fright ever flees.
    const frozen = (!!p.fright && p.fright.stage === 'look')
                || (!!p.stun && p.stun.stage === 'held')
                || (!!p.please && p.please.stage === 'held')
                || (!!p.punched && p.punched.stage !== 'marked') // (braced for a punch, knocked down, or getting up)
                || inWater(p); // (going into the water, or drowned: see peopleWater.js)
    const fleeing = !!p.fright && p.fright.stage === 'flee';
    // pleased: looking at it and then held still, beaming. The same 'look' and 'held' stages as stun — the ones
    // updatePeople freezes them on — read as delight rather than shock, below.
    const pleased = !!p.please && (p.please.stage === 'look' || p.please.stage === 'held');
    let speed = PERSON_WALK_SPEED*S.peopleSpeed*p.stride*(p.traits.speed + bloodSpeed(p))*bloodlustSpeed(p)*(fleeing ? FLEE_SPEED*p.traits.boost : 1)
      *(fleeing && p.sunRun ? SUN_RUN_BOOST : 1);
    let goal = null;
    //Updating hair colour depending on age
    //set default hair colour once
    if ((p.defaultHair === undefined) && personModel) {
      const o = ((2 + PERSON_TRAIT_COLORS.indexOf('Hair'))*PEOPLE_MAX + i)*4, data = personModel.traitData;
      const hairColor = new THREE.Color().setRGB(data[o], data[o+1], data[o+2]);
      p.defaultHair = hairColor;
      //TO DO: If birthdays added, break this block into two; below repeated after check for newBirthday boolean
      //Saving default hair future proofs against hair collapsing to white, but as is this should only run once anyways.
      const greyAmount = p.traits.bleach ? 2 :
        p.traits.ageless ? 0 : 
          Math.max(0, Math.min(1, (p.age - 30) / (100))); // tweak range to taste
      const newHair =  p.defaultHair.clone().lerp(new THREE.Color(0xffffff), greyAmount);
      data[o] = newHair.r; data[o+1] = newHair.g; data[o+2] = newHair.b;
      // the whites of the eyes yellow for vampires (more with age) and redden for the blazed; the black of them is left alone
      const e = ((2 + PERSON_TRAIT_COLORS.indexOf('Eyes'))*PEOPLE_MAX + i)*4;
      const eyes = new THREE.Color().setRGB(data[e], data[e+1], data[e+2]);
      if (p.traits.vampire) eyes.lerp(VAMPIRE_EYE_COLOR, Math.min(1, VAMPIRE_EYE_TINT*(1 + p.age/100)));
      if (p.traits.blazed) eyes.lerp(EYE_RED_COLOR, BLAZED_EYE_RED);
      data[e] = eyes.r; data[e+1] = eyes.g; data[e+2] = eyes.b;
      p.eyeBase = [eyes.r, eyes.g, eyes.b]; // (what bloodlust's eyes go back to: see stain in peopleBlood.js)
      // vampires' skin drains towards light grey with age
      if (p.traits.vampire) {
        const s = ((2 + PERSON_TRAIT_COLORS.indexOf('Skin'))*PEOPLE_MAX + i)*4;
        const paleSkin = new THREE.Color().setRGB(data[s], data[s+1], data[s+2]).lerp(VAMPIRE_SKIN_COLOR, Math.min(1, VAMPIRE_PALE_PER_CENTURY*(1 + p.age/100)));
        data[s] = paleSkin.r; data[s+1] = paleSkin.g; data[s+2] = paleSkin.b;
      }
    }
    // (stopped to talk, or frozen in shock, someone on a walkway stays put)
    if (p.mode === 'line' && p.act !== 'chat' && !frozen && !p.attack) {
      if (!p.jc && !p.act) maybeBuyOnWalkway(p, dt); // (stepping off to a hot dog or coffee stall: see peopleStalls.js)
      if (!p.jc && !p.act) maybeCrossRoad(p, peopleNav.lines[p.li], dt);
      if (p.act === 'buy') {
        goal = updateBuying(p, dt, walkwayPoint(p).y);
      } else if (p.jc) {
        goal = updateCrossing(p, dt, speed); // (null while waiting for a gap in traffic)
        if (isPedInDanger(p)) speed *= CROSS_SPEED_MULT; // an increased pace, crossing
      } else {
        walkAlong(p, speed*dt);
        if (p.mode === 'line') goal = walkwayPoint(p);
      }
    }
    if (p.mode === 'wander') {
      const area = peopleNav.areas[p.area];
      if (p.act) {
        goal = updateActivity(p, area, dt);
      } else if (p.fright || p.stun || p.please || p.attack || frozen) {
        // Frightened, stunned or pleased. Fright runs off further each time they reach where they were running to;
        // stun and please hold position through the `frozen` guard below, with no movement of their own.
        if (fleeing) {
          p.fleeInArea = (p.fleeArea === p.area ? p.fleeInArea ?? 0 : 0) + dt;
          p.fleeArea = p.area;
          if (wantsOut(p) && leaveArea(p, area, p.fright.from)) { /* heading out */ }
          else if (Math.hypot(p.tx - p.x, p.tz - p.z) < 0.5) fleeWithin(p, area);
        }
      } else if (p.wait > 0 || p.oneShot) {
        p.wait -= dt;
      } else if (p.swimming === 'going' && Math.hypot(p.tx - p.x, p.tz - p.z) < 0.3) {
        p.swimming = 'in'; p.wait = (SWIM_TIME[0] + peopleRng()*(SWIM_TIME[1] - SWIM_TIME[0]))*p.traits.patience;
      } else if (Math.hypot(p.tx - p.x, p.tz - p.z) < 0.3) {
        p.swimming = null;
        p.wait = (1 + peopleRng()*9)*p.traits.patience;
        // What next, weighted by their traits: leaving, sitting down, lying down, going over to talk to someone, going
        // over to someone else, somewhere else in the same hangout, a train, or something from a stall.
        const { lounging, chatty } = p.traits;
        const stations = p.trainCooldown <= 0 ? stationLinks().byArea.get(p.area) : null;
        const stalls = !p.snack && p.snackCooldown <= 0 && hasStallIn(area);
        // (someone drinking where there's a beer stall stays for another rather than moving on: see peopleStalls.js)
        const round = drinking(p) && hasStallIn(area, 'beer');
        const next = ['leave', 'sit', 'lie', 'chat', 'friend', 'roam', 'train', 'buy', 'swim'][pickWeighted([area.exits.length ? (round ? 0.03 : 0.2) : 0, 0.16*lounging, 0.08*lounging, 0.18*chatty, 0.13, 0.25, stations && !round ? 0.12 : 0, stalls ? (round ? 0.6 : 0.15) : 0, onWater(p) ? SWIM_WEIGHT : 0], w => w)];
        if (next === 'swim' && goSwim(p, area)) {
          // off for a swim (waterwalking/aqua)
        } else if (next === 'buy' && goBuy(p, area)) {
          // over to a hot dog, coffee or beer stall (see peopleStalls.js)
        } else if (next === 'train' && stations) {
          // over to a train station standing in here
          const node = stations[Math.floor(peopleRng()*stations.length)], st = getTrainStations().get(node);
          goRideTrain(p, node, { x: st.x, y: area.y, z: st.z });
        } else if (next === 'leave' && leaveArea(p, area)) {
          // off to the nearest of a few of the hangout's entrances
        } else if (next === 'sit' && goSit(p, area)) {
          // off to a bench, or to sit on the grass
        } else if (next === 'lie' && goLieDown(p, area)) {
          // off to lie down on the grass
        } else if (next === 'chat' && goChat(p, area)) {
          // over to talk to someone
        } else if (next === 'friend') {
          // over to someone else hanging out here
          let friend = null;
          for (let k=0;k<8 && !friend;k++) { const q = people[Math.floor(peopleRng()*people.length)]; if (q !== p && q.mode === 'wander' && q.area === p.area) friend = q; }
          const over = friend ? { x: friend.tx + (peopleRng()-0.5)*3, z: friend.tz + (peopleRng()-0.5)*3 } : null;
          const spot = over && insideFor(area, p)(over.x, over.z) ? reachableSpot(area, p, over.x, over.z) : null;
          if (spot) { p.tx = spot.x; p.tz = spot.z; } else { const s = randomSpotIn(area, p); p.tx = s.x; p.tz = s.z; }
        } else {
          const s = randomSpotIn(area, null, p); p.tx = s.x; p.tz = s.z;
        }
      }
      if (p.mode === 'wander' && !p.act && !frozen && !p.attack) goal = { x: p.tx, y: area.y, z: p.tz };
    }
    if (p.mode === 'train') {
      goal = updateTrainRider(p, i, dt);
      if (frozen) goal = null;
    }
    if (p.mode === 'indoors') {
      goal = updateIndoors(p, i, dt);
      if (frozen) goal = null;
    }
    if (p.attack) {
      goal = updateAttack(p, dt);
      if (p.attack?.stage === 'chase') speed *= PUNCH_CHASE_SPEED;
    }
    if (possessed) {
      if (frozen) cancelSwing(); // (knocked down: no walking, no punching)
      else { goal = walkPossessed(p, dt); updateSwing(p, dt); }
    }
    if (p.mode === 'leaving') {
      // already placed on their walkway by joinWalkway; once they've reached it they carry on along it
      goal = frozen ? null : p.exit;
      if (Math.hypot(p.exit.x - p.x, p.exit.z - p.z) < 0.5) p.mode = 'line';
    }
    // in a plaza, walk around its fountain rather than through the pool: while the straight line to where they're going
    // passes over it, head instead for the point on its rim nearest that line — which moves round as they do
    const hangout = (p.mode === 'wander' || p.mode === 'leaving') && p.area >= 0 ? peopleNav.areas[p.area] : null;
    if (goal && hangout && hangout.fountain) {
      const f = hangout.fountain, clearance = f.r + 1.2;
      const c = closestPointOnSegment(f, p, goal);
      let dx = c.x - f.x, dz = c.z - f.z;
      const d = Math.hypot(dx, dz);
      if (d < clearance) {
        if (d < 1e-3) { dx = -(goal.z - p.z); dz = goal.x - p.x; }
        const len = Math.hypot(dx, dz) || 1;
        goal = { x: f.x + dx/len*(clearance + 0.3), y: goal.y, z: f.z + dz/len*(clearance + 0.3) };
      }
    }
    if (inWater(p)) goal = null; // (the water has them: see peopleWater.js)
    // walk towards where they should be — faster if they've fallen behind (cutting across at a junction, say)
    p.moving = false;
    p.stepped = 0;
    if (goal) {
      const dx = goal.x - p.x, dz = goal.z - p.z, d = Math.hypot(dx, dz);
      const step = possessed ? d : speed*dt*(p.mode === 'line' && !p.crossStage && !p.attack && !p.act ? 1 + Math.min(2, d*0.5) : 1);
      const k = d > 1e-4 ? Math.min(1, step/d) : 0, mx = dx*k, mz = dz*k;
      // (anyone just walking waits where they are until whoever it is is up: a step that would take them nearer, inside LYING_CLEARANCE, isn't taken — but not someone going after someone, or running from them)
      const blocked = !possessed && !p.attack && !fleeing && lyingDown.some(q => {
        if (q === p) return false;
        const after = Math.hypot(q.x - (p.x + mx), q.z - (p.z + mz));
        return after < LYING_CLEARANCE*S.peopleSize && after < Math.hypot(q.x - p.x, q.z - p.z);
      });
      // (nobody walks into the water of their own accord: along the bank if they can, else they stop and think again)
      let sx = mx, sz = mz;
      if (!blocked && !possessed && d > 1e-4 && wouldWade(p, sx, sz)) {
        if (!wouldWade(p, sx, 0)) sz = 0;
        else if (!wouldWade(p, 0, sz)) sx = 0;
        else { sx = sz = 0; stopAtBank(p, dt); }
      }
      if (d > 1e-4 && !blocked && (sx || sz)) {
        const mx = sx, mz = sz;
        p.x += mx; p.z += mz;
        // which way they face, and whether they're walking, go by how far they actually moved this frame — someone
        // keeping pace with their walkway is always right on top of the point they're heading for
        if (Math.hypot(mx, mz) > (possessed ? 1e-3 : speed*dt*0.25)) {
          const facing = Math.atan2(mx, mz) + moonwalkTurn(p); // (or away from it, walking backwards)
          p.heading += Math.atan2(Math.sin(facing - p.heading), Math.cos(facing - p.heading))*Math.min(1, dt*8);
          p.moving = true;
          p.stepped = Math.hypot(mx, mz);
        }
      }
      p.y += (goal.y - p.y)*Math.min(1, dt*6);
    }
    updateWater(p, i, dt, wasX, wasZ, goal ? goal.y : null); // (over open water, they go in — or waterwalking/aqua, stand or swim on it: see peopleWater.js)
    updateDrunk(p, dt, wasX, wasZ); // (weaving, and now and then falling over: see peopleDrunk.js)
    // possessed, they face the way they're looking — the walk played backwards, stepping backwards
    if (possessed && !frozen) {
      p.heading = possession.yaw;
      if (p.moving && controlInput().forward < 0 !== !!moonwalkTurn(p)) p.stepped = -p.stepped;
    }
    // standing still for something (talking, sitting down), they turn to face the way it wants
    if (!p.moving && p.faceTo != null) p.heading += wrapAngle(p.faceTo - p.heading)*Math.min(1, dt*5);
    if (personModel) {
      const clipSet = personModel.clips, s = isDrawn(p) ? modelScale(p) : 0;
      // a cycle of the walk for every stride's worth of ground covered, as big as they are (played in reverse, backwards)
      if (s > 0) {
        const was = p.walkCycle;
        p.walkCycle = (p.walkCycle + (p.traits.backwards ? -1 : 1)*p.stepped/(personModel.stride*s) + 1) % 1;
        // a foot comes down STEPS_PER_CYCLE times a cycle, from FOOTFALLS on: each is heard (see audio/footsteps.js)
        const step = c => Math.floor(((c - FOOTFALLS + 1) % 1)*STEPS_PER_CYCLE); // (wrapped, so the cycle coming round isn't a step of its own)
        if (p.moving && step(was) !== step(p.walkCycle)) footstep({ x: p.x, y: p.y, z: p.z }, p.traits.weight);
      }
      p.idleTime += dt;
      // standing about with nothing to do for a while, now and then a scratch or a think
      if (p.moving) {
        p.stillFor = 0;
      } else if (!p.act && !p.oneShot && !p.fright && p.pose === 'Idle') {
        p.stillFor += dt;
        if (p.traits.fidgety > 0 && p.stillFor > p.fidgetAfter/p.traits.fidgety) { const fidget = pickFrom(FIDGETS); playOnce(p, fidget); p.fidgetThought = THINK_FIDGETS.includes(fidget); p.stillFor = 0; p.fidgetAfter = 3 + peopleRng()*8; }
      }
      // the animation: one playing through once, else walking, else the pose they're in — blending into it from the last
      if (p.oneShot) {
        p.shotTime += dt*(p.shotRate ?? 1);
        if (p.shotTime >= (p.oneShot.frames - 1)/PERSON_BAKE_FPS) {
          if (p.oneShot.name === 'Fall' && p.punched?.stage === 'fall') landFall(p);
          p.oneShot = null;
        }
      }
      if (!p.clipA) { p.clipA = p.clipB = clipSet.Idle; p.fade = 1; }
      // (and with a hot dog or a coffee in hand, a version of it holding that: see peopleHolding.js)
      setClip(p, p.oneShot || snackClip(p, p.moving ? clipSet.Walk : clipSet[p.pose] || clipSet.Idle, dt));
      p.fade = Math.min(1, p.fade + dt/p.fadeTime);
      // whatever the clip has happening as it comes round: a key struck (see audio/typing.js), or a moment of a meal
      // (see peopleHolding.js)
      if (p.clipA.taps && p.fade > 0.9) {
        const loop = p.clipA.duration, was = (p.idleTime - dt) % loop, now = p.idleTime % loop;
        for (const tap of p.clipA.taps) {
          if (!(now >= was ? tap.time > was && tap.time <= now : tap.time > was || tap.time <= now)) continue;
          if (tap.cue) mealCue(p, tap.cue);
          else keyClick({ x: p.x + Math.sin(p.heading)*0.4, y: p.y + 0.75, z: p.z + Math.cos(p.heading)*0.4 }, tap.space);
        }
      }
      // the model, scaled to the same height as a cuboid person — set back by however far their pose puts their pelvis from
      // their feet, and sat on a bench, up on its seat
      const blend = key => p.clipA[key]*p.fade + p.clipB[key]*(1 - p.fade);
      const offX = blend('pelvisX')*s, offZ = blend('pelvisZ')*s, sin = Math.sin(p.heading), cos = Math.cos(p.heading);
      p.heightScale = blend('heightScale');
      rotation.setFromAxisAngle(up, p.heading);
      const faceDown = turnInWater(p, rotation), crawlLift = turnCrawling(p, rotation); // (tipped, rocked or face down in the water: see peopleWater.js; face down crawling: see peopleRoad.js)
      position.set(p.x - offX*cos - offZ*sin, faceDown ? p.y : crawlLift != null ? p.y + crawlLift : p.y + p.seatLift*sitWeight(p) - personModel.minY*s, p.z + offX*sin - offZ*cos);
      if (p.punched?.revive && p.punched.stage === 'down') shake(position, rotation, PERSON_SHAKE*S.peopleSize); // (dead, before the bolt: see reviveInstead)
      sway(p, position, rotation);
      matrix.compose(position, rotation, scale.set(s, s, s));
      personModel.mesh.setMatrixAt(i, matrix);
      // a blink every few seconds, the eyes closing and opening again over BLINK_DURATION
      p.blinkIn -= dt;
      p.blinkAge += dt;
      if (p.blinkIn <= 0 && p.traits.blinks > 0) { p.blinkAge = 0; p.blinkIn = BLINK_DURATION + (1.5 + peopleRng()*5)/p.traits.blinks; }
      p.lookIn -= dt;
      if (p.lookAt) {
        // talking: at whoever they're talking to, or whoever's talking
        p.lookTurnTo = Math.max(-LOOK_MAX_TURN, Math.min(LOOK_MAX_TURN, wrapAngle(headingTo(p, p.lookAt) - p.heading)));
        p.lookTiltTo = 0;
      } else if (p.lookIn <= 0) {
        // every so often a glance somewhere else — not so far while walking — or back ahead, the head easing round to it
        // (the nosier they are, the more often, the less often back ahead, and the further round)
        const { nosy } = p.traits;
        p.lookIn = (1.5 + peopleRng()*4)/nosy;
        const ahead = peopleRng() < 0.35/nosy, reach = (p.moving ? 0.6 : 1)*Math.min(1.5, Math.sqrt(nosy));
        p.lookTurnTo = ahead ? 0 : (peopleRng()*2 - 1)*LOOK_MAX_TURN*reach;
        p.lookTiltTo = ahead ? 0 : (peopleRng()*2 - 1)*LOOK_MAX_TILT;
      }
      if (possessed) { p.lookTurnTo = 0; p.lookTiltTo = 0; }
      p.lookTurn += (p.lookTurnTo - p.lookTurn)*Math.min(1, dt*4);
      p.lookTilt += (p.lookTiltTo - p.lookTilt)*Math.min(1, dt*4);
      const fear = bloodFear(p); // (how much blood they're wearing, for how scared they look)
      const scaredByBlood = !!p.blood && !p.traits.bloodlust, lusting = isBloodlusting(p);
      if (lusting && !p.lusting) feel(p, 'bloodlust'); // (for what they say: see life/speech-text.js, {is = bloodlusting})
      p.lusting = lusting;
      const delighted = pleased && !scaredByBlood; // (blood wins over any other face: whatever they're doing, they look scared — unless they like it)
      // talking, their mouth moves; listening, their expression changes every now and then
      const group = p.group, talking = !!group && group.speaker === p, listening = !!group && !!group.speaker && !talking && p.lookAt === group.speaker;
      // (just bolted: calling something out, outside any conversation — see beginFleeing and shoutLine)
      // (on their own, reacting to what they've just seen or felt: aloud, or as a thought — see reactAloud)
      if (!group && !possessed && !p.saying && isDrawn(p) && (p.seen || p.felt)) {
        const head = { x: p.x, y: p.y + 1.6*p.height*S.peopleSize, z: p.z }, reaction = reactAloud(head, voiceOf(p, i), i, p);
        if (reaction?.thought) { p.thought = reaction; p.thoughtUntil = performance.now()/1000 + THOUGHT_TIME; }
        else if (reaction) { p.saying = reaction; p.shouting = true; }
      }
      if (p.fleeTalkUntil && !p.saying) {
        if (performance.now()/1000 > p.fleeTalkUntil || !isDrawn(p)) p.fleeTalkUntil = 0;
        else if ((p.saying = shoutLine({ x: p.x, y: p.y + 1.6*p.height*S.peopleSize, z: p.z }, voiceOf(p, i), i, p, 'fleeing'))) { p.shouting = true; p.fleeTalkUntil = 0; }
      }
      if (!(talking || p.shouting) || (p.saying && !isDrawn(p))) {
        p.shouting = false;
        p.talkTo = 0;
        p.phrase = null;
        stopLine(p.saying);
        p.saying = null;
      } else if (p.saying) {
        // saying a real line (see audio/dictionary.js): the mouth opening as wide as it's loud, and a breath once it's done
        const mouth = lineMouth(p.saying);
        if (mouth < 0) { p.saying = null; p.shouting = false; p.talkTo = 0; p.talkIn = 0.3 + peopleRng()*0.3; }
        else p.talkTo = mouth;
      } else if ((p.talkIn -= dt) <= 0) {
        const head = { x: p.x, y: p.y + 1.6*p.height*S.peopleSize, z: p.z }, heard = isDrawn(p);
        // at the start of a phrase, now and then something real instead
        const phraseStart = !p.phrase || p.phrase.said >= p.phrase.length;
        const far = Math.hypot(head.x - ear.x, head.y - ear.y, head.z - ear.z); // (from where you hear: see ear in audio/sfx.js)
        // (with Options > Speech > Babble only as fallback, anyone out of hearing keeps quiet: nothing real to say there)
        if (S.babbleFallbackOnly && far > hearDistance()) { p.talkTo = 0; p.talkIn = 0.5; p.phrase = null; }
        else if (heard && phraseStart && (p.saying = sayLine(head, voiceOf(p, i), i, p))) p.phrase = null;
        else if (heard && phraseStart && linePause(p)) { p.talkTo = 0; p.talkIn = 0.25; } // (waiting quietly for the next line)
        else {
          // in phrases, with a breath between (see nextSyllable in audio/voices.js)
          const { open, length, intonation } = nextSyllable(p, peopleRng);
          p.talkTo = open;
          p.talkIn = length;
          // and each syllable they say is heard
          if (open > 0 && heard) babble(head, voiceOf(p, i), length, open, p.traits.mood, intonation);
          if (open > 0 && S.babbleBubbles && far <= (S.bubbleDistance ?? 35) && p.babbleLine?.phrase !== p.phrase) p.babbleLine = babbleLine(p.phrase);
        }
      }
      // a bubble with what they're saying, kept up a little after (see ui/speech-bubbles.js); only for those on the camera's
      // side of a building's walls — in the room with it, or outdoors with it — else gone
      const bubbleSide = isInsideBuilding() ? inRoom(p) : isDrawn(p) && !inRoom(p);
      const babbling = S.babbleBubbles && p.phrase && p.babbleLine?.phrase === p.phrase && p.phrase.said < p.phrase.length ? p.babbleLine : null;
      const thinking = bubbleSide && !group && !possessed ? thoughtOf(p, dt) : (p.fidgetThought = false, p.thought = null);
      if (bubbleSide && (p.saying || babbling || thinking || hasBubble(p))) speechBubble(p, bubbleAt(p), p.saying ?? babbling ?? thinking);
      // (shocked, a gasp — agape while they stare)
      if (delighted) p.talkTo = 0.45;                      // smiling, not agape
      else if (frozen || fleeing || scaredByBlood) p.talkTo = frozen ? 1 : scaredByBlood ? 0.3 + 0.7*fear : 0.55; // (blood, the more of it the wider)
      p.talk += (p.talkTo - p.talk)*Math.min(1, dt*20);
      if (listening) {
        if ((p.emotionIn -= dt) <= 0) { p.emotionTo = Math.max(-1, Math.min(1, peopleRng()*2 - 1 + p.traits.mood)); p.emotionIn = 1.5 + peopleRng()*3; }
      } else if (!group) {
        p.emotionTo = p.traits.mood; // (their resting face)
      }
      if (delighted) p.emotionTo = 1;                      // beaming, where fright and stun go flat
      else if (frozen || fleeing || scaredByBlood) p.emotionTo = -1;
      p.emotion += (p.emotionTo - p.emotion)*Math.min(1, dt*5);
      // their eyes: the look their traits give them (from their mood, say), brighter or sadder as their expression swings
      // above or below where it rests, and wide with shock when frightened
      const { happy, sad, angry, shock } = p.traits, swing = p.emotion - p.traits.mood, shocked = (frozen || fleeing || scaredByBlood) && !delighted; // (they look scared for as long as they've blood on them)
      const eyesTo = [shocked ? (scaredByBlood ? 0.4 + 0.6*fear : 1) : shock, delighted ? 1 : shocked ? 0 : happy + Math.max(0, swing)*0.8, scaredByBlood ? 0 : p.attack || lusting ? 1 : angry, sad + Math.max(0, -swing)*0.8];
      for (let k=0;k<4;k++) p.eyes[k] += (Math.min(1, eyesTo[k]) - p.eyes[k])*Math.min(1, dt*6);
      // instanceAnim (see the shader): the rows they're at in the two animations, how far they've blended, and their blink
      const o = i*4, animArray = personModel.anim.array, lookArray = personModel.look.array;
      animArray[o] = clipRow(p, p.clipA);
      animArray[o+1] = p.clipB === p.clipA ? animArray[o] : p.rowB;
      animArray[o+2] = p.fade;
      animArray[o+3] = p.blinkAge < BLINK_DURATION ? Math.sin(Math.PI*p.blinkAge/BLINK_DURATION) : 0;
      lookArray[o] = p.lookTurn; lookArray[o+1] = p.lookTilt; lookArray[o+2] = p.talk; lookArray[o+3] = p.emotion;
      if (p.water?.drowned) holdDrowned(o, animArray, lookArray); // (still, face down: see peopleWater.js)
      const eyesArray = personModel.eyes.array;
      for (let k=0;k<4;k++) eyesArray[o + k] = p.eyes[k];
      // the copies everything they wear (hair, glasses, a skirt) keeps of where they are, how they're posed and which way they're looking
      personModel.wornLayers.forEach(layer => {
        const style = layer.of[i] >= 0 ? layer.styles[layer.of[i]] : null;
        if (!style || !style.mesh) return;
        const slot = layer.slot[i];
        matrix.toArray(style.mesh.instanceMatrix.array, slot*16);
        for (let k=0;k<4;k++) { style.anim.array[slot*4 + k] = animArray[o + k]; style.look.array[slot*4 + k] = lookArray[o + k]; style.eyes.array[slot*4 + k] = eyesArray[o + k]; }
      });
    } else {
      if (p.moving) p.phase += dt*speed*Math.PI/S.peopleSize;
      const bob = p.moving ? Math.abs(Math.sin(p.phase))*0.08*S.peopleSize : 0;
      rotation.setFromAxisAngle(up, p.heading);
      turnInWater(p, rotation); turnCrawling(p, rotation);
      if (!isDrawn(p)) scale.set(0, 0, 0); else scale.set(0.5*S.peopleSize, 1.7*p.height*S.peopleSize, 0.34*S.peopleSize);
      position.set(p.x, p.y + bob, p.z);
      if (p.punched?.revive && p.punched.stage === 'down') shake(position, rotation, PERSON_SHAKE*S.peopleSize);
      sway(p, position, rotation);
      matrix.compose(position, rotation, scale);
      peopleMesh.setMatrixAt(i, matrix);
    }
    if (S.showRoadsafetyDebug) {
      const dead = isGone(p), radius = dead ? 0 : ROADSAFETY_RADIUS*p.traits.roadsafety;
      const half = p.crossStage === 'mid' && p.jc && !p.jc.junction;
      rotation.identity();
      scale.setScalar(half ? 0 : radius);
      matrix.compose(position.set(p.x, p.y + 0.9, p.z), rotation, scale);
      roadsafetyDebugMesh.setMatrixAt(i, matrix);
      const across = half && p.jc.route[p.jc.i];
      rotation.setFromAxisAngle(up, across ? Math.atan2(across.x - p.x, across.z - p.z) : 0);
      scale.setScalar(half ? radius : 0);
      matrix.compose(position, rotation, scale);
      roadsafetyHalfDebugMesh.setMatrixAt(i, matrix);
      rotation.setFromAxisAngle(up, p.heading);
      scale.set(dead ? 0 : 0.5*S.peopleSize, dead ? 0 : 1.7*p.height*S.peopleSize, dead ? 0 : 0.34*S.peopleSize);
      matrix.compose(position.set(p.x, p.y, p.z), rotation, scale);
      pedHitboxDebugMesh.setMatrixAt(i, matrix);
    }
  });

  if (personModel) {
    [personModel, ...personModel.hair].forEach(part => { part.mesh.instanceMatrix.needsUpdate = true; part.anim.needsUpdate = true; part.look.needsUpdate = true; part.eyes.needsUpdate = true; });
    updateHeld(); // (whatever anyone's holding, from where their hands ended up)
  } else {
    peopleMesh.instanceMatrix.needsUpdate = true;
  }
  if (S.showRoadsafetyDebug) {
    roadsafetyDebugMesh.instanceMatrix.needsUpdate = true;
    roadsafetyHalfDebugMesh.instanceMatrix.needsUpdate = true;
    pedHitboxDebugMesh.instanceMatrix.needsUpdate = true;
  }
  showPassengers();
  showInhabitants();
  showFollowedDoing();
  // the camera onto whoever it's following, at about their shoulders — or, while they're indoors, onto the building
  // (but not someone picked in the room it's in, which holds it: see buildings/interior.js)
  const inside = followed >= 0 && isGone(people[followed]) && people[followed].indoors?.building;
  if (followedInside) { /* (the room's camera) */ }
  else if (inside) controls.goalTarget.set(inside.x, inside.y + inside.height*0.5, inside.z);
  else if (followed >= 0) { const p = people[followed]; controls.goalTarget.set(p.x, p.y + personHeight(p)*0.8, p.z); }
  // and the card's headshot of them (kept as it was while they can't be seen), which draws them whole
  if (personModel?.hidden) personModel.hidden.value = -1;
  // (them alone: everyone else is folded away while it draws)
  if (followed >= 0 && personModel && (!isGone(people[followed]) || inRoom(people[followed]))) {
    personModel.only.value = followed;
    App.drawPersonHeadshot(headshotOf(followed));
    personModel.only.value = -1;
  }
  // while controlling someone, their own head and hair are hidden (if S.hideOwnHead)
  if (personModel?.hidden && S.hideOwnHead && possession.index >= 0) personModel.hidden.value = possession.index;
  // or, possessing them, the view from their eyes
  if (possession.index >= 0 && possession.index === followed && people[followed].mode === 'possessed') placePossessedCamera(followed);
}


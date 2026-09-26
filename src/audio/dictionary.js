import { camera } from '../core/scene.js';
import { S } from '../core/shared.js';
import { listener, playBufferAt, muffler, ear } from './sfx.js';
import { speakText, SAMPLE_RATE } from './speech.js';
import { loudnessOf, hearDistance, hearRef, edgeFade } from './voices.js';
import { speechReady, pickCall, pickReply, pickReaction, pickCloser, pickGreeting, pickShout, hasNews } from '../life/speech-text.js';

// ============================================================ real words
// Now and then someone talking near the camera says something real in among their babble (see audio/voices.js): a line
// from the speech files (see life/speech-text.js and assets/text/speech/), picked to suit them. It's said in their own
// babble voice, worked out into its sounds and synthesized on the spot (see audio/speech.js), set down where they stand
// and heard from that side, and quieter the further off, and as loud as they babble. Up to MAX_LINES are said at
// once (any number with Options > Speech > Babble only as fallback), and each conversation waits LINE_GAP after a line before opening another. While they're saying it, their mouth opens as wide as the line's loud.
// A line with replies waits for one: the next in their group to speak (within REPLY_WINDOW) says a reply, picked for
// them, and so on down the conversation (group.talk). Someone who's just seen a death says something about it first.
const LINE_CHANCE = 0.15;   // at the start of each phrase of babble (× chat speed, Options > Speech: S.chatSpeed)
const LINE_GAP = 3;         // seconds after a line ends before its conversation opens another (÷ chat speed)
const LINE_START_GAP = 0.15; // seconds between any two lines starting (each is synthesized on the spot: a burst of them stalls the audio)
const CROWD_EASY = 3;       // lines at once before each is made quieter (by the square root of how many more), so a crowd doesn't clip
const MAX_LINES = 4;        // real lines said at once, at most (each is synthesized as it starts) — no limit with babble only as fallback
const REPLY_WINDOW = 4;     // seconds after a line ends that a reply to it can still come
const MATCH = 1;            // how loud a real line is next to the speaker's own babble (see loudnessOf in audio/voices.js)
const MUFFLE = 1.4; // (as for babble; beyond its hearDistance they only babble)
const MOUTH_FRAME = 0.05;   // seconds over which how wide the mouth is follows the line

let lastStart = -Infinity;
const speaking = new Set(); // { source, start, length, mouth: Float32Array, text, quiet } for each line being said
// (a conversation's gap is kept on its group — or on the speaker, with none — as quietUntil)
const quietOf = person => person.group ?? person;

const chatSpeed = () => S.chatSpeed ?? 1;

/**
 * At the start of a phrase of someone's babble, maybe have them say a real line instead: about a death they've just
 * seen; else a reply, if the last line in their group is waiting for one; else, now and then, a new one.
 * @param {{x: number, y: number, z: number}} at - their head
 * @param {{pitch: number, formant: number, sharpness: number}} voice - their voice, as for babble
 * @param {number} who - a number of their own, so the same person always sounds the same
 * @param {object} person - the speaker (traits, loves, hates, group)
 * @returns {?object} the line being said (for lineMouth and stopLine; `text` is what's said); or null, for them to babble on
 */
export function sayLine(at, voice, who, person) {
  const context = listener.context, now = context.currentTime;
  if ((!S.babbleFallbackOnly && speaking.size >= MAX_LINES) || !speechReady() || now - lastStart < LINE_START_GAP) return null;
  if (Math.hypot(at.x - ear.x, at.y - ear.y, at.z - ear.z) > hearDistance()) return null;
  const group = person.group, talk = group?.talk;
  // (a death they've just seen comes first, straight away: see pickReaction)
  // (who they're talking to, for other. tags: whoever said the line they're replying to, else whoever they're facing)
  const facing = group?.members.includes(person.lookAt) ? person.lookAt : null;
  let said = pickReaction(person, facing);
  // (someone's just joined their circle: see welcome in life/people/peopleActivities.js)
  const greet = person.greetTo;
  if (greet && (performance.now()/1000 > greet.until || !group?.members.includes(greet.who))) person.greetTo = null;
  else if (!said && greet) { said = pickGreeting(person, greet.who); person.greetTo = null; }
  if (!said && talk && talk.by !== person && now < talk.until) { said = pickReply(talk.replies, person, talk.vars, talk.by); group.talk = null; }
  // (a conversation whose time is up wants a closer, or someone leaving a circle does: see updateGroups and the circle's
  // 'sit' stage in life/people/peopleActivities.js)
  if (!said && (group?.wantsEnd || person.closing)) said = pickCloser(person, facing);
  if (!said) {
    // (with Options > Speech > Babble only as fallback, every phrase tries for a real line: see linePause)
    if (now < (quietOf(person).quietUntil ?? 0) || (!S.babbleFallbackOnly && Math.random() >= LINE_CHANCE*chatSpeed())) return null;
    said = pickCall(person, facing);
  }
  if (!said) return null;
  const line = voiceLine(said, at, voice, who, person);
  if (line && group && said.score) group.score = (group.score ?? 0) + said.score; // (see {score}: how the conversation's going)
  if (line && group) group.talk = said.replies.length && !said.end ? { replies: said.replies, vars: said.vars, by: person, until: now + line.length + REPLY_WINDOW } : null;
  return line;
}

/**
 * Someone calling something out, outside any conversation — as they run from something (fleeing.txt: see
 * beginFleeing in life/people/people.js) — within the same limits as any line.
 * @param {{x: number, y: number, z: number}} at - their head
 * @param {{pitch: number, formant: number, sharpness: number}} voice - their voice
 * @param {number} who - a number of their own
 * @param {object} person - the speaker
 * @param {string} category - the speech category to call out from
 * @returns {?object} the line being said, as sayLine's; or null if one can't be had just now
 */
export function shoutLine(at, voice, who, person, category) {
  const now = listener.context.currentTime;
  if ((!S.babbleFallbackOnly && speaking.size >= MAX_LINES) || !speechReady() || now - lastStart < LINE_START_GAP) return null;
  if (Math.hypot(at.x - ear.x, at.y - ear.y, at.z - ear.z) > hearDistance()) return null;
  const said = pickShout(person, category);
  return said ? voiceLine(said, at, voice, who, person) : null;
}

/**
 * Someone on their own reacting to what they've just seen or felt (reactions.txt): said aloud, unless the line's tagged
 * {thought} or they're out of hearing, when it's a thought instead. Waits (null) while too many lines are going or one's
 * just started, so its turn comes round.
 * @param {{x: number, y: number, z: number}} at - their head
 * @param {{pitch: number, formant: number, sharpness: number}} voice
 * @param {number} who
 * @param {object} person
 * @returns {?object} a line being said, or { text, thought: true }, or null
 */
export function reactAloud(at, voice, who, person) {
  const now = listener.context.currentTime, heard = Math.hypot(at.x - ear.x, at.y - ear.y, at.z - ear.z) <= hearDistance();
  if (!hasNews(person) || (heard && ((!S.babbleFallbackOnly && speaking.size >= MAX_LINES) || now - lastStart < LINE_START_GAP))) return null;
  const said = pickReaction(person);
  if (!said) return null;
  if (said.thought || !heard) return { text: said.text, thought: true };
  return voiceLine(said, at, voice, who, person) ?? { text: said.text, thought: true };
}

// A picked line synthesized in the speaker's voice and set playing where they are: the line (for lineMouth and stopLine), or null.
function voiceLine(said, at, voice, who, person) {
  const context = listener.context, now = context.currentTime;
  const text = said.text, mood = person.traits?.mood ?? 0;
  const samples = speakText(text, voice, { mood: mood ?? 0, who });
  if (!samples?.length) return null;
  // (how loud it is through each MOUTH_FRAME, for their mouth to follow; and how loud while they're sounding, the loudest
  // half of those frames, to bring it to their babble's loudness)
  const frame = Math.round(MOUTH_FRAME*SAMPLE_RATE), mouth = new Float32Array(Math.ceil(samples.length/frame));
  const power = new Float32Array(mouth.length);
  for (let i = 0; i < samples.length; i++) {
    const k = Math.floor(i/frame);
    mouth[k] = Math.max(mouth[k], Math.abs(samples[i])*1.2);
    power[k] += samples[i]*samples[i]/frame;
  }
  const loudest = power.filter(e => e > 1e-5).sort().slice(-Math.ceil(power.length/2));
  const rms = Math.sqrt(loudest.reduce((a, b) => a + b, 0)/(loudest.length || 1));
  const buffer = context.createBuffer(1, samples.length, SAMPLE_RATE);
  buffer.getChannelData(0).set(samples);
  const crowd = edgeFade(at)/Math.sqrt(Math.max(1, (speaking.size + 1)/CROWD_EASY)); // (and fading towards the hearing distance: see edgeFade)
  const source = playBufferAt(buffer, at, rms ? MATCH*loudnessOf(voice)/rms*crowd : 0, hearRef(), hearDistance(), 1, [muffler(at, hearRef(), MUFFLE)], 'peds');
  if (!source) return null;
  // (a line tagged {end} ends its conversation once it's said: see finish)
  const line = { source, start: now, length: buffer.duration, mouth, text, quiet: quietOf(person), end: said.end, by: person };
  speaking.add(line);
  lastStart = now;
  return line;
}

/**
 * How wide someone saying a line has their mouth open just now.
 * @param {object} line - as sayLine returned
 * @returns {number} 0 to 1; or -1, once the line's done
 */
export function lineMouth(line) {
  const t = listener.context.currentTime - line.start;
  if (!speaking.has(line) || t >= line.length) { finish(line); return -1; }
  return Math.min(1, line.mouth[Math.floor(t/MOUTH_FRAME)] ?? 0);
}

/**
 * Stop a line partway, when whoever's saying it stops talking.
 * @param {?object} line - as sayLine returned
 * @returns {void}
 */
export function stopLine(line) {
  if (!line || !speaking.has(line)) return;
  try { line.source.stop(); } catch { /* (already ended) */ }
  finish(line);
}

function finish(line) {
  if (!speaking.delete(line)) return;
  line.quiet.quietUntil = listener.context.currentTime + LINE_GAP/chatSpeed();
  if (line.end && line.quiet.members?.includes(line.by)) line.quiet.ending = { how: line.end, by: line.by };
}

/**
 * Whether someone who didn't get a real line should stay quiet rather than babble: with Options > Speech > Babble only
 * as fallback on, while the gap after their conversation's last line (LINE_GAP) runs out — babble's only for when no
 * line can be had.
 * @param {object} person
 * @returns {boolean}
 */
export function linePause(person) {
  const now = listener.context.currentTime;
  if (person.group?.wantsEnd || person.closing || person.greetTo) return true; // (their goodbye's due: no babble while they wait for a chance to say it)
  return !!S.babbleFallbackOnly && (now < (quietOf(person).quietUntil ?? 0) || now - lastStart < LINE_START_GAP);
}

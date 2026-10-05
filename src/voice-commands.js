// Pure helpers for voice control: no DOM, no browser APIs, so they can be unit-tested in Node.

export const DEFAULT_SEEK_SECONDS = 10;

const GREETINGS = new Set(['hey', 'hay', 'hi', 'hello', 'okay', 'ok', 'a', 'he', 'yo', 'hei', 'hey,']);

export function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s']/g, ' ')
    .replace(/'/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(value) {
  const text = normalizeText(value);
  return text ? text.split(' ') : [];
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

export function similarity(a, b) {
  const x = normalizeText(a);
  const y = normalizeText(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

// A small phonetic key so "sonora", "senora" and "sonara" are treated as the same sound.
export function phoneticKey(word) {
  let w = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return '';
  w = w
    .replace(/^(kn|gn|pn|wr)/, 'n')
    .replace(/ph/g, 'f')
    .replace(/ck/g, 'k')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/[cq]/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/z/g, 's')
    .replace(/v/g, 'f')
    .replace(/dg/g, 'j');
  const first = w[0];
  const rest = w.slice(1).replace(/[aeiouyhw]/g, '');
  return (first + rest).replace(/(.)\1+/g, '$1');
}

function soundsAlike(a, b) {
  const ka = phoneticKey(a);
  const kb = phoneticKey(b);
  return ka.length >= 2 && ka === kb;
}

// ---------------------------------------------------------------------------
// Numbers and durations

const NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, to: 2, too: 2, three: 3, four: 4, for: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90, hundred: 100,
};
// "to" and "for" are common mis-hearings of 2 and 4, but only count them right before a unit.
const AMBIGUOUS_NUMBER_WORDS = new Set(['to', 'too', 'for']);

const UNIT_SECONDS = {
  second: 1, seconds: 1, sec: 1, secs: 1, s: 1,
  minute: 60, minutes: 60, min: 60, mins: 60,
  hour: 3600, hours: 3600, hr: 3600, hrs: 3600,
};

/**
 * Parses spoken durations such as "30", "2 minutes", "one minute thirty seconds",
 * "a minute and a half", "an hour". A bare number means seconds.
 * Returns the number of seconds, or null when no amount was spoken.
 */
export function parseTimeSpan(input) {
  const tokens = tokenize(input);
  let total = 0;
  let found = false;
  let lastUnit = 0;
  let current = 0;
  let hasNumber = false;

  const flushBare = () => {
    if (hasNumber) {
      total += current;
      found = true;
    }
    current = 0;
    hasNumber = false;
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const next = tokens[i + 1];
    if (/^\d+(\.\d+)?$/.test(token)) {
      if (hasNumber && !(next in UNIT_SECONDS) && current) flushBare();
      current += Number(token);
      hasNumber = true;
    } else if (/^\d+(\.\d+)?(s|sec|secs|m|min|mins|h|hr|hrs)$/.test(token)) {
      const [, amount, unit] = token.match(/^(\d+(?:\.\d+)?)([a-z]+)$/);
      const seconds = unit.startsWith('h') ? 3600 : unit.startsWith('m') ? 60 : 1;
      total += Number(amount) * seconds;
      lastUnit = seconds;
      found = true;
    } else if (token in NUMBER_WORDS) {
      if (AMBIGUOUS_NUMBER_WORDS.has(token) && !(next in UNIT_SECONDS) && !(next in NUMBER_WORDS)) continue;
      const value = NUMBER_WORDS[token];
      if (value === 100) current = (current || 1) * 100;
      else current += value;
      hasNumber = true;
    } else if ((token === 'a' || token === 'an') && !hasNumber && next && next in UNIT_SECONDS) {
      current = 1;
      hasNumber = true;
    } else if (token === 'half') {
      if (!hasNumber && lastUnit) {
        total += lastUnit / 2;
        found = true;
      } else {
        current += 0.5;
        hasNumber = true;
      }
    } else if (token in UNIT_SECONDS && token !== 's') {
      if (hasNumber) {
        total += current * UNIT_SECONDS[token];
        lastUnit = UNIT_SECONDS[token];
        found = true;
        current = 0;
        hasNumber = false;
      }
    }
  }
  flushBare();
  return found ? total : null;
}

export function describeSeconds(seconds) {
  const total = Math.round(Math.abs(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const parts = [];
  if (hours) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  if (minutes) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
  if (secs || !parts.length) parts.push(`${secs} second${secs === 1 ? '' : 's'}`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Commands

const FILLER_PREFIX = /^(?:(?:please|hey|okay|ok|um|uh|can you|could you|would you|will you|i want you to|i want to|i would like you to|i'd like you to|go ahead and|just)\s+)+/;
const FILLER_SUFFIX = /\s+(?:please|now|for me|thanks|thank you)$/;

function stripFiller(text) {
  let output = text;
  let previous;
  do {
    previous = output;
    output = output.replace(FILLER_PREFIX, '').replace(FILLER_SUFFIX, '').trim();
  } while (output !== previous);
  return output;
}

const NEXT_WORDS = /^(?:(?:the|a)\s+)?(?:next|following)(?:\s+(?:song|track|one|tune))?$/;
const PREVIOUS_WORDS = /^(?:(?:the|a)\s+)?(?:previous|last|prior|earlier|back)(?:\s+(?:song|track|one|tune))?$/;

/**
 * Turns a transcript into a command object, or null when it is not understood.
 * Types: next, previous, pause, resume, playSong, seek, shuffle, volume, mute
 */
export function parseCommand(transcript) {
  const text = stripFiller(normalizeText(transcript));
  if (!text) return null;

  // --- pause / resume -----------------------------------------------------
  if (/^(?:pause|stop|stop (?:the )?(?:music|song|playing|playback)|pause (?:the )?(?:music|song|playback)|hold on|be quiet|silence)$/.test(text)) {
    return { type: 'pause' };
  }
  if (/^(?:resume|continue|unpause|keep playing|keep going|play|play (?:the )?(?:music|song)|resume (?:the )?(?:music|song|playback)|start (?:the )?(?:music|playing))$/.test(text)) {
    return { type: 'resume' };
  }

  // --- play <something> -----------------------------------------------------
  const playMatch = text.match(/^(?:play|put on|start|queue up|listen to)\s+(.+)$/);
  if (playMatch) {
    const rest = playMatch[1].replace(/^(?:the\s+)?(?:song|track|tune)\s+/, '').trim();
    if (NEXT_WORDS.test(rest)) return { type: 'next' };
    if (PREVIOUS_WORDS.test(rest)) return { type: 'previous' };
    if (/^(?:something random|random|a random song|shuffle|shuffled|music on shuffle|my music on shuffle|songs on shuffle|everything on shuffle)$/.test(rest)) {
      return { type: 'shuffle', enabled: true, play: true };
    }
    if (/^(?:it|again|this)$/.test(rest)) return { type: 'resume' };
    if (rest) return { type: 'playSong', query: rest };
  }

  // --- seeking ----------------------------------------------------------------
  const amount = parseTimeSpan(text);
  const backWords = /\b(?:rewind|rewound|backward|backwards|back|reverse|earlier)\b/.test(text);
  const forwardVerbs = /\b(?:fast forward|fastforward|forward|forwards|ahead|advance|move|jump|seek|skip|fast)\b/.test(text);
  const rewindVerb = /\b(?:rewind|backward|backwards)\b/.test(text);
  if (rewindVerb || (amount !== null && (forwardVerbs || backWords))) {
    const seconds = amount !== null ? amount : DEFAULT_SEEK_SECONDS;
    return { type: 'seek', seconds: backWords ? -seconds : seconds, defaulted: amount === null };
  }
  if (/\b(?:fast forward|fastforward|forward|forwards|skip ahead|jump ahead|move ahead|move forward|go forward)\b/.test(text)) {
    return { type: 'seek', seconds: DEFAULT_SEEK_SECONDS, defaulted: true };
  }

  // --- next / previous ----------------------------------------------------
  if (/^(?:next|skip|skip (?:this|the current|that)(?: song| track| one| tune)?|skip it|skip song|skip track|next (?:song|track|one|tune)|go to (?:the )?next(?: song| track)?|go next|change (?:the )?song|another (?:song|one)|play another(?: song| one)?)$/.test(text)
    || /\b(?:next|skip)\b/.test(text)) {
    return { type: 'next' };
  }
  if (/^(?:previous|go back|back|last|last song|previous (?:song|track|one)|go to (?:the )?previous(?: song| track)?|go back (?:a|one|to the previous) (?:song|track)|play (?:the )?previous|replay|start over|restart|from the beginning)$/.test(text)
    || /\b(?:previous|go back|last song)\b/.test(text)) {
    return { type: 'previous' };
  }

  // --- extras -------------------------------------------------------------
  if (/^(?:turn )?shuffle (?:off|disable|stop)$|^(?:turn off|disable|stop) shuffle$/.test(text)) return { type: 'shuffle', enabled: false };
  if (/\bshuffle\b/.test(text)) return { type: 'shuffle', enabled: true };
  if (/\b(?:volume up|louder|turn it up|turn (?:the )?volume up|increase (?:the )?volume|raise (?:the )?volume)\b/.test(text)) return { type: 'volume', delta: 0.15 };
  if (/\b(?:volume down|quieter|softer|turn it down|turn (?:the )?volume down|decrease (?:the )?volume|lower (?:the )?volume)\b/.test(text)) return { type: 'volume', delta: -0.15 };
  if (/^(?:unmute|sound on)$/.test(text)) return { type: 'mute', muted: false };
  if (/^(?:mute|sound off|mute (?:the )?(?:music|sound))$/.test(text)) return { type: 'mute', muted: true };

  return null;
}

// ---------------------------------------------------------------------------
// Song matching

function cleanTitle(value) {
  return normalizeText(String(value || '').replace(/\([^)]*\)|\[[^\]]*\]/g, ' '));
}

function tokenOverlap(queryTokens, targetTokens) {
  if (!queryTokens.length || !targetTokens.length) return 0;
  const used = new Set();
  let matched = 0;
  for (const q of queryTokens) {
    let bestIndex = -1;
    let best = 0;
    targetTokens.forEach((t, index) => {
      if (used.has(index)) return;
      let score = q === t ? 1 : similarity(q, t);
      if (score < 0.99 && q.length > 2 && t.length > 2 && soundsAlike(q, t)) score = Math.max(score, 0.9);
      if (score > best) { best = score; bestIndex = index; }
    });
    if (best >= 0.78) {
      matched += best;
      used.add(bestIndex);
    }
  }
  const queryCoverage = matched / queryTokens.length;
  const targetCoverage = matched / targetTokens.length;
  return queryCoverage * 0.72 + targetCoverage * 0.28;
}

export function scoreTrack(query, track) {
  const q = normalizeText(query);
  if (!q) return 0;
  const title = cleanTitle(track.title) || normalizeText(track.title);
  const artist = normalizeText(track.artist);
  const qTokens = q.split(' ');
  let best = 0;

  const against = (target, weight = 1) => {
    if (!target) return;
    const tTokens = target.split(' ');
    let score = 0;
    if (target === q) score = 1;
    else if (target.includes(q)) score = 0.86 + 0.14 * (q.length / target.length);
    else if (q.includes(target) && target.length > 2) score = 0.82 + 0.1 * (target.length / q.length);
    score = Math.max(score, similarity(q, target) * 0.96, tokenOverlap(qTokens, tTokens));
    best = Math.max(best, score * weight);
  };

  against(title);
  against(normalizeText(track.title), 0.99);
  against(`${title} ${artist}`.trim(), 0.97);
  against(`${artist} ${title}`.trim(), 0.97);
  // "play <title> by <artist>"
  const by = q.match(/^(.*)\s+by\s+(.+)$/);
  if (by) {
    const titleScore = scoreTrack(by[1], { title: track.title, artist: '' });
    const artistScore = artist ? Math.max(similarity(by[2], artist), tokenOverlap(by[2].split(' '), artist.split(' '))) : 0;
    best = Math.max(best, titleScore * 0.8 + artistScore * 0.2);
  }
  // Only artist spoken (e.g. "play queen"): weak match so a real title match wins.
  if (artist) best = Math.max(best, Math.max(similarity(q, artist), tokenOverlap(qTokens, artist.split(' '))) * 0.62);
  return Math.min(1, best);
}

export function rankTracks(query, tracks) {
  return tracks
    .map((track) => ({ track, score: scoreTrack(query, track) }))
    .sort((a, b) => b.score - a.score);
}

/** Returns the track whose name is most similar to the spoken query, or null if nothing is close. */
export function findBestTrack(query, tracks, minimum = 0.5) {
  if (!tracks?.length) return null;
  const [top] = rankTracks(query, tracks);
  return top && top.score >= minimum ? top : null;
}

// ---------------------------------------------------------------------------
// Wake phrase

export function stripGreeting(value) {
  const tokens = tokenize(value);
  while (tokens.length > 1 && GREETINGS.has(tokens[0])) tokens.shift();
  return tokens.join(' ');
}

export function titleCase(value) {
  return String(value || '').replace(/\b([a-z])/g, (letter) => letter.toUpperCase());
}

/**
 * Looks for "hey <name>" (or something that sounds like it) anywhere in a transcript.
 * `names` is the trigger name plus recorded variants, e.g. ['sonora', 'senora'].
 * Returns { matched, rest, score } where `rest` is anything spoken after the wake phrase.
 */
export function detectWake(transcript, names) {
  const tokens = tokenize(transcript);
  if (!tokens.length) return { matched: false, rest: '', score: 0 };
  const variants = [...new Set((names || []).map((name) => normalizeText(name)).filter(Boolean))];
  let best = { matched: false, rest: '', score: 0, end: -1 };

  for (const variant of variants) {
    const compact = variant.replace(/\s+/g, '');
    const nameWords = variant.split(' ').length;
    const short = compact.length <= 3;
    for (let size = Math.max(1, nameWords - 1); size <= nameWords + 2; size += 1) {
      for (let start = 0; start + size <= tokens.length; start += 1) {
        const window = tokens.slice(start, start + size);
        const joined = window.join('');
        const greeted = start > 0 && (GREETINGS.has(tokens[start - 1]) || similarity(tokens[start - 1], 'hey') >= 0.67);
        let score = similarity(joined, compact);
        if (score < 0.85 && !short && window.length <= 2 && soundsAlike(joined, compact)) score = Math.max(score, 0.86);
        const needed = short ? (greeted ? 0.99 : 2) : greeted ? 0.7 : 0.92;
        // A name that is only a prefix of a longer word ("sonoran") is not a match.
        if (score >= needed && score > best.score) {
          best = { matched: true, score, end: start + size, rest: tokens.slice(start + size).join(' ') };
        }
      }
    }
  }
  return best.matched ? { matched: true, rest: best.rest, score: best.score } : { matched: false, rest: '', score: best.score };
}

export function wakeNames(settingsName, variants = []) {
  const base = normalizeText(settingsName) || 'sonora';
  return [...new Set([base, ...variants.map((item) => normalizeText(item)).filter(Boolean)])];
}

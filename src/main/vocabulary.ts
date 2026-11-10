// Spelling hints for foreign words. People mix English tech words into other
// languages ("deploy ettim", "GitHub'a push"); Whisper hears those as local
// words ("diplo", "paşet", "Rigt") unless its starting prompt shows how they
// are written.
//
// Measured with large-v3-q5 on a 8-minute real Turkish video and a synthetic
// Turkish+English test set:
//  - a short prompt of the speaker's own terms fixed most of them (word error
//    rate 12.2% -> 4.4% on the test set; tool names written right in the video);
//  - but Whisper starts DROPPING WORDS once the prompt gets long: 5 terms lost
//    nothing, 10 terms lost ~2% of the words, 15 terms ~12%, 25+ terms ~18-20%,
//    and a 600 character built-in word list lost ~10-45%;
//  - with greedy decoding even a 5 term prompt dropped ~14% of the words, beam
//    search (5) fixed that, so the prompt is only ever sent together with beam search.
// Hence: a small prompt (the user's first terms), no built-in word list, and
// the full dictionary goes to the cleanup model instead, which has room.

/** Terms sent to Whisper. 5 lost nothing in our test, 10 started to lose words. */
const WHISPER_MAX_TERMS = 8;
/** The cleanup model has a 2048-token context shared with the transcript. */
const CLEANUP_MAX_TERMS = 80;

/** Splits the dictionary text into terms (newline, comma or semicolon separated). */
export function dictionaryTerms(dictionary: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of dictionary.split(/[\n\r,;]+/)) {
    const term = raw.trim().slice(0, 40);
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= 200) break;
  }
  return out;
}

/** Starting prompt for Whisper: the user's first terms; empty when there are none. */
export function whisperPrompt(dictionary: string): string {
  return dictionaryTerms(dictionary).slice(0, WHISPER_MAX_TERMS).join(', ');
}

/** Spelling list handed to the cleanup model: the whole dictionary. */
export function cleanupTerms(dictionary: string): string[] {
  return dictionaryTerms(dictionary).slice(0, CLEANUP_MAX_TERMS);
}

// Deterministic transcript fixes that run before the optional AI cleanup.

const norm = (w: string) => w.toLocaleLowerCase('tr').replace(/[^\p{L}\p{N}]+/gu, '');

/** A word or phrase repeated this many times in a row is treated as a
 *  Whisper decoding loop. Two repeats ("evet evet", "çok çok") are normal
 *  speech and stay untouched. */
const MIN_REPEATS = 3;
const MAX_PHRASE_WORDS = 8;

/**
 * Collapses Whisper repetition loops — "hayat, hayat, hayat, hayat" or the
 * same short phrase three or more times in a row — down to one occurrence.
 * The punctuation of the last repeat is kept so sentence ends survive.
 */
export function collapseRepeats(text: string): string {
  let words = text.split(/\s+/).filter(Boolean);
  for (let n = 1; n <= MAX_PHRASE_WORDS; n++) {
    const out: string[] = [];
    let i = 0;
    while (i < words.length) {
      const phrase = words.slice(i, i + n).map(norm);
      let reps = 1;
      if (phrase.length === n && phrase.some(Boolean)) {
        while (
          i + (reps + 1) * n <= words.length &&
          words.slice(i + reps * n, i + (reps + 1) * n).every((w, k) => norm(w) === phrase[k])
        ) {
          reps++;
        }
      }
      if (reps >= MIN_REPEATS) {
        const kept = words.slice(i, i + n);
        kept[n - 1] = words[i + reps * n - 1];
        out.push(...kept);
        i += reps * n;
      } else {
        out.push(words[i]);
        i++;
      }
    }
    words = out;
  }
  return words.join(' ');
}

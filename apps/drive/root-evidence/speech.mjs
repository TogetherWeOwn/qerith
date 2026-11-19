export function safeSpeech(phrases, secrets) {
  return phrases.every(phrase => typeof phrase === 'string' && phrase.length <= 1000 &&
    !/[\p{Cc}\\@]|https?:\/\/|[A-Za-z0-9_-]{32,}/u.test(phrase) &&
    !secrets.some(value => phrase.includes(value)));
}

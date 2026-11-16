// Pure helpers, kept apart from the interface so they can be tested on their own.

export const HOOKS = ['List', 'Question', 'Confession', 'Contrast', 'Direct address', 'How-to', 'Story', 'Statement']

// A first guess at the kind of hook, from the on-screen line. Always editable in the app.
export function guessHook(text) {
  const s = (text || '').trim().toLowerCase().replace(/[’‘]/g, "'")
  if (!s) return ''
  if (/^\d+\s/.test(s) || /\b(\d+|two|three|four|five|six|seven|ten)\s+(things|ways|reasons|signs|tips|lessons|habits|ideas|rules|truths)\b/.test(s)) return 'List'
  if (/^how (to|i|we)\b/.test(s)) return 'How-to'
  if (s.includes('?')) return 'Question'
  if (/\binstead of\b|\bnot\b.+\b(but|it's|it is|just)\b|\b(isn't|aren't|wasn't|don't|doesn't)\b.+[.,;]\s*\S/.test(s)) return 'Contrast'
  if (/^(when|one day|years ago|last (week|year|night|month)|the day|yesterday)\b/.test(s)) return 'Story'
  if (/^(i|i'm|i've|i'd|my|we|we're|our)\b/.test(s)) return 'Confession'
  if (/^(you|your|you're|if you|for the|to the|dear)\b/.test(s)) return 'Direct address'
  return 'Statement'
}

// Cleans up text-recognition output: drops watermarks, stray symbols and noise lines.
export function tidyText(raw) {
  return (raw || '').split(/\n+/).map(l => l.replace(/[|_~^`\\<>{}[\]=+*#]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(l => (l.match(/[A-Za-z]/g) || []).length >= 3 && !/^@\S+$/.test(l) && (l.match(/[A-Za-z0-9 ,.'’!?;:&-]/g) || []).length / l.length > 0.8
      && l.split(' ').some(w => w.replace(/[^A-Za-z]/g, '').length >= 3))
    .join(' ').slice(0, 600).trim()
}

export function median(nums) {
  const a = nums.filter(n => n != null && n !== '').map(Number).filter(Number.isFinite).sort((x, y) => x - y)
  if (!a.length) return null
  return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2
}

// A post counts as an outlier when it was added by link, or when it beats the account's typical figure by the brand's multiple.
export const outlierOf = (p, brand) => !p.dismissed && (p.source === 'link' || (p.score != null && Number(p.score) >= Number(brand.outlier_multiple)))

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)
const firstLine = s => (s || '').split('\n').map(x => x.trim()).find(Boolean) || ''

// The two Content Calendar entries a remix becomes: one to film, one to post. Both carry the brand label.
export function calendarRows(remix, label, sourceUrl) {
  const hook = remix.hook.trim()
  return [
    { day: remix.film_day, kind: 'broll', title: clip(`${label}: ${firstLine(remix.broll) || 'Film for "' + hook + '"'}`, 300), post_type: null, platform: null,
      notes: clip(`For: ${hook}`, 240) },
    { day: remix.post_day, kind: 'post', title: clip(`${label}: ${hook}`, 300), post_type: remix.post_type || 'Reel', platform: null,
      notes: clip([firstLine(remix.script), sourceUrl && `Inspired by ${sourceUrl}`].filter(Boolean).join(' · '), 240) || null },
  ]
}

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
export const fmt = n => (n == null ? '' : compact.format(Number(n)))

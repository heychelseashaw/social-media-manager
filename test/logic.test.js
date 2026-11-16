import { test } from 'node:test'
import assert from 'node:assert/strict'
import { guessHook, tidyText, median, outlierOf, calendarRows, fmt } from '../src/logic.js'

test('guessHook labels common hook shapes', () => {
  assert.equal(guessHook('5 things we do instead of worksheets'), 'List')
  assert.equal(guessHook('Four things that make homeschooling easy'), 'List')
  assert.equal(guessHook('How I plan our homeschool week'), 'How-to')
  assert.equal(guessHook('What if they’re not behind?'), 'Question')
  assert.equal(guessHook('I stopped rescuing my kids from boredom'), 'Confession')
  assert.equal(guessHook('Childhood isn’t a race. Nobody wins by finishing it first.'), 'Contrast')
  assert.equal(guessHook('You don’t have to rebuild a classroom'), 'Direct address')
  assert.equal(guessHook('When I was a child growing up in the school system'), 'Story')
  assert.equal(guessHook('Slow is a full day'), 'Statement')
  assert.equal(guessHook(''), '')
})

test('tidyText keeps real lines and drops noise and watermarks', () => {
  assert.equal(tidyText('WONDER BEFORE\nWORKSHEETS\n@wildwoodschoolofwonder\n|| ~~\n a\n'), 'WONDER BEFORE WORKSHEETS')
  assert.equal(tidyText('%$#@ )( 99 ..\n'), '')
  assert.equal(tidyText(''), '')
})

test('median', () => {
  assert.equal(median([3, 1, 2]), 2); assert.equal(median([1, 2, 3, 4]), 2.5); assert.equal(median([]), null); assert.equal(median(['4.5', null, 1.5]), 3)
})

test('outlierOf uses the brand multiple, includes pasted links, excludes dismissed', () => {
  const b = { outlier_multiple: 3 }
  assert.equal(outlierOf({ score: 3, source: 'sync' }, b), true)
  assert.equal(outlierOf({ score: '2.99', source: 'sync' }, b), false)
  assert.equal(outlierOf({ score: null, source: 'sync' }, b), false)
  assert.equal(outlierOf({ score: null, source: 'link' }, b), true)
  assert.equal(outlierOf({ score: 9, source: 'link', dismissed: true }, b), false)
})

test('calendarRows makes one film entry and one post entry, labelled and within the calendar limits', () => {
  const rows = calendarRows({ hook: 'Wonder before worksheets', script: 'Line one\nLine two', broll: 'Hands turning over a rock\nNotebook', post_type: 'Reel', film_day: '2026-11-17', post_day: '2026-11-18' }, 'Wildwood', 'https://www.instagram.com/p/abc/')
  assert.equal(rows.length, 2)
  assert.deepEqual(Object.keys(rows[0]).sort(), Object.keys(rows[1]).sort())
  assert.deepEqual([rows[0].kind, rows[0].day, rows[0].title], ['broll', '2026-11-17', 'Wildwood: Hands turning over a rock'])
  assert.deepEqual([rows[1].kind, rows[1].day, rows[1].title, rows[1].post_type], ['post', '2026-11-18', 'Wildwood: Wonder before worksheets', 'Reel'])
  assert.match(rows[1].notes, /Inspired by https:\/\/www\.instagram\.com\/p\/abc\//)
  const long = calendarRows({ hook: 'x'.repeat(400), script: '', broll: '', film_day: 'a', post_day: 'b' }, 'Referrals')
  assert.ok(long.every(r => r.title.length >= 1 && r.title.length <= 300))
  assert.equal(long[1].notes, null)
})

test('fmt', () => { assert.equal(fmt(1234), '1.2K'); assert.equal(fmt(null), ''); assert.equal(fmt(2500000), '2.5M') })

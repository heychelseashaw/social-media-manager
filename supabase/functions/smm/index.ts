// Social Media Manager server function.
// Actions:
//   POST {action:"sync"}            daily cron (x-hook-secret) or a signed-in user ("Sync now", own brands only)
//   POST {action:"status"}          signed-in user: is Meta connected, and what did the last sync report
//   POST {action:"link", ...}       signed-in user: log a pasted video link
//   GET  ?cover=<post id>           signed-in user: fetch a post's cover image so the app can read its on-screen text
// Meta access comes from function secrets (META_ACCESS_TOKEN, optionally META_APP_ID + META_APP_SECRET).
// Page tokens derived from it are kept in public.smm_config, which only the service role can read.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const SB_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const PUBLIC_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? 'sb_publishable_29BxUoeaIRaSbAGNV_DFgw_wXTPsJPl'
const GRAPH = 'https://graph.facebook.com/v25.0'
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
const admin = () => createClient(SB_URL, SERVICE, { auth: { persistSession: false } })
const clean = (h: string) => h.trim().replace(/^@/, '').replace(/\/+$/, '').toLowerCase()
const COVER_HOSTS = /(^|\.)(cdninstagram\.com|fbcdn\.net|tiktokcdn\.com|tiktokcdn-us\.com|tiktokcdn-eu\.com|tiktokv\.com|ttwstatic\.com)$/

async function signedIn(req: Request) {
  const auth = req.headers.get('Authorization') ?? ''
  if (!auth.startsWith('Bearer ')) return null
  const client = createClient(SB_URL, PUBLIC_KEY, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } })
  const { data } = await client.auth.getUser(auth.slice(7))
  return data?.user ? { user: data.user, client } : null
}

async function graph(path: string, token: string, params: Record<string, string> = {}) {
  const u = new URL(GRAPH + path)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  u.searchParams.set('access_token', token)
  const r = await fetch(u, { signal: AbortSignal.timeout(20000) })
  const body = await r.json().catch(() => ({}))
  if (!r.ok || body.error) throw new Error(body?.error?.message ?? `Meta returned ${r.status}`)
  return body
}

const fingerprint = async (s: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))).slice(0, 6).map(b => b.toString(16).padStart(2, '0')).join('')

type Page = { token: string; name: string; ig_id: string | null; ig_username: string | null }

// Returns the connected Facebook Pages (with their Instagram accounts), refreshing them when a new token is supplied.
async function pagesFor(db: ReturnType<typeof admin>): Promise<Record<string, Page> | null> {
  const { data: cfg } = await db.from('smm_config').select('meta').eq('id', 1).single()
  const meta = (cfg?.meta ?? {}) as { fp?: string; pages?: Record<string, Page> }
  const envToken = Deno.env.get('META_ACCESS_TOKEN')
  if (!envToken) return meta.pages && Object.keys(meta.pages).length ? meta.pages : null
  const fp = await fingerprint(envToken)
  if (meta.fp === fp && meta.pages && Object.keys(meta.pages).length) return meta.pages
  let token = envToken
  const appId = Deno.env.get('META_APP_ID'), secret = Deno.env.get('META_APP_SECRET')
  if (appId && secret) {
    // A long-lived user token yields Page tokens that do not expire.
    const u = new URL(GRAPH + '/oauth/access_token')
    u.searchParams.set('grant_type', 'fb_exchange_token'); u.searchParams.set('client_id', appId)
    u.searchParams.set('client_secret', secret); u.searchParams.set('fb_exchange_token', envToken)
    const r = await fetch(u, { signal: AbortSignal.timeout(20000) }); const b = await r.json().catch(() => ({}))
    if (r.ok && b.access_token) token = b.access_token
  }
  const res = await graph('/me/accounts', token, { fields: 'id,name,access_token,instagram_business_account{id,username}', limit: '100' })
  const pages: Record<string, Page> = {}
  for (const p of res.data ?? []) {
    pages[p.id] = { token: p.access_token, name: p.name, ig_id: p.instagram_business_account?.id ?? null, ig_username: p.instagram_business_account?.username ?? null }
  }
  await db.from('smm_config').update({ meta: { fp, pages }, updated_at: new Date().toISOString() }).eq('id', 1)
  return Object.keys(pages).length ? pages : null
}

const igCanonical = (url: string) => {
  const m = url.match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/)
  return m ? { code: m[1], url: `https://www.instagram.com/p/${m[1]}/` } : null
}
const igFormat = (m: { media_product_type?: string; media_type?: string }) =>
  m.media_product_type === 'REELS' ? 'Reel' : m.media_type === 'CAROUSEL_ALBUM' ? 'Carousel' : m.media_type === 'IMAGE' ? 'Photo' : 'Video'

async function ensureAccount(db: ReturnType<typeof admin>, owner: string, brand: string, platform: string, handle: string, isOwn: boolean) {
  const { data: rows } = await db.from('smm_accounts').select('*').eq('brand_id', brand).eq('platform', platform).ilike('handle', handle.replace(/[%_\\]/g, '\\$&'))
  if (rows?.length) return rows[0]
  const { data, error } = await db.from('smm_accounts').insert({ owner_id: owner, brand_id: brand, platform, handle, is_own: isOwn }).select().single()
  if (error) throw error
  return data
}

// deno-lint-ignore no-explicit-any
function igRow(owner: string, brand: string, account: string, m: any, extra: Record<string, unknown> = {}) {
  const c = igCanonical(m.permalink ?? '')
  if (!c) return null
  return {
    owner_id: owner, brand_id: brand, account_id: account, platform: 'instagram', url: c.url, external_id: m.id,
    posted_at: m.timestamp ?? null, caption: m.caption ?? null, format: igFormat(m),
    likes: m.like_count ?? null, comments: m.comments_count ?? null, views: m.view_count ?? null,
    cover_url: m.thumbnail_url ?? (m.media_type === 'IMAGE' ? m.media_url : null) ?? null,
    source: 'sync', updated_at: new Date().toISOString(), ...extra,
  }
}

// deno-lint-ignore no-explicit-any
async function save(db: ReturnType<typeof admin>, rows: any[]) {
  const good = rows.filter(Boolean)
  if (!good.length) return 0
  // Only the columns sent are updated, so on-screen text, hook type, topic and notes are never overwritten.
  const { error } = await db.from('smm_posts').upsert(good, { onConflict: 'brand_id,url' })
  if (error) throw error
  return good.length
}

async function syncCompetitor(db: ReturnType<typeof admin>, acct: { id: string; owner_id: string; brand_id: string; handle: string }, igId: string, token: string) {
  const h = clean(acct.handle)
  if (!/^[a-z0-9._]{1,30}$/.test(h)) throw new Error('That does not look like an Instagram username.')
  const res = await graph('/' + igId, token, {
    fields: `business_discovery.username(${h}){followers_count,media_count,media.limit(40){id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,view_count,thumbnail_url,media_url}}`,
  })
  const bd = res.business_discovery ?? {}
  const n = await save(db, (bd.media?.data ?? []).map((m: unknown) => igRow(acct.owner_id, acct.brand_id, acct.id, m)))
  await db.from('smm_accounts').update({ followers: bd.followers_count ?? null, last_synced_at: new Date().toISOString(), sync_note: `${n} posts read` }).eq('id', acct.id)
  return n
}

async function syncOwnInstagram(db: ReturnType<typeof admin>, brand: { id: string; owner_id: string }, page: Page) {
  const acct = await ensureAccount(db, brand.owner_id, brand.id, 'instagram', page.ig_username!, true)
  const me = await graph('/' + page.ig_id, page.token, { fields: 'followers_count' }).catch(() => ({}))
  const res = await graph(`/${page.ig_id}/media`, page.token, { fields: 'id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count', limit: '50' })
  const media = res.data ?? []
  const rows = []
  for (let i = 0; i < media.length; i += 8) {
    rows.push(...await Promise.all(media.slice(i, i + 8).map(async (m: { id: string }) => {
      // Every row in one save must carry the same columns, so these are always present.
      const extra: Record<string, unknown> = { shares: null, saves: null }
      try {
        const ins = await graph(`/${m.id}/insights`, page.token, { metric: 'views,shares,saved' })
        for (const d of ins.data ?? []) {
          const v = d.values?.[0]?.value ?? d.total_value?.value
          if (typeof v === 'number') extra[d.name === 'saved' ? 'saves' : d.name] = v
        }
      } catch { /* insights are unavailable for some post types; likes and comments still count */ }
      return igRow(brand.owner_id, brand.id, acct.id, m, extra)
    })))
  }
  const n = await save(db, rows)
  await db.from('smm_accounts').update({ followers: me.followers_count ?? null, last_synced_at: new Date().toISOString(), sync_note: `${n} posts read` }).eq('id', acct.id)
  return acct
}

async function syncOwnFacebook(db: ReturnType<typeof admin>, brand: { id: string; owner_id: string }, pageId: string, page: Page) {
  const acct = await ensureAccount(db, brand.owner_id, brand.id, 'facebook', page.name, true)
  const res = await graph(`/${pageId}/published_posts`, page.token, { fields: 'id,message,created_time,permalink_url,full_picture,shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)', limit: '40' })
  // deno-lint-ignore no-explicit-any
  const rows = (res.data ?? []).filter((p: any) => /^https:\/\//.test(p.permalink_url ?? '')).map((p: any) => ({
    owner_id: brand.owner_id, brand_id: brand.id, account_id: acct.id, platform: 'facebook', url: String(p.permalink_url).slice(0, 600), external_id: p.id,
    posted_at: p.created_time ?? null, caption: p.message ?? null, format: 'Facebook post',
    likes: p.reactions?.summary?.total_count ?? null, comments: p.comments?.summary?.total_count ?? null, shares: p.shares?.count ?? null,
    cover_url: p.full_picture ?? null, source: 'sync', updated_at: new Date().toISOString(),
  }))
  const n = await save(db, rows)
  await db.from('smm_accounts').update({ last_synced_at: new Date().toISOString(), sync_note: `${n} posts read` }).eq('id', acct.id)
}

async function sync(owner: string | null) {
  const db = admin()
  let pages: Record<string, Page> | null
  try { pages = await pagesFor(db) } catch (e) { return { ok: false, connected: false, reason: 'Meta did not accept the connection: ' + (e as Error).message } }
  if (!pages) return { ok: false, connected: false, reason: 'Instagram is not connected yet.' }
  let q = db.from('smm_brands').select('*')
  if (owner) q = q.eq('owner_id', owner)
  const { data: brands } = await q
  const report: { brand_id: string; notes: string[] }[] = []
  const entries = Object.entries(pages)
  for (const brand of brands ?? []) {
    const notes: string[] = []
    const want = brand.ig_handle ? clean(brand.ig_handle) : null
    const match = entries.find(([, p]) => (want && p.ig_username?.toLowerCase() === want) || (brand.ig_user_id && p.ig_id === brand.ig_user_id))
    if (match) {
      const [pageId, page] = match
      await db.from('smm_brands').update({ ig_user_id: page.ig_id, fb_page_id: pageId }).eq('id', brand.id)
      try { await syncOwnInstagram(db, brand, page); notes.push(`Read @${page.ig_username}`) } catch (e) { notes.push(`Could not read @${page.ig_username}: ${(e as Error).message}`) }
      try { await syncOwnFacebook(db, brand, pageId, page); notes.push(`Read Facebook Page ${page.name}`) } catch (e) { notes.push(`Could not read Facebook Page ${page.name}: ${(e as Error).message}`) }
    } else if (want) notes.push(`No connected Instagram account is named @${want}.`)
    else notes.push('Add this brand\'s own Instagram username in Settings to watch it.')
    // Any connected Instagram account can look up other professional accounts.
    const via = match?.[1].ig_id ? match[1] : entries.map(([, p]) => p).find(p => p.ig_id)
    const { data: accts } = await db.from('smm_accounts').select('*').eq('brand_id', brand.id).eq('platform', 'instagram').eq('is_own', false).eq('active', true)
    for (const a of accts ?? []) {
      if (!via) { notes.push('No Instagram account is connected to look up other accounts.'); break }
      try { await syncCompetitor(db, a, via.ig_id!, via.token) } catch (e) {
        const msg = (e as Error).message
        await db.from('smm_accounts').update({ last_synced_at: new Date().toISOString(), sync_note: 'Could not read: ' + msg.slice(0, 200) }).eq('id', a.id)
        notes.push(`Could not read @${a.handle}`)
      }
    }
    report.push({ brand_id: brand.id, notes })
  }
  const result = { ok: true, connected: true, at: new Date().toISOString(), report }
  if (!owner) await db.from('smm_config').update({ last_sync: result, updated_at: result.at }).eq('id', 1)
  return result
}

async function addLink(ctx: { user: { id: string }; client: ReturnType<typeof createClient> }, body: Record<string, unknown>) {
  const brandId = String(body.brand_id ?? ''), raw = String(body.url ?? '').trim()
  let u: URL
  try { u = new URL(raw) } catch { return json({ error: 'That does not look like a link.' }, 400) }
  if (u.protocol !== 'https:') return json({ error: 'The link must start with https://' }, 400)
  const { data: brand } = await ctx.client.from('smm_brands').select('id').eq('id', brandId).maybeSingle()
  if (!brand) return json({ error: 'Brand not found.' }, 404)
  const db = admin(), owner = ctx.user.id
  const host = u.hostname.replace(/^www\./, '')
  let handle = body.handle ? clean(String(body.handle)) : ''
  // deno-lint-ignore no-explicit-any
  const row: any = { owner_id: owner, brand_id: brandId, source: 'link', platform: 'other', url: raw.slice(0, 600) }
  let note = ''
  if (/(^|\.)tiktok\.com$/.test(host)) {
    row.platform = 'tiktok'; row.format = 'Video'
    let full = u
    if (!/\/video\/\d+/.test(u.pathname)) {
      // Short share links (vm.tiktok.com, tiktok.com/t/...) redirect to the full address.
      try { const r = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(10000) }); const f = new URL(r.url); if (/(^|\.)tiktok\.com$/.test(f.hostname)) full = f } catch { /* keep the link as pasted */ }
    }
    row.url = (full.origin + full.pathname).slice(0, 600)
    row.external_id = full.pathname.match(/\/video\/(\d+)/)?.[1] ?? null
    try {
      const r = await fetch('https://www.tiktok.com/oembed?url=' + encodeURIComponent(row.url), { signal: AbortSignal.timeout(10000) })
      if (r.ok) { const o = await r.json(); row.caption = o.title ?? null; row.cover_url = o.thumbnail_url ?? null; handle = handle || clean(String(o.author_unique_id ?? '')) }
      else note = 'TikTok did not return details for this link.'
    } catch { note = 'TikTok did not return details for this link.' }
    handle = handle || clean(full.pathname.match(/^\/@([^/]+)/)?.[1] ?? '')
  } else if (/(^|\.)instagram\.com$/.test(host)) {
    const c = igCanonical(u.href)
    if (!c) return json({ error: 'That Instagram link is not a post or Reel.' }, 400)
    row.platform = 'instagram'; row.url = c.url; row.external_id = c.code
  } else if (/(^|\.)(facebook\.com|fb\.watch)$/.test(host)) {
    row.platform = 'facebook'; row.url = (u.origin + u.pathname + (u.searchParams.get('v') ? '?v=' + u.searchParams.get('v') : '')).slice(0, 600)
  }
  for (const k of ['views', 'likes', 'shares', 'comments', 'saves']) {
    const n = Number(body[k]); if (body[k] !== undefined && body[k] !== '' && Number.isFinite(n) && n >= 0) row[k] = Math.round(n)
  }
  if (typeof body.screen_text === 'string' && body.screen_text.trim()) { row.screen_text = body.screen_text.trim().slice(0, 2000); row.screen_text_source = 'manual' }
  let acct = null
  if (handle) { acct = await ensureAccount(db, owner, brandId, row.platform, handle, false); row.account_id = acct.id }
  const { data: existing } = await db.from('smm_posts').select('id').eq('brand_id', brandId).eq('url', row.url).maybeSingle()
  if (existing) { const { source: _s, ...patch } = row; await db.from('smm_posts').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', existing.id) }
  else { const { error } = await db.from('smm_posts').insert(row); if (error) return json({ error: error.message }, 400) }
  // For Instagram, the numbers come from the account lookup, when Meta is connected and the username is known.
  if (row.platform === 'instagram') {
    if (!acct) note = 'Add the account\'s username so its numbers can be read automatically.'
    else if (!acct.is_own) {
      try {
        const pages = await pagesFor(db); const via = pages && Object.values(pages).find(p => p.ig_id)
        if (via) await syncCompetitor(db, acct, via.ig_id!, via.token); else note = 'Numbers will fill in once Instagram is connected.'
      } catch (e) { note = 'Could not read that account: ' + (e as Error).message.slice(0, 160) }
    }
  } else if (row.platform !== 'tiktok' || row.views === undefined) note = note || 'Add the view count so this can be compared.'
  const { data: post } = await db.from('smm_posts').select('*').eq('brand_id', brandId).eq('url', row.url).maybeSingle()
  return json({ post, note })
}

async function cover(ctx: { client: ReturnType<typeof createClient> }, id: string) {
  const { data: post } = await ctx.client.from('smm_posts').select('cover_url').eq('id', id).maybeSingle()
  if (!post?.cover_url) return json({ error: 'No cover image.' }, 404)
  let u: URL
  try { u = new URL(post.cover_url as string) } catch { return json({ error: 'No cover image.' }, 404) }
  if (u.protocol !== 'https:' || !COVER_HOSTS.test(u.hostname)) return json({ error: 'Cover image is not from a supported source.' }, 400)
  const r = await fetch(u, { signal: AbortSignal.timeout(15000) })
  const type = r.headers.get('content-type') ?? ''
  if (!r.ok || !type.startsWith('image/')) return json({ error: 'The cover image has expired. It refreshes at the next sync.' }, 404)
  const bytes = new Uint8Array(await r.arrayBuffer())
  if (bytes.length > 6_000_000) return json({ error: 'Cover image is too large.' }, 413)
  return new Response(bytes, { headers: { ...CORS, 'Content-Type': type, 'Cache-Control': 'private, max-age=3600' } })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const url = new URL(req.url)
    if (req.method === 'GET') {
      const ctx = await signedIn(req); if (!ctx) return json({ error: 'Sign in first.' }, 401)
      const id = url.searchParams.get('cover') ?? ''
      if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: 'Not found.' }, 404)
      return await cover(ctx, id)
    }
    if (req.method !== 'POST') return json({ error: 'Not found.' }, 404)
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const hook = req.headers.get('x-hook-secret')
    if (hook) {
      const { data: cfg } = await admin().from('smm_config').select('hook_secret').eq('id', 1).single()
      if (!cfg || hook !== cfg.hook_secret) return json({ error: 'Not allowed.' }, 401)
      return json(await sync(null))
    }
    const ctx = await signedIn(req); if (!ctx) return json({ error: 'Sign in first.' }, 401)
    const { data: ok } = await ctx.client.rpc('has_access'); if (!ok) return json({ error: 'This account does not currently have access.' }, 403)
    if (body.action === 'link') return await addLink(ctx, body)
    if (body.action === 'sync') return json(await sync(ctx.user.id))
    if (body.action === 'status') {
      const db = admin()
      const { data: cfg } = await db.from('smm_config').select('meta,last_sync').eq('id', 1).single()
      const connected = !!Deno.env.get('META_ACCESS_TOKEN') || Object.keys((cfg?.meta as { pages?: object })?.pages ?? {}).length > 0
      const { data: mine } = await ctx.client.from('smm_brands').select('id')
      const ids = new Set((mine ?? []).map((b: { id: string }) => b.id))
      const last = cfg?.last_sync as { at?: string; report?: { brand_id: string; notes: string[] }[] } | null
      return json({ connected, last_at: last?.at ?? null, report: (last?.report ?? []).filter(r => ids.has(r.brand_id)) })
    }
    return json({ error: 'Unknown action.' }, 400)
  } catch (e) {
    return json({ error: (e as Error).message ?? 'Something went wrong.' }, 500)
  }
})

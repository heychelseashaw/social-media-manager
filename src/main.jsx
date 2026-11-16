import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createClient } from '@supabase/supabase-js'
import { guessHook, HOOKS, tidyText, median, outlierOf, calendarRows, fmt } from './logic.js'
import './styles.css'

const SB_URL = 'https://tmzlclbpscxrgzpnryma.supabase.co', SB_KEY = 'sb_publishable_29BxUoeaIRaSbAGNV_DFgw_wXTPsJPl'
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: true, autoRefreshToken: true } })
const FN = SB_URL + '/functions/v1/smm'
const pad = n => String(n).padStart(2, '0')
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const plusDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d) }
const PLATFORMS = { instagram: 'Instagram', tiktok: 'TikTok', facebook: 'Facebook', other: 'Other' }

async function token() { const { data } = await sb.auth.getSession(); return data.session?.access_token }
async function server(body) {
  const r = await fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SB_KEY, Authorization: 'Bearer ' + await token() }, body: JSON.stringify(body) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || 'The server did not respond.')
  return j
}
const covers = new Map()
function coverBlob(id) {
  if (!covers.has(id)) covers.set(id, (async () => {
    const r = await fetch(FN + '?cover=' + id, { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + await token() } })
    if (!r.ok) throw new Error('No cover image')
    return await r.blob()
  })())
  return covers.get(id)
}

// On-screen text is read in the browser with a free text-recognition library. Two passes: the image as it is,
// and a high-contrast version that turns light lettering dark, which suits white text laid over a photo.
let workerP
async function readText(blob) {
  workerP ||= import('tesseract.js').then(m => m.createWorker('eng'))
  const worker = await workerP
  const img = await createImageBitmap(blob)
  const scale = Math.min(1, 1400 / Math.max(img.width, img.height))
  const c = document.createElement('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale)
  const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0, c.width, c.height)
  const plain = await worker.recognize(c)
  const d = ctx.getImageData(0, 0, c.width, c.height), p = d.data
  for (let i = 0; i < p.length; i += 4) { const lum = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2], v = lum > 205 ? 0 : 255; p[i] = p[i + 1] = p[i + 2] = v }
  ctx.putImageData(d, 0, 0)
  const contrast = await worker.recognize(c)
  const a = tidyText(plain.data.text), b = tidyText(contrast.data.text)
  const score = (t, conf) => (t.length >= 6 ? conf : 0)
  return score(b, contrast.data.confidence) >= score(a, plain.data.confidence) ? b : a
}

function Auth() {
  const [email, setEmail] = useState(''), [pw, setPw] = useState(''), [err, setErr] = useState(''), [busy, setBusy] = useState(false)
  const go = async e => { e.preventDefault(); setBusy(true); const { error } = await sb.auth.signInWithPassword({ email, password: pw }); setBusy(false); if (error) setErr(error.message) }
  return <div className="center"><form className="card auth" onSubmit={go}><div className="brand">Social Media Manager</div><h1>Sign in</h1>
    <p className="muted">Use the same email and password as Content Calendar.</p>
    <label className="field"><span>Email</span><input type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} /></label>
    <label className="field"><span>Password</span><input type="password" required autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} /></label>
    {err && <p className="error">{err}</p>}<button disabled={busy}>Sign in</button></form></div>
}

function BrandForm({ brand, onSave, onDelete }) {
  const [f, setF] = useState(brand || { name: '', label: '', brief: '', ig_handle: '', outlier_multiple: 3 })
  const set = (k, v) => setF({ ...f, [k]: v })
  const submit = e => { e.preventDefault(); onSave({ name: f.name.trim(), label: (f.label || f.name).trim().slice(0, 24), brief: f.brief || '', ig_handle: (f.ig_handle || '').trim().replace(/^@/, '') || null, outlier_multiple: Number(f.outlier_multiple) || 3 }) }
  return <form className="card stack" onSubmit={submit}><h2>{brand ? 'Brand details' : 'Add a brand'}</h2>
    <label className="field"><span>Brand name</span><input required maxLength="80" value={f.name} onChange={e => set('name', e.target.value)} placeholder="Wildwood School of Wonder" /></label>
    <label className="field"><span>Short label for calendar entries</span><input maxLength="24" value={f.label} onChange={e => set('label', e.target.value)} placeholder="Wildwood" /></label>
    <label className="field"><span>This brand's own Instagram username</span><input value={f.ig_handle || ''} onChange={e => set('ig_handle', e.target.value)} placeholder="wildwoodschoolofwonder" autoCapitalize="none" /></label>
    <label className="field"><span>Brand brief: audience, voice, and what it stands for. Remixes are written from this.</span><textarea rows="5" value={f.brief} onChange={e => set('brief', e.target.value)} /></label>
    <label className="field"><span>Flag a post as an outlier at this many times the account's typical views</span><input type="number" min="1.2" max="100" step="0.1" value={f.outlier_multiple} onChange={e => set('outlier_multiple', e.target.value)} /></label>
    <div className="row wrap"><button>{brand ? 'Save brand' : 'Add brand'}</button>{brand && onDelete && <button type="button" className="link" onClick={onDelete}>Delete this brand and its data</button>}</div></form>
}

function App({ user }) {
  const [brands, setBrands] = useState(null), [bid, setBid] = useState(() => localStorage.getItem('smm-brand') || ''), [tab, setTab] = useState('outliers')
  const [accounts, setAccounts] = useState([]), [posts, setPosts] = useState([]), [remixes, setRemixes] = useState([]), [msg, setMsg] = useState(null), [paused, setPaused] = useState(false), [draftFor, setDraftFor] = useState(null)
  const notify = useCallback((t, bad) => { setMsg({ t, bad }); setTimeout(() => setMsg(null), 4000) }, [])
  const brand = brands?.find(b => b.id === bid) || brands?.[0]
  const loadBrands = useCallback(async () => { const { data, error } = await sb.from('smm_brands').select('*').order('created_at'); if (error) return notify(error.message, true); setBrands(data) }, [notify])
  const load = useCallback(async () => {
    if (!brand) return
    const [a, p, r] = await Promise.all([
      sb.from('smm_accounts').select('*').eq('brand_id', brand.id).order('created_at'),
      sb.from('smm_posts_scored').select('*').eq('brand_id', brand.id).order('posted_at', { ascending: false, nullsFirst: true }).limit(600),
      sb.from('smm_remixes').select('*').eq('brand_id', brand.id).order('created_at', { ascending: false }).limit(200)])
    const err = a.error || p.error || r.error; if (err) return notify(err.message, true)
    setAccounts(a.data); setPosts(p.data); setRemixes(r.data)
  }, [brand?.id, notify])
  useEffect(() => { loadBrands(); sb.from('profiles').select('access_status').eq('user_id', user.id).maybeSingle().then(({ data }) => setPaused(!data || !['active', 'trial'].includes(data.access_status))) }, [loadBrands, user.id])
  useEffect(() => { load() }, [load])
  useEffect(() => { if (brand) localStorage.setItem('smm-brand', brand.id) }, [brand?.id])
  const api = { notify, brand, user, load, accounts, posts, remixes,
    async patchPost(id, patch) { const { error } = await sb.from('smm_posts').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id); if (error) return notify(error.message, true); setPosts(x => x.map(p => p.id === id ? { ...p, ...patch } : p)) },
    startRemix(post) { setDraftFor(post); setTab('remixes') },
  }
  if (paused) return <div className="center"><div className="card auth"><div className="brand">Social Media Manager</div><h1>Access is paused</h1><p className="muted">This account does not currently have access.</p><button onClick={() => sb.auth.signOut()}>Sign out</button></div></div>
  if (brands === null) return <div className="center muted">Loading…</div>
  const saveBrand = async (row, id) => { const q = id ? sb.from('smm_brands').update(row).eq('id', id) : sb.from('smm_brands').insert(row); const { data, error } = await q.select().single(); if (error) return notify(error.message, true); await loadBrands(); if (!id) setBid(data.id); notify('Saved') }
  if (!brands.length) return <div className="shell"><header><div className="brand">Social Media Manager</div></header><main>
    <p className="muted">Start by adding your first brand. You can add the second one in Settings afterwards.</p><BrandForm onSave={r => saveBrand(r)} /></main>{msg && <div className={'toast' + (msg.bad ? ' bad' : '')} role="status">{msg.t}</div>}</div>
  const outliers = posts.filter(p => outlierOf(p, brand)), drafts = remixes.filter(r => r.status === 'draft')
  const tabs = [['outliers', `Outliers${outliers.length ? ` (${outliers.length})` : ''}`], ['add', 'Add a link'], ['remixes', `Remixes${drafts.length ? ` (${drafts.length})` : ''}`], ['patterns', 'Patterns'], ['accounts', 'Accounts'], ['settings', 'Settings']]
  return <div className="shell">
    <header><div className="row"><div className="brand">Social Media Manager</div>
      <select value={brand.id} onChange={e => { setBid(e.target.value); setDraftFor(null) }} aria-label="Brand">{brands.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
      <nav>{tabs.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</nav></header>
    <main key={brand.id}>
      {tab === 'outliers' && <Outliers api={api} />}
      {tab === 'add' && <AddLink api={api} />}
      {tab === 'remixes' && <Remixes api={api} draftFor={draftFor} clearDraft={() => setDraftFor(null)} />}
      {tab === 'patterns' && <Patterns api={api} />}
      {tab === 'accounts' && <Accounts api={api} />}
      {tab === 'settings' && <div className="stack">
        <BrandForm key={brand.id} brand={brand} onSave={r => saveBrand(r, brand.id)} onDelete={async () => { if (!confirm(`Delete ${brand.name} and everything logged for it? This cannot be undone.`)) return; const { error } = await sb.from('smm_brands').delete().eq('id', brand.id); if (error) return notify(error.message, true); setBid(''); loadBrands() }} />
        <BrandForm key="new" onSave={r => saveBrand(r)} />
        <section className="card"><h2>Account</h2><p className="muted">{user.email}</p><button className="ghost" onClick={() => sb.auth.signOut()}>Sign out</button></section></div>}
    </main>
    {msg && <div className={'toast' + (msg.bad ? ' bad' : '')} role="status">{msg.t}</div>}
  </div>
}

function Cover({ post }) {
  const [src, setSrc] = useState(null)
  useEffect(() => { let url, live = true; if (post.cover_url) coverBlob(post.id).then(b => { if (live) { url = URL.createObjectURL(b); setSrc(url) } }).catch(() => {}); return () => { live = false; if (url) URL.revokeObjectURL(url) } }, [post.id, post.cover_url])
  return src ? <img className="cover" src={src} alt="" /> : <div className="cover empty">{post.cover_url ? '…' : 'No cover'}</div>
}

function PostCard({ post, api, reading }) {
  const [text, setText] = useState(post.screen_text || ''), [topic, setTopic] = useState(post.topic || ''), [busy, setBusy] = useState(false)
  useEffect(() => { setText(post.screen_text || '') }, [post.screen_text])
  const saveText = () => { const t = text.trim(); if (t !== (post.screen_text || '')) api.patchPost(post.id, { screen_text: t || null, screen_text_source: t ? 'manual' : null, ...(t && !post.hook_type ? { hook_type: guessHook(t) } : {}) }) }
  const fromImage = async blobP => { setBusy(true); try { const t = await readText(await blobP); if (!t) return api.notify('No text could be read from that image.', true); setText(t); await api.patchPost(post.id, { screen_text: t, screen_text_source: 'ocr', hook_type: post.hook_type || guessHook(t) }) } catch (e) { api.notify(e.message || 'Could not read the image.', true) } finally { setBusy(false) } }
  const when = post.posted_at ? new Date(post.posted_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Date unknown'
  return <li className={'post' + (post.dismissed ? ' dim' : '')}>
    <Cover post={post} />
    <div className="grow stack tight">
      <div className="row wrap"><b>{post.account_handle ? '@' + post.account_handle : 'Unknown account'}</b>
        <span className="muted small">{PLATFORMS[post.platform]}{post.format ? ' · ' + post.format : ''} · {when}{post.is_own ? ' · yours' : ''}</span>
        {post.score != null && <span className={'badge' + (post.score >= api.brand.outlier_multiple ? ' hot' : '')}>{post.score}× typical {post.score_basis}</span>}
        {post.score == null && post.source === 'link' && <span className="badge">Added by link</span>}</div>
      <div className="muted small">{[['views', post.views], ['likes', post.likes], ['comments', post.comments], ['shares', post.shares], ['saves', post.saves]].filter(x => x[1] != null).map(([k, v]) => `${fmt(v)} ${k}`).join(' · ') || 'No numbers yet'}</div>
      <label className="field"><span>Text on screen{post.screen_text_source === 'ocr' ? ' (read automatically, edit if it looks wrong)' : ''}{reading || busy ? ' · reading…' : ''}</span>
        <textarea rows="2" value={text} onChange={e => setText(e.target.value)} onBlur={saveText} placeholder="What the video says on screen" /></label>
      {post.caption && <p className="caption small">{post.caption}</p>}
      <div className="row wrap">
        <select value={post.hook_type || ''} onChange={e => api.patchPost(post.id, { hook_type: e.target.value || null })} aria-label="Hook type"><option value="">Hook type</option>{HOOKS.map(h => <option key={h}>{h}</option>)}</select>
        <input className="grow" value={topic} onChange={e => setTopic(e.target.value)} onBlur={() => topic.trim() !== (post.topic || '') && api.patchPost(post.id, { topic: topic.trim() || null })} placeholder="Topic, e.g. boredom" aria-label="Topic" /></div>
      <div className="row wrap"><button className="small" onClick={() => api.startRemix(post)}>Write a remix</button>
        <a className="btn ghost small" href={post.url} target="_blank" rel="noreferrer">Open video</a>
        {post.cover_url && <button className="ghost small" disabled={busy} onClick={() => fromImage(coverBlob(post.id))}>Read cover again</button>}
        <label className="btn ghost small">Use a screenshot<input type="file" accept="image/*" hidden onChange={e => e.target.files[0] && fromImage(Promise.resolve(e.target.files[0]))} /></label>
        <button className="link" onClick={() => api.patchPost(post.id, { dismissed: !post.dismissed })}>{post.dismissed ? 'Restore' : 'Dismiss'}</button></div>
    </div></li>
}

function Outliers({ api }) {
  const [who, setWho] = useState('all'), [showAll, setShowAll] = useState(false), [reading, setReading] = useState(null)
  const tried = useRef(new Set())
  const list = api.posts.filter(p => (showAll ? true : outlierOf(p, api.brand)) && (who === 'all' || (who === 'mine') === !!p.is_own))
  // Read on-screen text for new outliers, one at a time, a few per visit.
  useEffect(() => {
    if (reading) return
    const next = api.posts.find(p => outlierOf(p, api.brand) && p.cover_url && !p.screen_text && !tried.current.has(p.id))
    if (!next || tried.current.size >= 15) return
    tried.current.add(next.id); setReading(next.id)
    coverBlob(next.id).then(readText).then(t => t && api.patchPost(next.id, { screen_text: t, screen_text_source: 'ocr', hook_type: next.hook_type || guessHook(t) })).catch(() => {}).finally(() => setReading(null))
  }, [api.posts, reading])
  return <div className="stack">
    <div className="row wrap"><div className="seg">{[['all', 'Everyone'], ['theirs', 'Other accounts'], ['mine', 'Mine']].map(([k, l]) => <button key={k} className={who === k ? 'on' : ''} onClick={() => setWho(k)}>{l}</button>)}</div>
      <label className="check"><input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} /> Show every logged post</label></div>
    {list.length ? <ul className="posts">{list.map(p => <PostCard key={p.id} post={p} api={api} reading={reading === p.id} />)}</ul>
      : <section className="card"><h2>No outliers yet</h2><p className="muted">A post appears here when it reaches {api.brand.outlier_multiple}× the typical views for its account, or when you add it by link. An account needs at least five logged posts before its typical figure can be worked out.</p></section>}
  </div>
}

function AddLink({ api }) {
  const empty = { url: '', handle: '', views: '', likes: '', shares: '', screen_text: '' }
  const [f, setF] = useState(empty), [file, setFile] = useState(null), [busy, setBusy] = useState(false), [note, setNote] = useState('')
  const set = (k, v) => setF({ ...f, [k]: v }), ig = /instagram\.com/i.test(f.url)
  const submit = async e => { e.preventDefault(); setBusy(true); setNote('')
    try {
      const { post, note } = await server({ action: 'link', brand_id: api.brand.id, ...f })
      if (file && post) { const t = await readText(file); if (t) await sb.from('smm_posts').update({ screen_text: t, screen_text_source: 'ocr', hook_type: post.hook_type || guessHook(t) }).eq('id', post.id) }
      setF(empty); setFile(null); setNote(note || ''); api.notify('Logged'); await api.load()
    } catch (err) { api.notify(err.message, true) } finally { setBusy(false) } }
  return <form className="card stack" onSubmit={submit}><h2>Add a video by link</h2>
    <p className="muted">Paste a TikTok, Instagram or Facebook link. It is logged as an outlier for {api.brand.name} and queued for a remix.</p>
    <label className="field"><span>Link</span><input type="url" required value={f.url} onChange={e => set('url', e.target.value)} placeholder="https://www.tiktok.com/@name/video/…" autoCapitalize="none" /></label>
    <label className="field"><span>Account username{ig ? ' (needed for Instagram so the numbers can be read)' : ' (optional)'}</span><input value={f.handle} onChange={e => set('handle', e.target.value)} autoCapitalize="none" /></label>
    <div className="row wrap">{['views', 'likes', 'shares'].map(k => <label className="field grow" key={k}><span>{k[0].toUpperCase() + k.slice(1)}{ig ? ' (optional)' : ''}</span><input inputMode="numeric" pattern="[0-9]*" value={f[k]} onChange={e => set(k, e.target.value.replace(/\D/g, ''))} /></label>)}</div>
    <label className="field"><span>Text on screen (optional; the cover image is read automatically when there is one)</span><textarea rows="2" value={f.screen_text} onChange={e => set('screen_text', e.target.value)} /></label>
    <label className="field"><span>Or a screenshot to read the text from</span><input type="file" accept="image/*" onChange={e => setFile(e.target.files[0] || null)} /></label>
    <button disabled={busy}>{busy ? 'Logging…' : 'Log this video'}</button>{note && <p className="note">{note}</p>}</form>
}

function RemixEditor({ remix, source, api, onDone }) {
  const [f, setF] = useState(() => ({ hook: '', script: '', broll: '', post_type: 'Reel', film_day: plusDays(1), post_day: plusDays(2), ...Object.fromEntries(Object.entries(remix || {}).filter(([, v]) => v != null)) }))
  const [busy, setBusy] = useState(false), set = (k, v) => setF({ ...f, [k]: v })
  const fields = () => ({ hook: f.hook.trim(), script: f.script, broll: f.broll, post_type: f.post_type, film_day: f.film_day || null, post_day: f.post_day || null, updated_at: new Date().toISOString() })
  const save = async extra => { if (!f.hook.trim()) { api.notify('Add a hook line first.', true); return null }
    const row = { ...fields(), ...extra }
    const q = remix ? sb.from('smm_remixes').update(row).eq('id', remix.id) : sb.from('smm_remixes').insert({ ...row, brand_id: api.brand.id, post_id: source?.id || null, author: 'me' })
    const { data, error } = await q.select().single(); if (error) { api.notify(error.message, true); return null } return data }
  const run = fn => async () => { setBusy(true); try { await fn() } finally { setBusy(false) } }
  const justSave = run(async () => { if (await save()) { api.notify('Saved'); await api.load(); onDone?.() } })
  const schedule = run(async () => {
    if (!f.film_day || !f.post_day) return api.notify('Choose a filming day and a posting day.', true)
    const saved = await save(); if (!saved) return
    const rows = calendarRows({ ...f, hook: f.hook.trim() }, api.brand.label, source?.url)
    const { data, error } = await sb.from('cal_items').insert(rows).select('id,kind'); if (error) return api.notify(error.message, true)
    await sb.from('smm_remixes').update({ status: 'scheduled', cal_broll_id: data.find(x => x.kind === 'broll')?.id, cal_post_id: data.find(x => x.kind === 'post')?.id }).eq('id', saved.id)
    api.notify('Added to your Content Calendar'); await api.load(); onDone?.()
  })
  const dismiss = run(async () => { if (remix) await sb.from('smm_remixes').update({ status: 'dismissed' }).eq('id', remix.id); await api.load(); onDone?.() })
  return <section className="card stack">
    <div className="row wrap"><h2 className="grow">{remix ? (remix.author === 'claude' ? 'Drafted by Claude' : 'Your draft') : 'New remix'}</h2>{remix?.status === 'scheduled' && <span className="badge good">In calendar</span>}</div>
    {source && <p className="note small"><b>Based on</b> {source.account_handle ? '@' + source.account_handle : 'a logged video'}{source.score != null ? ` · ${source.score}× typical` : ''}: {source.screen_text || source.caption || 'no text logged'} <a href={source.url} target="_blank" rel="noreferrer">Open</a></p>}
    <label className="field"><span>Hook: the line on screen</span><textarea rows="2" maxLength="400" value={f.hook} onChange={e => set('hook', e.target.value)} /></label>
    <label className="field"><span>Script or caption</span><textarea rows="5" value={f.script} onChange={e => set('script', e.target.value)} /></label>
    <label className="field"><span>B-roll to film</span><textarea rows="2" value={f.broll} onChange={e => set('broll', e.target.value)} /></label>
    <div className="row wrap"><label className="field"><span>Post type</span><select value={f.post_type} onChange={e => set('post_type', e.target.value)}>{['Reel', 'Carousel', 'Photo', 'Video', 'Story', 'Text post'].map(t => <option key={t}>{t}</option>)}</select></label>
      <label className="field"><span>Film on</span><input type="date" value={f.film_day || ''} onChange={e => set('film_day', e.target.value)} /></label>
      <label className="field"><span>Post on</span><input type="date" value={f.post_day || ''} onChange={e => set('post_day', e.target.value)} /></label></div>
    <div className="row wrap">{remix?.status !== 'scheduled' && <button disabled={busy} onClick={schedule}>Add to Content Calendar</button>}
      <button className="ghost" disabled={busy} onClick={justSave}>Save draft</button>
      <button className="link" disabled={busy} onClick={remix ? dismiss : onDone}>{remix ? 'Dismiss' : 'Cancel'}</button></div></section>
}

function Remixes({ api, draftFor, clearDraft }) {
  const [show, setShow] = useState('draft')
  const byId = useMemo(() => Object.fromEntries(api.posts.map(p => [p.id, p])), [api.posts])
  const list = api.remixes.filter(r => r.status === show)
  const waiting = api.posts.filter(p => outlierOf(p, api.brand) && !api.remixes.some(r => r.post_id === p.id)).length
  return <div className="stack">
    {draftFor && <RemixEditor key={'new' + draftFor.id} source={draftFor} api={api} onDone={clearDraft} />}
    <div className="row wrap"><div className="seg">{[['draft', 'Drafts'], ['scheduled', 'In calendar'], ['dismissed', 'Dismissed']].map(([k, l]) => <button key={k} className={show === k ? 'on' : ''} onClick={() => setShow(k)}>{l}</button>)}</div>
      {waiting > 0 && <span className="muted small">{waiting} outlier{waiting === 1 ? '' : 's'} waiting for a remix</span>}</div>
    {list.length ? list.map(r => <RemixEditor key={r.id + r.updated_at} remix={r} source={byId[r.post_id]} api={api} />) : !draftFor && <section className="card"><p className="muted">Nothing here yet. Remixes appear as outliers are found, or start one from any post on the Outliers tab.</p></section>}
  </div>
}

function Patterns({ api }) {
  const [who, setWho] = useState('theirs')
  const rows = api.posts.filter(p => outlierOf(p, api.brand) && (who === 'mine') === !!p.is_own)
  const group = key => Object.entries(rows.reduce((m, p) => { const k = p[key] || 'Not labelled'; (m[k] ||= []).push(p); return m }, {})).map(([k, v]) => ({ k, n: v.length, score: median(v.map(p => p.score).filter(s => s != null)) })).sort((a, b) => b.n - a.n)
  const table = (title, key) => <section className="card"><h2>{title}</h2>{rows.length ? <table><thead><tr><th>{title}</th><th>Outliers</th><th>Typical lift</th></tr></thead>
    <tbody>{group(key).map(g => <tr key={g.k}><td>{g.k}</td><td>{g.n}</td><td>{g.score != null ? g.score.toFixed(1) + '×' : '–'}</td></tr>)}</tbody></table> : <p className="muted small">No outliers to compare yet.</p>}</section>
  return <div className="stack"><div className="seg">{[['theirs', 'Other accounts'], ['mine', 'Mine']].map(([k, l]) => <button key={k} className={who === k ? 'on' : ''} onClick={() => setWho(k)}>{l}</button>)}</div>
    <p className="muted small">A pattern that shows up across several accounts is worth more than one big video. Label hook types and topics on the Outliers tab to sharpen this view.</p>
    {table('Hook type', 'hook_type')}{table('Topic', 'topic')}{table('Format', 'format')}</div>
}

function Accounts({ api }) {
  const [status, setStatus] = useState(null), [busy, setBusy] = useState(false), [f, setF] = useState({ platform: 'instagram', handle: '', is_own: false })
  useEffect(() => { server({ action: 'status' }).then(setStatus).catch(() => setStatus({ connected: false })) }, [])
  const typical = id => api.posts.find(p => p.account_id === id && p.typical_views != null)?.typical_views
  const count = id => api.posts.filter(p => p.account_id === id).length
  const add = async e => { e.preventDefault(); const handle = f.handle.trim().replace(/^@/, ''); if (!handle) return
    const { error } = await sb.from('smm_accounts').insert({ brand_id: api.brand.id, platform: f.platform, handle, is_own: f.is_own }); if (error) return api.notify(error.code === '23505' ? 'That account is already on the list.' : error.message, true)
    setF({ ...f, handle: '' }); api.load() }
  const patch = async (id, p) => { const { error } = await sb.from('smm_accounts').update(p).eq('id', id); if (error) return api.notify(error.message, true); api.load() }
  const remove = async a => { if (!confirm(`Remove @${a.handle} and its logged posts?`)) return; const { error } = await sb.from('smm_accounts').delete().eq('id', a.id); if (error) return api.notify(error.message, true); api.load() }
  const sync = async () => { setBusy(true); try { const r = await server({ action: 'sync' }); api.notify(r.ok ? 'Sync finished' : r.reason, !r.ok); await api.load(); setStatus(await server({ action: 'status' })) } catch (e) { api.notify(e.message, true) } finally { setBusy(false) } }
  const notes = status?.report?.find(r => r.brand_id === api.brand.id)?.notes || []
  const row = a => <li className="item" key={a.id}><div className="grow"><b>@{a.handle}</b> <span className="muted small">{PLATFORMS[a.platform]}{a.followers != null ? ` · ${fmt(a.followers)} followers` : ''} · {count(a.id)} posts logged{typical(a.id) != null ? ` · typical ${fmt(typical(a.id))} views` : ''}</span>
      <div className="muted small">{a.platform === 'instagram' ? (a.sync_note ? `${a.sync_note}${a.last_synced_at ? ' · ' + new Date(a.last_synced_at).toLocaleDateString() : ''}` : 'Waiting for the first sync') : 'Posts from this account are added by link'}</div></div>
    <div className="row wrap end"><label className="field"><span className="small">Typical views, if you want to set it yourself</span><input className="narrow" inputMode="numeric" defaultValue={a.typical_override ?? ''} onBlur={e => { const v = e.target.value.replace(/\D/g, ''); if (String(a.typical_override ?? '') !== v) patch(a.id, { typical_override: v ? Number(v) : null }) }} /></label>
      {a.platform === 'instagram' && !a.is_own && <button className="link" onClick={() => patch(a.id, { active: !a.active })}>{a.active ? 'Pause' : 'Resume'}</button>}<button className="link" onClick={() => remove(a)}>Remove</button></div></li>
  const mine = api.accounts.filter(a => a.is_own), theirs = api.accounts.filter(a => !a.is_own)
  return <div className="stack">
    <section className="card"><div className="row wrap"><h2 className="grow">Instagram and Facebook connection</h2><span className={'badge' + (status?.connected ? ' good' : '')}>{status === null ? 'Checking…' : status.connected ? 'Connected' : 'Not connected yet'}</span></div>
      <p className="muted">{status?.connected ? `Numbers refresh every morning.${status.last_at ? ' Last run: ' + new Date(status.last_at).toLocaleString() + '.' : ''}` : 'Until the Meta connection is set up, accounts can be listed here and videos added by link. Nothing is read automatically yet.'}</p>
      {notes.length > 0 && <ul className="small muted">{notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
      {status?.connected && <button className="ghost" disabled={busy} onClick={sync}>{busy ? 'Syncing…' : 'Sync now'}</button>}</section>
    <section className="card"><h2>Your accounts for {api.brand.name}</h2>{mine.length ? <ul className="items">{mine.map(row)}</ul> : <p className="muted small">Your own Instagram and Facebook Page appear here after the first sync. Set the Instagram username in Settings.</p>}</section>
    <section className="card"><h2>Accounts you are learning from</h2>{theirs.length ? <ul className="items">{theirs.map(row)}</ul> : <p className="muted small">Add accounts whose best posts you want to study.</p>}
      <form className="row wrap" onSubmit={add}><select value={f.platform} onChange={e => setF({ ...f, platform: e.target.value })} aria-label="Platform">{Object.entries(PLATFORMS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <input className="grow" required placeholder="username" value={f.handle} onChange={e => setF({ ...f, handle: e.target.value })} autoCapitalize="none" aria-label="Username" />
        <label className="check"><input type="checkbox" checked={f.is_own} onChange={e => setF({ ...f, is_own: e.target.checked })} /> Mine</label><button>Add account</button></form>
      <p className="muted small">Instagram accounts are read automatically once connected, as long as they are professional accounts. TikTok and Facebook accounts are filled by pasting links.</p></section></div>
}

function Root() {
  const [session, setSession] = useState(undefined)
  useEffect(() => { sb.auth.getSession().then(({ data }) => setSession(data.session)); const { data } = sb.auth.onAuthStateChange((_e, s) => setSession(s)); return () => data.subscription.unsubscribe() }, [])
  if (session === undefined) return <div className="center muted">Loading…</div>
  return session ? <App key={session.user.id} user={session.user} /> : <Auth />
}
createRoot(document.getElementById('root')).render(<StrictMode><Root /></StrictMode>)

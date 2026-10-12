import type { Register } from 'claude-code'

const LOG = "/Users/thinhkhuat/.tmp/ce-probe/log.json"
let n = 0
const log = async ($: any, row: any) => { await $.fs.write(`/Users/thinhkhuat/.tmp/ce-probe/${row.ev}-${Date.now()}-${n++}.json`, JSON.stringify(row, null, 1)) }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    try {
      const res = await $.http.fetch('http://127.0.0.1:4377/v1/systemone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: { x: 'probe' }, questions: { ok: { type: 'noul', instructions: 'Is this a probe?' } } }),
      })
      await log($, { ev: 'jevd', status: res.status, prov: res.headers?.['x-jevd-provider'], body: String(res.text ?? '').slice(0, 160) })
    } catch (err) { await log($, { ev: 'jevd', error: String(err) }) }
    await log($, { ev: 'session.start', keys: Object.keys(e), sid: $.session.id() })
    return r
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    await log($, { ev: 'classic.in', keys: Object.keys(e), source: (e as any).source, prompt_id: (e as any).prompt_id, transcript_path: (e as any).transcript_path })
    $.env.set('CE_PROBE_ENV', 'set-before-next')
    const r: any = await next({ ...e, prompt: `${e.prompt} [REWRITTEN-BY-MOD]`, concierge_probe: 'extra-field' } as any)
    const ctx: string[] = r?.additionalContext ?? []
    await log($, { ev: 'classic.out', keys: Object.keys(r ?? {}), ctx: ctx.map(s => s.slice(0, 90)) })
    return { ...r, additionalContext: ctx.map(s => s.startsWith('PROBE-CMD-CONTEXT') ? 'PROBE-REPLACED-BETA' : s) }
  })

  on('prompt.submit', async ($, e, next) => {
    await log($, { ev: 'submit.in', origin: e.origin, text: e.text.slice(0, 80), ctxIn: e.context?.length ?? 0 })
    const r: any = await next({ ...e, context: [...(e.context ?? []), 'PROBE-SUBMIT-CONTEXT-GAMMA'] })
    await log($, { ev: 'submit.out', keys: Object.keys(r ?? {}) })
    return r
  })

  on('prompt.autocomplete', async ($, e, next) => {
    if (n < 3) await log($, { ev: 'autocomplete', token: e.token, len: e.text.length })
    return next(e)
  })
}

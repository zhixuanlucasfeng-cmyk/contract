import { useEffect, useState, type ReactNode } from 'react';

type Mode = 'user' | 'admin';
const store = { get: (k: string) => { try { return sessionStorage.getItem(k) ?? ''; } catch { return ''; } }, set: (k: string, v: string) => { try { sessionStorage.setItem(k, v); } catch {} } };

function useApi(token: string) {
  return async (path: string, init: RequestInit = {}) => {
    const r = await fetch(path, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error?.message ?? r.statusText);
    return body;
  };
}

const Card = ({ title, children, right }: { title?: string; children: ReactNode; right?: ReactNode }) => (
  <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
    {(title || right) && <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold text-zinc-400">{title}</h2>{right}</div>}
    {children}
  </section>
);
const Btn = ({ children, onClick, primary, danger }: { children: ReactNode; onClick: () => void; primary?: boolean; danger?: boolean }) => (
  <button onClick={onClick} className={`rounded-lg px-3 py-1.5 text-sm ${primary ? 'bg-accent text-white' : danger ? 'border border-red-500/40 text-red-300' : 'border border-zinc-700 hover:border-zinc-500'}`}>{children}</button>
);
const Table = ({ head, rows }: { head: string[]; rows: ReactNode[][] }) => (
  <div className="overflow-x-auto"><table className="w-full text-left text-sm">
    <thead><tr>{head.map((h) => <th key={h} className="border-b border-zinc-800 px-2 py-1.5 font-medium text-zinc-500">{h}</th>)}</tr></thead>
    <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="border-b border-zinc-900 px-2 py-1.5 align-top">{c}</td>)}</tr>)}</tbody>
  </table></div>
);
const Stat = ({ n, label }: { n: ReactNode; label: string }) => <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4"><div className="text-2xl font-bold">{n}</div><div className="text-xs text-zinc-500">{label}</div></div>;
const time = (s: string) => new Date(s).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const failText = (f: { provider: string; error: string }[]) => f.map((x) => `${x.provider}: ${x.error}`).join('\n');

export default function App() {
  const [mode, setMode] = useState<Mode>((store.get('mode') as Mode) || 'user');
  const [token, setToken] = useState(store.get('token'));
  const [ok, setOk] = useState(false);
  const login = () => { store.set('mode', mode); store.set('token', token); setOk(true); };
  return (
    <main className="mx-auto max-w-6xl space-y-5 px-4 py-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-2xl font-black tracking-wide">CONTRACT <span className="text-accent">gateway</span></h1><p className="text-sm text-zinc-500">一个主密钥，所有工具 · 自动故障转移</p></div>
        <div className="flex flex-wrap items-center gap-2">
          <select value={mode} onChange={(e) => { setMode(e.target.value as Mode); setOk(false); }} className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm"><option value="user">用户（主密钥）</option><option value="admin">管理员</option></select>
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={mode === 'user' ? 'ct_…' : 'ADMIN_TOKEN'} className="w-72 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm" />
          <Btn primary onClick={login}>进入</Btn>
        </div>
      </header>
      {ok && (mode === 'user' ? <UserView token={token} onToken={(t) => { setToken(t); store.set('token', t); }} /> : <AdminView token={token} />)}
    </main>
  );
}

function UserView({ token, onToken }: { token: string; onToken: (t: string) => void }) {
  const api = useApi(token);
  const [bal, setBal] = useState<any>(null), [usage, setUsage] = useState<any>(null), [cat, setCat] = useState<any>(null), [error, setError] = useState('');
  const load = () => Promise.all([api('/v1/account/balance'), api('/v1/account/usage'), api('/v1/tools')]).then(([b, u, c]) => { setBal(b); setUsage(u); setCat(c); setError(''); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [token]);
  if (error) return <Card><p className="text-red-300">{error}</p></Card>;
  if (!bal) return null;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat n={bal.credits} label="剩余积分" /><Stat n={bal.used_this_period} label="本期已用" />
        <Stat n={bal.plan_name} label={`套餐 · 每月 ${bal.monthly_credits}${bal.overage_allowed ? ` · 可透支 ${bal.overage_limit}` : ''}`} />
        <Stat n={<span className="text-base">{bal.key}</span>} label={`下次发放 ${time(bal.period_end)}`} />
      </div>
      <Card title="主密钥" right={<Rotate onRotate={async () => { const r = await api('/v1/account/rotate', { method: 'POST' }); onToken(r.key); return r.key; }} />}>
        <p className="text-sm text-zinc-400">所有工具只认这一个密钥。底层各家服务商的密钥只存在网关里，你永远看不到，也不需要管。</p>
      </Card>
      <TryIt api={api} catalog={cat} onDone={load} />
      <Card title="最近调用">
        <Table head={['时间', '工具', '实际回答', '结果', '耗时', '积分', '故障转移']} rows={usage.recent.map((r: any) => [time(r.created_at), r.tool, r.providers.join(' → ') || '—',
          <span className={r.ok ? 'text-emerald-400' : 'text-red-400'}>{r.ok ? '成功' : '失败'}{r.streamed ? ' · 流式' : ''}</span>, `${r.ms}ms`, r.credits,
          <span className="whitespace-pre-wrap text-xs text-zinc-500">{failText(r.failed_over)}</span>])} />
      </Card>
      <div className="grid gap-5 md:grid-cols-2">
        <Card title="按天 · 按分类"><Table head={['日期', '分类', '工具', '调用', '错误', '积分']} rows={usage.byDay.map((d: any) => [String(d.day).slice(0, 10), d.category, d.tool, d.calls, d.errors, d.credits])} /></Card>
        <Card title="积分流水"><Table head={['时间', '变动', '原因']} rows={usage.ledger.map((l: any) => [time(l.created_at), <span className={l.delta > 0 ? 'text-emerald-400' : ''}>{l.delta > 0 ? '+' : ''}{l.delta}</span>, l.reason])} /></Card>
      </div>
    </div>
  );
}

function Rotate({ onRotate }: { onRotate: () => Promise<string> }) {
  const [armed, setArmed] = useState(false), [key, setKey] = useState('');
  if (key) return <code className="rounded bg-zinc-800 px-2 py-1 text-xs">新密钥（只显示这一次）：{key}</code>;
  return <Btn danger onClick={async () => { if (!armed) return setArmed(true); setKey(await onRotate()); }}>{armed ? '再点一次确认重置' : '重置密钥'}</Btn>;
}

function TryIt({ api, catalog, onDone }: { api: ReturnType<typeof useApi>; catalog: any; onDone: () => void }) {
  const tools = Object.entries(catalog.categories).flatMap(([c, ts]: any) => ts.map((t: any) => ({ ...t, category: c })));
  const [name, setName] = useState(tools[0]?.name), [vals, setVals] = useState<Record<string, string>>({}), [out, setOut] = useState<string[]>([]), [busy, setBusy] = useState(false);
  const t = tools.find((x: any) => x.name === name);
  // Start each tool with its documented example filled in.
  useEffect(() => { setVals(Object.fromEntries(Object.entries(t?.example.params ?? {}).map(([k, v]) => [k, String(v)]))); }, [name]);
  const run = async () => {
    setBusy(true); setOut([]);
    const params = Object.fromEntries(Object.entries(vals).filter(([k, v]) => v && k in t.input_schema.properties).map(([k, v]) => [k, t.input_schema.properties[k].type === 'integer' ? Number(v) : v]));
    const r = await fetch(`/v1/tools/${name}/execute`, { method: 'POST', headers: { authorization: `Bearer ${store.get('token')}`, 'content-type': 'application/json' }, body: JSON.stringify({ params, stream: true }) });
    if (!r.ok) { setOut([(await r.json()).error.message]); setBusy(false); return; }
    const reader = r.body!.getReader(), dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true }); let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const e = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        const d = e.data ?? {};
        setOut((o) => [...o, e.type === 'item' ? `[${d.provider}] ${d.title ?? d.text ?? d.name ?? d.pair ?? d.symbol ?? ''} ${d.price ?? d.balance ?? d.value ?? ''} ${d.url ?? ''}`.trim() : `— ${e.type}: ${JSON.stringify(e.error ?? { credits: e.credits, providers: e.providers })}`]);
      }
    }
    setBusy(false); onDone();
  };
  return (
    <Card title="试一下（流式；主服务商中途挂掉时由备用接上）">
      <div className="flex flex-wrap gap-2">
        <select value={name} onChange={(e) => setName(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm">
          {tools.map((x: any) => <option key={x.name} value={x.name} disabled={!x.available}>{x.category} · {x.name}{x.available ? '' : '（没配服务商）'}</option>)}
        </select>
        {t && Object.keys(t.input_schema.properties).map((k) => <input key={k} placeholder={`${k}${t.input_schema.required.includes(k) ? '' : '（可选）'}`} value={vals[k] ?? ''} onChange={(e) => setVals((v) => ({ ...v, [k]: e.target.value }))} className="min-w-40 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm" />)}
        <Btn primary onClick={run}>{busy ? '运行中…' : '运行'}</Btn>
      </div>
      {t && <p className="mt-2 text-xs text-zinc-500">{t.description} · 返回 {t.output} · 服务商 {t.providers.join(' → ') || '无'} · {t.credits} 积分</p>}
      {out.length > 0 && <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-zinc-950 p-3 text-xs">{out.join('\n')}</pre>}
    </Card>
  );
}

function AdminView({ token }: { token: string }) {
  const api = useApi(token);
  const [users, setUsers] = useState<any[]>([]), [stats, setStats] = useState<any[]>([]), [prov, setProv] = useState<any>(null), [plans, setPlans] = useState<any[]>([]);
  const [error, setError] = useState(''), [email, setEmail] = useState(''), [plan, setPlan] = useState('basic'), [newKey, setNewKey] = useState(''), [open, setOpen] = useState<number | null>(null);
  const load = () => Promise.all([api('/admin/users'), api('/admin/stats'), api('/admin/providers'), api('/admin/plans')]).then(([u, s, p, pl]) => { setUsers(u); setStats(s); setProv(p); setPlans(pl); setError(''); }).catch((e) => setError(e.message));
  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [token]);
  if (error) return <Card><p className="text-red-300">{error}</p></Card>;
  return (
    <div className="space-y-5">
      <Card title="最近 24 小时">
        <Table head={['工具', '分类', '调用', '错误', '发生故障转移', '平均耗时', '积分']} rows={stats.map((s) => [s.tool, s.category, s.calls, s.errors, s.failovers, `${s.avg_ms}ms`, s.credits])} />
      </Card>
      {prov && <div className="grid gap-5 md:grid-cols-2">
        <Card title="服务商（优先级从左到右）"><Table head={['工具', '服务商']} rows={Object.entries(prov.status).map(([tool, ps]: any) => [tool,
          <span>{ps.map((p: any, i: number) => <span key={p.id} className={!p.configured ? 'text-zinc-600' : p.coolingUntil ? 'text-red-400' : 'text-emerald-400'}>{i ? ' → ' : ''}{p.id}{!p.configured ? '（无密钥）' : p.coolingUntil ? '（冷却中）' : ''}</span>)}</span>])} /></Card>
        <Card title="健康日志"><Table head={['时间', '服务商', '事件', '详情']} rows={prov.log.map((l: any) => [time(l.created_at), l.provider, l.event, <span className="text-xs text-zinc-500">{l.detail}</span>])} /></Card>
      </div>}
      <Card title="用户" right={<div className="flex flex-wrap gap-2">
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm" />
        <select value={plan} onChange={(e) => setPlan(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm">{plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <Btn primary onClick={async () => { try { const r = await api('/admin/users', { method: 'POST', body: JSON.stringify({ email, plan }) }); setNewKey(`${r.user.email}: ${r.key}`); setEmail(''); load(); } catch (e: any) { setError(e.message); } }}>新建用户</Btn>
      </div>}>
        {newKey && <p className="mb-3 rounded bg-zinc-800 p-2 text-xs">主密钥（只显示这一次）：<code>{newKey}</code></p>}
        <Table head={['ID', 'Email', '套餐', '积分', '密钥', '24h 调用', '']} rows={users.map((u) => [u.id, u.email, u.plan_id, u.credits, u.keys, u.calls_24h,
          <Btn onClick={() => setOpen(open === u.id ? null : u.id)}>{open === u.id ? '收起' : '管理'}</Btn>])} />
        {open !== null && <UserAdmin api={api} id={open} plans={plans} onChange={load} onKey={(k) => setNewKey(k)} />}
      </Card>
    </div>
  );
}

function UserAdmin({ api, id, plans, onChange, onKey }: { api: ReturnType<typeof useApi>; id: number; plans: any[]; onChange: () => void; onKey: (k: string) => void }) {
  const [keys, setKeys] = useState<any[]>([]), [credits, setCredits] = useState('1000');
  const load = () => api(`/admin/users/${id}/keys`).then(setKeys);
  useEffect(() => { load(); }, [id]);
  const act = async (fn: () => Promise<any>) => { const r = await fn(); if (r?.key) onKey(r.key); load(); onChange(); };
  return (
    <div className="mt-4 space-y-3 rounded-lg border border-zinc-800 p-3">
      <div className="flex flex-wrap gap-2">
        <input value={credits} onChange={(e) => setCredits(e.target.value)} className="w-28 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm" />
        <Btn onClick={() => act(() => api(`/admin/users/${id}/topup`, { method: 'POST', body: JSON.stringify({ credits: Number(credits) }) }))}>充值积分</Btn>
        {plans.map((p) => <Btn key={p.id} onClick={() => act(() => api(`/admin/users/${id}/plan`, { method: 'POST', body: JSON.stringify({ plan: p.id }) }))}>改为{p.name}</Btn>)}
        <Btn primary onClick={() => act(() => api(`/admin/users/${id}/keys`, { method: 'POST', body: '{}' }))}>新密钥</Btn>
      </div>
      <Table head={['ID', '密钥', '每分钟', 'IP 白名单', '最后使用', '状态', '']} rows={keys.map((k) => [k.id, k.hint, k.per_minute, k.ip_allow.join(', ') || '不限', k.last_used_at ? new Date(k.last_used_at).toLocaleString('zh-CN') : '—', k.revoked_at ? '已吊销' : '有效',
        !k.revoked_at && <span className="flex gap-2"><Btn onClick={() => act(() => api(`/admin/keys/${k.id}/rotate`, { method: 'POST', body: '{}' }))}>重置</Btn><Btn danger onClick={() => act(() => api(`/admin/keys/${k.id}/revoke`, { method: 'POST', body: '{}' }))}>吊销</Btn></span>])} />
    </div>
  );
}

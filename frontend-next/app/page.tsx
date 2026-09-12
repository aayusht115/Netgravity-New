"use client";

import {
  ArrowRight, BarChart3, Boxes, BrainCircuit, Building2, Check,
  ChevronDown, CircleAlert, Cloud, Database, FileSpreadsheet, Gauge,
  Layers3, LoaderCircle, LogOut, Menu, Network, Plus, RefreshCw,
  Send, Settings2, ShieldCheck, Sparkles, UploadCloud, X
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "@/lib/api";

type User = { user_id: string; name: string; email: string; role: string; organization?: string };
type Project = {
  id: string; name: string; client: string; region: string; description: string;
  status: string; snapshot_id?: string | null; has_network?: boolean; updated_at?: number;
};
type Kpi = { label?: string; name?: string; value?: number | string | null; unit?: string; status?: string };
type StatusPayload = { storage?: { engine?: string; target?: string }; version?: string };
type ChatTurn = { role: "user" | "assistant"; text: string; provenance?: string };

const nav = [
  { id: "overview", label: "Overview", icon: Gauge },
  { id: "facilities", label: "Facilities", icon: Building2 },
  { id: "scenarios", label: "Scenarios", icon: Layers3 },
  { id: "data", label: "Data workspace", icon: Database },
  { id: "assistant", label: "Decision assistant", icon: BrainCircuit }
] as const;
type View = (typeof nav)[number]["id"];

function asNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatValue(metric: Kpi, currency = "USD"): string {
  const n = asNumber(metric?.value);
  if (n === null) return metric?.value == null ? "—" : String(metric.value);
  const unit = (metric.unit || "").toLowerCase();
  if (unit.includes("%") || unit.includes("percent")) return `${n.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
  if (unit.includes("currency") || unit.includes("cost") || ["usd", "inr", "eur", "gbp"].includes(unit)) {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0, notation: Math.abs(n) > 999999 ? "compact" : "standard" }).format(n);
    } catch { return n.toLocaleString(); }
  }
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 1, notation: Math.abs(n) > 999999 ? "compact" : "standard" })}${metric.unit ? ` ${metric.unit}` : ""}`;
}

function initials(name: string): string {
  return (name || "NG").split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function statusTone(status?: string): string {
  const value = (status || "").toLowerCase();
  if (value.includes("critical") || value.includes("red") || value.includes("breach")) return "danger";
  if (value.includes("warn") || value.includes("amber") || value.includes("watch")) return "warning";
  return "good";
}

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);
  const [view, setView] = useState<View>("overview");
  const [mobileNav, setMobileNav] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [kpis, setKpis] = useState<Record<string, Kpi>>({});
  const [facilities, setFacilities] = useState<Record<string, Record<string, Kpi>>>({});
  const [scenarios, setScenarios] = useState<any[]>([]);
  const [currency, setCurrency] = useState("USD");
  const [storage, setStorage] = useState("local");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  const selected = useMemo(() => projects.find((p) => p.id === projectId), [projects, projectId]);

  const loadProjects = useCallback(async () => {
    const response = await api<{ projects: Project[] }>("/api/projects");
    setProjects(response.projects);
    setProjectId((current) => current && response.projects.some((p) => p.id === current)
      ? current : (response.projects[0]?.id || ""));
  }, []);

  useEffect(() => {
    Promise.allSettled([
      api<{ user: User }>("/api/auth/me"),
      api<StatusPayload>("/api/status")
    ]).then(([identity, health]) => {
      if (identity.status === "fulfilled") setUser(identity.value.user);
      if (health.status === "fulfilled") setStorage(health.value.storage?.engine || "connected");
      setBooting(false);
    });
  }, []);

  useEffect(() => {
    if (!user) return;
    loadProjects().catch((error) => setNotice(error.message));
  }, [user, loadProjects]);

  const loadAnalysis = useCallback(async () => {
    if (!selected?.snapshot_id) {
      setKpis({}); setFacilities({}); setScenarios([]); return;
    }
    setBusy(true);
    const query = `?project_id=${encodeURIComponent(selected.id)}`;
    const results = await Promise.allSettled([
      api<any>(`/api/kpis/network${query}`),
      api<any>(`/api/kpis/facilities${query}`),
      api<any>(`/api/scenarios${query}`)
    ]);
    if (results[0].status === "fulfilled") {
      setKpis(results[0].value.kpis || {});
      setCurrency(results[0].value.currency || "USD");
    }
    if (results[1].status === "fulfilled") setFacilities(results[1].value.facilities || {});
    if (results[2].status === "fulfilled") setScenarios(results[2].value.scenarios || []);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") setNotice(failed.reason?.message || "Some analysis could not be loaded.");
    setBusy(false);
  }, [selected]);

  useEffect(() => { loadAnalysis(); }, [loadAnalysis]);

  async function logout() {
    await api("/api/auth/logout", { method: "POST", body: "{}" }).catch(() => undefined);
    setUser(null); setProjects([]); setProjectId("");
  }

  if (booting) return <LoadingScreen />;
  if (!user) return <AuthScreen onAuthenticated={setUser} />;

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
        <div className="brand"><div className="brand-mark"><Network size={21} /></div><span>NetGravity</span></div>
        <button className="close-mobile" onClick={() => setMobileNav(false)} aria-label="Close navigation"><X /></button>
        <p className="eyebrow side-label">Workspace</p>
        <nav>
          {nav.map(({ id, label, icon: Icon }) => (
            <button key={id} className={view === id ? "active" : ""} onClick={() => { setView(id); setMobileNav(false); }}>
              <Icon size={18} /><span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-spacer" />
        <div className="cloud-chip"><Cloud size={16} /><div><strong>Azure ready</strong><span>{storage.replace("_", " ")} storage</span></div></div>
        <div className="user-block">
          <div className="avatar">{initials(user.name)}</div>
          <div><strong>{user.name}</strong><span>{user.role}</span></div>
          <button onClick={logout} aria-label="Sign out"><LogOut size={17} /></button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <button className="menu-button" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu /></button>
          <div className="project-picker-wrap">
            <span>Active network</span>
            <div className="select-shell">
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Active project">
                {projects.length === 0 && <option value="">No project yet</option>}
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select><ChevronDown size={16} />
            </div>
          </div>
          <div className="top-actions">
            <button className="icon-button" onClick={loadAnalysis} disabled={!selected || busy} aria-label="Refresh"><RefreshCw size={18} className={busy ? "spin" : ""} /></button>
            <button className="button secondary" onClick={() => setShowCreate(true)}><Plus size={17} /> New project</button>
          </div>
        </header>

        <div className="content">
          {notice && <div className="notice"><CircleAlert size={18} /><span>{notice}</span><button onClick={() => setNotice("")}><X size={16} /></button></div>}
          {projects.length === 0 ? <EmptyProjects onCreate={() => setShowCreate(true)} /> : (
            <>
              {view === "overview" && <Overview project={selected!} kpis={kpis} facilities={facilities} currency={currency} busy={busy} onUpload={() => setView("data")} />}
              {view === "facilities" && <Facilities facilities={facilities} currency={currency} hasNetwork={!!selected?.snapshot_id} onUpload={() => setView("data")} />}
              {view === "scenarios" && <Scenarios project={selected!} scenarios={scenarios} facilityIds={Object.keys(facilities)} currency={currency} onChanged={loadAnalysis} />}
              {view === "data" && <DataWorkspace project={selected!} onCommitted={async () => { await loadProjects(); await loadAnalysis(); }} />}
              {view === "assistant" && <Assistant project={selected!} />}
            </>
          )}
        </div>
      </main>

      {showCreate && <CreateProject onClose={() => setShowCreate(false)} onCreated={async (project) => { setShowCreate(false); await loadProjects(); setProjectId(project.id); setView("data"); }} />}
    </div>
  );
}

function LoadingScreen() {
  return <div className="loading-screen"><div className="brand-mark"><Network /></div><LoaderCircle className="spin" /><span>Opening your workspace</span></div>;
}

function AuthScreen({ onAuthenticated }: { onAuthenticated: (user: User) => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [mfaToken, setMfaToken] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      if (mfaToken) {
        const result = await api<{ user: User }>("/api/auth/login/mfa", { method: "POST", body: JSON.stringify({ mfa_token: mfaToken, code: form.get("code") }) });
        onAuthenticated(result.user); return;
      }
      const payload: Record<string, FormDataEntryValue | null> = { email: form.get("email"), password: form.get("password") };
      if (mode === "signup") { payload.name = form.get("name"); payload.organization = form.get("organization"); }
      const result = await api<{ user?: User; mfa_required?: boolean; mfa_token?: string }>(`/api/auth/${mode}`, { method: "POST", body: JSON.stringify(payload) });
      if (result.mfa_required && result.mfa_token) setMfaToken(result.mfa_token);
      else if (result.user) onAuthenticated(result.user);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not sign in."); }
    finally { setBusy(false); }
  }

  return (
    <div className="auth-page">
      <section className="auth-story">
        <div className="brand light"><div className="brand-mark"><Network size={21} /></div><span>NetGravity</span></div>
        <div className="auth-copy">
          <p className="eyebrow">Network decision intelligence</p>
          <h1>See the whole network.<br />Choose the next move.</h1>
          <p>Turn supply-chain data into traceable KPIs, facility insights, and solver-backed scenarios.</p>
          <div className="story-points">
            <span><ShieldCheck /> Governed decisions</span><span><Cloud /> Azure-native storage</span><span><Sparkles /> Explainable analysis</span>
          </div>
        </div>
        <div className="auth-orbit"><div /><div /><div /></div>
      </section>
      <section className="auth-panel">
        <form className="auth-card" onSubmit={submit}>
          <div><p className="eyebrow">Secure workspace</p><h2>{mfaToken ? "Verify your sign-in" : mode === "login" ? "Welcome back" : "Create your account"}</h2><p>{mfaToken ? "Enter the code from your authenticator." : mode === "login" ? "Sign in to continue to your network." : "Set up a private planning workspace."}</p></div>
          {error && <div className="form-error"><CircleAlert size={17} />{error}</div>}
          {mfaToken ? <label>Authentication code<input name="code" inputMode="numeric" autoComplete="one-time-code" required autoFocus /></label> : (
            <>
              {mode === "signup" && <><label>Full name<input name="name" required placeholder="Your name" /></label><label>Organization<input name="organization" placeholder="Your company" /></label></>}
              <label>Email address<input name="email" type="email" autoComplete="email" required placeholder="name@company.com" /></label>
              <label>Password<input name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required placeholder="••••••••••••" /></label>
            </>
          )}
          <button className="button primary wide" disabled={busy}>{busy ? <LoaderCircle className="spin" size={18} /> : null}{mfaToken ? "Verify" : mode === "login" ? "Sign in" : "Create account"}<ArrowRight size={18} /></button>
          {!mfaToken && <p className="switch-auth">{mode === "login" ? "New to NetGravity?" : "Already have an account?"} <button type="button" onClick={() => { setMode(mode === "login" ? "signup" : "login"); setError(""); }}>{mode === "login" ? "Create an account" : "Sign in"}</button></p>}
        </form>
      </section>
    </div>
  );
}

function PageHeading({ kicker, title, copy, actions }: { kicker: string; title: string; copy: string; actions?: React.ReactNode }) {
  return <div className="page-heading"><div><p className="eyebrow">{kicker}</p><h1>{title}</h1><p>{copy}</p></div>{actions}</div>;
}

function EmptyProjects({ onCreate }: { onCreate: () => void }) {
  return <div className="empty-state"><div className="empty-icon"><Boxes /></div><p className="eyebrow">First workspace</p><h1>Create your network project</h1><p>Projects keep uploaded data, analyses, and scenarios together. Start one, then add a CSV or Excel workbook.</p><button className="button primary" onClick={onCreate}><Plus size={18} /> Create project</button></div>;
}

function NoNetwork({ onUpload }: { onUpload: () => void }) {
  return <div className="network-empty"><div><FileSpreadsheet size={28} /></div><section><h3>This project needs network data</h3><p>Upload a CSV or Excel workbook, review the detected mapping, then commit it before analysis runs.</p></section><button className="button primary" onClick={onUpload}><UploadCloud size={17} /> Add data</button></div>;
}

function Overview({ project, kpis, facilities, currency, busy, onUpload }: { project: Project; kpis: Record<string, Kpi>; facilities: Record<string, Record<string, Kpi>>; currency: string; busy: boolean; onUpload: () => void }) {
  const metrics = Object.entries(kpis).slice(0, 4);
  const facilityRows = Object.entries(facilities).slice(0, 6);
  return <>
    <PageHeading kicker={project.region || "Network workspace"} title={project.name} copy={project.description || `Decision workspace${project.client ? ` for ${project.client}` : ""}.`} actions={<span className={`status-pill ${project.snapshot_id ? "good" : "warning"}`}><span />{project.snapshot_id ? "Network bound" : "Awaiting data"}</span>} />
    {!project.snapshot_id ? <NoNetwork onUpload={onUpload} /> : <>
      <div className="kpi-grid">
        {metrics.length ? metrics.map(([key, metric], index) => <article className="kpi-card" key={key}><div className="kpi-top"><span className={`metric-icon metric-${index}`}><BarChart3 size={18} /></span><span className={`status-dot ${statusTone(metric.status)}`} /> </div><p>{metric.label || metric.name || key.replaceAll("_", " ")}</p><strong>{formatValue(metric, currency)}</strong><small>{metric.status || "Measured from the active solve"}</small></article>) : Array.from({ length: 4 }).map((_, i) => <article className="kpi-card skeleton" key={i} />)}
      </div>
      <div className="dashboard-grid">
        <article className="panel wide-panel"><div className="panel-title"><div><p className="eyebrow">Operating footprint</p><h2>Facility pulse</h2></div><span>{facilityRows.length} shown</span></div>
          <div className="facility-pulse">{facilityRows.map(([id, values], i) => { const first = Object.values(values).find((m) => asNumber(m.value) !== null); const value = first ? Math.min(100, Math.max(8, asNumber(first.value) || 0)) : 18 + i * 11; return <div className="pulse-row" key={id}><span>{id}</span><div><i style={{ width: `${value}%` }} /></div><strong>{first ? formatValue(first, currency) : "Ready"}</strong></div>; })}</div>
        </article>
        <article className="panel decision-card"><p className="eyebrow">Decision posture</p><div className="decision-score"><span><BrainCircuit /></span><strong>{Object.values(kpis).filter((k) => statusTone(k.status) !== "good").length}</strong></div><h2>Items need attention</h2><p>Open the assistant to investigate pressure points or model a governed scenario.</p></article>
      </div>
      {busy && <div className="inline-loading"><LoaderCircle className="spin" /> Recomputing the network view…</div>}
    </>}
  </>;
}

function Facilities({ facilities, currency, hasNetwork, onUpload }: { facilities: Record<string, Record<string, Kpi>>; currency: string; hasNetwork: boolean; onUpload: () => void }) {
  const rows = Object.entries(facilities);
  const metricNames = Array.from(new Set(rows.flatMap(([, metrics]) => Object.keys(metrics)))).slice(0, 4);
  return <><PageHeading kicker="Network operations" title="Facilities" copy="Modelled performance for every site in the active network." />{!hasNetwork ? <NoNetwork onUpload={onUpload} /> : <article className="panel table-panel"><div className="table-scroll"><table><thead><tr><th>Facility</th>{metricNames.map((name) => <th key={name}>{name.replaceAll("_", " ")}</th>)}<th>Health</th></tr></thead><tbody>{rows.map(([id, metrics]) => { const tone = statusTone(Object.values(metrics).map((m) => m.status).find(Boolean)); return <tr key={id}><td><div className="facility-name"><span><Building2 size={16} /></span><strong>{id}</strong></div></td>{metricNames.map((name) => <td key={name}>{formatValue(metrics[name] || {}, currency)}</td>)}<td><span className={`status-pill ${tone}`}><span />{tone === "good" ? "Stable" : tone === "warning" ? "Watch" : "Critical"}</span></td></tr>; })}</tbody></table></div>{!rows.length && <div className="table-empty">No facility metrics were returned for this network.</div>}</article>}</>;
}

function Scenarios({ project, scenarios, facilityIds, currency, onChanged }: { project: Project; scenarios: any[]; facilityIds: string[]; currency: string; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function simulate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); const form = new FormData(event.currentTarget);
    try {
      const action = String(form.get("action"));
      const payload: any = { project_id: project.id, name: form.get("name"), action, facility_ids: form.get("facility") ? [form.get("facility")] : [] };
      const amount = Number(form.get("amount"));
      if (action === "CHANGE_CAPACITY") payload.capacity_delta_units = amount;
      if (action === "CHANGE_DEMAND") payload.demand_multiplier = amount;
      if (action === "CHANGE_TRANSPORT_COST") payload.transport_cost_multiplier = amount;
      await api("/api/scenarios/simulate", { method: "POST", body: JSON.stringify(payload) });
      setOpen(false); await onChanged();
    } catch (err) { setError(err instanceof Error ? err.message : "Scenario could not be run."); }
    finally { setBusy(false); }
  }
  return <><PageHeading kicker="What-if planning" title="Scenarios" copy="Compare alternatives against the unchanged baseline." actions={<button className="button primary" disabled={!project.snapshot_id} onClick={() => setOpen(true)}><Plus size={17} /> Run scenario</button>} />
    {!project.snapshot_id ? <NoNetwork onUpload={() => undefined} /> : <div className="scenario-grid">{scenarios.map((scenario) => <article className="panel scenario-card" key={scenario.id}><div className="scenario-head"><span><Layers3 size={18} /></span><span className={`status-pill ${scenario.feasible === false ? "danger" : "good"}`}><span />{scenario.feasible === false ? "Infeasible" : "Solved"}</span></div><h3>{scenario.name || scenario.id}</h3><p>{scenario.action || scenario.type || "Network what-if"}</p><div className="scenario-footer"><div><small>Cost delta</small><strong>{formatValue({ value: scenario.deltas?.total_cost ?? scenario.cost_delta, unit: "currency" }, currency)}</strong></div><div><small>Service delta</small><strong>{formatValue({ value: scenario.deltas?.service_level ?? scenario.service_delta, unit: "%" })}</strong></div></div></article>)}{scenarios.length === 0 && <article className="panel scenario-empty"><Sparkles /><h3>No scenarios yet</h3><p>Model capacity, demand, or transport-cost changes to see their network effect.</p><button className="button secondary" onClick={() => setOpen(true)}>Create first scenario</button></article>}</div>}
    {open && <div className="modal-backdrop"><form className="modal" onSubmit={simulate}><div className="modal-head"><div><p className="eyebrow">Solver-backed what-if</p><h2>Run scenario</h2></div><button type="button" onClick={() => setOpen(false)}><X /></button></div>{error && <div className="form-error"><CircleAlert size={17} />{error}</div>}<label>Name<input name="name" required placeholder="e.g. Add 15% Delhi capacity" /></label><label>Change<select name="action"><option value="CHANGE_CAPACITY">Facility capacity</option><option value="CHANGE_DEMAND">Network demand</option><option value="CHANGE_TRANSPORT_COST">Transport cost</option></select></label><label>Facility<select name="facility"><option value="">Network-wide / choose site</option>{facilityIds.map((id) => <option key={id}>{id}</option>)}</select></label><label>Amount or multiplier<input name="amount" type="number" step="0.01" defaultValue="1.1" required /></label><div className="modal-actions"><button type="button" className="button ghost" onClick={() => setOpen(false)}>Cancel</button><button className="button primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <Sparkles size={17} />}Solve scenario</button></div></form></div>}
  </>;
}

function DataWorkspace({ project, onCommitted }: { project: Project; onCommitted: () => Promise<void> }) {
  const [files, setFiles] = useState<File[]>([]); const [preview, setPreview] = useState<any>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function upload() { if (!files.length) return; setBusy(true); setError(""); const body = new FormData(); body.set("project_id", project.id); files.forEach((file) => body.append("files", file)); try { setPreview(await api("/api/ingestions/preview/upload-and-parse", { method: "POST", body })); } catch (err) { setError(err instanceof Error ? err.message : "Upload failed."); } finally { setBusy(false); } }
  async function commit() { setBusy(true); setError(""); try { await api("/api/ingestions/preview/commit", { method: "POST", body: JSON.stringify({ project_id: project.id }) }); setPreview(null); setFiles([]); await onCommitted(); } catch (err) { setError(err instanceof Error ? err.message : "Dataset could not be committed."); } finally { setBusy(false); } }
  return <><PageHeading kicker="Source of truth" title="Data workspace" copy="Upload, inspect, and commit the data that powers this project." actions={project.snapshot_id ? <span className="status-pill good"><span />Dataset active</span> : undefined} />
    <div className="data-grid"><article className="panel uploader"><div className="drop-zone"><div className="upload-icon"><UploadCloud /></div><h2>Drop in your network files</h2><p>CSV, XLSX, or XLS. Multiple related sheets are supported.</p><label className="button secondary file-button">Choose files<input type="file" multiple accept=".csv,.xlsx,.xls" onChange={(e) => setFiles(Array.from(e.target.files || []))} /></label></div>{files.length > 0 && <div className="file-list">{files.map((file) => <div key={`${file.name}-${file.size}`}><FileSpreadsheet size={18} /><span><strong>{file.name}</strong><small>{(file.size / 1024).toFixed(1)} KB</small></span><Check size={17} /></div>)}<button className="button primary wide" onClick={upload} disabled={busy}>{busy ? <LoaderCircle className="spin" size={18} /> : <UploadCloud size={18} />}Parse and review</button></div>}</article>
      <article className="panel review-panel"><div className="panel-title"><div><p className="eyebrow">Mapping review</p><h2>{preview ? "Ready to confirm" : "Waiting for an upload"}</h2></div></div>{error && <div className="form-error"><CircleAlert size={17} />{error}</div>}{preview ? <><div className="quality-grid"><div><span>Records</span><strong>{preview.dataQuality?.totalRecords ?? "—"}</strong></div><div><span>Valid</span><strong>{preview.dataQuality?.validPct == null ? "—" : `${preview.dataQuality.validPct}%`}</strong></div><div><span>Auto-mapped</span><strong>{preview.mapStats?.auto ?? 0}</strong></div><div><span>Review</span><strong>{preview.mapStats?.review ?? 0}</strong></div></div><div className="review-note"><ShieldCheck /><p><strong>Your file has only been previewed.</strong><span>No KPI or optimization runs until you confirm this mapping.</span></p></div><button className="button primary wide" onClick={commit} disabled={busy}>{busy ? <LoaderCircle className="spin" size={18} /> : <Check size={18} />}Commit dataset</button></> : <div className="review-empty"><Settings2 /><p>Detected fields, data quality, and assumptions will appear here before anything becomes active.</p></div>}</article>
    </div>
  </>;
}

function Assistant({ project }: { project: Project }) {
  const [turns, setTurns] = useState<ChatTurn[]>([{ role: "assistant", text: "Ask me about the active network, a facility, or a what-if change. I’ll ground the answer in the Python optimization engine.", provenance: "OBSERVED" }]);
  const [conversationId, setConversationId] = useState<string | undefined>(); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function send(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); const message = String(form.get("message") || "").trim(); if (!message) return; (event.currentTarget as HTMLFormElement).reset(); setTurns((old) => [...old, { role: "user", text: message }]); setBusy(true); setError(""); try { const response = await api<any>("/orchestrator/chat", { method: "POST", body: JSON.stringify({ message, conversation_id: conversationId, network_snapshot_id: project.snapshot_id, disable_llm: true }) }); setConversationId(response.conversation_id); setTurns((old) => [...old, { role: "assistant", text: response.reply || "The analysis completed without a narrative response.", provenance: response.provenance }]); } catch (err) { setError(err instanceof Error ? err.message : "The assistant could not answer."); } finally { setBusy(false); } }
  return <div className="assistant-layout"><section><PageHeading kicker="Decision support" title="Ask NetGravity" copy="Natural-language access to deterministic network results." /><div className="prompt-grid">{["Where is capacity tight?", "Summarize network cost", "Which facilities need attention?"].map((prompt) => <button key={prompt} onClick={() => { const input = document.querySelector<HTMLInputElement>("#assistant-input"); if (input) { input.value = prompt; input.focus(); } }}>{prompt}<ArrowRight size={15} /></button>)}</div></section><article className="chat-panel"><div className="chat-header"><div className="assistant-avatar"><BrainCircuit /></div><div><strong>Decision assistant</strong><span><i /> Engine connected</span></div></div><div className="turns">{turns.map((turn, index) => <div className={`turn ${turn.role}`} key={index}>{turn.role === "assistant" && <div className="mini-avatar"><Network size={15} /></div>}<div>{turn.provenance && <small>{turn.provenance}</small>}<p>{turn.text}</p></div></div>)}{busy && <div className="turn assistant"><div className="mini-avatar"><LoaderCircle className="spin" size={15} /></div><div><p>Working through the network…</p></div></div>}</div>{error && <div className="chat-error">{error}</div>}<form className="composer" onSubmit={send}><input id="assistant-input" name="message" placeholder={project.snapshot_id ? "Ask a network question…" : "Bind network data to start…"} disabled={!project.snapshot_id || busy} autoComplete="off" /><button disabled={!project.snapshot_id || busy} aria-label="Send"><Send size={18} /></button></form></article></div>;
}

function CreateProject({ onClose, onCreated }: { onClose: () => void; onCreated: (project: Project) => void }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setBusy(true); setError(""); const form = new FormData(event.currentTarget); try { const project = await api<Project>("/api/projects", { method: "POST", body: JSON.stringify({ name: form.get("name"), client: form.get("client"), region: form.get("region"), description: form.get("description") }) }); onCreated(project); } catch (err) { setError(err instanceof ApiError ? err.message : "Project could not be created."); } finally { setBusy(false); } }
  return <div className="modal-backdrop"><form className="modal" onSubmit={submit}><div className="modal-head"><div><p className="eyebrow">New workspace</p><h2>Create project</h2></div><button type="button" onClick={onClose}><X /></button></div>{error && <div className="form-error"><CircleAlert size={17} />{error}</div>}<label>Project name<input name="name" required autoFocus placeholder="e.g. APAC distribution redesign" /></label><div className="field-row"><label>Client<input name="client" placeholder="Company or business unit" /></label><label>Region<input name="region" placeholder="Optional" /></label></div><label>Description<textarea name="description" rows={3} placeholder="What decision is this workspace supporting?" /></label><div className="modal-actions"><button type="button" className="button ghost" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />}Create project</button></div></form></div>;
}

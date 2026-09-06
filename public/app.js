/* Kotiopetus tracker — front end. Vanilla JS + supabase-js. All data access goes through RLS. */
(() => {
const SUPABASE_URL = "https://htgliokekeaovdiafrgs.supabase.co";
const SUPABASE_KEY = "sb_publishable_QWvR124i4h0hvQumyjBgDw_018SlMbp";
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

// ---------- i18n ----------
let lang = localStorage.getItem("ks_lang") || "fi";
const t = k => (I18N[lang] && I18N[lang][k]) || I18N.fi[k] || k;
function applyLang() {
  document.documentElement.lang = lang;
  $$("[data-i18n]").forEach(el => el.textContent = t(el.dataset.i18n));
  $$("[data-i18n-ph]").forEach(el => el.placeholder = t(el.dataset.i18nPh));
  $$("[data-i18n-aria]").forEach(el => el.setAttribute("aria-label", t(el.dataset.i18nAria)));
  $("#lang-toggle").textContent = lang === "fi" ? "EN" : "FI";
}
function setLang(l) { lang = l; localStorage.setItem("ks_lang", l); applyLang(); if (S.plan) render(); }
const fmtDate = d => d ? new Date(d).toLocaleDateString(lang === "fi" ? "fi-FI" : "en-GB") : "";
const kindLabel = k => I18N[lang]["kind." + k] ? t("kind." + k) : (k || "");
const name = row => lang === "fi" ? (row.title_fi || row.name_fi || row.short_fi) : (row.title_en || row.name_en || row.short_en || row.title_fi || row.name_fi);

// ---------- state ----------
const S = { user: null, profile: null, family: null, plan: null, student: null, subjects: [], progress: [], topics: [], areas: {}, objectives: {}, teacher: false };
const isFamily = () => S.profile && S.profile.role !== "teacher";

function toast(msg, isErr) { const el = $("#toast"); el.textContent = msg; el.hidden = false; el.style.background = isErr ? "var(--bad)" : "var(--ink)"; clearTimeout(el._t); el._t = setTimeout(() => el.hidden = true, 3000); }
const fail = e => { console.error(e); toast(t("toast.error") + (e.message || e), true); };

// ---------- auth ----------
async function boot() {
  applyLang();
  $$("[data-lang]").forEach(b => b.onclick = () => setLang(b.dataset.lang));
  $("#lang-toggle").onclick = () => setLang(lang === "fi" ? "en" : "fi");
  $("#show-login").onclick = () => { $("#request-form").hidden = true; $("#login-form").hidden = false; $("#auth-msg").hidden = true; };
  // password change (accounts are created by the family admin / bootstrap, so this is how first passwords get replaced)
  $("#change-pw").onclick = () => { $("#f-pw").reset(); $("#pw-msg").hidden = true; $("#pw-dialog").showModal(); };
  $("#pw-cancel").onclick = () => $("#pw-dialog").close();
  $("#f-pw").onsubmit = async e => {
    e.preventDefault(); const f = new FormData(e.target);
    if (f.get("p1") !== f.get("p2")) { const m = $("#pw-msg"); m.textContent = t("pw.mismatch"); m.hidden = false; return; }
    const { error } = await sb.auth.updateUser({ password: f.get("p1") });
    if (error) { const m = $("#pw-msg"); m.textContent = error.message; m.hidden = false; return; }
    $("#pw-dialog").close(); toast(t("pw.done"));
  };
  $("#logout").onclick = async () => { await sb.auth.signOut(); location.hash = ""; location.reload(); };

  $("#login-form").onsubmit = async e => {
    e.preventDefault(); const f = new FormData(e.target);
    const { error } = await sb.auth.signInWithPassword({ email: f.get("email"), password: f.get("password") });
    if (error) return authMsg(error.message);
    start();
  };
  $("#show-request").onclick = () => { $("#login-form").hidden = true; $("#request-form").hidden = false; $("#auth-msg").hidden = true; };
  $("#request-form").onsubmit = async e => {
    e.preventDefault(); const f = new FormData(e.target);
    const { error } = await sb.from("ks_signup_requests").insert({ parent_name: f.get("parent_name"), email: f.get("email"), municipality: f.get("municipality") || null, child_grade: +f.get("child_grade"), message: f.get("message") || null, ui_lang: lang });
    if (error) return authMsg(error.message);
    e.target.hidden = true; $("#login-form").hidden = false; authMsg(t("auth.requestSent"), true);
  };
  $("#join-form").onsubmit = async e => {
    e.preventDefault(); const f = new FormData(e.target);
    try { await joinFamily(f.get("join_code"), f.get("role"), f.get("display_name")); start(); } catch (err) { authMsg(err.message); }
  };
  sb.auth.onAuthStateChange((ev) => { if (ev === "SIGNED_IN" && !S.user) start(); });
  const { data: { session } } = await sb.auth.getSession();
  if (session) start(); else showAuth();
}
function authMsg(m, ok) { const el = $("#auth-msg"); el.textContent = m; el.hidden = false; el.style.color = ok ? "var(--ok)" : "var(--bad)"; }
function showAuth() { $("#auth").hidden = false; $("#app").hidden = true; document.documentElement.classList.add("on-landing"); }
async function joinFamily(code, role, display_name) {
  const { error } = await sb.rpc("ks_join_family", { p_code: code, p_role: role, p_display_name: display_name, p_ui_lang: lang });
  if (error) throw error;
}

// ---------- start / load ----------
async function start() {
  const { data: { user } } = await sb.auth.getUser(); if (!user) return showAuth();
  S.user = user;
  const pending = localStorage.getItem("ks_pending_join");
  if (pending) { try { const p = JSON.parse(pending); await joinFamily(p.code, p.role, p.name); } catch (e) {} localStorage.removeItem("ks_pending_join"); }
  let { data: prof } = await sb.from("ks_profiles").select("*").eq("user_id", user.id).maybeSingle();
  if (!prof) {
    // teacher invited by e-mail? accept pending invites (creates ks_teacher_access + profile), else ask for a join code
    try { const { data: n } = await sb.rpc("ks_accept_teacher_invite"); if (n > 0) ({ data: prof } = await sb.from("ks_profiles").select("*").eq("user_id", user.id).maybeSingle()); } catch (e) { console.warn(e); }
  }
  if (!prof) {
    const { data: ta } = await sb.from("ks_teacher_access").select("family_id").eq("teacher_user_id", user.id);
    if (ta && ta.length) {
      await sb.from("ks_profiles").insert({ user_id: user.id, role: "teacher", display_name: user.user_metadata?.display_name || user.email, ui_lang: "fi" });
      ({ data: prof } = await sb.from("ks_profiles").select("*").eq("user_id", user.id).maybeSingle());
    } else { $("#auth").hidden = false; $("#login-form").hidden = true; $("#request-form").hidden = true; $("#join-form").hidden = false; return; }
  }
  S.profile = prof; S.teacher = prof.role === "teacher";
  if (prof.ui_lang && prof.ui_lang !== lang && !localStorage.getItem("ks_lang")) { lang = prof.ui_lang; localStorage.setItem("ks_lang", lang); applyLang(); }
  // family + plan (teacher: first family that invited them)
  let famId = prof.family_id;
  if (!famId) { const { data: ta } = await sb.from("ks_teacher_access").select("family_id").eq("teacher_user_id", user.id).limit(1); famId = ta?.[0]?.family_id; }
  const { data: fam } = await sb.from("ks_families").select("*").eq("id", famId).maybeSingle(); S.family = fam;
  const { data: plans } = await sb.from("ks_plans").select("*, ks_students(first_name)").eq("family_id", famId).order("school_year", { ascending: false }).limit(1);
  S.plan = plans?.[0] || null; S.student = S.plan?.ks_students;
  const { data: subs } = await sb.from("ks_subjects").select("*").order("sort"); S.subjects = subs || [];
  $("#auth").hidden = true; $("#app").hidden = false; document.documentElement.classList.remove("on-landing");
  $("#who").textContent = `${prof.display_name} · ${t("role." + prof.role)}`;
  $$(".family-only").forEach(el => el.hidden = !isFamily());
  window.onhashchange = render; render();
}

// ---------- router ----------
async function render() {
  if (!S.plan) { $("#view").innerHTML = `<p class="muted">${t("dash.noPlan")}</p>`; return; }
  const qz = location.hash.match(/^#\/quiz\/([0-9a-f-]+)/);
  if (qz) { closeDrawer(); return renderQuiz(qz[1]); }
  if (/^#\/report$/.test(location.hash)) { closeDrawer(); return renderReport(); }
  const mp = location.hash.match(/^#\/map(?:\/(\d+))?$/);
  if (mp) { closeDrawer(); return mp[1] ? renderMap(+mp[1]) : renderMapOverview(); }
  const m = location.hash.match(/^#\/subject\/(\d+)(?:\/topic\/([0-9a-f-]+))?/);
  if (m) { await renderSubject(+m[1]); if (m[2]) openDrawer(m[2]); else closeDrawer(); }
  else { closeDrawer(); await renderDashboard(); }
}
function crumbs(parts) { $("#crumbs").innerHTML = parts.map((p, i) => i < parts.length - 1 ? `<a href="${p.href}">${esc(p.label)}</a><span class="muted">›</span>` : `<span>${esc(p.label)}</span>`).join(""); }

// ---------- dashboard ----------
async function renderDashboard() {
  crumbs([{ label: t("nav.home") }]);
  const { data: prog, error } = await sb.from("ks_subject_progress").select("*").eq("plan_id", S.plan.id).order("sort"); if (error) return fail(error);
  S.progress = prog;
  const wk = isoWeek(new Date());
  const { data: week } = await sb.from("ks_topic_status").select("topic_id,subject_id,title_fi,title_en,status,planned_week").eq("plan_id", S.plan.id).eq("planned_week", wk).eq("archived", false);
  const totalMin = prog.reduce((a, r) => a + (r.minutes || 0), 0);
  $("#view").innerHTML = `
    <div class="plan-head"><h1>${esc(S.student?.first_name || "")} · ${S.plan.grade}. ${t("dash.plan")}</h1>
      <span class="meta">${t("dash.year")} ${esc(S.plan.school_year)} · POPS 2014 · ${totalMin} ${t("dash.minutes")}${isFamily() && S.profile.role === "parent" ? ` · ${t("dash.joinCode")}: <span class="mono">${esc(S.family.join_code)}</span>` : ""}</span></div>
    <div class="tiles">${prog.map(r => tile(r)).join("")}</div>
    <p class="map-link"><a href="#/map">${t("map.dashLink")}</a><br><a href="#/report">${t("report.dashLink")}</a></p>
    <div class="section-title"><h2>${t("dash.week")}</h2><span class="muted mono">${t("map.week")} ${wk}</span></div>
    ${week && week.length ? `<ul class="week-list">${week.map(w => `<li onclick="location.hash='#/subject/${w.subject_id}/topic/${w.topic_id}'"><i class="dot s-${w.status}"></i>${esc(name(w))}<span class="muted">· ${esc(name(S.subjects.find(s => s.id === w.subject_id) || {}))}</span></li>`).join("")}</ul>` : `<p class="muted">${t("dash.noWeek")}</p>`}
    ${S.profile.role === "parent" ? `<section class="teach"><div class="section-title"><h2>${t("teach.title")}</h2></div><p class="muted small">${t("teach.intro")}</p><ul id="teach-list" class="list"></ul>
      <form id="f-teach" class="row-form"><input name="teacher_name" placeholder="${t("teach.name")}" required><input name="email" type="email" placeholder="${t("teach.email")}" required><button class="btn small primary" type="submit">${t("teach.invite")}</button></form></section>` : ""}`;
  $$(".tile").forEach(el => el.onclick = () => location.hash = "#/subject/" + el.dataset.id);
  if (S.profile.role === "parent") { loadTeachers(); $("#f-teach").onsubmit = async e => { e.preventDefault(); const f = new FormData(e.target);
    const { error } = await sb.from("ks_teacher_invites").insert({ family_id: S.family.id, email: String(f.get("email")).trim().toLowerCase(), teacher_name: f.get("teacher_name"), invited_by: S.user.id, ui_lang: "fi" });
    if (error) return fail(error); e.target.reset(); toast(t("toast.saved")); loadTeachers(); }; }
}
async function loadTeachers() {
  const [{ data: inv }, { data: acc }] = await Promise.all([sb.from("ks_teacher_invites").select("*").eq("family_id", S.family.id).order("invited_at"), sb.from("ks_teacher_access").select("teacher_user_id,accepted_at").eq("family_id", S.family.id)]);
  const accepted = new Set((inv || []).filter(i => i.teacher_user_id).map(i => i.teacher_user_id));
  const rows = (inv || []).map(i => `<li><span class="chip ${i.accepted_at ? "ok" : i.mail_sent_at ? "warn" : ""}">${i.accepted_at ? t("teach.active") : i.mail_sent_at ? t("teach.mailSent") : t("teach.pending")}</span><span class="grow">${esc(i.teacher_name || "")} <span class="muted">· ${esc(i.email)}</span> <span class="muted mono">${fmtDate(i.accepted_at || i.invited_at)}</span></span>${i.accepted_at ? "" : `<button class="btn link danger small" data-del-inv="${i.id}">×</button>`}</li>`)
    .concat((acc || []).filter(a => !accepted.has(a.teacher_user_id)).map(a => `<li><span class="chip ok">${t("teach.active")}</span><span class="grow">${t("role.teacher")} <span class="muted mono">${t("teach.since")} ${fmtDate(a.accepted_at)}</span></span></li>`));
  $("#teach-list").innerHTML = rows.join("") || `<li class="muted">${t("teach.none")}</li>`;
  $$("[data-del-inv]").forEach(b => b.onclick = async () => { const { error } = await sb.from("ks_teacher_invites").delete().eq("id", b.dataset.delInv); error ? fail(error) : loadTeachers(); });
}
function tile(r) {
  const worst = r.attention ? "s-attention" : r.in_progress ? "s-progress" : r.done ? "s-done" : "";
  return `<button class="tile" data-id="${r.subject_id}">
    <div class="name">${esc(name(r))}</div>
    <div class="sub">${r.kind === "portfolio" ? t("subj.portfolio") : "OPS " + esc(r.code)}</div>
    <div class="bar"><i style="width:${r.pct || 0}%"></i></div>
    <div class="nums"><span>${r.done}/${r.topics} ${t("dash.done")}</span>${r.attention ? `<span class="att">${r.attention} ${t("dash.attention")}</span>` : ""}${r.minutes ? `<span>${r.minutes} min</span>` : ""}</div></button>`;
}
// school-year order: autumn weeks (>= 32) come before spring weeks; unplanned topics last
const syOrder = w => w == null ? 999 : (w >= 32 ? w - 32 : w + 21);
function isoWeek(d) { const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const day = x.getUTCDay() || 7; x.setUTCDate(x.getUTCDate() + 4 - day); const y0 = new Date(Date.UTC(x.getUTCFullYear(), 0, 1)); return Math.ceil((((x - y0) / 864e5) + 1) / 7); }

// ---------- subject ----------
async function renderSubject(subjectId) {
  const subj = S.subjects.find(s => s.id === subjectId); if (!subj) return location.hash = "";
  crumbs([{ label: t("nav.home"), href: "#/" }, { label: name(subj) }]);
  const showArchived = sessionStorage.getItem("ks_arch") === "1";
  const sortMode = sessionStorage.getItem("ks_sort") || "week";
  const [{ data: topics, error }, { data: areas }, { data: ta }, { data: notes }] = await Promise.all([
    sb.from("ks_topic_status").select("*").eq("plan_id", S.plan.id).eq("subject_id", subjectId).order("seq"),
    sb.from("ks_content_areas").select("id,code,name_fi,name_en,description_fi").eq("subject_id", subjectId).order("sort"),
    sb.from("ks_topic_areas").select("topic_id,content_area_id"),
    sb.from("ks_notes").select("topic_id,body,author_role,created_at").eq("plan_id", S.plan.id).eq("subject_id", subjectId).order("created_at", { ascending: false })
  ]);
  if (error) return fail(error);
  S.topics = topics; S.areas = Object.fromEntries((areas || []).map(a => [a.id, a]));
  const ids = new Set(topics.map(x => x.topic_id));
  const topicAreas = {}; (ta || []).forEach(x => { if (ids.has(x.topic_id)) (topicAreas[x.topic_id] ||= []).push(x.content_area_id); });
  const lastNote = {}; (notes || []).forEach(n => { if (n.topic_id && !lastNote[n.topic_id]) lastNote[n.topic_id] = n; });
  // group by primary content area (first linked, by area sort)
  const groups = new Map(); (areas || []).forEach(a => groups.set(a.id, [])); groups.set(0, []);
  topics.forEach(tp => { if (tp.archived && !showArchived) return; const first = (topicAreas[tp.topic_id] || []).sort((a, b) => (S.areas[a]?.code || "").localeCompare(S.areas[b]?.code || ""))[0]; groups.get(first || 0).push(tp); });
  const rows = [];
  if (sortMode === "week") {
    // chronological: autumn (vko 32–52) first, then spring (vko 1–31); ties by curriculum sequence
    const list = topics.filter(tp => !tp.archived || showArchived).sort((a, b) => syOrder(a.planned_week) - syOrder(b.planned_week) || a.seq - b.seq);
    let half = null;
    list.forEach(tp => {
      const h = tp.planned_week == null ? "none" : tp.planned_week >= 32 ? "autumn" : "spring";
      if (h !== half) { half = h; rows.push(`<tr class="area"><td colspan="8">${t("subj.term." + h)}</td></tr>`); }
      rows.push(topicRow(tp, topicAreas[tp.topic_id] || [], lastNote[tp.topic_id]));
    });
  } else {
    for (const [aid, list] of groups) {
      if (!list.length) continue;
      const a = S.areas[aid];
      rows.push(`<tr class="area"><td colspan="8">${a ? `${esc(a.code)} · ${esc(lang === "fi" ? a.name_fi : (a.name_en || a.name_fi))}` : t("area.other")}</td></tr>`);
      list.sort((a, b) => syOrder(a.planned_week) - syOrder(b.planned_week) || a.seq - b.seq).forEach(tp => rows.push(topicRow(tp, topicAreas[tp.topic_id] || [], lastNote[tp.topic_id])));
    }
  }
  $("#view").innerHTML = `
    <div class="plan-head"><h1>${esc(name(subj))}</h1><span class="meta">${esc(lang === "fi" ? subj.name_fi : subj.name_en)} · ${subj.hours_7_9 ? `${subj.hours_7_9} ${t("subj.hoursWeek")}` : ""}</span>
      <span class="sort-sw" style="margin-left:auto">${t("subj.sort")}: <button class="btn link ${sortMode === "week" ? "on" : ""}" data-sort="week">${t("subj.sortWeek")}</button><span class="muted">·</span><button class="btn link ${sortMode === "area" ? "on" : ""}" data-sort="area">${t("subj.sortArea")}</button></span>
      <label class="check"><input type="checkbox" id="arch" ${showArchived ? "checked" : ""}> ${t("subj.showArchived")}</label></div>
    <div class="legend"><span><i class="dot"></i>${t("status.none")}</span><span><i class="dot s-progress"></i>${t("status.progress")}</span><span><i class="dot s-done"></i>${t("status.done")}</span><span><i class="dot s-evidenced"></i>${t("status.evidenced")}</span><span><i class="dot s-attention"></i>${t("status.attention")}</span></div>
    <div class="tablewrap"><table class="smart"><thead><tr><th></th><th>${t("subj.topic")}</th><th>${t("subj.ops")}</th><th>${t("subj.materials")}</th><th>${t("subj.tests")}</th><th>${t("subj.evidence")}</th><th>${t("subj.week")}</th><th>${t("subj.notes")}</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
  $("#arch").onchange = e => { sessionStorage.setItem("ks_arch", e.target.checked ? "1" : "0"); renderSubject(subjectId); };
  $$("[data-sort]").forEach(b => b.onclick = () => { sessionStorage.setItem("ks_sort", b.dataset.sort); renderSubject(subjectId); });
  $$("tr.topic").forEach(tr => tr.onclick = () => location.hash = `#/subject/${subjectId}/topic/${tr.dataset.id}`);
}
function topicRow(tp, areaIds, note) {
  const codes = areaIds.map(id => `<span class="chip ops">${esc(S.areas[id]?.code || "")}</span>`).join("");
  const mats = tp.materials ? `<span class="chip ${tp.reviewed === tp.materials ? "ok" : tp.reviewed ? "warn" : ""}">${tp.reviewed}/${tp.materials}</span>` : `<span class="muted">—</span>`;
  const tests = tp.attempts ? `<span class="chip ${tp.passes ? "ok" : "bad"} num">${tp.best_pct}%</span><span class="muted num">×${tp.attempts}</span>` : `<span class="muted">—</span>`;
  const ev = tp.evidence ? `<span class="chip evid">${tp.evidence}</span>` : `<span class="muted">—</span>`;
  return `<tr class="topic ${tp.archived ? "archived" : ""}" data-id="${tp.topic_id}">
    <td class="status"><span class="stripe s-${tp.status}"></span></td>
    <td><span class="topic-title">${esc(name(tp))}<small lang="${lang === "fi" ? "en" : "fi"}">${esc(lang === "fi" ? tp.title_en : tp.title_fi)}</small></span>${tp.grade_flag ? `<span class="chip flag">${esc(tp.grade_flag)}</span>` : ""}</td>
    <td>${codes}</td><td>${mats}</td><td>${tests}</td><td>${ev}</td>
    <td class="num">${tp.planned_week ? (tp.planned_week < 32 ? `<span class="wk spring" title="${t("subj.term.spring")}">${tp.planned_week}</span>` : `<span class="wk">${tp.planned_week}</span>`) : ""}</td>
    <td class="note-cell">${note ? esc(note.body.slice(0, 90)) + (note.author_role === "teacher" ? ` <span class="chip warn">${t("note.teacher")}</span>` : "") : ""}</td></tr>`;
}

// ---------- OPS map (Tavoitekartta) ----------
// Turns the data inside out: objectives (T-codes) first, then the topics / tests / evidence that serve each one.
// Works for all roles; the teacher sees the same page read-only (RLS already limits evidence & notes to teacher_visible rows).
const scopeOk = (gs, grade) => { if (!gs) return true; const m = String(gs).match(/^(\d+)(?:-(\d+))?$/); if (!m) return true; const a = +m[1], b = m[2] ? +m[2] : a; return grade >= a && grade <= b; };
const objNum = c => +String(c || "").replace(/\D/g, "") || 0;
window.addEventListener("beforeprint", () => $$(".map-crit").forEach(d => d.open = true));

async function loadCoverage(subjectId) {
  const q = sb.from("ks_topic_status").select("topic_id,subject_id,seq,title_en,title_fi,assessment,planned_week,grade_flag,archived,attempts,passes,best_pct,evidence,minutes,status").eq("plan_id", S.plan.id).eq("archived", false);
  const { data: topics, error } = await (subjectId ? q.eq("subject_id", subjectId) : q); if (error) throw error;
  const ids = topics.map(x => x.topic_id);
  const oq = sb.from("ks_objectives").select("id,subject_id,code,text_fi,text_en,learning_goal_fi,criteria,transversal,grade_scope,sort").order("sort");
  const [{ data: objs }, { data: links }] = await Promise.all([subjectId ? oq.eq("subject_id", subjectId) : oq, ids.length ? sb.from("ks_topic_objectives").select("topic_id,objective_id").in("topic_id", ids) : { data: [] }]);
  const byTopic = Object.fromEntries(topics.map(x => [x.topic_id, x]));
  const served = {}; (links || []).forEach(l => { if (byTopic[l.topic_id]) (served[l.objective_id] ||= []).push(byTopic[l.topic_id]); });
  return { topics, objectives: (objs || []).filter(o => scopeOk(o.grade_scope, S.plan.grade)), served };
}
const objStat = (o, served) => { const list = (served[o.id] || []).sort((a, b) => a.seq - b.seq); const done = list.filter(x => x.status === "done" || x.status === "evidenced").length; const ev = list.reduce((a, x) => a + (x.evidence || 0), 0); return { list, done, ev, state: !list.length ? "uncovered" : done === list.length ? "done" : done || list.some(x => x.status === "progress" || x.status === "attention") ? "progress" : "planned" }; };

async function renderMapOverview() {
  crumbs([{ label: t("nav.home"), href: "#/" }, { label: t("nav.map") }]);
  let cov; try { cov = await loadCoverage(null); } catch (e) { return fail(e); }
  const rows = S.subjects.map(s => {
    const objs = cov.objectives.filter(o => o.subject_id === s.id); if (!objs.length) return "";
    const st = objs.map(o => objStat(o, cov.served));
    const covered = st.filter(x => x.list.length).length, done = st.filter(x => x.state === "done").length, partial = st.filter(x => x.state === "progress").length;
    const pct = Math.round(100 * covered / objs.length);
    return `<a class="map-row" href="#/map/${s.id}">
      <div class="map-name">${esc(name(s))}<small>${s.kind === "portfolio" ? t("subj.portfolio") : "OPS " + esc(s.code)} · ${objs.length} ${t("map.objectives")}</small></div>
      <div class="map-bar"><i class="c" style="width:${pct}%"></i><i class="d" style="width:${Math.round(100 * done / objs.length)}%"></i></div>
      <div class="map-nums"><span class="ok">${done} ${t("map.done")}</span><span class="warn">${partial} ${t("map.inProgress")}</span><span>${covered}/${objs.length} ${t("map.covered")}</span></div></a>`;
  }).join("");
  const all = cov.objectives.length, allCov = cov.objectives.filter(o => (cov.served[o.id] || []).length).length, allDone = cov.objectives.filter(o => objStat(o, cov.served).state === "done").length;
  $("#view").innerHTML = `
    <div class="plan-head"><h1>${t("map.title")}</h1><span class="meta">${esc(S.student?.first_name || "")} · ${S.plan.grade}. ${t("dash.plan")} · ${esc(S.plan.school_year)} · POPS 2014</span>
      <button class="btn small no-print" style="margin-left:auto" onclick="window.print()">${t("map.print")}</button></div>
    <p class="summary map-intro">${t("map.intro")}</p>
    <div class="map-total"><b>${allDone}</b> ${t("map.done")} · <b>${allCov - allDone}</b> ${t("map.inProgressOrPlanned")} · <b>${all - allCov}</b> ${t("map.uncoveredShort")} · ${all} ${t("map.objectives")}</div>
    <div class="map-list">${rows}</div>`;
}

async function renderMap(subjectId) {
  const subj = S.subjects.find(s => s.id === subjectId); if (!subj) return location.hash = "#/map";
  crumbs([{ label: t("nav.home"), href: "#/" }, { label: t("nav.map"), href: "#/map" }, { label: name(subj) }]);
  let cov; try { cov = await loadCoverage(subjectId); } catch (e) { return fail(e); }
  const [{ data: areas }, { data: ta }] = await Promise.all([
    sb.from("ks_content_areas").select("id,code,name_fi,name_en").eq("subject_id", subjectId).order("sort"),
    cov.topics.length ? sb.from("ks_topic_areas").select("topic_id,content_area_id").in("topic_id", cov.topics.map(x => x.topic_id)) : { data: [] }]);
  const areaCount = {}; (ta || []).forEach(x => areaCount[x.content_area_id] = (areaCount[x.content_area_id] || 0) + 1);
  const objs = cov.objectives.sort((a, b) => objNum(a.code) - objNum(b.code));
  const stats = objs.map(o => objStat(o, cov.served));
  const done = stats.filter(x => x.state === "done").length, covered = stats.filter(x => x.list.length).length;
  const topicLine = tp => `<li><a href="#/subject/${subjectId}/topic/${tp.topic_id}"><i class="dot s-${tp.status}"></i><span class="tt">${esc(name(tp))}</span></a>
      <span class="map-meta">${tp.attempts ? `<span class="chip ${tp.passes ? "ok" : "bad"} num">${tp.best_pct}%</span>` : tp.assessment === "test" ? `<span class="chip">${t("map.test")}</span>` : ""}${tp.evidence ? `<span class="chip evid">${tp.evidence} ${t("map.evidence")}</span>` : tp.assessment === "evidence" ? `<span class="chip">${t("map.evidenceDue")}</span>` : ""}${tp.planned_week ? `<span class="muted mono">${t("map.week")} ${tp.planned_week}</span>` : ""}${tp.grade_flag ? `<span class="chip flag">${esc(tp.grade_flag)}</span>` : ""}</span></li>`;
  const card = (o, st) => `<article class="map-obj ${st.state}">
      <header><span class="chip ops">${esc(o.code)}</span><span class="map-state ${st.state}">${t("map.state." + st.state)}${st.list.length ? ` · ${st.done}/${st.list.length}` : ""}</span>${o.grade_scope ? `<span class="chip">${t("map.gradeScope")} ${esc(o.grade_scope)}</span>` : ""}${(o.transversal || []).map(l => `<span class="chip">${esc(l)}</span>`).join("")}</header>
      <p class="map-text">${esc(lang === "en" && o.text_en ? o.text_en : o.text_fi)}</p>
      ${st.list.length ? `<ul class="map-topics">${[...st.list].sort((a, b) => syOrder(a.planned_week) - syOrder(b.planned_week) || a.seq - b.seq).map(topicLine).join("")}</ul>` : `<p class="muted small">${t("map.uncovered")}</p>`}
      ${(o.learning_goal_fi || (o.criteria || []).length) ? `<details class="map-crit"><summary>${t("map.criteria")}</summary>
        ${o.learning_goal_fi ? `<div class="crit"><b>${t("ops.goal")}</b> ${esc(o.learning_goal_fi)}</div>` : ""}
        ${(o.criteria || []).map(c => `<div class="crit"><b>${t("ops.grade")} ${c.grade}</b> ${esc(c.fi)}</div>`).join("")}</details>` : ""}
    </article>`;
  $("#view").innerHTML = `
    <div class="plan-head"><h1>${t("map.title")} · ${esc(name(subj))}</h1><span class="meta">${esc(lang === "fi" ? subj.name_fi : subj.name_en)} · ${esc(S.student?.first_name || "")} · ${S.plan.grade}. ${t("dash.plan")} · ${esc(S.plan.school_year)}</span>
      <span class="no-print" style="margin-left:auto;display:flex;gap:10px"><a class="btn small" href="#/subject/${subjectId}">${t("map.toSubject")}</a><button class="btn small" onclick="window.print()">${t("map.print")}</button></span></div>
    <div class="map-total"><b>${done}</b>/${objs.length} ${t("map.done")} · <b>${covered}</b>/${objs.length} ${t("map.covered")}${(areas || []).length ? ` · ${t("map.areas")}: ${(areas || []).map(a => `<span class="chip ops" title="${esc(lang === "fi" ? a.name_fi : (a.name_en || a.name_fi))}">${esc(a.code)} <span class="num">${areaCount[a.id] || 0}</span></span>`).join("")}` : ""}</div>
    <div class="legend"><span><i class="dot"></i>${t("status.none")}</span><span><i class="dot s-progress"></i>${t("status.progress")}</span><span><i class="dot s-done"></i>${t("status.done")}</span><span><i class="dot s-evidenced"></i>${t("status.evidenced")}</span><span><i class="dot s-attention"></i>${t("status.attention")}</span></div>
    <div class="map-grid">${objs.map((o, i) => card(o, stats[i])).join("")}</div>`;
}


// ---------- School-year report (Lukuvuosiraportti) ----------
// One printable page for the supervising teacher: per-subject summary, objective coverage, test results, evidence list,
// teacher comments, parent summary and signature lines. Client-side pivot over the same views as the map (RLS applies).
async function renderReport() {
  crumbs([{ label: t("nav.home"), href: "#/" }, { label: t("nav.report") }]);
  let cov; try { cov = await loadCoverage(null); } catch (e) { return fail(e); }
  const [{ data: prog }, { data: ev }, { data: tests }, { data: tnotes }, { data: teachers }] = await Promise.all([
    sb.from("ks_subject_progress").select("*").eq("plan_id", S.plan.id).order("sort"),
    sb.from("ks_evidence").select("subject_id,topic_id,kind,caption,recorded_on,teacher_visible").eq("plan_id", S.plan.id).order("recorded_on"),
    sb.from("ks_tests").select("id,topic_id,title,pass_pct,ks_quizzes(code,title_en,title_fi),ks_test_attempts(percentage,taken_at)").eq("family_id", S.family.id),
    sb.from("ks_notes").select("subject_id,topic_id,body,created_at").eq("plan_id", S.plan.id).eq("author_role", "teacher").order("created_at"),
    S.teacher ? { data: [{ teacher_name: S.profile.display_name }] } : sb.from("ks_teacher_invites").select("teacher_name,email").eq("family_id", S.family.id).not("accepted_at", "is", null)]);
  const topicById = Object.fromEntries(cov.topics.map(x => [x.topic_id, x]));
  const subjName = id => name(S.subjects.find(s => s.id === id) || {});
  const objBySubj = {}; cov.objectives.forEach(o => { const st = objStat(o, cov.served); const b = (objBySubj[o.subject_id] ||= { all: 0, cov: 0, done: 0 }); b.all++; if (st.list.length) b.cov++; if (st.state === "done") b.done++; });
  const testRows = (tests || []).map(x => { const at = (x.ks_test_attempts || []).sort((a, b) => a.taken_at.localeCompare(b.taken_at)); if (!at.length) return null; const tp = topicById[x.topic_id]; if (!tp) return null; return { subject_id: tp.subject_id, seq: tp.seq, topic: name(tp), title: x.ks_quizzes ? `${x.ks_quizzes.code} · ${name(x.ks_quizzes)}` : x.title, best: Math.max(...at.map(a => a.percentage)), n: at.length, last: at[at.length - 1].taken_at, pass: x.pass_pct || S.plan.pass_pct }; }).filter(Boolean);
  const testsBySubj = {}; testRows.forEach(r => { const b = (testsBySubj[r.subject_id] ||= { taken: 0, passed: 0 }); b.taken++; if (r.best >= r.pass) b.passed++; });
  const evBySubj = {}; (ev || []).forEach(e => evBySubj[e.subject_id] = (evBySubj[e.subject_id] || 0) + 1);
  const h = m => (Math.round((m || 0) / 6) / 10).toLocaleString(lang === "fi" ? "fi-FI" : "en-GB");
  const tot = { topics: 0, done: 0, taken: 0, passed: 0, ev: 0, min: 0, oAll: 0, oCov: 0, oDone: 0 };
  const rows = (prog || []).map(r => { const o = objBySubj[r.subject_id] || { all: 0, cov: 0, done: 0 }, ts = testsBySubj[r.subject_id] || { taken: 0, passed: 0 }, e = evBySubj[r.subject_id] || 0;
    tot.topics += r.topics; tot.done += r.done; tot.taken += ts.taken; tot.passed += ts.passed; tot.ev += e; tot.min += r.minutes || 0; tot.oAll += o.all; tot.oCov += o.cov; tot.oDone += o.done;
    return `<tr><td>${esc(name(r))}<small class="muted"> ${r.kind === "portfolio" ? t("subj.portfolio") : esc(r.code)}</small></td><td class="num">${r.done}/${r.topics}</td><td class="num">${ts.taken ? `${ts.passed}/${ts.taken}` : "—"}</td><td class="num">${e || "—"}</td><td class="num">${r.minutes ? h(r.minutes) + " " + t("report.hoursUnit") : "—"}</td><td class="num">${o.all ? `${o.done} / ${o.cov} / ${o.all}` : "—"}</td></tr>`; }).join("");
  const evRows = (ev || []).map(e => { const tp = topicById[e.topic_id]; return `<tr><td class="mono">${fmtDate(e.recorded_on)}</td><td>${esc(subjName(e.subject_id))}</td><td>${esc(tp ? name(tp) : "")}</td><td>${esc(kindLabel(e.kind))}</td><td>${esc(e.caption)}${e.teacher_visible ? "" : ` <span class="chip">${t("note.private")}</span>`}</td></tr>`; }).join("");
  const trRows = testRows.sort((a, b) => a.subject_id - b.subject_id || a.seq - b.seq).map(r => `<tr><td>${esc(subjName(r.subject_id))}</td><td>${esc(r.topic)}<small class="muted"> ${esc(r.title)}</small></td><td class="num"><span class="chip ${r.best >= r.pass ? "ok" : "bad"} num">${r.best} %</span></td><td class="num">${r.n}</td><td class="mono">${fmtDate(r.last)}</td></tr>`).join("");
  const noteRows = (tnotes || []).map(n => { const tp = topicById[n.topic_id]; return `<li><span class="muted mono">${fmtDate(n.created_at)}</span> ${tp ? `<b>${esc(subjName(n.subject_id))} · ${esc(name(tp))}</b> — ` : ""}${esc(n.body)}</li>`; }).join("");
  const draftKey = `ks_report_${S.plan.id}`; let draft = ""; try { draft = localStorage.getItem(draftKey) || ""; } catch (e) {}
  $("#view").innerHTML = `
    <div class="plan-head"><h1>${t("report.title")}</h1><span class="meta">${esc(S.student?.first_name || "")} · ${S.plan.grade}. ${t("dash.plan")} · ${esc(S.plan.school_year)} · POPS 2014</span>
      <button class="btn small no-print" style="margin-left:auto" onclick="window.print()">${t("map.print")}</button></div>
    <p class="summary map-intro no-print">${t("report.intro")}</p>
    <div class="report">
      <dl class="report-head">
        <div><dt>${t("report.student")}</dt><dd>${esc(S.student?.first_name || "")} · ${S.plan.grade}. ${t("dash.plan")} · ${t("dash.year")} ${esc(S.plan.school_year)}</dd></div>
        <div><dt>${t("report.family")}</dt><dd>${esc(S.family?.name || "")}</dd></div>
        <div><dt>${t("report.municipality")}</dt><dd>${esc(S.family?.municipality || "—")}</dd></div>
        <div><dt>${t("report.teacher")}</dt><dd>${esc((teachers || []).map(x => x.teacher_name || x.email).filter(Boolean).join(", ") || "—")}</dd></div>
        <div><dt>${t("report.generated")}</dt><dd>${fmtDate(new Date())}</dd></div>
      </dl>
      <p class="muted small">${t("report.basis")}</p>
      <h2>${t("report.summary")}</h2>
      <div class="tablewrap"><table class="report-table"><thead><tr><th>${t("report.subject")}</th><th class="num">${t("report.topics")} ${t("report.done")}</th><th class="num">${t("report.tests")}</th><th class="num">${t("report.evidence")}</th><th class="num">${t("report.hours")}</th><th class="num">${t("report.objectives")}</th></tr></thead>
        <tbody>${rows}</tbody><tfoot><tr><td>${t("report.total")}</td><td class="num">${tot.done}/${tot.topics}</td><td class="num">${tot.taken ? `${tot.passed}/${tot.taken}` : "—"}</td><td class="num">${tot.ev || "—"}</td><td class="num">${h(tot.min)} ${t("report.hoursUnit")}</td><td class="num">${tot.oDone} / ${tot.oCov} / ${tot.oAll}</td></tr></tfoot></table></div>
      <h2>${t("report.testsTitle")}</h2>
      ${trRows ? `<div class="tablewrap"><table class="report-table"><thead><tr><th>${t("report.subject")}</th><th>${t("report.test")}</th><th class="num">${t("report.best")}</th><th class="num">${t("report.attempts")}</th><th>${t("report.last")}</th></tr></thead><tbody>${trRows}</tbody></table></div>` : `<p class="muted">${t("report.noTests")}</p>`}
      <h2>${t("report.evidenceTitle")}</h2>
      ${evRows ? `<div class="tablewrap"><table class="report-table"><thead><tr><th>${t("report.date")}</th><th>${t("report.subject")}</th><th>${t("report.topic")}</th><th>${t("report.kind")}</th><th>${t("report.caption")}</th></tr></thead><tbody>${evRows}</tbody></table></div><p class="muted small">${t("report.evidenceNote")}</p>` : `<p class="muted">${t("report.noEvidence")}</p>`}
      ${noteRows ? `<h2>${t("report.notesTitle")}</h2><ul class="report-notes">${noteRows}</ul>` : ""}
      <h2>${t("report.parentTitle")}</h2>
      <p class="muted small no-print">${t("report.parentHint")}</p>
      <div id="report-parent" class="report-parent" contenteditable="${isFamily() ? "true" : "false"}">${esc(draft)}</div>
      <div class="report-sign"><div><span>${t("report.sign.parent")}</span><i></i><small>${t("report.sign.date")}</small></div><div><span>${t("report.sign.teacher")}</span><i></i><small>${t("report.sign.date")}</small></div></div>
    </div>`;
  $("#report-parent").oninput = e => { try { localStorage.setItem(draftKey, e.target.innerText); } catch (err) {} };
}

// ---------- quiz player ----------
async function renderQuiz(testId) {
  const { data: test, error } = await sb.from("ks_tests").select("*, ks_quizzes(*, ks_quiz_questions(*)), ks_topics(title_en,title_fi,subject_id)").eq("id", testId).single();
  if (error || !test?.ks_quizzes) return fail(error || new Error("No quiz"));
  const quiz = test.ks_quizzes, qs = (quiz.ks_quiz_questions || []).sort((a, b) => a.seq - b.seq);
  const subj = S.subjects.find(s => s.id === test.ks_topics.subject_id);
  crumbs([{ label: t("nav.home"), href: "#/" }, { label: name(subj), href: "#/subject/" + subj.id }, { label: name(test.ks_topics), href: `#/subject/${subj.id}/topic/${test.topic_id}` }, { label: quiz.code }]);
  const prompt = q => lang === "fi" && q.prompt_fi ? `${esc(q.prompt_fi)}<small>${esc(q.prompt_en)}</small>` : `${esc(q.prompt_en)}${q.prompt_fi ? `<small lang="fi">${esc(q.prompt_fi)}</small>` : ""}`;
  const opts = q => (lang === "fi" && q.options_fi) ? q.options_fi : q.options;
  $("#view").innerHTML = `
    <div class="plan-head"><h1>${esc(quiz.code)} · ${esc(name(quiz))}</h1><span class="meta">${qs.length} ${t("quiz.questions")} · ${t("quiz.pass")} ${test.pass_pct || quiz.pass_pct || S.plan.pass_pct} %${quiz.criteria_grade ? ` · ${t("ops.grade")} ${quiz.criteria_grade}` : ""}</span></div>
    ${quiz.intro_en ? `<p class="summary">${esc(lang === "fi" && quiz.intro_fi ? quiz.intro_fi : quiz.intro_en)}</p>` : ""}
    <form id="quiz-form" class="quiz">
      ${qs.map((q, i) => `<fieldset class="q" data-id="${q.id}" data-kind="${q.kind}"><legend><span class="num">${i + 1}.</span> ${prompt(q)}</legend>
        ${q.kind === "mc" ? opts(q).map((o, j) => `<label class="opt"><input type="radio" name="q${i}" value="${j}"> <span>${esc(o)}</span></label>`).join("") : ""}
        ${q.kind === "multi" ? opts(q).map((o, j) => `<label class="opt"><input type="checkbox" name="q${i}" value="${j}"> <span>${esc(o)}</span></label>`).join("") : ""}
        ${q.kind === "numeric" ? `<input type="text" inputmode="decimal" name="q${i}" class="ans" autocomplete="off">` : ""}
        ${q.kind === "short" ? `<input type="text" name="q${i}" class="ans" autocomplete="off">` : ""}
        <div class="feedback" hidden></div></fieldset>`).join("")}
      <div class="row"><button class="btn primary" type="submit">${t("quiz.submit")}</button><a class="btn" href="#/subject/${subj.id}/topic/${test.topic_id}">${t("btn.cancel")}</a></div>
    </form>
    <div id="quiz-result" class="result" hidden></div>`;
  $("#quiz-form").onsubmit = async e => {
    e.preventDefault();
    const answers = {};
    $$("fieldset.q").forEach(fs => {
      const kind = fs.dataset.kind, id = fs.dataset.id;
      if (kind === "mc") { const c = $("input:checked", fs); if (c) answers[id] = +c.value; }
      else if (kind === "multi") { answers[id] = $$("input:checked", fs).map(x => +x.value); }
      else { const v = $("input", fs).value.trim().replace(",", "."); if (v !== "") answers[id] = kind === "numeric" ? (isNaN(+v) ? v : +v) : v; }
    });
    const { data, error } = await sb.rpc("ks_submit_quiz", { p_test: testId, p_answers: answers });
    if (error) return fail(error);
    const pass = data.percentage >= data.pass_pct;
    $("#quiz-result").hidden = false;
    $("#quiz-result").innerHTML = `<div class="score ${pass ? "ok" : "bad"}"><b>${data.score}/${data.total}</b> · ${data.percentage} % · ${pass ? t("quiz.passed") : t("quiz.failed")}</div>
      <div class="row"><a class="btn primary" href="#/subject/${subj.id}/topic/${test.topic_id}">${t("quiz.back")}</a><button class="btn" type="button" onclick="location.reload()">${t("quiz.retry")}</button></div>`;
    data.items.forEach(it => { const fs = $(`fieldset.q[data-id="${it.question_id}"]`); if (!fs) return; fs.classList.add(it.correct ? "correct" : "wrong");
      const fb = $(".feedback", fs); fb.hidden = false;
      const ans = typeof it.answer === "object" && it.answer !== null && !Array.isArray(it.answer) ? it.answer.value : Array.isArray(it.answer) ? (fs.dataset.kind === "multi" ? it.answer.map(j => opts(qs.find(q => q.id === it.question_id))[j]).join(", ") : it.answer[0]) : (fs.dataset.kind === "mc" ? opts(qs.find(q => q.id === it.question_id))[it.answer] : it.answer);
      fb.innerHTML = `${it.correct ? "✓" : "✗"} ${it.correct ? "" : `<b>${t("quiz.answer")}:</b> ${esc(ans)} · `}${esc(lang === "fi" && it.explanation_fi ? it.explanation_fi : (it.explanation_en || ""))}`;
      $$("input", fs).forEach(i => i.disabled = true); });
    $("#quiz-form button[type=submit]").hidden = true; $("#quiz-result").scrollIntoView({ behavior: "smooth" });
  };
}

// ---------- drawer ----------
let D = null; // current topic
async function openDrawer(topicId) {
  const tp = S.topics.find(x => x.topic_id === topicId); if (!tp) return;
  D = tp;
  const subj = S.subjects.find(s => s.id === tp.subject_id);
  $("#d-subject").textContent = name(subj); $("#d-title").textContent = name(tp); $("#d-summary").textContent = ""; $("#d-summary2").hidden = true;
  $("#drawer").hidden = false; $("#scrim").hidden = false;
  $("#d-close").onclick = $("#scrim").onclick = () => location.hash = `#/subject/${tp.subject_id}`;
  const [{ data: full }, { data: objs }, { data: areas }] = await Promise.all([
    sb.from("ks_topics").select("summary,summary_fi,planned_week,local_ops_confirmed,archived").eq("id", topicId).single(),
    sb.from("ks_topic_objectives").select("objective_id, ks_objectives(code,text_fi,text_en,learning_goal_fi,criteria)").eq("topic_id", topicId),
    sb.from("ks_topic_areas").select("content_area_id").eq("topic_id", topicId)
  ]);
  const sFi = full?.summary_fi || "", sEn = full?.summary || "";
  $("#d-summary").textContent = lang === "fi" ? (sFi || sEn) : (sEn || sFi);
  const s2 = $("#d-summary2"); s2.hidden = !(sFi && sEn); s2.textContent = lang === "fi" ? sEn : sFi; s2.lang = lang === "fi" ? "en" : "fi";
  $("#d-codes").innerHTML = (areas || []).map(a => `<span class="chip ops">${esc(S.areas[a.content_area_id]?.code || "")}</span>`).join("") + (objs || []).map(o => `<span class="chip ops">${esc(o.ks_objectives.code)}</span>`).join("");
  $("#d-ops-body").innerHTML = (objs || []).sort((a, b) => +a.ks_objectives.code.slice(1) - +b.ks_objectives.code.slice(1)).map(o => { const x = o.ks_objectives; return `<div class="obj"><b>${esc(x.code)}</b> ${esc(lang === "en" && x.text_en ? x.text_en : x.text_fi)}
      ${x.learning_goal_fi ? `<div class="crit"><b>${t("ops.goal")}</b> ${esc(x.learning_goal_fi)}</div>` : ""}
      ${(x.criteria || []).length ? `<div class="crit"><b>${t("ops.criteria")}</b> ${x.criteria.map(c => `<div><b>${t("ops.grade")} ${c.grade}</b> ${esc(c.fi)}</div>`).join("")}</div>` : ""}</div>`; }).join("");
  const pf = $("#f-plan"); pf.planned_week.value = full?.planned_week || ""; pf.local_ops_confirmed.checked = !!full?.local_ops_confirmed; pf.archived.checked = !!full?.archived;
  $("#f-log").logged_on.value = new Date().toISOString().slice(0, 10);
  await Promise.all([loadMaterials(), loadTests(), loadEvidence(), loadNotes(), loadMinutes()]);
}
function closeDrawer() { $("#drawer").hidden = true; $("#scrim").hidden = true; D = null; }
const refresh = async () => { const m = location.hash.match(/^#\/subject\/(\d+)/); if (m) await renderSubject(+m[1]); };

async function loadMaterials() {
  const { data } = await sb.from("ks_materials").select("*").eq("topic_id", D.topic_id).order("sort").order("created_at");
  $("#d-materials").innerHTML = (data || []).map(m => `<li><span class="chip ${m.status === "reviewed" ? "ok" : m.status === "open" ? "warn" : ""}">${t("mat." + m.status)}</span>
    <span class="grow">${m.url ? `<a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.title)}</a>` : esc(m.title)} <span class="muted">· ${esc(kindLabel(m.kind))}</span></span>
    ${isFamily() && m.status !== "reviewed" ? `<button class="btn small" data-rev="${m.id}">${t("mat.markReviewed")}</button>` : ""}
    ${isFamily() ? `<button class="btn link danger small" data-del-mat="${m.id}">×</button>` : ""}</li>`).join("") || `<li class="muted">—</li>`;
  $$("[data-rev]").forEach(b => b.onclick = async () => { const { error } = await sb.from("ks_materials").update({ status: "reviewed", reviewed_at: new Date().toISOString(), reviewed_by: S.user.id }).eq("id", b.dataset.rev); error ? fail(error) : (await loadMaterials(), refresh()); });
  $$("[data-del-mat]").forEach(b => b.onclick = async () => { await sb.from("ks_materials").delete().eq("id", b.dataset.delMat); loadMaterials(); refresh(); });
}
$("#f-material").onsubmit = async e => {
  e.preventDefault(); const f = new FormData(e.target);
  const { error } = await sb.from("ks_materials").insert({ family_id: S.family.id, topic_id: D.topic_id, title: f.get("title"), url: f.get("url") || null, kind: f.get("kind"), status: f.get("url") ? "open" : "queued" });
  if (error) return fail(error); e.target.reset(); toast(t("toast.saved")); loadMaterials(); refresh();
};

async function loadTests() {
  const { data } = await sb.from("ks_tests").select("*, ks_quizzes(code,title_en,title_fi,criteria_grade), ks_test_attempts(percentage,score,total,taken_at,source)").eq("topic_id", D.topic_id).order("created_at");
  // quiz picker: global quizzes for this topic's template + family quizzes
  const { data: tpl } = await sb.from("ks_topics").select("template_id").eq("id", D.topic_id).single();
  const { data: quizzes } = await sb.from("ks_quizzes").select("id,code,title_en,title_fi,template_id,family_id").or(`template_id.eq.${tpl?.template_id || 0},family_id.eq.${S.family.id}`).order("code");
  const sel = $("#f-test [name=quiz_uuid]"); sel.innerHTML = `<option value="">${t("test.noQuiz")}</option>` + (quizzes || []).map(q => `<option value="${q.id}">${esc(q.code || "")} ${esc(name(q))}</option>`).join("");
  $("#d-tests").innerHTML = (data || []).map(x => { const at = (x.ks_test_attempts || []).sort((a, b) => b.taken_at.localeCompare(a.taken_at)); const best = at.length ? Math.max(...at.map(a => a.percentage)) : null; const pass = x.pass_pct || S.plan.pass_pct;
    return `<li><span class="grow">${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a>` : esc(x.title)} ${x.ks_quizzes ? `<span class="muted mono">${esc(x.ks_quizzes.code)}</span>` : ""}</span>
      ${x.quiz_uuid && isFamily() ? `<a class="btn small primary" href="#/quiz/${x.id}">${t("test.take")}</a>` : ""}
      ${best !== null ? `<span class="chip ${best >= pass ? "ok" : "bad"} num">${t("test.best")} ${best}%</span><span class="muted num">${at.length} ${t("test.attempts")}</span>` : `<span class="muted">—</span>`}
      ${isFamily() ? `<button class="btn small" data-att="${x.id}">${t("test.logAttempt")}</button><button class="btn link danger small" data-del-test="${x.id}">×</button>` : ""}</li>`; }).join("") || `<li class="muted">—</li>`;
  $$("[data-att]").forEach(b => b.onclick = async () => { const v = prompt(t("test.logAttempt") + " (%)"); if (v === null) return; const pct = parseInt(v, 10); if (isNaN(pct)) return;
    const { error } = await sb.from("ks_test_attempts").insert({ family_id: S.family.id, test_id: b.dataset.att, percentage: pct, source: "manual" }); error ? fail(error) : (loadTests(), refresh()); });
  $$("[data-del-test]").forEach(b => b.onclick = async () => { await sb.from("ks_tests").delete().eq("id", b.dataset.delTest); loadTests(); refresh(); });
}
$("#f-test").onsubmit = async e => {
  e.preventDefault(); const f = new FormData(e.target);
  const quiz_uuid = f.get("quiz_uuid") || null; const chosen = quiz_uuid ? $(`#f-test [name=quiz_uuid] option[value="${quiz_uuid}"]`).textContent.trim() : null;
  const { error } = await sb.from("ks_tests").insert({ family_id: S.family.id, topic_id: D.topic_id, title: f.get("title") || chosen || "Test", quiz_uuid, url: f.get("url") || null });
  if (error) return fail(error); e.target.reset(); toast(t("toast.saved")); loadTests(); refresh();
};

async function loadEvidence() {
  const { data } = await sb.from("ks_evidence").select("*").eq("topic_id", D.topic_id).order("recorded_on", { ascending: false });
  const items = await Promise.all((data || []).map(async ev => { let href = ev.url; if (ev.storage_path) { const { data: s } = await sb.storage.from("ks-evidence").createSignedUrl(ev.storage_path, 3600); href = s?.signedUrl; }
    return `<li><span class="chip evid">${esc(kindLabel(ev.kind))}</span><span class="grow">${href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(ev.caption)}</a>` : esc(ev.caption)} <span class="muted mono">${fmtDate(ev.recorded_on)}</span>${ev.teacher_visible ? "" : ` <span class="chip">${t("note.private")}</span>`}</span>${isFamily() ? `<button class="btn link danger small" data-del-ev="${ev.id}">×</button>` : ""}</li>`; }));
  $("#d-evidence").innerHTML = items.join("") || `<li class="muted">—</li>`;
  $$("[data-del-ev]").forEach(b => b.onclick = async () => { await sb.from("ks_evidence").delete().eq("id", b.dataset.delEv); loadEvidence(); refresh(); });
}
$("#f-evidence").onsubmit = async e => {
  e.preventDefault(); const f = new FormData(e.target); const file = f.get("file"); let storage_path = null;
  try {
    if (file && file.size) { storage_path = `${S.family.id}/${S.plan.id}/${crypto.randomUUID()}-${file.name.replace(/[^\w.\-]+/g, "_")}`; const { error } = await sb.storage.from("ks-evidence").upload(storage_path, file); if (error) throw error; }
    const { error } = await sb.from("ks_evidence").insert({ family_id: S.family.id, plan_id: S.plan.id, topic_id: D.topic_id, subject_id: D.subject_id, kind: f.get("kind"), storage_path, url: f.get("url") || null, caption: f.get("caption"), created_by: S.user.id });
    if (error) throw error; e.target.reset(); toast(t("toast.saved")); loadEvidence(); refresh();
  } catch (err) { fail(err); }
};

async function loadNotes() {
  const { data } = await sb.from("ks_notes").select("*").eq("topic_id", D.topic_id).order("created_at", { ascending: false });
  $("#d-notes").innerHTML = (data || []).map(n => `<li class="${n.author_role}">${esc(n.body)}<div class="meta">${t("role." + n.author_role)} · ${new Date(n.created_at).toLocaleDateString(lang === "fi" ? "fi-FI" : "en-GB")}${n.teacher_visible ? "" : " · " + t("note.private")}${n.author_id === S.user.id ? ` · <button class="btn link danger small" data-del-note="${n.id}">${t("btn.delete")}</button>` : ""}</div></li>`).join("") || `<li class="muted">—</li>`;
  $$("[data-del-note]").forEach(b => b.onclick = async () => { await sb.from("ks_notes").delete().eq("id", b.dataset.delNote); loadNotes(); refresh(); });
}
$("#f-note").onsubmit = async e => {
  e.preventDefault(); const f = new FormData(e.target);
  const { error } = await sb.from("ks_notes").insert({ family_id: S.family.id, plan_id: S.plan.id, topic_id: D.topic_id, subject_id: D.subject_id, author_id: S.user.id, author_role: S.profile.role, body: f.get("body"), teacher_visible: S.teacher ? true : !!f.get("teacher_visible") });
  if (error) return fail(error); e.target.reset(); $("#f-note [name=teacher_visible]").checked = true; toast(t("toast.saved")); loadNotes(); refresh();
};

async function loadMinutes() {
  const { data } = await sb.from("ks_study_log").select("minutes").eq("topic_id", D.topic_id);
  const total = (data || []).reduce((a, r) => a + r.minutes, 0); $("#d-minutes").textContent = `${t("log.total")}: ${total} min`;
}
$("#f-log").onsubmit = async e => {
  e.preventDefault(); const f = new FormData(e.target);
  const { error } = await sb.from("ks_study_log").insert({ family_id: S.family.id, plan_id: S.plan.id, topic_id: D.topic_id, subject_id: D.subject_id, minutes: +f.get("minutes"), logged_on: f.get("logged_on") || undefined, by_user: S.user.id });
  if (error) return fail(error); toast(t("toast.saved")); loadMinutes(); refresh();
};
$("#f-plan").onsubmit = async e => {
  e.preventDefault(); const f = e.target;
  const { error } = await sb.from("ks_topics").update({ planned_week: f.planned_week.value ? +f.planned_week.value : null, local_ops_confirmed: f.local_ops_confirmed.checked, archived: f.archived.checked }).eq("id", D.topic_id);
  if (error) return fail(error); toast(t("toast.saved")); refresh();
};

boot();
})();

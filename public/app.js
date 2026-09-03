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
  $("#lang-toggle").textContent = lang === "fi" ? "EN" : "FI";
}
function setLang(l) { lang = l; localStorage.setItem("ks_lang", l); applyLang(); if (S.plan) render(); }
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
    // teacher invited by e-mail? then create a teacher profile; otherwise ask for a join code
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
    ${week && week.length ? `<div class="section-title"><h2>${t("dash.week")}</h2><span class="muted mono">vko ${wk}</span></div>
      <ul class="week-list">${week.map(w => `<li onclick="location.hash='#/subject/${w.subject_id}/topic/${w.topic_id}'"><i class="dot s-${w.status}"></i>${esc(name(w))}<span class="muted">· ${esc(name(S.subjects.find(s => s.id === w.subject_id) || {}))}</span></li>`).join("")}</ul>` : ""}`;
  $$(".tile").forEach(el => el.onclick = () => location.hash = "#/subject/" + el.dataset.id);
}
function tile(r) {
  const worst = r.attention ? "s-attention" : r.in_progress ? "s-progress" : r.done ? "s-done" : "";
  return `<button class="tile" data-id="${r.subject_id}">
    <div class="name">${esc(name(r))}</div>
    <div class="sub">${r.kind === "portfolio" ? "portfolio" : "OPS " + esc(r.code)}</div>
    <div class="bar"><i style="width:${r.pct || 0}%"></i></div>
    <div class="nums"><span>${r.done}/${r.topics} ${t("dash.done")}</span>${r.attention ? `<span class="att">${r.attention} ${t("dash.attention")}</span>` : ""}${r.minutes ? `<span>${r.minutes} min</span>` : ""}</div></button>`;
}
function isoWeek(d) { const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const day = x.getUTCDay() || 7; x.setUTCDate(x.getUTCDate() + 4 - day); const y0 = new Date(Date.UTC(x.getUTCFullYear(), 0, 1)); return Math.ceil((((x - y0) / 864e5) + 1) / 7); }

// ---------- subject ----------
async function renderSubject(subjectId) {
  const subj = S.subjects.find(s => s.id === subjectId); if (!subj) return location.hash = "";
  crumbs([{ label: t("nav.home"), href: "#/" }, { label: name(subj) }]);
  const showArchived = sessionStorage.getItem("ks_arch") === "1";
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
  for (const [aid, list] of groups) {
    if (!list.length) continue;
    const a = S.areas[aid];
    rows.push(`<tr class="area"><td colspan="8">${a ? `${esc(a.code)} · ${esc(lang === "fi" ? a.name_fi : (a.name_en || a.name_fi))}` : t("area.other")}</td></tr>`);
    list.forEach(tp => rows.push(topicRow(tp, topicAreas[tp.topic_id] || [], lastNote[tp.topic_id])));
  }
  $("#view").innerHTML = `
    <div class="plan-head"><h1>${esc(name(subj))}</h1><span class="meta">${esc(lang === "fi" ? subj.name_fi : subj.name_en)} · ${subj.hours_7_9 || ""} h/vko 7–9</span>
      <label class="check" style="margin-left:auto"><input type="checkbox" id="arch" ${showArchived ? "checked" : ""}> ${t("subj.showArchived")}</label></div>
    <div class="legend"><span><i class="dot"></i>${t("status.none")}</span><span><i class="dot s-progress"></i>${t("status.progress")}</span><span><i class="dot s-done"></i>${t("status.done")}</span><span><i class="dot s-evidenced"></i>${t("status.evidenced")}</span><span><i class="dot s-attention"></i>${t("status.attention")}</span></div>
    <div class="tablewrap"><table class="smart"><thead><tr><th></th><th>${t("subj.topic")}</th><th>${t("subj.ops")}</th><th>${t("subj.materials")}</th><th>${t("subj.tests")}</th><th>${t("subj.evidence")}</th><th>${t("subj.week")}</th><th>${t("subj.notes")}</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
  $("#arch").onchange = e => { sessionStorage.setItem("ks_arch", e.target.checked ? "1" : "0"); renderSubject(subjectId); };
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
    <td class="num">${tp.planned_week || ""}</td>
    <td class="note-cell">${note ? esc(note.body.slice(0, 90)) + (note.author_role === "teacher" ? ` <span class="chip warn">${t("note.teacher")}</span>` : "") : ""}</td></tr>`;
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
      fb.innerHTML = `${it.correct ? "✓" : "✗"} ${it.correct ? "" : `<b>${t("quiz.answer")}:</b> ${esc(ans)} · `}${esc(it.explanation_en || "")}`;
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
  $("#d-subject").textContent = name(subj); $("#d-title").textContent = name(tp); $("#d-summary").textContent = tp.summary || "";
  $("#drawer").hidden = false; $("#scrim").hidden = false;
  $("#d-close").onclick = $("#scrim").onclick = () => location.hash = `#/subject/${tp.subject_id}`;
  const [{ data: full }, { data: objs }, { data: areas }] = await Promise.all([
    sb.from("ks_topics").select("summary,planned_week,local_ops_confirmed,archived").eq("id", topicId).single(),
    sb.from("ks_topic_objectives").select("objective_id, ks_objectives(code,text_fi,text_en,learning_goal_fi,criteria)").eq("topic_id", topicId),
    sb.from("ks_topic_areas").select("content_area_id").eq("topic_id", topicId)
  ]);
  $("#d-summary").textContent = full?.summary || "";
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
    <span class="grow">${m.url ? `<a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.title)}</a>` : esc(m.title)} <span class="muted">· ${esc(m.kind)}</span></span>
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
    return `<li><span class="chip evid">${esc(ev.kind)}</span><span class="grow">${href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(ev.caption)}</a>` : esc(ev.caption)} <span class="muted mono">${esc(ev.recorded_on)}</span>${ev.teacher_visible ? "" : ` <span class="chip">${t("note.private")}</span>`}</span>${isFamily() ? `<button class="btn link danger small" data-del-ev="${ev.id}">×</button>` : ""}</li>`; }));
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

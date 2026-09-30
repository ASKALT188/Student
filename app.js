/* =====================================================================
   منصة استئذان الطلاب — نسخة مستقلة (HTML/CSS/JS + Supabase)
   =====================================================================
   خطوات التشغيل:
   1) أنشئ مشروعاً على https://supabase.com
   2) من Project Settings > API انسخ Project URL و anon public key
      والصقهما في SUPABASE_URL و SUPABASE_ANON_KEY بالأسفل.
   3) من SQL Editor نفّذ سكربت الإنشاء الموجود في التعليق أدناه.
   4) استضف المجلد standalone/ على أي استضافة ثابتة.

   ---- سكربت قاعدة البيانات (انسخه كاملاً في SQL Editor) ----
   create table if not exists classes (
     id uuid primary key default gen_random_uuid(),
     name text not null, grade text not null, section text not null,
     created_at timestamptz default now()
   );
   create table if not exists students (
     id uuid primary key default gen_random_uuid(),
     full_name text not null, student_id text,
     class_id uuid references classes(id) on delete set null,
     total_passes int default 0, created_at timestamptz default now()
   );
   create table if not exists pass_logs (
     id uuid primary key default gen_random_uuid(),
     student_id uuid references students(id) on delete cascade,
     student_name text, class_id uuid,
     time_out timestamptz not null default now(), time_in timestamptz,
     duration_minutes int default 0, reason text, status text default 'active',
     notes text, created_at timestamptz default now()
   );
   create table if not exists staff (
     id uuid primary key default gen_random_uuid(),
     email text unique not null, role text default 'teacher',
     created_at timestamptz default now()
   );
   create table if not exists settings (
     key text primary key, value text
   );
   insert into settings(key,value) values ('maxActivePasses','1')
     on conflict (key) do nothing;

   alter table classes enable row level security;
   alter table students enable row level security;
   alter table pass_logs enable row level security;
   alter table staff enable row level security;
   alter table settings enable row level security;
   create policy "auth all classes"   on classes   for all to authenticated using (true) with check (true);
   create policy "auth all students"  on students  for all to authenticated using (true) with check (true);
   create policy "auth all passes"    on pass_logs for all to authenticated using (true) with check (true);
   create policy "auth all staff"     on staff     for all to authenticated using (true) with check (true);
   create policy "auth all settings"  on settings  for all to authenticated using (true) with check (true);

   alter publication supabase_realtime add table pass_logs;
   ===================================================================== */

const SUPABASE_URL = "https://YOUR-PROJECT.supabase.co";
const SUPABASE_ANON_KEY = "YOUR-ANON-KEY";

const sb = (window.supabase || window.supabaseJs).createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const REASONS = ["دورة المياه", "العيادة المدرسية", "المرشد الطلابي", "الإدارة", "شرب ماء", "أخرى"];
const STATUS = { active: "غائب حالياً", returned: "عاد للفصل", overdue: "تجاوز الوقت" };
const OVERDUE_MIN = 5;
const PIE_COLORS = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#06b6d4", "#a855f7"];

const state = { user: null, role: "viewer", maxActive: 1, classes: [], students: [], activePasses: [], recent: [] };
const app = document.getElementById("app");

/* ---------- helpers ---------- */
const $ = (s, p = document) => p.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const isEditor = () => state.role === "admin" || state.role === "teacher";
const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit" }) : "—";
const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString("ar-SA", { day: "numeric", month: "long", year: "numeric" }) : "—";
const fmtDur = (m) => m == null ? "—" : m < 60 ? `${m} د` : (m % 60 ? `${Math.floor(m / 60)} س ${m % 60} د` : `${Math.floor(m / 60)} س`);
const elapsed = (outIso) => Math.max(0, Math.round((Date.now() - new Date(outIso).getTime()) / 60000));
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");

async function resolveRole() {
  if (!state.user) return "viewer";
  const { data: rows } = await sb.from("staff").select("*").eq("email", state.user.email);
  if (rows && rows.length) { state.role = rows[0].role; return rows[0].role; }
  const { count } = await sb.from("staff").select("*", { count: "exact", head: true });
  const first = !count;
  const r = first ? "admin" : "teacher";
  await sb.from("staff").insert({ email: state.user.email, role: r });
  state.role = r;
  return r;
}
async function loadSettings() {
  const { data } = await sb.from("settings").select("*");
  const m = (data || []).find((s) => s.key === "maxActivePasses");
  state.maxActive = m ? parseInt(m.value, 10) || 1 : 1;
}
async function setSetting(key, value) { await sb.from("settings").upsert({ key, value }); }

/* ---------- router ---------- */
window.addEventListener("hashchange", render);
async function render() {
  app.innerHTML = "";
  if (!state.user) { renderAuth(); return; }
  const route = (location.hash || "#/home").slice(1);
  const page = route.split("/")[1] || "home";
  const shell = el("div", "shell");
  shell.appendChild(buildSidebar(page));
  const main = el("main", "main");
  const topbar = el("div", "topbar");
  topbar.innerHTML = `<div class="tb-brand"><div class="logo">🎓</div><span>منصة الاستئذان</span></div><button class="burger" id="burger">☰</button>`;
  main.appendChild(topbar);
  const content = el("div");
  main.appendChild(content);
  shell.appendChild(main);
  app.appendChild(shell);
  $("#burger").onclick = () => { $(".sidebar").classList.add("open"); const d = el("div", "drawer"); app.appendChild(d); d.onclick = () => { $(".sidebar").classList.remove("open"); d.remove(); }; };
  try {
    if (page === "home") await renderHome(content);
    else if (page === "classes") await renderClasses(content);
    else if (page === "students") await renderStudents(content);
    else if (page === "analytics") await renderAnalytics(content);
    else if (page === "settings") await renderSettings(content);
    else renderHome(content);
  } catch (e) { content.innerHTML = `<div class="err">${esc(e.message || "خطأ")}</div>`; }
}

/* ---------- sidebar ---------- */
function buildSidebar(page) {
  const items = [
    ["home", "لوحة الاستئذانات", "📊"],
    ["classes", "الصفوف", "🏫"],
    ["students", "الطلاب", "👥"],
    ["analytics", "التقارير", "📈"],
    ["settings", "الإعدادات", "⚙️"],
  ];
  const side = el("aside", "sidebar");
  side.innerHTML = `
    <div class="brand"><div class="logo">🎓</div><div><h1>منصة الاستئذان</h1><p>PassManager</p></div></div>
    <nav class="nav">${items.map(([k, l, i]) => `<a href="#/${k}" class="${page === k ? "active" : ""}"><span class="ic">${i}</span>${l}</a>`).join("")}</nav>
    <div class="side-user">
      <div class="chip"><div class="ava">${esc((state.user.email || "؟")[0].toUpperCase())}</div>
        <div><div class="nm">${esc(state.user.email)}</div><div class="rl">${state.role === "admin" ? "مدير" : state.role === "teacher" ? "معلم" : "مشاهد"}</div></div></div>
      <button class="btn-logout" id="logout">🚪 تسجيل الخروج</button>
    </div>`;
  side.querySelector("#logout").onclick = async () => { await sb.auth.signOut(); state.user = null; render(); };
  return side;
}

function head(title, sub) {
  return `<div class="page-head"><div><h2>${title}</h2><p>${sub}</p></div></div>`;
}
function spinner() { return `<div class="spinner"><div></div></div>`; }

/* =================== AUTH =================== */
function renderAuth() {
  app.innerHTML = `
    <div class="auth">
      <div class="auth-card">
        <div class="logo">🎓</div>
        <h2 id="authTitle">تسجيل الدخول</h2>
        <p class="sub" id="authSub">ادخل بريدك الإلكتروني وكلمة المرور للمتابعة</p>
        <div class="err" id="authErr" style="display:none"></div>
        <div class="field"><label>البريد الإلكتروني</label><input id="email" type="email" placeholder="name@school.edu.sa" dir="ltr"></div>
        <div class="field"><label>كلمة المرور</label><input id="pass" type="password" placeholder="••••••••" dir="ltr"></div>
        <button class="btn btn-primary" id="authBtn">دخول</button>
        <div class="auth-toggle" id="toggle">ليس لديك حساب؟ <a href="#">إنشاء حساب</a></div>
        <div class="setup-note">
          للبدء: أنشئ مشروع Supabase وضع رابطه ومفتاحه في أعلى ملف <code>app.js</code>،
          ثم نفّذ سكربت SQL الموجود في تعليق أعلى الملف.
        </div>
      </div>
    </div>`;
  let mode = "login";
  const toggle = $("#toggle");
  toggle.onclick = (e) => {
    e.preventDefault();
    mode = mode === "login" ? "register" : "login";
    $("#authTitle").textContent = mode === "login" ? "تسجيل الدخول" : "إنشاء حساب";
    $("#authSub").textContent = mode === "login" ? "ادخل بريدك الإلكتروني وكلمة المرور للمتابعة" : "أنشئ حساب معلم جديد";
    $("#authBtn").textContent = mode === "login" ? "دخول" : "إنشاء الحساب";
    toggle.innerHTML = mode === "login" ? 'ليس لديك حساب؟ <a href="#">إنشاء حساب</a>' : 'لديك حساب؟ <a href="#">تسجيل الدخول</a>';
  };
  $("#authBtn").onclick = async (e) => {
    e.preventDefault();
    const email = $("#email").value.trim(); const pass = $("#pass").value;
    const err = $("#authErr"); err.style.display = "none";
    if (!email || !pass) { err.textContent = "يرجى إدخال البريد وكلمة المرور"; err.style.display = "block"; return; }
    const btn = $("#authBtn"); const label = mode === "login" ? "دخول" : "إنشاء الحساب";
    btn.disabled = true; btn.textContent = "...";
    try {
      if (mode === "login") {
        const { data, error } = await sb.auth.signInWithPassword({ email, password: pass });
        if (error) throw error;
        state.user = data.user;
      } else {
        const { data, error } = await sb.auth.signUp({ email, password: pass });
        if (error) throw error;
        if (data.session) state.user = data.user;
        else { err.textContent = "تم إنشاء الحساب. فعّل بريدك ثم سجّل الدخول."; err.style.display = "block"; btn.disabled = false; btn.textContent = label; return; }
      }
      await resolveRole(); await loadSettings(); render();
    } catch (ex) {
      err.textContent = ex.message || "فشل المصادقة"; err.style.display = "block";
      btn.disabled = false; btn.textContent = label;
    }
  };
}

/* =================== HOME =================== */
async function renderHome(c) {
  if (state._clock) clearInterval(state._clock);
  c.innerHTML = head("لوحة الاستئذانات المباشرة", "تابع استئذانات الطلاب وأوقات عودتهم") + `
    <div class="toolbar">
      <select id="classSel" style="max-width:300px;padding:10px 14px;border:1px solid var(--border);border-radius:12px;background:#fff;font-size:14px"></select>
      ${isEditor() ? '<button class="btn btn-primary btn-sm" id="newPass">➕ منح استئذان</button>' : ""}
    </div>
    <div class="grid stats" id="stats"></div>
    <h3 style="margin-bottom:12px;font-weight:800">الطلاب خارج الفصل الآن</h3>
    <div id="activeZone"></div>
    <div id="grantForm"></div>
    <h3 style="margin:24px 0 12px;font-weight:800">آخر العودات</h3>
    <div id="recentZone"></div>`;
  const { data: cls } = await sb.from("classes").select("*").order("name");
  state.classes = cls || [];
  const sel = $("#classSel");
  if (!state.classes.length) { sel.innerHTML = `<option>لا توجد صفوف بعد</option>`; }
  else { sel.innerHTML = state.classes.map((x) => `<option value="${x.id}">${esc(x.name)} — ${esc(x.grade)} ${esc(x.section)}</option>`).join(""); }
  const loadClass = async () => {
    const cid = sel.value; if (!cid || !state.classes.length) return;
    await loadStudents(cid); await loadPasses(cid); drawHome(cid);
  };
  sel.onchange = loadClass;
  if (isEditor()) $("#newPass").onclick = () => showGrant(sel.value);
  sb.channel("passes").on("postgres_changes", { event: "*", schema: "public", table: "pass_logs" }, () => { if (sel.value) loadPasses(sel.value).then(() => drawHome(sel.value)); }).subscribe();
  state._clock = setInterval(() => { const z = $("#activeZone"); if (z && z.dataset.cid === sel.value) drawActive(sel.value); }, 1000);
  if (state.classes.length) await loadClass();
}

async function loadStudents(cid) {
  const { data } = await sb.from("students").select("*").eq("class_id", cid).order("full_name");
  state.students = data || [];
}
async function loadPasses(cid) {
  const { data: active } = await sb.from("pass_logs").select("*").eq("class_id", cid).eq("status", "active").order("time_out", { ascending: false });
  const { data: recent } = await sb.from("pass_logs").select("*").eq("class_id", cid).in("status", ["returned", "overdue"]).order("time_out", { ascending: false }).limit(8);
  state.activePasses = active || []; state.recent = recent || [];
}

function drawHome(cid) {
  const atLimit = state.activePasses.length >= state.maxActive;
  $("#stats").innerHTML = `
    ${statCard("غائبون الآن", state.activePasses.length, "amber", "⏱")}
    ${statCard("الحد الأقصى", state.maxActive, "indigo", "✅")}
    ${statCard("عدد الطلاب", state.students.length, "emerald", "➕")}
    ${statCard("عادوا", state.recent.length, "slate", "↩️")}`;
  const np = $("#newPass");
  if (np) { if (isEditor() && atLimit) np.setAttribute("disabled", ""); else np.removeAttribute("disabled"); }
  drawActive(cid);
  drawRecent();
}
function statCard(l, v, color, ic) { return `<div class="stat"><div class="top"><span class="lbl">${l}</span><span class="ic ic-${color}">${ic}</span></div><div class="val">${v}</div></div>`; }
function drawActive(cid) {
  const z = $("#activeZone"); if (!z) return; z.dataset.cid = cid;
  if (!state.activePasses.length) { z.innerHTML = `<div class="empty"><div class="ic">⏱</div>لا يوجد طلاب خارج الفصل حالياً</div>`; return; }
  z.innerHTML = `<div class="passes">${state.activePasses.map((p) => {
    const m = elapsed(p.time_out); const od = m >= OVERDUE_MIN;
    return `<div class="pass ${od ? "overdue" : ""}">
      <div class="ph"><div><div class="nm">${esc(p.student_name)}</div><div class="rs">السبب: ${esc(p.reason)}</div><div class="to">خرج: ${fmtTime(p.time_out)}</div></div>
        <div class="timer"><div class="n">${m}</div><div class="u">دقيقة</div></div></div>
      ${od ? `<div class="warn">⚠️ تجاوز الوقت المسموح (${OVERDUE_MIN} دقائق)</div>` : ""}
      ${isEditor() ? `<button class="btn btn-emerald" style="width:100%;justify-content:center;margin-top:12px" onclick="markReturn('${p.id}','${p.time_out}')">↩️ تسجيل عودة</button>` : ""}
    </div>`;
  }).join("")}</div>`;
}
function drawRecent() {
  const z = $("#recentZone"); if (!z) return;
  if (!state.recent.length) { z.innerHTML = `<div class="empty">لا توجد عودات مسجلة بعد</div>`; return; }
  z.innerHTML = `<div class="table-wrap"><table><thead><tr><th>الطالب</th><th>السبب</th><th>المدة</th><th>الحالة</th></tr></thead><tbody>${state.recent.map((p) => `<tr><td><b>${esc(p.student_name)}</b></td><td>${esc(p.reason)}</td><td>${fmtDur(p.duration_minutes)}</td><td><span class="badge b-${p.status}">${STATUS[p.status]}</span></td></tr>`).join("")}</tbody></table></div>`;
}
window.markReturn = async (id, outIso) => {
  const inTime = new Date().toISOString();
  const dur = Math.round((new Date(inTime).getTime() - new Date(outIso).getTime()) / 60000);
  const status = dur > OVERDUE_MIN ? "overdue" : "returned";
  await sb.from("pass_logs").update({ time_in: inTime, duration_minutes: dur, status }).eq("id", id);
};
function showGrant(cid) {
  if (state.activePasses.length >= state.maxActive) { alert("تم بلوغ الحد الأقصى للاستئذانات النشطة."); return; }
  const f = $("#grantForm");
  f.innerHTML = `<div class="card"><h3>➕ منح استئذان جديد</h3>
    <div class="row row-2" style="margin-bottom:12px">
      <div class="field"><label>السبب</label><select id="gReason">${REASONS.map((r) => `<option>${r}</option>`).join("")}</select></div>
      <div class="field"><label>ملاحظات (اختياري)</label><input id="gNotes" placeholder="ملاحظات المعلم..."></div>
    </div>
    <div class="search" style="margin-bottom:10px"><span class="ic">🔍</span><input id="gSearch" placeholder="ابحث عن طالب..."></div>
    <div id="gList" style="max-height:240px;overflow:auto;margin-bottom:12px"></div>
    <button class="btn btn-ghost btn-sm" onclick="document.getElementById('grantForm').innerHTML=''">إغلاق</button></div>`;
  const list = $("#gList"); const search = $("#gSearch");
  const drawList = () => {
    const q = search.value.trim();
    const arr = state.students.filter((s) => !q || s.full_name.includes(q) || (s.student_id || "").includes(q)).slice(0, 40);
    list.innerHTML = arr.length ? arr.map((s) => `<div class="student-pick" onclick="grantPass('${s.id}','${esc(s.full_name)}')"><div><div style="font-weight:700">${esc(s.full_name)}</div><div style="font-size:12px;color:var(--muted)">${esc(s.student_id) || "—"}</div></div><span class="badge badge-plain">استئذان ↩️</span></div>`).join("") : `<div class="empty">لا يوجد طلاب</div>`;
  };
  search.oninput = drawList; drawList();
}
window.grantPass = async (sid, name) => {
  const reason = $("#gReason").value; const notes = $("#gNotes").value;
  await sb.from("pass_logs").insert({ student_id: sid, student_name: name, class_id: $("#classSel").value, time_out: new Date().toISOString(), reason, status: "active", notes });
  const st = state.students.find((s) => s.id === sid);
  if (st) await sb.from("students").update({ total_passes: (st.total_passes || 0) + 1 }).eq("id", sid);
  $("#grantForm").innerHTML = "";
};

/* =================== CLASSES =================== */
async function renderClasses(c) {
  c.innerHTML = head("الصفوف والشعب", "إدارة الصفوف الدراسية") + (isEditor() ? `<button class="btn btn-primary" id="addBtn">➕ إضافة صف</button>` : "") + `<div id="form"></div><div id="list" style="margin-top:18px"></div>`;
  if (isEditor()) $("#addBtn").onclick = () => classForm(null);
  await loadClassesList();
}
async function loadClassesList() {
  const { data } = await sb.from("classes").select("*").order("name");
  const list = $("#list");
  if (!data || !data.length) { list.innerHTML = `<div class="empty"><div class="ic">🏫</div>لا توجد صفوف بعد. ${isEditor() ? "ابدأ بإضافة صف جديد." : ""}</div>`; return; }
  list.innerHTML = `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(220px,1fr))">${data.map((cl) => `<div class="stat"><div style="display:flex;justify-content:space-between"><span class="ic ic-indigo">🏫</span>${isEditor() ? `<div><button class="ic-btn" onclick="classForm('${cl.id}','${esc(cl.name)}','${esc(cl.grade)}','${esc(cl.section)}')">✏️</button><button class="ic-btn danger" onclick="delClass('${cl.id}','${esc(cl.name)}')">🗑️</button></div>` : ""}</div><div style="font-weight:800;margin-top:10px">${esc(cl.name)}</div><div style="font-size:14px;color:var(--muted)">${esc(cl.grade)} — ${esc(cl.section)}</div></div>`).join("")}</div>`;
}
window.classForm = (id, name = "", grade = "", section = "") => {
  $("#form").innerHTML = `<div class="card"><h3>${id ? "تعديل الصف" : "صف جديد"}</h3>
    <div class="row row-3"><div class="field"><label>اسم الصف</label><input id="cName" value="${esc(name)}"></div>
    <div class="field"><label>المرحلة</label><input id="cGrade" value="${esc(grade)}"></div>
    <div class="field"><label>الشعبة</label><input id="cSection" value="${esc(section)}"></div></div>
    <div style="margin-top:12px"><button class="btn btn-primary" id="cSave">حفظ</button> <button class="btn btn-ghost" id="cCancel">إلغاء</button></div></div>`;
  $("#cCancel").onclick = () => $("#form").innerHTML = "";
  $("#cSave").onclick = async () => {
    const o = { name: $("#cName").value, grade: $("#cGrade").value, section: $("#cSection").value };
    if (!o.name || !o.grade || !o.section) return;
    if (id) await sb.from("classes").update(o).eq("id", id); else await sb.from("classes").insert(o);
    $("#form").innerHTML = ""; await loadClassesList();
  };
};
window.delClass = async (id, name) => { if (!confirm(`حذف الصف "${name}"؟`)) return; await sb.from("classes").delete().eq("id", id); await loadClassesList(); };

/* =================== STUDENTS =================== */
async function renderStudents(c) {
  c.innerHTML = head("الطلاب", "إدارة الطلاب وإضافة الاستئذانات") + `<div class="toolbar"><select id="sClass" style="max-width:260px;padding:10px 14px;border:1px solid var(--border);border-radius:12px;background:#fff;font-size:14px"></select><div class="search grow"><span class="ic">🔍</span><input id="sSearch" placeholder="ابحث بالاسم أو الرقم..."></div>${isEditor() ? '<button class="btn btn-primary" id="sAdd">➕ إضافة طالب</button>' : ""}</div><div id="sForm"></div><div id="sList"></div>`;
  const { data: cls } = await sb.from("classes").select("*").order("name");
  const sel = $("#sClass");
  sel.innerHTML = (cls || []).map((x) => `<option value="${x.id}">${esc(x.name)} — ${esc(x.grade)} ${esc(x.section)}</option>`).join("") || `<option>لا توجد صفوف</option>`;
  const load = async () => { if (!sel.value) return; await loadStudents(sel.value); drawStudents(); };
  sel.onchange = load; $("#sSearch").oninput = drawStudents;
  if (isEditor()) $("#sAdd").onclick = () => studentForm(null);
  if (cls && cls.length) await load();
}
function drawStudents() {
  const q = $("#sSearch").value.trim();
  const arr = state.students.filter((s) => !q || s.full_name.includes(q) || (s.student_id || "").includes(q));
  const z = $("#sList");
  if (!arr.length) { z.innerHTML = `<div class="empty"><div class="ic">👥</div>لا يوجد طلاب. ${isEditor() ? "أضف طالباً جديداً." : ""}</div>`; return; }
  z.innerHTML = `<div class="table-wrap"><table><thead><tr><th>الطالب</th><th>الرقم</th><th>الاستئذانات</th>${isEditor() ? "<th>إجراءات</th>" : ""}</tr></thead><tbody>${arr.map((s) => `<tr><td><b>${esc(s.full_name)}</b></td><td style="color:var(--muted)">${esc(s.student_id) || "—"}</td><td><span class="badge-plain">${s.total_passes || 0}</span></td>${isEditor() ? `<td><button class="ic-btn" onclick="studentForm('${s.id}','${esc(s.full_name)}','${esc(s.student_id || "")}')">✏️</button> <button class="ic-btn danger" onclick="delStudent('${s.id}','${esc(s.full_name)}')">🗑️</button></td>` : ""}</tr>`).join("")}</tbody></table></div>`;
}
window.studentForm = (id, name = "", sid = "") => {
  $("#sForm").innerHTML = `<div class="card"><h3>${id ? "تعديل طالب" : "طالب جديد"}</h3>
    <div class="row row-2"><div class="field"><label>الاسم الكامل</label><input id="stName" value="${esc(name)}"></div>
    <div class="field"><label>الرقم/الباركود</label><input id="stId" value="${esc(sid)}"></div></div>
    <div style="margin-top:12px"><button class="btn btn-primary" id="stSave">حفظ</button> <button class="btn btn-ghost" id="stCancel">إلغاء</button></div></div>`;
  $("#stCancel").onclick = () => $("#sForm").innerHTML = "";
  $("#stSave").onclick = async () => {
    const o = { full_name: $("#stName").value, student_id: $("#stId").value, class_id: $("#sClass").value };
    if (!o.full_name) return;
    if (id) await sb.from("students").update(o).eq("id", id); else await sb.from("students").insert({ ...o, total_passes: 0 });
    $("#sForm").innerHTML = ""; await loadStudents($("#sClass").value); drawStudents();
  };
};
window.delStudent = async (id, name) => { if (!confirm(`حذف الطالب "${name}"؟`)) return; await sb.from("students").delete().eq("id", id); await loadStudents($("#sClass").value); drawStudents(); };

/* =================== ANALYTICS =================== */
async function renderAnalytics(c) {
  c.innerHTML = head("التقارير والإحصاءات", "تحليل استئذانات الطلاب") + `<div class="toolbar"><div class="seg" id="range">${[["today", "اليوم"], ["week", "أسبوع"], ["month", "شهر"], ["all", "الكل"]].map(([k, l]) => `<button data-r="${k}">${l}</button>`).join("")}</div><button class="btn btn-ghost btn-sm" id="csv">⬇️ CSV</button></div><div id="an"></div>`;
  let range = "week";
  const seg = $("#range"); seg.querySelector('[data-r="week"]').classList.add("active");
  seg.querySelectorAll("button").forEach((b) => b.onclick = () => { seg.querySelectorAll("button").forEach((x) => x.classList.remove("active")); b.classList.add("active"); range = b.dataset.r; load(); });
  $("#csv").onclick = exportCSV;
  async function load() {
    $("#an").innerHTML = spinner();
    let q = sb.from("pass_logs").select("*").order("time_out", { ascending: false }).limit(1000);
    if (range !== "all") {
      const now = Date.now();
      const since = range === "today" ? new Date(new Date().setHours(0, 0, 0, 0)).toISOString() : new Date(now - (range === "week" ? 7 : 30) * 864e5).toISOString();
      q = q.gte("time_out", since);
    }
    const { data } = await q;
    drawAnalytics(data || []);
  }
  load();
}
function drawAnalytics(logs) {
  const returned = logs.filter((l) => l.status !== "active");
  const totalMin = returned.reduce((s, l) => s + (l.duration_minutes || 0), 0);
  const avg = returned.length ? Math.round(totalMin / returned.length) : 0;
  const studs = {};
  logs.forEach((l) => { if (!studs[l.student_name]) studs[l.student_name] = { n: 0, m: 0 }; studs[l.student_name].n++; studs[l.student_name].m += l.duration_minutes || 0; });
  const top = Object.entries(studs).sort((a, b) => b[1].n - a[1].n).slice(0, 8);
  const reasonCounts = REASONS.map((r) => ({ r, n: logs.filter((l) => l.reason === r).length })).filter((x) => x.n);
  const pieData = reasonCounts.map((x, i) => [x.r, x.n, PIE_COLORS[i % PIE_COLORS.length]]);
  const totalLog = logs.length || 1;
  const pieFill = pieData.length ? `conic-gradient(${pieData.map((d, i) => { const pct = (d[1] / totalLog) * 100; const prev = pieData.slice(0, i).reduce((s, x) => s + (x[1] / totalLog) * 100, 0); return `${d[2]} ${prev}% ${prev + pct}%`; }).join(",")})` : "#f1f5f9";
  const hours = {};
  logs.forEach((l) => { const h = new Date(l.time_out).getHours(); hours[h] = (hours[h] || 0) + 1; });
  const hourArr = Object.entries(hours).sort((a, b) => +a[0] - +b[0]);
  const maxH = Math.max(1, ...hourArr.map((x) => x[1]));
  const days = {};
  logs.forEach((l) => { const d = new Date(l.time_out); const k = `${d.getMonth() + 1}/${d.getDate()}`; days[k] = (days[k] || 0) + 1; });
  const dayArr = Object.entries(days).slice(-14); const maxD = Math.max(1, ...dayArr.map((x) => x[1]));
  const topMax = top.length ? top[0][1].n : 1;
  $("#an").innerHTML = `
    <div class="grid stats">${statCard("إجمالي الاستئذانات", logs.length, "indigo", "📈")}${statCard("إجمالي الدقائق", fmtDur(totalMin), "amber", "⏱")}${statCard("متوسط المدة", fmtDur(avg), "emerald", "⏱")}${statCard("عدد الطلاب", Object.keys(studs).length, "slate", "👥")}</div>
    <div class="chart-grid">
      <div class="card"><h3>📅 الاتجاه اليومي</h3>${dayArr.length ? `<div class="bars">${dayArr.map(([d, n]) => `<div class="bar-row"><span class="lab">${d}</span><div class="track"><div class="fill" style="width:${(n / maxD) * 100}%"></div></div><span class="val">${n}</span></div>`).join("")}</div>` : `<div class="empty">لا توجد بيانات</div>`}</div>
      <div class="card"><h3>📊 أسباب الاستئذان</h3>${pieData.length ? `<div class="pie"><div class="donut" style="background:${pieFill}"></div><div class="legend">${pieData.map((d) => `<div class="li"><span class="dot" style="background:${d[2]}"></span>${d[0]} (${d[1]})</div>`).join("")}</div></div>` : `<div class="empty">لا توجد بيانات</div>`}</div>
      <div class="card"><h3>⏱ ساعات الذروة</h3>${hourArr.length ? `<div class="bars">${hourArr.map(([h, n]) => `<div class="bar-row"><span class="lab">${h}:00</span><div class="track"><div class="fill" style="width:${(n / maxH) * 100}%;background:#10b981"></div></div><span class="val">${n}</span></div>`).join("")}</div>` : `<div class="empty">لا توجد بيانات</div>`}</div>
      <div class="card"><h3>👥 أكثر الطلاب استئذاناً</h3>${top.length ? `<div class="bars">${top.map(([nm, v], i) => `<div class="bar-row"><span class="lab">${i + 1}.</span><div class="track"><div class="fill" style="width:${(v.n / topMax) * 100}%"></div></div><span class="val">${v.n}</span></div><div style="font-size:12px;color:var(--muted);margin-top:-4px">${esc(nm)} · ${fmtDur(v.m)}</div>`).join("")}</div>` : `<div class="empty">لا توجد بيانات</div>`}</div>
    </div>
    <div class="card"><h3>📄 السجل الكامل</h3>${logs.length ? `<div class="table-wrap"><table><thead><tr><th>الطالب</th><th>السبب</th><th>التاريخ</th><th>المدة</th><th>الحالة</th></tr></thead><tbody>${logs.slice(0, 50).map((l) => `<tr><td><b>${esc(l.student_name)}</b></td><td>${esc(l.reason)}</td><td style="color:var(--muted)">${fmtDate(l.time_out)}</td><td>${l.status === "active" ? "—" : fmtDur(l.duration_minutes)}</td><td><span class="badge b-${l.status}">${STATUS[l.status]}</span></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">لا توجد بيانات</div>`}</div>`;
}
function exportCSV() {
  sb.from("pass_logs").select("*").order("time_out", { ascending: false }).limit(2000).then(({ data }) => {
    const headers = ["الطالب", "السبب", "وقت الخروج", "وقت العودة", "المدة", "الحالة", "ملاحظات"];
    const rows = (data || []).map((l) => [l.student_name, l.reason, l.time_out, l.time_in || "", l.duration_minutes || "", STATUS[l.status] || l.status, (l.notes || "").replace(/[\n,]/g, " ")]);
    const csv = [headers, ...rows].map((r) => r.map((c) => `"${c}"`).join(",")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `pass-logs-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  });
}

/* =================== SETTINGS =================== */
async function renderSettings(c) {
  const { data: wl } = await sb.from("staff").select("*").order("created_at");
  c.innerHTML = head("الإعدادات", "إعدادات النظام والصلاحيات") + `
    <div class="card"><h3>🛡️ الحد الأقصى للاستئذانات النشطة</h3><p style="color:var(--muted);font-size:14px;margin-bottom:14px">عدد الطلاب المسموح بخروجهم من الفصل في نفس الوقت.</p>
      <div class="seg" id="maxSeg">${[1, 2, 3].map((n) => `<button data-n="${n}">${n} ${n === 1 ? "طالب" : "طلاب"}</button>`).join("")}</div>
      ${isEditor() ? '<button class="btn btn-primary btn-sm" id="maxSave" style="margin-top:12px">💾 حفظ</button>' : ""}</div>
    <div class="card"><h3>📧 قائمة المعلمين المصرّح لهم</h3><p style="color:var(--muted);font-size:14px;margin-bottom:14px">المعلمون لهم صلاحية الإنشاء والتعديل. المدير (admin) صلاحية كاملة.</p>
      ${isEditor() ? `<div class="row row-2" style="margin-bottom:14px"><input id="wlEmail" placeholder="name@school.edu.sa" dir="ltr"><button class="btn btn-primary" id="wlAdd">➕ إضافة</button></div>` : ""}
      <div id="wlList"></div></div>
    ${!isEditor() ? `<div class="err">أنت تعمل بصلاحية "مشاهد". تواصل مع المدير لمنحك صلاحية المعلم.</div>` : ""}`;
  const seg = $("#maxSeg"); seg.querySelector(`[data-n="${state.maxActive}"]`).classList.add("active");
  let chosen = state.maxActive;
  seg.querySelectorAll("button").forEach((b) => b.onclick = () => { seg.querySelectorAll("button").forEach((x) => x.classList.remove("active")); b.classList.add("active"); chosen = +b.dataset.n; });
  if (isEditor()) $("#maxSave").onclick = async () => { await setSetting("maxActivePasses", String(chosen)); state.maxActive = chosen; const b = $("#maxSave"); b.textContent = "✅ تم الحفظ"; setTimeout(() => b.textContent = "💾 حفظ", 1500); };
  function drawWL() {
    $("#wlList").innerHTML = (wl && wl.length) ? `<div style="display:flex;flex-direction:column;gap:8px">${wl.map((w) => `<div class="student-pick"><span dir="ltr" style="font-family:monospace">${esc(w.email)}</span><span class="badge-plain">${w.role === "admin" ? "مدير" : "معلم"}</span>${isEditor() ? `<button class="ic-btn danger" onclick="delStaff('${w.id}')">🗑️</button>` : ""}</div>`).join("")}</div>` : `<div class="empty">لا يوجد معلمون مصرّح لهم</div>`;
  }
  drawWL();
  if (isEditor()) $("#wlAdd").onclick = async () => {
    const email = $("#wlEmail").value.trim().toLowerCase();
    if (!email || !email.includes("@")) return;
    if ((wl || []).some((w) => w.email === email)) return;
    const { data } = await sb.from("staff").insert({ email, role: "teacher" }).select();
    if (data) wl.push(data[0]);
    $("#wlEmail").value = ""; drawWL();
  };
}
window.delStaff = async (id) => { await sb.from("staff").delete().eq("id", id); render(); };

/* ---------- boot ---------- */
(async function init() {
  const { data: { session } } = await sb.auth.getSession();
  if (session) { state.user = session.user; await resolveRole(); await loadSettings(); }
  if (!location.hash) location.hash = "#/home";
  render();
})();

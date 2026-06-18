const $ = (id) => document.getElementById(id);

// ===== Auth gate =====
const gate = $("gate");
const gateForm = $("gateForm");
const gateInput = $("gateInput");
const gateBtn = $("gateBtn");
const gateError = $("gateError");
const appEl = $("app");
const logoutBtn = $("logout");

// ===== Bypass tab =====
const form = $("form");
const urlInput = $("url");
const goBtn = $("go");
const resendBtn = $("resend");
const resetBtn = $("reset");
const logBox = $("logBox");
const logTitle = $("logTitle");
const logBody = $("logBody");
const logElapsed = $("logElapsed");
const resultBox = $("result");
const resultMeta = $("resultMeta");
const finalLink = $("finalLink");
const chainEl = $("chain");
const errorBox = $("error");
const errorText = $("errorText");
const copyBtn = $("copyBtn");
const openBtn = $("openBtn");

// ===== Management tab =====
const tabBypass = $("tab-bypass");
const tabManagement = $("tab-management");
const genForm = $("genForm");
const genCount = $("genCount");
const genDays = $("genDays");
const genBtn = $("genBtn");
const genResult = $("genResult");
const genResultBody = $("genResultBody");
const copyAllBtn = $("copyAllBtn");
const codesList = $("codesList");
const codesMeta = $("codesMeta");
const refreshCodesBtn = $("refreshCodes");

const show = (el) => el.removeAttribute("hidden");
const hide = (el) => el.setAttribute("hidden", "");
const showCls = (el) => el.classList.remove("hidden");
const hideCls = (el) => el.classList.add("hidden");

let session = null; // { code, role }

// ===== Toast =====
function toast(msg) {
  let el = document.querySelector(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 1500);
}

// ===== Auth =====

function loadSession() {
  try {
    const raw = localStorage.getItem("passlink:session");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveSession(s) {
  if (s) localStorage.setItem("passlink:session", JSON.stringify(s));
  else localStorage.removeItem("passlink:session");
}

async function authenticate(code) {
  const res = await fetch("/api/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const data = await res.json().catch(() => ({}));
  return data;
}

function showApp() {
  hide(gate);
  show(appEl);
  document.querySelectorAll(".admin-only").forEach((el) => {
    if (session?.role === "admin") show(el);
    else hide(el);
  });
}

function showGate(errorMsg) {
  show(gate);
  hide(appEl);
  if (errorMsg) {
    gateError.textContent = errorMsg;
    show(gateError);
  } else {
    hide(gateError);
  }
  gateInput.value = "";
  gateInput.focus();
}

async function tryRestoreSession() {
  const s = loadSession();
  if (!s || !s.code) {
    showGate();
    return;
  }
  // Revalidate with server.
  const result = await authenticate(s.code);
  if (result.ok) {
    session = { code: s.code, role: result.role };
    saveSession(session);
    showApp();
    if (session.role === "admin") refreshCodes();
  } else {
    saveSession(null);
    showGate();
  }
}

gateForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = gateInput.value.trim();
  if (!code) return;
  gateBtn.disabled = true;
  hide(gateError);
  try {
    const result = await authenticate(code);
    if (!result.ok) {
      gateError.textContent = result.error || "Invalid code";
      show(gateError);
      return;
    }
    session = { code, role: result.role };
    saveSession(session);
    showApp();
    if (session.role === "admin") refreshCodes();
  } catch (err) {
    gateError.textContent = err.message || "Network error";
    show(gateError);
  } finally {
    gateBtn.disabled = false;
  }
});

logoutBtn.addEventListener("click", () => {
  session = null;
  saveSession(null);
  showGate();
});

// ===== Tabs =====

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    const name = btn.dataset.tab;
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
    if (name === "bypass") {
      show(tabBypass);
      hide(tabManagement);
    } else {
      hide(tabBypass);
      show(tabManagement);
      if (session?.role === "admin") refreshCodes();
    }
  });
});

// ===== Bypass =====

let lastFinalUrl = null;
let activeStream = null;
let startTime = null;
let elapsedTimer = null;

function fmtTime() {
  return new Date().toTimeString().slice(0, 8);
}

function appendLog(text) {
  const line = document.createElement("span");
  line.className = "log-line new";
  const time = document.createElement("span");
  time.className = "log-time";
  time.textContent = fmtTime();
  line.appendChild(time);
  line.appendChild(document.createTextNode(text));
  line.appendChild(document.createTextNode("\n"));
  logBody.appendChild(line);
  logBody.scrollTop = logBody.scrollHeight;
}

function tickElapsed() {
  if (!startTime) return;
  logElapsed.textContent = ((Date.now() - startTime) / 1000).toFixed(1) + "s";
}

function startElapsed() {
  startTime = Date.now();
  tickElapsed();
  elapsedTimer = setInterval(tickElapsed, 100);
}

function stopElapsed() {
  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedTimer = null;
  tickElapsed();
}

function resetBypassUI() {
  if (activeStream) {
    activeStream.close();
    activeStream = null;
  }
  stopElapsed();
  startTime = null;
  lastFinalUrl = null;
  logBody.textContent = "";
  logTitle.textContent = "Working…";
  logBox.dataset.status = "";
  hideCls(logBox);
  hideCls(resultBox);
  hideCls(errorBox);
  hide(resetBtn);
  hide(resendBtn);
  goBtn.disabled = false;
  urlInput.value = "";
  urlInput.focus();
}

function runBypass(url) {
  if (!session?.code) {
    showGate("Session expired");
    return;
  }
  hideCls(resultBox);
  hideCls(errorBox);
  logBody.textContent = "";
  logTitle.textContent = "Working…";
  logBox.dataset.status = "";
  showCls(logBox);
  show(resetBtn);
  show(resendBtn);
  resendBtn.disabled = true;
  goBtn.disabled = true;
  startElapsed();

  appendLog(`> ${url}`);

  const streamUrl = `/api/bypass-stream?url=${encodeURIComponent(url)}&code=${encodeURIComponent(session.code)}`;
  const stream = new EventSource(streamUrl);
  activeStream = stream;

  stream.addEventListener("note", (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data && data.note) appendLog(data.note);
    } catch {/* ignore */}
  });

  stream.addEventListener("done", (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    stream.close();
    activeStream = null;
    stopElapsed();
    goBtn.disabled = false;
    resendBtn.disabled = false;
    logBox.dataset.status = "done";
    logTitle.textContent = "Done";

    if (!data || !data.ok) {
      errorText.textContent = (data && data.error) || "Unknown error";
      showCls(errorBox);
      return;
    }
    lastFinalUrl = data.finalUrl;
    finalLink.textContent = data.finalUrl;
    finalLink.href = data.finalUrl;
    resultMeta.textContent = `${data.hops} hop${data.hops === 1 ? "" : "s"} · ${data.elapsedMs} ms`;
    chainEl.innerHTML = "";
    for (const u of data.chain) {
      const li = document.createElement("li");
      li.textContent = u;
      chainEl.appendChild(li);
    }
    showCls(resultBox);
  });

  stream.addEventListener("error", (e) => {
    if (e.data) {
      try {
        const data = JSON.parse(e.data);
        errorText.textContent = data.error || "Stream error";
      } catch {
        errorText.textContent = "Stream error";
      }
    } else {
      errorText.textContent = "Connection lost";
    }
    stream.close();
    activeStream = null;
    stopElapsed();
    goBtn.disabled = false;
    resendBtn.disabled = false;
    logBox.dataset.status = "error";
    logTitle.textContent = "Failed";
    showCls(errorBox);
  });
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;
  runBypass(url);
});

resetBtn.addEventListener("click", resetBypassUI);

resendBtn.addEventListener("click", () => {
  const url = urlInput.value.trim();
  if (!url) return;
  if (activeStream) {
    activeStream.close();
    activeStream = null;
  }
  runBypass(url);
});

copyBtn.addEventListener("click", async () => {
  if (!lastFinalUrl) return;
  try { await navigator.clipboard.writeText(lastFinalUrl); toast("Copied"); }
  catch { toast("Copy failed"); }
});

openBtn.addEventListener("click", () => {
  if (!lastFinalUrl) return;
  window.open(lastFinalUrl, "_blank", "noopener,noreferrer");
});

// ===== Management =====

function fmtDate(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtRemaining(expiresAt) {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return "expired";
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  if (days >= 1) return `${days}d ${hours}h left`;
  const mins = Math.floor((ms % 3600000) / 60000);
  return `${hours}h ${mins}m left`;
}

async function authedFetch(path, opts = {}) {
  if (!session?.code) throw new Error("No session");
  const headers = { ...(opts.headers || {}), "x-access-code": session.code };
  if (opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401 || res.status === 403) {
    showGate(res.status === 403 ? "Admin required" : "Session expired");
    throw new Error("Unauthorized");
  }
  return res;
}

async function refreshCodes() {
  if (session?.role !== "admin") return;
  try {
    const res = await authedFetch("/api/codes");
    const data = await res.json();
    renderCodes(data.codes || []);
  } catch (err) {
    if (err.message !== "Unauthorized") console.error(err);
  }
}

function renderCodes(codes) {
  codesList.innerHTML = "";
  const active = codes.filter((c) => !c.expired);
  codesMeta.textContent = `${active.length} active · ${codes.length} total`;

  if (codes.length === 0) {
    const empty = document.createElement("div");
    empty.className = "codes-empty";
    empty.textContent = "No codes yet. Generate one above.";
    codesList.appendChild(empty);
    return;
  }

  for (const c of codes) {
    const row = document.createElement("div");
    row.className = "code-row" + (c.expired ? " expired" : "");
    const codeEl = document.createElement("span");
    codeEl.className = "code";
    codeEl.textContent = c.code;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = c.expired
      ? `expired ${fmtDate(c.expiresAt)}`
      : `${fmtRemaining(c.expiresAt)} · expires ${fmtDate(c.expiresAt)}`;
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = c.expired ? "expired" : "active";
    const revoke = document.createElement("button");
    revoke.className = "revoke-btn";
    revoke.textContent = "Revoke";
    revoke.addEventListener("click", async () => {
      if (!confirm(`Revoke code ${c.code}?`)) return;
      revoke.disabled = true;
      try {
        await authedFetch("/api/codes", { method: "DELETE", body: JSON.stringify({ code: c.code }) });
        await refreshCodes();
        toast("Revoked");
      } catch {
        revoke.disabled = false;
      }
    });
    row.append(codeEl, meta, pill, revoke);
    codesList.appendChild(row);
  }
}

genForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const count = parseInt(genCount.value, 10) || 1;
  const days = parseInt(genDays.value, 10) || 30;
  genBtn.disabled = true;
  try {
    const res = await authedFetch("/api/codes", {
      method: "POST",
      body: JSON.stringify({ count, days }),
    });
    const data = await res.json();
    const created = data.created || [];
    genResultBody.textContent = created.map((c) => c.code).join("\n");
    showCls(genResult);
    await refreshCodes();
    toast(`Generated ${created.length}`);
  } catch (err) {
    if (err.message !== "Unauthorized") toast("Generate failed");
  } finally {
    genBtn.disabled = false;
  }
});

copyAllBtn.addEventListener("click", async () => {
  const text = genResultBody.textContent.trim();
  if (!text) return;
  try { await navigator.clipboard.writeText(text); toast("Copied"); }
  catch { toast("Copy failed"); }
});

refreshCodesBtn.addEventListener("click", refreshCodes);

// ===== Boot =====

(async function boot() {
  // Allow ?url=... preset after auth.
  const params = new URLSearchParams(location.search);
  const preset = params.get("url");

  await tryRestoreSession();

  if (preset && session?.code) {
    urlInput.value = preset;
    runBypass(preset);
  }
})();

const panelStatus = {
  health: "loading",
  raw: "loading",
  mints: "loading",
  buyers: "loading",
  actors: "loading",
  quest: "loading",
  claims: "loading",
};

let CATALOG = null;
let currentQuest = null;
let selectedWallet = null;

function el(id) { return document.getElementById(id); }
function setText(id, t){ const x=el(id); if(x) x.textContent = t; }
function setHtml(id, h){ const x=el(id); if(x) x.innerHTML = h; }

function short(s, n = 18) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

async function safeJson(url, opts) {
  const r = await fetch(url, { cache: "no-store", ...(opts || {}) });
  let j = null;
  try { j = await r.json(); } catch {}
  if (!r.ok) throw new Error(j?.error || `${url} -> ${r.status}`);
  return j;
}

function renderPanelHealth(){
  const parts = Object.entries(panelStatus).map(([k,v])=>{
    const cls = v==="ok" ? "ok" : v==="err" ? "err" : "warn";
    return `<span class="${cls}">${k}:${v}</span>`;
  });
  setHtml("panelHealth", parts.join(" · "));
}

function toast(kind, title, body){
  const root = el("toast");
  if(!root) return;
  const node = document.createElement("div");
  node.className = `toastItem ${kind}`;
  node.innerHTML = `<div class="tTitle">${title}</div><div class="tBody">${body}</div>`;
  root.appendChild(node);
  setTimeout(()=>{ node.style.opacity="0"; node.style.transform="translateY(8px)"; }, 2600);
  setTimeout(()=>{ node.remove(); }, 3100);
}

function statusDot(kind){
  const dot = el("statusDot");
  if(!dot) return;
  dot.classList.remove("ok","err");
  if(kind==="ok") dot.classList.add("ok");
  else if(kind==="err") dot.classList.add("err");
}

function catClass(cat){
  if(cat === "Quest") return "catQuest";
  if(cat === "Rarity") return "catRarity";
  if(cat === "Streak") return "catStreak";
  if(cat === "Memory") return "catMemory";
  return "";
}
function rarityClass(rarity){
  if(rarity === "Legendary") return "rarLegendary";
  if(rarity === "Rare") return "rarRare";
  return "";
}

// ---------------------
// Unlock sound (no mp3)
// ---------------------
let audioCtx = null;
function ping(){
  try{
    if(!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const t0 = audioCtx.currentTime;

    const o1 = audioCtx.createOscillator();
    const o2 = audioCtx.createOscillator();
    const g = audioCtx.createGain();

    o1.type = "sine";
    o2.type = "triangle";

    o1.frequency.setValueAtTime(880, t0);
    o2.frequency.setValueAtTime(1320, t0);

    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);

    o1.connect(g); o2.connect(g);
    g.connect(audioCtx.destination);

    o1.start(t0); o2.start(t0);
    o1.stop(t0 + 0.24); o2.stop(t0 + 0.24);
  }catch{}
}

function badgeNode({ code, info, locked=false, justUnlocked=false, nextUnlockText=null }){
  const span = document.createElement("span");
  const base = `badge ${catClass(info.cat)} ${rarityClass(info.rarity)}`;
  const lockCls = locked ? " lockedBadge" : "";
  const unlockCls = justUnlocked ? " justUnlocked" : "";
  span.className = base + lockCls + unlockCls;

  const label = locked ? `<span class="ghost"></span><span class="label">${info.label}</span>` : `<span class="label">${info.label}</span>`;

  const extra = nextUnlockText
    ? `<div class="m">Next unlock in: ${nextUnlockText}</div>`
    : `<div class="m">${info.cat} · ${info.rarity} · ${code}</div>`;

  span.innerHTML = `
    ${label}
    <span class="tip">
      <div class="t">${info.label}${locked ? " 🔒" : ""}</div>
      <div class="d">${info.desc}</div>
      ${extra}
    </span>
  `;
  return span;
}

function formatCountdown(ms){
  const s = Math.max(0, Math.floor(ms/1000));
  const m = Math.floor(s/60);
  const h = Math.floor(m/60);
  const mm = String(m%60).padStart(2,"0");
  const ss = String(s%60).padStart(2,"0");
  return `Next quest in ${h}:${mm}:${ss}`;
}

function progressRowHTML({ label, pct, have, need, unlocked, nextUnlockIn, kindLabel }) {
  const lock = unlocked ? "✓ " : "🔒 ";
  const left = `${Math.min(have, need)}/${need}`;
  const right = unlocked ? "unlocked" : "locked";
  const nextLine = unlocked ? "" : `<div class="progMetaLine">Next unlock in: <b>${nextUnlockIn}</b> ${kindLabel}</div>`;
  return `
    <div class="progRow">
      <div class="progTop">
        <div class="mono"><b>${lock}${label}</b> <span class="muted">${left}</span></div>
        <div class="mono muted">${right}</div>
      </div>
      <div class="progBar"><div class="progFill" style="width:${pct}%"></div></div>
      ${nextLine}
    </div>
  `;
}

// ---------------------
// Local unlocked cache
// ---------------------
function keyUnlocked(wallet){ return `unlocked:${wallet}`; }
function loadUnlocked(wallet){
  try{
    const raw = localStorage.getItem(keyUnlocked(wallet));
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  }catch{ return new Set(); }
}
function saveUnlocked(wallet, set){
  try{
    localStorage.setItem(keyUnlocked(wallet), JSON.stringify([...set]));
  }catch{}
}

async function loadCatalog(){
  const r = await safeJson("/badges/catalog");
  CATALOG = r.catalog || {};
}

async function loadHealth(){
  try{
    const h = await safeJson("/health");
    panelStatus.health = "ok";
    setText("status", "online");
    statusDot("ok");
    setText("rawCount", h.stats?.rawCount ?? "-");
    setText("buyCount", h.stats?.buyCount ?? "-");
    setText("targetMint", h.targetMint ?? "null");
    setText("creatorWallet", h.creator ?? "—");
    setText("lastUpdated", `Updated ${new Date().toLocaleTimeString()}`);
  }catch{
    panelStatus.health = "err";
    setText("status","error");
    statusDot("err");
  }finally{
    renderPanelHealth();
  }
}

async function loadRaw(){
  try{
    const raw = await safeJson("/debug/raw");
    panelStatus.raw = "ok";
    const body = el("latest"); body.innerHTML="";
    const list = raw.latest || [];
    el("latestEmpty").style.display = list.length ? "none":"block";
    list.forEach(x=>{
      const tr=document.createElement("tr");
      tr.innerHTML = `<td class="mono">${x.signature}</td><td class="muted mono">${x.block_time}</td>`;
      body.appendChild(tr);
    });
  }catch{
    panelStatus.raw="err";
  }finally{ renderPanelHealth(); }
}

async function loadMints(){
  try{
    const m = await safeJson("/debug/top-mints?limit=300");
    panelStatus.mints="ok";
    const body=el("mints"); body.innerHTML="";
    const top=(m.top||[]).slice(0,10);
    el("mintsEmpty").style.display = top.length ? "none":"block";
    top.forEach(x=>{
      const tr=document.createElement("tr");
      tr.innerHTML = `<td class="mono">${x.mint}</td><td>${x.count}</td>`;
      body.appendChild(tr);
    });
  }catch{
    panelStatus.mints="err";
  }finally{ renderPanelHealth(); }
}

async function loadBuyers(){
  try{
    const b = await safeJson("/buyers?limit=50");
    panelStatus.buyers="ok";
    const body=el("buyers"); body.innerHTML="";
    const list=b.buyers||[];
    el("buyersEmpty").style.display = list.length ? "none":"block";
    list.forEach(x=>{
      const tr=document.createElement("tr");
      tr.innerHTML = `
        <td class="mono">${short(x.buyer_wallet, 22)}</td>
        <td>${x.token_amount}</td>
        <td>${x.sol_spent ?? "-"}</td>
        <td class="mono">${short(x.signature, 18)}</td>
      `;
      body.appendChild(tr);
    });
  }catch{
    panelStatus.buyers="err";
  }finally{ renderPanelHealth(); }
}

async function loadActors(){
  try{
    const a = await safeJson("/memory/actors?limit=50");
    panelStatus.actors="ok";
    const body=el("actors"); body.innerHTML="";
    const actors=a.actors||[];
    setText("actorsMeta", `(${actors.length})`);
    el("actorsEmpty").style.display = actors.length ? "none":"block";

    actors.forEach(x=>{
      const tr=document.createElement("tr");
      tr.className="rowClick";
      tr.innerHTML = `
        <td>
          <div><b>${x.codename || "Unknown"}</b></div>
          <div class="muted small mono">${short(x.wallet, 32)}</div>
        </td>
        <td>${x.vibe}</td>
        <td class="mono">${x.badge_count ?? 0}</td>
        <td class="mono">${x.interactions}</td>
        <td class="mono">${x.sol_out}</td>
      `;
      tr.addEventListener("click", ()=> loadWalletTimeline(x.wallet));
      body.appendChild(tr);
    });
  }catch{
    panelStatus.actors="err";
  }finally{ renderPanelHealth(); }
}

async function loadWalletTimeline(wallet){
  selectedWallet = wallet;

  try{
    setText("walletMeta", `loading ${short(wallet, 26)}…`);

    const prevUnlocked = loadUnlocked(wallet);

    const data = await safeJson(`/memory/wallet/${wallet}`);
    const meta = data.wallet;
    const codename = data.profile?.codename || short(wallet, 26);
    setText("walletMeta", `${codename} · vibe:${meta?.vibe ?? "?"} · interactions:${meta?.interactions ?? 0}`);

    // unlocked badges (from DB)
    const badgeWrap = el("walletBadges");
    badgeWrap.innerHTML = "";
    const unlockedBadges = (data.badges || []).map(b => b.badge);
    const unlockedSet = new Set(unlockedBadges);

    // detect newly unlocked (client-side)
    const justUnlocked = unlockedBadges.filter(code => !prevUnlocked.has(code));
    if(justUnlocked.length){
      ping();
      toast("ok", "Badge unlocked", justUnlocked.map(x => CATALOG?.[x]?.label || x).join(", "));
    }
    saveUnlocked(wallet, unlockedSet);

    // show unlocked badges
    if(unlockedBadges.length){
      (data.badges || []).slice(0, 18).forEach(b=>{
        const isJust = justUnlocked.includes(b.badge);
        badgeWrap.appendChild(
          badgeNode({
            code: b.badge,
            info: b.info,
            locked: false,
            justUnlocked: isJust,
            nextUnlockText: null
          })
        );
      });
    } else {
      badgeWrap.appendChild(
        badgeNode({
          code: "NO_BADGES",
          info: { cat:"Memory", rarity:"Common", label:"No badges", desc:"This wallet has no badges yet." },
          locked: false,
          justUnlocked: false,
          nextUnlockText: null
        })
      );
    }

    // progress section (shows locked silhouettes too)
    const p = await safeJson(`/badges/progress/${wallet}`);
    setText("progressMeta", `streak:${p.streak} · interactions:${p.interactions}`);

    const box = el("progressBox");
    box.innerHTML = "";

    const order = ["REGULAR","KNOWN_ENTITY","STREAK_2","STREAK_3","STREAK_5","STREAK_10"];
    const kindLabelFor = (code)=>{
      if(code.startsWith("STREAK")) return "hours";
      return "interactions";
    };

    // render progress bars
    order.forEach(code=>{
      const it = (p.progress || []).find(x => x.badge === code);
      if(!it) return;
      box.innerHTML += progressRowHTML({
        label: it.info?.label || code,
        pct: it.pct,
        have: it.have,
        need: it.need,
        unlocked: it.unlocked,
        nextUnlockIn: it.nextUnlockIn ?? 0,
        kindLabel: kindLabelFor(code)
      });
    });

    // render locked silhouettes under progress
    const lockedToShow = order
      .map(code => (p.progress || []).find(x => x.badge === code))
      .filter(x => x && !x.unlocked);

    if(lockedToShow.length){
      const wrap = document.createElement("div");
      wrap.className = "badgeWrap";
      wrap.style.marginTop = "10px";

      lockedToShow.forEach(it=>{
        wrap.appendChild(
          badgeNode({
            code: it.badge,
            info: it.info,
            locked: true,
            justUnlocked: false,
            nextUnlockText: `${it.nextUnlockIn} ${kindLabelFor(it.badge)}`
          })
        );
      });

      box.appendChild(wrap);
    }

    // timeline
    const body=el("walletEvents");
    body.innerHTML="";
    const evs=data.events||[];
    el("walletEmpty").style.display = evs.length ? "none":"block";

    evs.slice(0,40).forEach(e=>{
      const tr=document.createElement("tr");
      tr.innerHTML = `
        <td class="muted mono">${e.block_time}</td>
        <td>${e.kind}</td>
        <td class="mono">${e.amount ?? "-"}</td>
        <td class="mono">${e.other_wallet ? short(e.other_wallet, 18) : "-"}</td>
        <td class="mono">${short(e.signature, 18)}</td>
      `;
      body.appendChild(tr);
    });

  }catch(err){
    setText("walletMeta", "failed");
    el("walletEmpty").style.display = "block";
    toast("err","Wallet load failed", String(err.message||err));
  }
}

async function loadQuest(){
  try{
    const q = await safeJson("/quest/current");
    panelStatus.quest="ok";
    currentQuest=q.quest;

    setText("questTitle", q.quest.title);
    setText("questRule", q.quest.rule);
    setText("questClaimsCount", String(q.quest.claims));
    setText("questCountdown", formatCountdown(q.quest.msLeft));

    const qb = el("questBadgeWrap");
    qb.innerHTML = "";
    qb.appendChild(
      badgeNode({
        code: q.quest.badge,
        info: q.quest.badgeInfo,
        locked: false,
        justUnlocked: false,
        nextUnlockText: null
      })
    );
  }catch{
    panelStatus.quest="err";
  }finally{ renderPanelHealth(); }
}

async function loadClaims(){
  try{
    const c = await safeJson("/quest/claims?limit=8");
    panelStatus.claims="ok";
    const body=el("claims"); body.innerHTML="";
    const list=c.claims||[];
    setText("claimsMeta", `(${list.length})`);
    el("claimsEmpty").style.display = list.length ? "none":"block";

    list.forEach(x=>{
      const tr=document.createElement("tr");
      tr.innerHTML = `
        <td class="mono"><b>#${x.rank ?? "-"}</b></td>
        <td class="mono">${short(x.wallet, 22)}</td>
        <td class="mono">${short(x.signature, 22)}</td>
        <td class="muted mono">${new Date(x.created_at).toLocaleTimeString()}</td>
      `;
      body.appendChild(tr);
    });
  }catch{
    panelStatus.claims="err";
  }finally{ renderPanelHealth(); }
}

async function claimQuest(){
  const wallet = el("claimWallet").value.trim();
  const signature = el("claimSig").value.trim();
  if(!wallet || !signature){
    toast("err","Missing fields","wallet + signature required");
    return;
  }

  try{
    const res = await safeJson("/quest/claim", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ wallet, signature })
    });

    const awardedLabels = (res.awarded || []).map(x => x.info?.label || x.badge).join(", ");
    ping();
    toast("ok", `Claimed Rank #${res.yourRank}`, `streak:${res.streak} · ${awardedLabels}`);

    loadQuest();
    loadClaims();
    loadActors();
    loadWalletTimeline(wallet);
  }catch(err){
    toast("err","Claim failed", String(err.message||err));
  }
}

async function refreshAll(){
  await loadCatalog();
  await loadHealth();
  loadQuest();
  loadClaims();
  loadActors();
  loadRaw();
  loadMints();
  loadBuyers();

  // keep wallet UI alive if selected
  if(selectedWallet) loadWalletTimeline(selectedWallet);
}

el("refreshBtn").addEventListener("click", refreshAll);
el("claimBtn").addEventListener("click", claimQuest);

refreshAll();

setInterval(()=>{
  if(currentQuest){
    currentQuest.msLeft = Math.max(0, currentQuest.msLeft - 1000);
    setText("questCountdown", formatCountdown(currentQuest.msLeft));
    if(currentQuest.msLeft === 0){
      loadQuest();
      loadClaims();
    }
  }
}, 1000);

setInterval(()=>{
  loadHealth();
  loadQuest();
  loadClaims();
  loadActors();
  loadRaw();
  loadMints();
  loadBuyers();
  if(selectedWallet) loadWalletTimeline(selectedWallet);
}, 8000);

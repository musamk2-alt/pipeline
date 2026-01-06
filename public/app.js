let selectedWallet = null;
let currentQuest = null;

function el(id) { return document.getElementById(id); }
function setText(id, t){ const x=el(id); if(x) x.textContent = t; }
function setHtml(id, h){ const x=el(id); if(x) x.innerHTML = h; }
function short(s, n = 18) { return s && s.length > n ? s.slice(0,n)+"…" : (s||""); }

async function safeJson(url, opts) {
  const r = await fetch(url, { cache:"no-store", ...(opts||{}) });
  let j=null; try{ j=await r.json(); }catch{}
  if(!r.ok) throw new Error(j?.error || `${url} -> ${r.status}`);
  return j;
}

function formatCountdown(ms){
  const s = Math.max(0, Math.floor(ms/1000));
  const m = Math.floor(s/60);
  const h = Math.floor(m/60);
  const mm = String(m%60).padStart(2,"0");
  const ss = String(s%60).padStart(2,"0");
  return `Next quest in ${h}:${mm}:${ss}`;
}

async function loadHealth(){
  try{
    const h = await safeJson("/health");
    setText("status","online");
    setText("rawCount", h.stats?.rawCount ?? "-");
    setText("buyCount", h.stats?.buyCount ?? "-");
    setText("targetMint", h.targetMint ?? "null");
    setText("creatorWallet", h.creator ?? "—");
    setText("lastUpdated", `Updated ${new Date().toLocaleTimeString()}`);
  }catch{
    setText("status","error");
  }
}

// ✅ NEW: Quest overview (A)
async function loadQuestOverview(){
  const q = await safeJson("/quest/overview");
  currentQuest = q.active;

  setText("questTitle", q.active.title);
  setText("questRule", q.active.rule);
  setText("questClaimsCount", String(q.active.claims));
  setText("questCountdown", formatCountdown(q.active.msLeft));

  // active badge
  const badgeWrap = el("questBadgeWrap");
  badgeWrap.innerHTML = `<span class="pill">badge: <b>${q.active.badgeInfo?.label || q.active.badge}</b></span>`;

  // next quests
  const next = q.next || [];
  setHtml("nextQuests", next.map((x,i)=>`
    <div style="margin-bottom:12px">
      <div class="tag">+${i+1}h · locked</div>
      <div style="font-size:16px;font-weight:900;margin-top:4px">${x.title}</div>
      <div class="muted" style="margin-top:4px">${x.rule}</div>
      <div class="row" style="margin-top:8px">
        <span class="pill">badge: <b>${x.badgeInfo?.label || x.badge}</b></span>
      </div>
    </div>
  `).join(""));

  // pool proof
  const pool = q.pool || [];
  setHtml("questPool", pool.map(x=>`
    <div style="margin-bottom:10px">
      <span class="pill">${x.title}</span>
      <span class="muted">${x.rule}</span>
    </div>
  `).join(""));
}

async function loadClaims(){
  try{
    const c = await safeJson("/quest/claims?limit=8");
    const list=c.claims||[];
    setText("claimsMeta", `(${list.length})`);
    const body=el("claims"); body.innerHTML="";
    el("claimsEmpty").style.display = list.length ? "none":"block";
    list.forEach(x=>{
      const tr=document.createElement("tr");
      tr.innerHTML = `
        <td class="mono"><b>#${x.rank ?? "-"}</b></td>
        <td class="mono">${short(x.wallet, 22)}</td>
        <td class="mono">${short(x.signature, 22)}</td>
        <td class="mono muted">${new Date(x.created_at).toLocaleTimeString()}</td>
      `;
      body.appendChild(tr);
    });
  }catch{}
}

async function loadActors(){
  try{
    const a = await safeJson("/memory/actors?limit=50");
    const actors=a.actors||[];
    setText("actorsMeta", `(${actors.length})`);
    const body=el("actors"); body.innerHTML="";
    el("actorsEmpty").style.display = actors.length ? "none":"block";

    actors.forEach(x=>{
      const tr=document.createElement("tr");
      tr.style.cursor="pointer";
      tr.innerHTML = `
        <td>
          <div><b>${x.codename || "Unknown"}</b></div>
          <div class="mono muted" style="font-size:12px">${short(x.wallet, 32)}</div>
        </td>
        <td>${x.vibe}</td>
        <td class="mono">${x.badge_count ?? 0}</td>
        <td class="mono">${x.interactions}</td>
      `;
      tr.addEventListener("click", ()=> loadWalletTimeline(x.wallet));
      body.appendChild(tr);
    });
  }catch{}
}

// ✅ wallet view now also loads quest badge progress (B)
async function loadWalletTimeline(wallet){
  selectedWallet = wallet;
  setText("walletMeta", `loading ${short(wallet, 26)}…`);

  const data = await safeJson(`/memory/wallet/${wallet}`);
  const meta = data.wallet;
  const codename = data.profile?.codename || short(wallet, 26);
  setText("walletMeta", `${codename} · vibe:${meta?.vibe ?? "?"} · interactions:${meta?.interactions ?? 0}`);

  // unlocked badges
  const badgeWrap = el("walletBadges");
  badgeWrap.innerHTML = "";
  const badges = data.badges || [];
  if(!badges.length){
    badgeWrap.innerHTML = `<span class="pill">No badges yet</span>`;
  } else {
    badges.slice(0,20).forEach(b=>{
      const span = document.createElement("span");
      span.className = "pill";
      span.textContent = b.info?.label || b.badge;
      badgeWrap.appendChild(span);
    });
  }

  // ✅ progress (includes questProgress)
  const p = await safeJson(`/badges/progress/${wallet}`);
  setText("progressMeta", `streak:${p.streak} · interactions:${p.interactions}`);

  const box = el("progressBox");
  const prog = p.progress || [];
  const qprog = p.questProgress || [];

  function bar(label, have, need, unlocked){
    const pct = need===0 ? 100 : Math.floor((Math.min(have,need)/need)*100);
    const next = unlocked ? "" : ` · next unlock in: ${Math.max(0,need-have)}`;
    return `
      <div style="margin-bottom:12px">
        <div class="mono"><b>${unlocked ? "✓" : "🔒"} ${label}</b> <span class="muted">${have}/${need}${next}</span></div>
        <div style="height:10px;border-radius:999px;background:rgba(255,255,255,0.07);overflow:hidden;margin-top:6px">
          <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#7c58ff,#00e1ff)"></div>
        </div>
      </div>
    `;
  }

  // Memory/streak bars
  const memBars = prog.map(x => bar(x.info?.label || x.badge, x.have, x.need, x.unlocked)).join("");

  // Quest badge bars (need 1 = unlock by completing quest once)
  const questBars = qprog.map(x => bar(x.info?.label || x.badge, x.have, x.need, x.unlocked)).join("");

  box.innerHTML = `
    <div class="tag">Memory & Streak</div>
    <div style="margin-top:10px">${memBars}</div>
    <div class="tag" style="margin-top:14px">Quest Badges</div>
    <div style="margin-top:10px">${questBars}</div>
  `;

  // timeline
  const body=el("walletEvents");
  body.innerHTML="";
  const evs=data.events||[];
  el("walletEmpty").style.display = evs.length ? "none":"block";

  evs.slice(0,40).forEach(e=>{
    const tr=document.createElement("tr");
    tr.innerHTML = `
      <td class="mono muted">${e.block_time}</td>
      <td>${e.kind}</td>
      <td class="mono">${e.amount ?? "-"}</td>
      <td class="mono">${e.other_wallet ? short(e.other_wallet, 18) : "-"}</td>
      <td class="mono">${short(e.signature, 18)}</td>
    `;
    body.appendChild(tr);
  });
}

async function claimQuest(){
  const wallet = el("claimWallet").value.trim();
  const signature = el("claimSig").value.trim();
  if(!wallet || !signature) return;

  try{
    await safeJson("/quest/claim", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ wallet, signature })
    });
    await loadQuestOverview();
    await loadClaims();
    await loadActors();
    await loadWalletTimeline(wallet);
  }catch(e){
    alert("Claim failed: " + (e.message||e));
  }
}

el("refreshBtn").addEventListener("click", async ()=>{
  await loadHealth();
  await loadQuestOverview();
  await loadClaims();
  await loadActors();
  if(selectedWallet) await loadWalletTimeline(selectedWallet);
});
el("claimBtn").addEventListener("click", claimQuest);

(async function boot(){
  await loadHealth();
  await loadQuestOverview();
  await loadClaims();
  await loadActors();
})();

setInterval(async ()=>{
  await loadHealth();
  await loadQuestOverview();
  await loadClaims();
  await loadActors();
  if(selectedWallet) await loadWalletTimeline(selectedWallet);
}, 15000);

setInterval(()=>{
  if(currentQuest){
    currentQuest.msLeft = Math.max(0, currentQuest.msLeft - 1000);
    setText("questCountdown", formatCountdown(currentQuest.msLeft));
  }
}, 1000);

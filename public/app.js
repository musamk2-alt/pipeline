let selectedWallet = null;
let currentQuest = null;

const $ = (id) => document.getElementById(id);
const setText = (id, t) => { const x=$(id); if(x) x.textContent = t; };
const setHtml = (id, h) => { const x=$(id); if(x) x.innerHTML = h; };
const short = (s, n=18) => (s && s.length>n ? s.slice(0,n)+"…" : (s||""));

/** ✅ Vercel prefix */
const API = "/api";

async function safeJson(url, opts){
  const r = await fetch(url, { cache:"no-store", ...(opts||{}) });
  let j=null; try{ j=await r.json(); }catch{}
  if(!r.ok) throw new Error(j?.error || `${url} -> ${r.status}`);
  return j;
}

function statusChip(state){
  const chip = $("statusChip");
  const dot = chip?.querySelector(".dot");
  if(!chip || !dot) return;

  if(state === "online"){
    dot.style.background = "var(--green, #2dff9b)";
    dot.style.boxShadow = "0 0 0 4px rgba(45,255,155,.10), 0 0 18px rgba(45,255,155,.35)";
  } else if(state === "error"){
    dot.style.background = "#ff4d7d";
    dot.style.boxShadow = "0 0 0 4px rgba(255,77,125,.10), 0 0 18px rgba(255,77,125,.35)";
  } else {
    dot.style.background = "rgba(255,255,255,.25)";
    dot.style.boxShadow = "0 0 0 4px rgba(255,255,255,.06)";
  }
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
    const h = await safeJson(`${API}/health`);
    setText("status","online");
    statusChip("online");
    setText("rawCount", h.stats?.rawCount ?? "-");
    setText("buyCount", h.stats?.buyCount ?? "-");
    setText("targetMint", h.targetMint ?? "null");
    setText("creatorWallet", h.creator ?? "—");
    setText("lastUpdated", `Updated ${new Date().toLocaleTimeString()}`);
  }catch{
    setText("status","error");
    statusChip("error");
  }
}

async function loadQuestOverview(){
  const q = await safeJson(`${API}/quest/overview`);
  currentQuest = q.active;

  setText("questTitle", q.active.title);
  setText("questRule", q.active.rule);
  setText("questClaimsCount", String(q.active.claims));
  setText("questCountdown", formatCountdown(q.active.msLeft));

  setHtml("questBadgeWrap", `
    <span class="badge"><span class="spark">💊</span> badge: <b>${q.active.badgeInfo?.label || q.active.badge}</b></span>
    <span class="badge"><span class="spark">✓</span> $EMOTIONS live system</span>
  `);

  const next = q.next || [];
  setHtml("nextQuests", next.map((x,i)=>`
    <div class="item">
      <div class="lock">+${i+1}h · locked</div>
      <div class="t">${x.title}</div>
      <div class="r">${x.rule}</div>
      <div class="chips" style="margin-top:10px">
        <span class="badge"><span class="spark">💊</span> ${x.badgeInfo?.label || x.badge}</span>
      </div>
    </div>
  `).join(""));

  const pool = q.pool || [];
  setHtml("questPool", pool.map(x=>`
    <div class="item">
      <div class="t">${x.title}</div>
      <div class="r">${x.rule}</div>
    </div>
  `).join(""));
}

async function loadClaims(){
  try{
    const c = await safeJson(`${API}/quest/claims?limit=10`);
    const list = c.claims || [];
    setText("claimsMeta", `(${list.length})`);
    const body = $("claims"); body.innerHTML="";
    $("claimsEmpty").style.display = list.length ? "none" : "block";

    // rank optioneel; als backend geen rank geeft, nummeren we gewoon zelf
    list.forEach((x, idx)=>{
      const tr=document.createElement("tr");
      tr.innerHTML = `
        <td class="mono"><b>#${x.rank ?? (idx+1)}</b></td>
        <td class="mono">${short(x.wallet, 28)}</td>
        <td class="mono">${short(x.signature, 28)}</td>
        <td class="mono" style="opacity:.7">${x.created_at ? new Date(x.created_at).toLocaleTimeString() : "-"}</td>
      `;
      body.appendChild(tr);
    });
  }catch{}
}

async function loadActors(){
  try{
    const a = await safeJson(`${API}/memory/actors?limit=50`);
    const actors = a.actors || [];
    setText("actorsMeta", `(${actors.length})`);

    const body = $("actors"); body.innerHTML="";
    $("actorsEmpty").style.display = actors.length ? "none" : "block";

    actors.forEach(x=>{
      const tr=document.createElement("tr");
      tr.style.cursor="pointer";
      tr.innerHTML = `
        <td>
          <div style="font-weight:900">${x.codename || "Unknown"}</div>
          <div class="mono" style="opacity:.65;font-size:12px">${short(x.wallet, 36)}</div>
        </td>
        <td>${x.vibe}</td>
        <td class="mono">${x.badge_count ?? 0}</td>
        <td class="mono">${x.interactions ?? 0}</td>
      `;
      tr.addEventListener("click", ()=> loadWalletTimeline(x.wallet));
      body.appendChild(tr);
    });
  }catch{}
}

function progressRow(label, have, need, unlocked){
  const pct = need===0 ? 100 : Math.floor((Math.min(have,need)/need)*100);
  const remaining = Math.max(0, need - have);
  return `
    <div class="progressRow">
      <div class="progressTop">
        <div><b>${unlocked ? "✓" : "🔒"} ${label}</b></div>
        <div style="opacity:.7">${have}/${need}${unlocked ? "" : ` · next unlock in ${remaining}`}</div>
      </div>
      <div class="barOuter"><div class="barInner" style="width:${pct}%"></div></div>
    </div>
  `;
}

async function loadWalletTimeline(wallet){
  selectedWallet = wallet;
  setText("walletMeta", `loading ${short(wallet, 26)}…`);

  const data = await safeJson(`${API}/memory/wallet/${wallet}`);
  const meta = data.wallet;
  const codename = data.profile?.codename || data.wallet?.codename || short(wallet, 26);

  setText(
    "walletMeta",
    `${codename} · vibe:${meta?.vibe ?? "?"} · interactions:${meta?.interactions ?? 0}`
  );

  const badgeWrap = $("walletBadges");
  badgeWrap.innerHTML = "";
  const badges = data.badges || [];

  if(!badges.length){
    badgeWrap.innerHTML = `<span class="badge">No badges yet</span>`;
  }else{
    badges.slice(0,20).forEach(b=>{
      const s=document.createElement("span");
      s.className="badge";
      s.innerHTML = `<span class="spark">💊</span> ${b.info?.label || b.badge}`;
      badgeWrap.appendChild(s);
    });
  }

  const p = await safeJson(`${API}/badges/progress/${wallet}`);
  setText("progressMeta", `interactions:${p.interactions ?? 0}`);

  const box = $("progressBox");
  const prog = p.progress || [];
  const qprog = p.questProgress || [];

  const mem = prog.map(x => progressRow(x.info?.label || x.badge, x.have, x.need, x.unlocked)).join("");
  const quest = qprog.map(x => progressRow(x.info?.label || x.badge, x.have, x.need, x.unlocked)).join("");

  box.innerHTML = `
    <div class="small" style="padding:12px 12px 0">Memory</div>
    ${mem || `<div class="empty" style="display:block">No progress yet.</div>`}
    <div class="small" style="padding:12px 12px 0">Quest Badges</div>
    ${quest || `<div class="empty" style="display:block">No quest badges yet.</div>`}
  `;

  const body = $("walletEvents");
  body.innerHTML="";
  const evs = data.events || [];
  $("walletEmpty").style.display = evs.length ? "none" : "block";

  evs.slice(0,40).forEach(e=>{
    const tr=document.createElement("tr");
    tr.innerHTML = `
      <td class="mono" style="opacity:.7">${e.block_time ?? "-"}</td>
      <td>${e.kind ?? "-"}</td>
      <td class="mono">${e.amount ?? "-"}</td>
      <td class="mono">${e.other_wallet ? short(e.other_wallet, 18) : "-"}</td>
      <td class="mono">${short(e.signature, 18)}</td>
    `;
    body.appendChild(tr);
  });
}

async function claimQuest(){
  const wallet = $("claimWallet").value.trim();
  const signature = $("claimSig").value.trim();
  if(!wallet || !signature) return;

  try{
    await safeJson(`${API}/quest/claim`, {
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

$("refreshBtn")?.addEventListener("click", async ()=>{
  await loadHealth();
  await loadQuestOverview();
  await loadClaims();
  await loadActors();
  if(selectedWallet) await loadWalletTimeline(selectedWallet);
});

$("claimBtn")?.addEventListener("click", claimQuest);

(async function boot(){
  statusChip("loading");
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

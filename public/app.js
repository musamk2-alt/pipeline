async function getJson(url) {
  const r = await fetch(url, { cache: "no-store" });
  return await r.json();
}

function short(s, n = 10) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

async function tick() {
  try {
    const health = await getJson("/health");
    document.getElementById("status").textContent = health.ok ? "online" : "error";
    document.getElementById("status").className = health.ok ? "ok" : "warn";
    document.getElementById("rawCount").textContent = health.stats?.rawCount ?? "-";
    document.getElementById("buyCount").textContent = health.stats?.buyCount ?? "-";
    document.getElementById("targetMint").textContent = health.targetMint ?? "null";

    const raw = await getJson("/debug/raw");
    const latestBody = document.getElementById("latest");
    latestBody.innerHTML = "";
    (raw.latest || []).forEach((x) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td><code>${x.signature}</code></td><td class="muted">${x.block_time}</td>`;
      latestBody.appendChild(tr);
    });

    const mints = await getJson("/debug/top-mints?limit=300");
    const mintBody = document.getElementById("mints");
    mintBody.innerHTML = "";
    (mints.top || []).slice(0, 10).forEach((x) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td><code>${x.mint}</code></td><td>${x.count}</td>`;
      mintBody.appendChild(tr);
    });

    const buyers = await getJson("/buyers?limit=50");
    const buyerBody = document.getElementById("buyers");
    buyerBody.innerHTML = "";
    (buyers.buyers || []).forEach((b) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><code>${short(b.buyer_wallet, 18)}</code></td>
        <td>${b.token_amount}</td>
        <td>${b.sol_spent ?? "-"}</td>
        <td><code>${short(b.signature, 18)}</code></td>
      `;
      buyerBody.appendChild(tr);
    });
  } catch (e) {
    document.getElementById("status").textContent = "error";
    document.getElementById("status").className = "warn";
  }
}

tick();
setInterval(tick, 2500);

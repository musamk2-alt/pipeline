export const QUEST_POOL = [
  { id: "SHOW_RESPECT", title: "SHOW RESPECT", rule: "Send at least 0.0005 SOL to the creator wallet.", badge: "Respect Paid" },
  { id: "FIRST_BLOOD", title: "FIRST BLOOD", rule: "Send at least 0.001 SOL to the creator wallet.", badge: "Early Supporter" },
  { id: "SIGNAL_CHECK", title: "SIGNAL CHECK", rule: "Any SOL interaction to the creator wallet (>= 0.0001 SOL).", badge: "Signal Sender" }
];

export function nowHourIndex() {
  return Math.floor(Date.now() / 3600000);
}

export function msToNextHour() {
  const d = new Date();
  const next = new Date(d);
  next.setUTCMinutes(60, 0, 0);
  return next.getTime() - d.getTime();
}

export function activeQuestForHour(hourIndex) {
  return QUEST_POOL[hourIndex % QUEST_POOL.length];
}

export function nextQuests(hourIndex, n = 3) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push(activeQuestForHour(hourIndex + i));
  return out;
}

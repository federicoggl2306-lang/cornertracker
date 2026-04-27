const https = require("https");
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const API_KEY = process.env.API_KEY;
let followedMatches = new Set();
let lastSeenEvents = {};
let lastUpdateId = 0;

function sendTelegram(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: CHAT_ID, text: text, parse_mode: "HTML" });
    const options = { hostname: "api.telegram.org", path: `/bot${TELEGRAM_TOKEN}/sendMessage`, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } };
    const req = https.request(options, (res) => { let data = ""; res.on("data", (chunk) => (data += chunk)); res.on("end", () => resolve(JSON.parse(data))); });
    req.on("error", reject); req.write(body); req.end();
  });
}

function getLiveMatches() {
  return new Promise((resolve, reject) => {
    const options = { hostname: "v3.football.api-sports.io", path: "/fixtures?live=all", method: "GET", headers: { "x-apisports-key": API_KEY } };
    const req = https.request(options, (res) => { let data = ""; res.on("data", (chunk) => (data += chunk)); res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } }); });
    req.on("error", reject); req.end();
  });
}

function getMatchEvents(fixtureId) {
  return new Promise((resolve, reject) => {
    const options = { hostname: "v3.football.api-sports.io", path: `/fixtures/events?fixture=${fixtureId}`, method: "GET", headers: { "x-apisports-key": API_KEY } };
    const req = https.request(options, (res) => { let data = ""; res.on("data", (chunk) => (data += chunk)); res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } }); });
    req.on("error", reject); req.end();
  });
}

async function checkCorners() {
  if (followedMatches.size === 0) return;
  for (const matchId of followedMatches) {
    try {
      const data = await getMatchEvents(matchId);
      const events = data.response || [];
      if (!lastSeenEvents[matchId]) lastSeenEvents[matchId] = new Set();
      const cornerEvents = events.filter((e) => e.type === "Corner" || e.detail === "Corner");
      for (const ev of cornerEvents) {
        const eventId = `${ev.team.id}-${ev.time.elapsed}-corner`;
        if (!lastSeenEvents[matchId].has(eventId)) {
          lastSeenEvents[matchId].add(eventId);
          const msg = `🚩 <b>CORNER!</b>\n\n⚽ Squadra: <b>${ev.team.name}</b>\n⏱ Minuto: <b>${ev.time.elapsed}'</b>`;
          await sendTelegram(msg);
          console.log(`Notifica corner: ${ev.team.name} al ${ev.time.elapsed}'`);
        }
      }
    } catch (err) { console.error(`Errore partita ${matchId}:`, err.message); }
  }
}

async function getUpdates() {
  return new Promise((resolve) => {
    const options = { hostname: "api.telegram.org", path: `/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=10`, method: "GET" };
    const req = https.request(options, (res) => { let data = ""; res.on("data", (chunk) => (data += chunk)); res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({ result: [] }); } }); });
    req.on("error", () => resolve({ result: [] })); req.end();
  });
}

async function handleCommands() {
  const data = await getUpdates();
  const updates = data.result || [];
  for (const update of updates) {
    lastUpdateId = update.update_id;
    const msg = update.message;
    if (!msg || !msg.text) continue;
    const text = msg.text.trim();

    if (text === "/start") {
      await sendTelegram("🚩 <b>CornerTracker attivo!</b>\n\nComandi:\n/live — partite in corso\n/segui 12345 — segui una partita\n/smetti 12345 — smetti di seguire\n/seguite — cosa stai seguendo\n/stop — ferma tutto");
    } else if (text === "/live") {
      await sendTelegram("⏳ Carico le partite live...");
      try {
        const d = await getLiveMatches();
        const matches = d.response || [];
        if (matches.length === 0) { await sendTelegram("😴 Nessuna partita live ora."); }
        else {
          let m = "⚽ <b>Partite live:</b>\n\n";
          matches.slice(0, 10).forEach((f) => {
            m += `🆔 <code>${f.fixture.id}</code>\n`;
            m += `${f.teams.home.name} ${f.goals.home ?? 0}–${f.goals.away ?? 0} ${f.teams.away.name}\n`;
            m += `⏱ ${f.fixture.status.elapsed ?? "?"}' — scrivi: /segui ${f.fixture.id}\n\n`;
          });
          await sendTelegram(m);
        }
      } catch(e) { await sendTelegram("❌ Errore: " + e.message); }
    } else if (text.startsWith("/segui ")) {
      const id = text.split(" ")[1];
      if (!id || isNaN(id)) { await sendTelegram("⚠️ Usa: /segui 12345"); }
      else { followedMatches.add(id); lastSeenEvents[id] = new Set(); await sendTelegram(`✅ Segui la partita <code>${id}</code>\n🚩 Riceverai notifiche per ogni corner!`); }
    } else if (text.startsWith("/smetti ")) {
      const id = text.split(" ")[1];
      followedMatches.delete(id);
      await sendTelegram(`🛑 Hai smesso di seguire la partita <code>${id}</code>`);
    } else if (text === "/seguite") {
      if (followedMatches.size === 0) { await sendTelegram("📋 Non segui nessuna partita.\nUsa /live per vedere le partite."); }
      else { await sendTelegram(`📋 <b>Seguite:</b>\n${[...followedMatches].map(id => `• <code>${id}</code>`).join("\n")}`); }
    } else if (text === "/stop") {
      followedMatches.clear();
      await sendTelegram("🛑 Tracking fermato.");
    }
  }
}

async function main() {
  console.log("🚩 CornerTracker avviato!");
  await sendTelegram("🚩 <b>CornerTracker online!</b>\nScrivi /live per vedere le partite in corso.");
  setInterval(handleCommands, 3000);
  setInterval(checkCorners, 30000);
}

main().catch(console.error);

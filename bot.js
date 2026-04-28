// ============================================
// CORNERTRACKER BOT v3 - Fix live + tutto funzionante
// ============================================

const https = require("https");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const API_KEY = process.env.API_KEY;

let followedMatches = new Set();
let lastSeenEvents = {};
let lastUpdateId = 0;
let matchInfo = {};

// ============================================
// TELEGRAM
// ============================================

function sendTelegram(text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML" });
    const opts = {
      hostname: "api.telegram.org",
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    };
    const req = https.request(opts, (res) => {
      let d = ""; res.on("data", c => d += c); res.on("end", () => resolve());
    });
    req.on("error", () => resolve());
    req.write(body); req.end();
  });
}

function sendMediaGroup(photos) {
  return new Promise((resolve) => {
    const media = photos.map((p, i) => ({
      type: "photo", media: p.url,
      ...(i === 0 ? { caption: p.caption, parse_mode: "HTML" } : {}),
    }));
    const body = JSON.stringify({ chat_id: CHAT_ID, media });
    const opts = {
      hostname: "api.telegram.org",
      path: `/bot${TELEGRAM_TOKEN}/sendMediaGroup`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    };
    const req = https.request(opts, (res) => {
      let d = ""; res.on("data", c => d += c); res.on("end", () => resolve());
    });
    req.on("error", () => resolve());
    req.write(body); req.end();
  });
}

// ============================================
// API FOOTBALL
// ============================================

function apiRequest(path) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "v3.football.api-sports.io",
      path,
      method: "GET",
      headers: { "x-apisports-key": API_KEY },
    };
    const req = https.request(opts, (res) => {
      let data = ""; res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on("error", reject); req.end();
  });
}

function todayDate() {
  return new Date().toISOString().split("T")[0];
}

// Partite live — compatibile col piano gratuito API Football
async function getLiveMatches() {
  // Tentativo 1: live=all
  try {
    const liveData = await apiRequest("/fixtures?live=all");
    const live = liveData.response || [];
    console.log("Live=all risultati:", live.length);
    if (live.length > 0) return live;
  } catch(e) { console.error("Errore live=all:", e.message); }

  // Tentativo 2: partite di oggi per lega specifica (compatibile col piano free)
  const TODAY = todayDate();
  const SEASON = new Date().getFullYear();
  const LEGHE = [135, 39, 140, 78, 61, 2, 3];
  let allMatches = [];

  for (const leagueId of LEGHE) {
    try {
      const data = await apiRequest(`/fixtures?league=${leagueId}&season=${SEASON}&date=${TODAY}`);
      const matches = data.response || [];
      console.log(`Lega ${leagueId} oggi: ${matches.length} partite`);
      allMatches = allMatches.concat(matches);
    } catch(e) { console.error(`Errore lega ${leagueId}:`, e.message); }
  }

  const live = allMatches.filter(f => ["1H","2H","HT","ET","P"].includes(f.fixture.status.short));
  if (live.length > 0) return live;
  const upcoming = allMatches.filter(f => ["NS","TBD"].includes(f.fixture.status.short));
  if (upcoming.length > 0) return upcoming;
  return allMatches;
}

function getMatchEvents(fixtureId) {
  return apiRequest(`/fixtures/events?fixture=${fixtureId}`);
}

function getMatchDetails(fixtureId) {
  return apiRequest(`/fixtures?id=${fixtureId}`);
}

// ============================================
// FORMATTAZIONE
// ============================================

function formatMatch(f) {
  const home = f.teams.home.name;
  const away = f.teams.away.name;
  const scoreH = f.goals.home ?? 0;
  const scoreA = f.goals.away ?? 0;
  const minute = f.fixture.status.elapsed;
  const id = f.fixture.id;
  const league = f.league.name;
  const status = f.fixture.status.short;
  const isLive = ["1H","2H","HT","ET","P"].includes(status);
  const timeStr = isLive
    ? `🔴 ${minute}'`
    : new Date(f.fixture.date).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Rome" });

  return (
    `🏆 <b>${league}</b>\n` +
    `⚽ <b>${home}</b> ${isLive ? scoreH + "–" + scoreA : "vs"} <b>${away}</b>\n` +
    `${timeStr}\n` +
    `📲 /segui_${id}\n`
  );
}

function formatCornerNotification(ev, info, homeCorners, awayCorners) {
  const home = info?.home?.name || "Casa";
  const away = info?.away?.name || "Ospite";
  const scoreH = info?.scoreH ?? "-";
  const scoreA = info?.scoreA ?? "-";
  const league = info?.league || "";
  const total = (homeCorners || 0) + (awayCorners || 0);

  return (
    `🚩 <b>CORNER!</b>\n` +
    `━━━━━━━━━━━━━━\n` +
    `🏆 ${league}\n` +
    `⚽ ${home} ${scoreH}–${scoreA} ${away}\n` +
    `━━━━━━━━━━━━━━\n` +
    `👟 Squadra: <b>${ev.team.name}</b>\n` +
    `⏱ Minuto: <b>${ev.time.elapsed}'</b>\n` +
    `━━━━━━━━━━━━━━\n` +
    `🚩 Corner: <b>${home} ${homeCorners} – ${awayCorners} ${away}</b>\n` +
    `📐 Totale: <b>${total}</b>\n` +
    `━━━━━━━━━━━━━━\n` +
    `📊 /stats_${info?.id}`
  );
}

// ============================================
// CONTROLLO CORNER
// ============================================

async function checkCorners() {
  if (followedMatches.size === 0) return;

  for (const matchId of followedMatches) {
    try {
      // Aggiorna dettagli partita (punteggio, loghi)
      try {
        const details = await getMatchDetails(matchId);
        const f = details.response?.[0];
        if (f) {
          matchInfo[matchId] = {
            id: matchId,
            home: f.teams.home,
            away: f.teams.away,
            scoreH: f.goals.home ?? 0,
            scoreA: f.goals.away ?? 0,
            league: f.league.name,
          };
        }
      } catch(e) {}

      const data = await getMatchEvents(matchId);
      const events = data.response || [];
      if (!lastSeenEvents[matchId]) lastSeenEvents[matchId] = new Set();

      // Controlla tutti e tre i formati possibili dell'API
      const cornerEvents = events.filter(e =>
        e.type === "Corner" ||
        e.type === "corner" ||
        e.detail === "Corner" ||
        e.detail === "corner"
      );

      const info = matchInfo[matchId];
      const homeCorners = cornerEvents.filter(e => e.team.id === info?.home?.id).length;
      const awayCorners = cornerEvents.filter(e => e.team.id === info?.away?.id).length;

      for (const ev of cornerEvents) {
        const eventId = `${ev.team.id}-${ev.time.elapsed}-corner`;
        if (!lastSeenEvents[matchId].has(eventId)) {
          lastSeenEvents[matchId].add(eventId);

          const caption = formatCornerNotification(ev, info, homeCorners, awayCorners);

          try {
            if (info?.home?.logo && info?.away?.logo) {
              await sendMediaGroup([
                { url: info.home.logo, caption },
                { url: info.away.logo },
              ]);
            } else {
              await sendTelegram(caption);
            }
          } catch(e) {
            await sendTelegram(caption);
          }

          console.log(`✅ Corner: ${ev.team.name} al ${ev.time.elapsed}'`);
        }
      }
    } catch(err) {
      console.error(`Errore partita ${matchId}:`, err.message);
    }
  }
}

// ============================================
// COMANDI
// ============================================

async function getUpdates() {
  return new Promise((resolve) => {
    const opts = {
      hostname: "api.telegram.org",
      path: `/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=10`,
      method: "GET",
    };
    const req = https.request(opts, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({ result: [] }); } });
    });
    req.on("error", () => resolve({ result: [] })); req.end();
  });
}

async function handleCommands() {
  const data = await getUpdates();
  for (const update of (data.result || [])) {
    lastUpdateId = update.update_id;
    const msg = update.message;
    if (!msg?.text) continue;
    const text = msg.text.trim();
    console.log("Comando:", text);

    // /start
    if (text === "/start") {
      await sendTelegram(
        "🚩 <b>CornerTracker v3</b>\n\n" +
        "⚽ /live — partite di oggi\n" +
        "🔍 /cerca Inter — cerca una squadra\n" +
        "📲 /segui_ID — segui una partita\n" +
        "🛑 /smetti_ID — smetti di seguire\n" +
        "📋 /seguite — partite seguite\n" +
        "📊 /stats_ID — statistiche partita\n" +
        "🔴 /stop — ferma tutto\n\n" +
        "💡 <i>Usa /cerca per trovare subito la tua squadra!</i>"
      );
    }

    // /live
    else if (text === "/live") {
      await sendTelegram("⏳ Carico le partite...");
      try {
        const matches = await getLiveMatches();
        if (matches.length === 0) {
          await sendTelegram("😴 Nessuna partita disponibile oggi.\nRiprova più tardi!");
        } else {
          const live = matches.filter(f => ["1H","2H","HT","ET","P"].includes(f.fixture.status.short));
          const upcoming = matches.filter(f => ["NS","TBD"].includes(f.fixture.status.short));
          const finished = matches.filter(f => ["FT","AET","PEN"].includes(f.fixture.status.short));

          if (live.length > 0) {
            let msg = `🔴 <b>Partite LIVE (${live.length})</b>\n\n`;
            live.slice(0, 8).forEach(f => { msg += formatMatch(f) + "\n"; });
            await sendTelegram(msg);
          }
          if (upcoming.length > 0) {
            let msg = `🕐 <b>Prossime oggi (${upcoming.length})</b>\n\n`;
            upcoming.slice(0, 8).forEach(f => { msg += formatMatch(f) + "\n"; });
            await sendTelegram(msg);
          }
          if (live.length === 0 && upcoming.length === 0 && finished.length > 0) {
            let msg = `✅ <b>Partite di oggi già finite (${finished.length})</b>\n\n`;
            finished.slice(0, 8).forEach(f => { msg += formatMatch(f) + "\n"; });
            await sendTelegram(msg);
          }
        }
      } catch(e) {
        console.error(e);
        await sendTelegram("❌ Errore nel caricare le partite. Riprova tra poco.");
      }
    }

    // /cerca
    else if (text.startsWith("/cerca")) {
      const query = text.replace("/cerca", "").trim();
      if (!query) { await sendTelegram("⚠️ Scrivi il nome, es:\n/cerca Inter"); return; }
      await sendTelegram(`🔍 Cerco "${query}"...`);
      try {
        const matches = await getLiveMatches();
        const found = matches.filter(f =>
          f.teams.home.name.toLowerCase().includes(query.toLowerCase()) ||
          f.teams.away.name.toLowerCase().includes(query.toLowerCase())
        );
        if (found.length === 0) {
          await sendTelegram(`😔 Nessuna partita trovata con "${query}" oggi.`);
        } else {
          let msg = `🔍 <b>Risultati per "${query}":</b>\n\n`;
          found.forEach(f => { msg += formatMatch(f) + "\n"; });
          await sendTelegram(msg);
        }
      } catch(e) { await sendTelegram("❌ Errore nella ricerca."); }
    }

    // /segui_ID
    else if (text.startsWith("/segui_") || text.startsWith("/segui ")) {
      const id = text.replace("/segui_", "").replace("/segui ", "").trim();
      if (!id || isNaN(id)) {
        await sendTelegram("⚠️ Usa: /segui_12345");
      } else {
        followedMatches.add(id);
        lastSeenEvents[id] = new Set();
        try {
          const details = await getMatchDetails(id);
          const f = details.response?.[0];
          if (f) {
            matchInfo[id] = {
              id, home: f.teams.home, away: f.teams.away,
              scoreH: f.goals.home ?? 0, scoreA: f.goals.away ?? 0,
              league: f.league.name,
            };
            const caption =
              `✅ <b>Stai seguendo:</b>\n\n` +
              `🏆 ${f.league.name}\n` +
              `⚽ <b>${f.teams.home.name}</b> vs <b>${f.teams.away.name}</b>\n\n` +
              `🚩 Riceverai una notifica per ogni corner!\n` +
              `🔴 Per smettere: /smetti_${id}`;
            try {
              await sendMediaGroup([
                { url: f.teams.home.logo, caption },
                { url: f.teams.away.logo },
              ]);
            } catch(e) { await sendTelegram(caption); }
          } else {
            await sendTelegram(`✅ Stai seguendo la partita <code>${id}</code>\n🚩 Notifiche corner attive!\n🔴 /smetti_${id}`);
          }
        } catch(e) {
          await sendTelegram(`✅ Stai seguendo la partita <code>${id}</code>\n🚩 Notifiche corner attive!`);
        }
      }
    }

    // /smetti_ID
    else if (text.startsWith("/smetti_") || text.startsWith("/smetti ")) {
      const id = text.replace("/smetti_", "").replace("/smetti ", "").trim();
      followedMatches.delete(id);
      const info = matchInfo[id];
      const nome = info ? `${info.home.name} vs ${info.away.name}` : id;
      await sendTelegram(`🛑 Hai smesso di seguire:\n<b>${nome}</b>`);
    }

    // /seguite
    else if (text === "/seguite") {
      if (followedMatches.size === 0) {
        await sendTelegram("📋 Non segui nessuna partita.\n💡 Usa /live o /cerca per trovarne una!");
      } else {
        let msg = "📋 <b>Partite seguite:</b>\n\n";
        for (const id of followedMatches) {
          const info = matchInfo[id];
          if (info) {
            msg += `⚽ <b>${info.home.name}</b> ${info.scoreH}–${info.scoreA} <b>${info.away.name}</b>\n`;
            msg += `🏆 ${info.league} — /smetti_${id}\n\n`;
          } else {
            msg += `• Partita <code>${id}</code> — /smetti_${id}\n\n`;
          }
        }
        await sendTelegram(msg);
      }
    }

    // /stats_ID
    else if (text.startsWith("/stats_") || text.startsWith("/stats ")) {
      const id = text.replace("/stats_", "").replace("/stats ", "").trim();
      try {
        const details = await getMatchDetails(id);
        const f = details.response?.[0];
        if (!f) { await sendTelegram("❌ Partita non trovata."); continue; }
        const evData = await getMatchEvents(id);
        const events = evData.response || [];
        const corners = events.filter(e => e.type === "Corner" || e.detail === "Corner");
        const homeC = corners.filter(e => e.team.id === f.teams.home.id).length;
        const awayC = corners.filter(e => e.team.id === f.teams.away.id).length;
        const goals = events.filter(e => e.type === "Goal").length;
        const cards = events.filter(e => e.type === "Card").length;
        const msg =
          `📊 <b>Statistiche</b>\n` +
          `━━━━━━━━━━━━━━\n` +
          `🏆 ${f.league.name}\n` +
          `⚽ <b>${f.teams.home.name}</b> ${f.goals.home ?? 0}–${f.goals.away ?? 0} <b>${f.teams.away.name}</b>\n` +
          `⏱ ${f.fixture.status.elapsed ?? "?"}'\n` +
          `━━━━━━━━━━━━━━\n` +
          `🚩 Corner: ${homeC} – ${awayC} (tot. ${homeC + awayC})\n` +
          `⚽ Gol: ${goals}\n` +
          `🟨 Cartellini: ${cards}\n` +
          `━━━━━━━━━━━━━━`;
        try {
          await sendMediaGroup([
            { url: f.teams.home.logo, caption: msg },
            { url: f.teams.away.logo },
          ]);
        } catch(e) { await sendTelegram(msg); }
      } catch(e) { await sendTelegram("❌ Errore statistiche."); }
    }

    // /stop
    else if (text === "/stop") {
      followedMatches.clear();
      await sendTelegram("🔴 <b>Tracking fermato.</b>\nTutte le partite rimosse.\n\nScrivi /live per ricominciare!");
    }

    else {
      await sendTelegram("❓ Comando non riconosciuto.\nScrivi /start per i comandi disponibili.");
    }
  }
}

// ============================================
// AVVIO
// ============================================

async function main() {
  console.log("🚩 CornerTracker v3 avviato!");
  await sendTelegram(
    "🚩 <b>CornerTracker v3 online!</b>\n\n" +
    "Scrivi /live per vedere le partite di oggi\n" +
    "oppure /cerca [squadra] per cercare subito!"
  );
  setInterval(handleCommands, 3000);
  setInterval(checkCorners, 30000);
}

main().catch(console.error);

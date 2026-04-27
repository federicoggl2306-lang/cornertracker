// ============================================
// CORNERTRACKER BOT v2 - Con ricerca, messaggi belli e loghi
// ============================================

const https = require("https");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const API_KEY = process.env.API_KEY;

let followedMatches = new Set();
let lastSeenEvents = {};
let lastUpdateId = 0;

// Salva info partite per usarle nelle notifiche
let matchInfo = {};

// ============================================
// FUNZIONI TELEGRAM
// ============================================

// Manda messaggio testo
function sendTelegram(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: CHAT_ID, text: text, parse_mode: "HTML" });
    const options = {
      hostname: "api.telegram.org",
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(JSON.parse(data)));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Manda foto con didascalia (per i loghi)
function sendPhoto(photoUrl, caption) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      chat_id: CHAT_ID,
      photo: photoUrl,
      caption: caption,
      parse_mode: "HTML",
    });
    const options = {
      hostname: "api.telegram.org",
      path: `/bot${TELEGRAM_TOKEN}/sendPhoto`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(JSON.parse(data)));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Manda media group (due foto insieme = loghi delle due squadre)
function sendMediaGroup(photos) {
  return new Promise((resolve, reject) => {
    const media = photos.map((p, i) => ({
      type: "photo",
      media: p.url,
      ...(i === 0 ? { caption: p.caption, parse_mode: "HTML" } : {}),
    }));
    const body = JSON.stringify({ chat_id: CHAT_ID, media: media });
    const options = {
      hostname: "api.telegram.org",
      path: `/bot${TELEGRAM_TOKEN}/sendMediaGroup`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(JSON.parse(data)));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ============================================
// FUNZIONI API FOOTBALL
// ============================================

function apiRequest(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "v3.football.api-sports.io",
      path: path,
      method: "GET",
      headers: { "x-apisports-key": API_KEY },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on("error", reject);
    req.end();
  });
}

// Partite live (tutte)
function getLiveMatches() {
  return apiRequest("/fixtures?live=all");
}

// Cerca partite live per nome squadra
function searchLiveByTeam(teamName) {
  return apiRequest(`/fixtures?live=all&search=${encodeURIComponent(teamName)}`);
}

// Eventi di una partita
function getMatchEvents(fixtureId) {
  return apiRequest(`/fixtures/events?fixture=${fixtureId}`);
}

// Dettagli partita (per avere i loghi)
function getMatchDetails(fixtureId) {
  return apiRequest(`/fixtures?id=${fixtureId}`);
}

// ============================================
// FORMATTAZIONE MESSAGGI BELLI
// ============================================

// Formatta una partita per la lista /live
function formatMatch(f) {
  const home = f.teams.home.name;
  const away = f.teams.away.name;
  const scoreH = f.goals.home ?? 0;
  const scoreA = f.goals.away ?? 0;
  const minute = f.fixture.status.elapsed ?? "?";
  const id = f.fixture.id;
  const league = f.league.name;
  const country = f.league.country;

  return (
    `🏆 <b>${league}</b> — ${country}\n` +
    `⚽ <b>${home}</b> ${scoreH} – ${scoreA} <b>${away}</b>\n` +
    `⏱ Minuto: <b>${minute}'</b>\n` +
    `📲 /segui_${id}\n`
  );
}

// Messaggio notifica corner (bello) con contatore
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
      const data = await getMatchEvents(matchId);
      const events = data.response || [];

      if (!lastSeenEvents[matchId]) lastSeenEvents[matchId] = new Set();

      // Aggiorna il punteggio in tempo reale
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
      } catch(e) { /* ignora errori dettagli */ }

      const cornerEvents = events.filter(
        (e) => e.type === "Corner" || e.detail === "Corner"
      );

      for (const ev of cornerEvents) {
        const eventId = `${ev.team.id}-${ev.time.elapsed}-corner`;

        if (!lastSeenEvents[matchId].has(eventId)) {
          lastSeenEvents[matchId].add(eventId);

          const info = matchInfo[matchId];
          const homeCorners = cornerEvents.filter(e => e.team.id === info?.home?.id).length;
          const awayCorners = cornerEvents.filter(e => e.team.id === info?.away?.id).length;
          const caption = formatCornerNotification(ev, info, homeCorners, awayCorners);

          // Prova a mandare con i loghi delle due squadre
          try {
            if (info?.home?.logo && info?.away?.logo) {
              await sendMediaGroup([
                { url: info.home.logo, caption: caption },
                { url: info.away.logo },
              ]);
            } else {
              await sendTelegram(caption);
            }
          } catch(e) {
            // Se fallisce con le foto, manda solo testo
            await sendTelegram(caption);
          }

          console.log(`✅ Corner notificato: ${ev.team.name} al ${ev.time.elapsed}'`);
        }
      }
    } catch (err) {
      console.error(`Errore partita ${matchId}:`, err.message);
    }
  }
}

// ============================================
// GESTIONE COMANDI
// ============================================

async function getUpdates() {
  return new Promise((resolve) => {
    const options = {
      hostname: "api.telegram.org",
      path: `/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=10`,
      method: "GET",
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({ result: [] }); } });
    });
    req.on("error", () => resolve({ result: [] }));
    req.end();
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
    console.log("Comando:", text);

    // /start
    if (text === "/start") {
      await sendTelegram(
        "🚩 <b>CornerTracker v2</b>\n\n" +
        "Comandi disponibili:\n\n" +
        "⚽ /live — tutte le partite in corso\n" +
        "🔍 /cerca Inter — cerca una squadra specifica\n" +
        "📲 /segui_12345 — segui una partita\n" +
        "🛑 /smetti_12345 — smetti di seguire\n" +
        "📋 /seguite — cosa stai seguendo\n" +
        "📊 /stats_12345 — statistiche partita\n" +
        "🔴 /stop — ferma tutto\n\n" +
        "💡 <i>Suggerimento: usa /cerca per trovare subito la tua squadra!</i>"
      );
    }

    // /live
    else if (text === "/live") {
      await sendTelegram("⏳ Carico le partite live...");
      try {
        const d = await getLiveMatches();
        const matches = d.response || [];
        if (matches.length === 0) {
          await sendTelegram("😴 Nessuna partita live in questo momento.\nRiprova più tardi!");
        } else {
          // Manda max 8 partite per non appesantire
          let msg = `⚽ <b>Partite live (${matches.length} totali)</b>\n\n`;
          matches.slice(0, 8).forEach((f) => { msg += formatMatch(f) + "\n"; });
          if (matches.length > 8) msg += `<i>...e altre ${matches.length - 8} partite. Usa /cerca per trovare la tua squadra!</i>`;
          await sendTelegram(msg);
        }
      } catch(e) { await sendTelegram("❌ Errore nel caricare le partite."); }
    }

    // /cerca [nome squadra]
    else if (text.startsWith("/cerca ") || text.startsWith("/cerca@")) {
      const query = text.replace("/cerca", "").trim();
      if (!query) { await sendTelegram("⚠️ Scrivi il nome della squadra, es:\n/cerca Inter"); }
      else {
        await sendTelegram(`🔍 Cerco "${query}" tra le partite live...`);
        try {
          const d = await getLiveMatches();
          const all = d.response || [];
          // Filtra per nome squadra (case insensitive)
          const found = all.filter((f) =>
            f.teams.home.name.toLowerCase().includes(query.toLowerCase()) ||
            f.teams.away.name.toLowerCase().includes(query.toLowerCase())
          );
          if (found.length === 0) {
            await sendTelegram(`😔 Nessuna partita live con "${query}" in questo momento.\n\nProva con /live per vedere tutte le partite!`);
          } else {
            let msg = `🔍 <b>Risultati per "${query}":</b>\n\n`;
            found.forEach((f) => { msg += formatMatch(f) + "\n"; });
            await sendTelegram(msg);
          }
        } catch(e) { await sendTelegram("❌ Errore nella ricerca."); }
      }
    }

    // /segui_ID (nuovo formato con underscore per cliccare direttamente)
    else if (text.startsWith("/segui_") || text.startsWith("/segui ")) {
      const id = text.replace("/segui_", "").replace("/segui ", "").trim();
      if (!id || isNaN(id)) {
        await sendTelegram("⚠️ Formato non valido. Usa /segui_12345 oppure /segui 12345");
      } else {
        followedMatches.add(id);
        lastSeenEvents[id] = new Set();

        // Carica subito i dettagli della partita
        try {
          const details = await getMatchDetails(id);
          const f = details.response?.[0];
          if (f) {
            matchInfo[id] = {
              id: id,
              home: f.teams.home,
              away: f.teams.away,
              scoreH: f.goals.home ?? 0,
              scoreA: f.goals.away ?? 0,
              league: f.league.name,
            };

            const home = f.teams.home.name;
            const away = f.teams.away.name;
            const league = f.league.name;

            // Manda conferma con i loghi
            const caption =
              `✅ <b>Stai seguendo:</b>\n\n` +
              `🏆 ${league}\n` +
              `⚽ <b>${home}</b> vs <b>${away}</b>\n\n` +
              `🚩 Riceverai una notifica per ogni corner!\n` +
              `🔴 Per smettere: /smetti_${id}`;

            try {
              await sendMediaGroup([
                { url: f.teams.home.logo, caption: caption },
                { url: f.teams.away.logo },
              ]);
            } catch(e) {
              await sendTelegram(caption);
            }
          } else {
            await sendTelegram(`✅ Stai seguendo la partita <code>${id}</code>\n🚩 Riceverai notifiche per ogni corner!\n🔴 Per smettere: /smetti_${id}`);
          }
        } catch(e) {
          await sendTelegram(`✅ Stai seguendo la partita <code>${id}</code>\n🚩 Riceverai notifiche per ogni corner!`);
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
        await sendTelegram("📋 Non stai seguendo nessuna partita.\n\n💡 Usa /cerca per trovare la tua squadra!");
      } else {
        let msg = "📋 <b>Partite seguite:</b>\n\n";
        for (const id of followedMatches) {
          const info = matchInfo[id];
          if (info) {
            msg += `⚽ <b>${info.home.name}</b> ${info.scoreH}–${info.scoreA} <b>${info.away.name}</b>\n`;
            msg += `🏆 ${info.league}\n`;
            msg += `🔴 /smetti_${id}\n\n`;
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
        const homeCorners = corners.filter(e => e.team.id === f.teams.home.id).length;
        const awayCorners = corners.filter(e => e.team.id === f.teams.away.id).length;
        const goals = events.filter(e => e.type === "Goal");
        const cards = events.filter(e => e.type === "Card");

        const msg =
          `📊 <b>Statistiche partita</b>\n` +
          `━━━━━━━━━━━━━━\n` +
          `🏆 ${f.league.name}\n` +
          `⚽ <b>${f.teams.home.name}</b> ${f.goals.home ?? 0}–${f.goals.away ?? 0} <b>${f.teams.away.name}</b>\n` +
          `⏱ Minuto: ${f.fixture.status.elapsed ?? "?"}\n` +
          `━━━━━━━━━━━━━━\n` +
          `🚩 Corner: ${homeCorners} – ${awayCorners}\n` +
          `⚽ Gol: ${goals.length}\n` +
          `🟨 Cartellini: ${cards.length}\n` +
          `━━━━━━━━━━━━━━`;

        try {
          await sendMediaGroup([
            { url: f.teams.home.logo, caption: msg },
            { url: f.teams.away.logo },
          ]);
        } catch(e) {
          await sendTelegram(msg);
        }
      } catch(e) { await sendTelegram("❌ Errore nel caricare le statistiche."); }
    }

    // /stop
    else if (text === "/stop") {
      followedMatches.clear();
      await sendTelegram("🔴 <b>Tracking fermato.</b>\nTutte le partite rimosse.\n\nScrivi /live per ricominciare!");
    }

    // Comando non riconosciuto
    else {
      await sendTelegram("❓ Comando non riconosciuto.\nScrivi /start per vedere tutti i comandi disponibili!");
    }
  }
}

// ============================================
// AVVIO
// ============================================

async function main() {
  console.log("🚩 CornerTracker v2 avviato!");
  await sendTelegram(
    "🚩 <b>CornerTracker v2 online!</b>\n\n" +
    "💡 Scrivi /cerca [squadra] per trovare subito la tua partita!\n" +
    "Esempio: /cerca Inter"
  );
  setInterval(handleCommands, 3000);
  setInterval(checkCorners, 30000);
}

main().catch(console.error);

// ==UserScript==
// @name         Travel Airways Log Bot
// @namespace    https://travelairways.org/flightlogger
// @version      1.0.1
// @description  Logs flights with crash detection, auto ICAO detection, session recovery & terrain-based AGL check for Travel Airways
// @match        http://*/geofs.php*
// @match        https://*/geofs.php*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const WEBHOOK_URL = "https://discord.com/api/webhooks/1411315862048084020/Kr-E6vo1tGucV3JFlLoMPE-atz0btZUtIfWTWQ6sqqrxKQ7MPY4chpsWhvqmz3FtY_Cx";
  const STORAGE_KEY = "geofs_flight_logger_session";

  let flightStarted = false;
  let flightStartTime = null;
  let departureICAO = "UNKNOWN";
  let arrivalICAO = "UNKNOWN";
  let hasLanded = false;
  let monitorInterval = null;
  let firstGroundContact = false;
  let firstGroundTime = null;
  let panelUI, startButton, callsignInput;
  let airportsDB = [];
  let departureAirportData = null;
  let arrivalAirportData = null;

fetch("https://raw.githubusercontent.com/mwgg/Airports/master/airports.json")
  .then(r => r.json())
  .then(data => {
    airportsDB = Object.entries(data).map(([icao, info]) => ({
      icao,
      lat: info.lat,
      lon: info.lon,
      tz: info.tz || null,
      name: info.name || "",
      city: info.city || "",
      country: info.country || ""
    }));
    console.log(`✅ Loaded ${airportsDB.length} airports`);
  })
  .catch(err => console.error("❌ Airport DB load failed:", err));

  // 获取最近机场函数：使用Haversine公式计算距离
  function getNearestAirport(lat, lon) {
    if (!airportsDB.length) return { icao: "UNKNOWN" };
    let nearest = null, minDist = Infinity;
    for (const ap of airportsDB) {
      const dLat = (ap.lat - lat) * Math.PI / 180;
      const dLon = (ap.lon - lon) * Math.PI / 180;
      const a = Math.sin(dLat/2) ** 2 +
        Math.cos(lat * Math.PI/180) * Math.cos(ap.lat * Math.PI/180) *
        Math.sin(dLon/2) ** 2;
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      const dist = 6371 * c;
      if (dist < minDist) {
        minDist = dist;
        nearest = ap;
      }
    }
    if (nearest && minDist > 30) return null;
    return nearest || null;
  }

  function saveSession() {
    const session = {
      flightStarted,
      flightStartTime,
      departureICAO,
      callsign: callsignInput?.value.trim() || "Unknown",
      firstGroundContact,
      departureAirportData,
      timestamp: Date.now()
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  }

  function loadSession() {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  }

  function clearSession() {
    localStorage.removeItem(STORAGE_KEY);
  }

  function promptForAirportICAO(type, lat, lon) {
    const locationStr = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    const icao = prompt(`❓ ${type} airport not found in database.\nLocation: ${locationStr}\n\nPlease enter the ICAO code manually (or leave empty for UNKNOWN):`);
    return icao ? icao.toUpperCase().trim() : "UNKNOWN";
  }

  function getAircraftName() {
    let raw = geofs?.aircraft?.instance?.aircraftRecord?.name || "Unknown";
    return raw.replace(/^\([^)]*\)\s*/, ""); // 去掉 (作者名) 部分
  }

  function formatTimeWithTimezone(timestamp, airportData) {
    let timeZone = 'UTC';
    let suffix = 'UTC';

    if (airportData && airportData.tz) {
      timeZone = airportData.tz;
      const date = new Date(timestamp);
      const timezoneName = date.toLocaleDateString('en', {
        timeZone: timeZone,
        timeZoneName: 'short'
      }).split(', ')[1] || timeZone.split('/')[1] || 'LT';
      suffix = timezoneName;
    }

    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });

    return `${fmt.format(new Date(timestamp))} ${suffix}`;
  }

  function sendLogToDiscord(data) {
    const takeoffTime = formatTimeWithTimezone(data.takeoff, departureAirportData);
    const landingTime = formatTimeWithTimezone(data.landing, arrivalAirportData);

    let embedColor;
    switch(data.landingQuality) {
      case "BUTTER": embedColor = 0x00FF00; break;
      case "HARD": embedColor = 0xFF8000; break;
      case "CRASH": embedColor = 0xFF0000; break;
      default: embedColor = 0x0099FF; break;
    }

    const message = {
      embeds: [{
        title: "🛫 Flight Report - Travel Airways",
        color: embedColor,
        fields: [
          {
            name: "✈️ Flight Information",
            value: `**Flight no.**: ${data.pilot}\n**Pilot name**: ${geofs?.userRecord?.callsign || "Unknown"}\n**Aircraft**: ${data.aircraft}`,
            inline: false
          },
          {
            name: "📍 Route",
            value: `**Departure**: ${data.dep}\n**Arrival**: ${data.arr}`,
            inline: true
          },
          {
            name: "⏱️ Duration",
            value: `**Flight Time**: ${data.duration}`,
            inline: true
          },
          {
            name: "📊 Flight Data",
            value: `**V/S**: ${data.vs} fpm\n**G-Force**: ${data.gforce}\n**TAS**: ${data.ktrue} kts\n**GS**: ${data.gs} kts`,
            inline: true
          },
          {
            name: "🏁 Landing Quality",
            value: `**${data.landingQuality}**`,
            inline: true
          },
          {
            name: "🕓 Times",
            value: `**Takeoff**: ${takeoffTime}\n**Landing**: ${landingTime}`,
            inline: false
          }
        ],
        timestamp: new Date().toISOString(),
        footer: {
          text: "Travel Airways Flight Logger"
        }
      }]
    };

    fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message)
    }).then(() => console.log("✅ Flight log sent"))
      .catch(console.error);
  }

  function showToast(message, type = 'info', duration = 3000) {
    const toast = document.createElement('div');
    Object.assign(toast.style, {
      position: 'fixed',
      top: '20px',
      right: '20px',
      padding: '12px 20px',
      borderRadius: '8px',
      color: 'white',
      fontWeight: 'bold',
      fontSize: '14px',
      fontFamily: 'sans-serif',
      zIndex: '10001',
      minWidth: '300px',
      boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
      opacity: '0',
      transform: 'translateX(100%)',
      transition: 'all 0.3s ease-in-out'
    });
    switch(type) {
      case 'crash': toast.style.background = 'linear-gradient(135deg, #ff4444, #cc0000)'; break;
      case 'success': toast.style.background = 'linear-gradient(135deg, #00ff44, #00cc00)'; break;
      case 'warning': toast.style.background = 'linear-gradient(135deg, #ffaa00, #ff8800)'; break;
      default: toast.style.background = 'linear-gradient(135deg, #0099ff, #0066cc)';
    }
    toast.innerHTML = message;
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '1'; toast.style.transform = 'translateX(0)'; }, 10);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(100%)';
      setTimeout(() => { if (document.body.contains(toast)) document.body.removeChild(toast); }, 300);
    }, duration);
  }

  function monitorFlight() {
    if (!geofs?.animation?.values || !geofs.aircraft?.instance) return;
    const values = geofs.animation.values;
    const onGround = values.groundContact;
    const altitudeFt = values.altitude * 3.28084;
    const terrainFt = geofs.api?.map?.getTerrainAltitude?.() * 3.28084 || 0;
    const agl = altitudeFt - terrainFt;
    const [lat, lon] = geofs.aircraft.instance.llaLocation || [values.latitude, values.longitude];
    const now = Date.now();

    if (!flightStarted && !onGround && agl > 100) {
      flightStarted = true;
      flightStartTime = now;
      const nearestAirport = getNearestAirport(lat, lon);
      if (nearestAirport) {
        departureICAO = nearestAirport.icao;
        departureAirportData = nearestAirport;
      } else {
        departureICAO = promptForAirportICAO("Departure", lat, lon);
        departureAirportData = null;
      }
      saveSession();
      console.log(`🛫 Departure detected at ${departureICAO}`);
      if (panelUI) {
        if (window.instruments && window.instruments.visible) {
          panelUI.style.opacity = "0";
          setTimeout(() => panelUI.style.display = "none", 500);
        }
      }
    }

    const elapsed = (now - flightStartTime) / 1000;
    if (flightStarted && !firstGroundContact && onGround) {
      if (elapsed < 1) return;
      const vs = values.verticalSpeed;
      
      if (vs <= -800) {
        showToast("💥 CRASH DETECTED<br>Logging crash report...", 'crash', 4000);
        const nearestAirport = getNearestAirport(lat, lon);
        if (nearestAirport) {
          arrivalICAO = "Crash";
          arrivalAirportData = nearestAirport;
        } else {
          arrivalICAO = "Crash";
          arrivalAirportData = null;
        }
      } else {
        const nearestAirport = getNearestAirport(lat, lon);
        if (nearestAirport) {
          arrivalICAO = nearestAirport.icao;
          arrivalAirportData = nearestAirport;
        } else {
          arrivalICAO = promptForAirportICAO("Arrival", lat, lon);
          arrivalAirportData = null;
        }
      }

      console.log(`🛬 Arrival detected at ${arrivalICAO}`);
      firstGroundContact = true;
      firstGroundTime = now;

      const g = (values.accZ / 9.80665).toFixed(2);
      const gs = values.groundSpeedKnt.toFixed(1);
      const tas = geofs.aircraft.instance.trueAirSpeed?.toFixed(1) || "N/A";
      const quality = (vs > -60) ? "BUTTER" : (vs > -800) ? "HARD" : "CRASH";
      const baseCallsign = callsignInput.value.trim() || "Unknown";
      const pilot = baseCallsign.toUpperCase().startsWith("TRA") ?
        baseCallsign : `TRA${baseCallsign}`;
      const aircraft = getAircraftName();
      const durationMin = Math.round((firstGroundTime - flightStartTime) / 60000);

      const hours = Math.floor(durationMin / 60);
      const minutes = durationMin % 60;
      const formattedDuration = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;

      sendLogToDiscord({
        pilot, aircraft,
        takeoff: flightStartTime,
        landing: firstGroundTime,
        dep: departureICAO,
        arr: arrivalICAO,
        duration: formattedDuration,
        vs: vs.toFixed(1),
        gforce: g,
        gs: gs,
        ktrue: tas,
        landingQuality: quality
      });

      saveSession();
      clearSession();
      resetPanel();

      if (monitorInterval) {
        clearInterval(monitorInterval);
        monitorInterval = null;
      }
    }
  }

  function resetPanel() {
    flightStarted = false;
    hasLanded = false;
    firstGroundContact = false;
    flightStartTime = null;
    departureICAO = "UNKNOWN";
    arrivalICAO = "UNKNOWN";
    departureAirportData = null;
    arrivalAirportData = null;
    callsignInput.value = "";
    startButton.disabled = true;
    startButton.innerText = "📋 Start Flight Logger";
    if (panelUI) {
      if (window.instruments && window.instruments.visible) {
        panelUI.style.display = "block";
        panelUI.style.opacity = "0.5";
      }
    }
  }

  function disableKeyPropagation(input) {
    ["keydown", "keyup", "keypress"].forEach(ev =>
      input.addEventListener(ev, e => e.stopPropagation())
    );
  }

  function createSidePanel() {
    panelUI = document.createElement("div");
    Object.assign(panelUI.style, {
      position: "absolute",
      bottom: "50px",
      left: "10px",
      background: "#111",
      color: "white",
      padding: "10px",
      border: "2px solid white",
      zIndex: "21",
      width: "220px",
      fontSize: "14px",
      fontFamily: "sans-serif",
      transition: "opacity 0.5s ease",
      display: "block",
      opacity: "0.5"
    });

    const airlineLabel = document.createElement("div");
    airlineLabel.textContent = "Airline: Travel Airways (TRA)";
    airlineLabel.style.marginBottom = "10px";
    airlineLabel.style.fontSize = "12px";
    airlineLabel.style.color = "#00C8FF";
    panelUI.appendChild(airlineLabel);

    callsignInput = document.createElement("input");
    callsignInput.placeholder = "Flight Number (e.g., 123)";
    callsignInput.style.width = "100%";
    callsignInput.style.marginBottom = "6px";
    disableKeyPropagation(callsignInput);
    callsignInput.onkeyup = () => {
      startButton.disabled = callsignInput.value.trim() === "";
    };
    startButton = document.createElement("button");
    startButton.innerText = "📋 Start Flight Logger";
    startButton.disabled = true;
    Object.assign(startButton.style, {
      width: "100%",
      padding: "6px",
      background: "#333",
      color: "white",
      border: "1px solid white",
      cursor: "pointer"
    });

    startButton.onclick = () => {
      alert("Flight Logger activated! Start your flight when ready.");
      monitorInterval = setInterval(monitorFlight, 1000);
      startButton.innerText = "✅ Logger Running...";
      startButton.disabled = true;
    };

    panelUI.appendChild(callsignInput);
    panelUI.appendChild(startButton);

    const resumeSession = loadSession();
    const resumeBtn = document.createElement("button");
    resumeBtn.innerText = "⏪ Resume Last Flight";
    Object.assign(resumeBtn.style, {
      width: "100%",
      marginTop: "6px",
      padding: "6px",
      background: "#222",
      color: "white",
      border: "1px solid white",
      cursor: "pointer"
    });

    resumeBtn.onclick = () => {
      if (resumeSession) {
        flightStarted = true;
        flightStartTime = resumeSession.flightStartTime;
        departureICAO = resumeSession.departureICAO;
        departureAirportData = resumeSession.departureAirportData;
        firstGroundContact = resumeSession.firstGroundContact || false;
        callsignInput.value = resumeSession.callsign || "";
        monitorInterval = setInterval(monitorFlight, 1000);
        resumeBtn.innerText = "✅ Resumed!";
        resumeBtn.disabled = true;
        startButton.innerText = "✅ Logger Running...";
        startButton.disabled = true;
        console.log("🔁 Resumed flight session.");
        if (panelUI && window.instruments && window.instruments.visible) {
          panelUI.style.opacity = "0";
          setTimeout(() => panelUI.style.display = "none", 500);
        }
      } else {
        alert("❌ No previous session found.");
      }
    };

    panelUI.appendChild(resumeBtn);
    document.body.appendChild(panelUI);
  }

  function updatePanelVisibility() {
    if (panelUI) {
      panelUI.style.display = (window.instruments && window.instruments.visible) ? "block" : "none";
    }
    setTimeout(updatePanelVisibility, 100);
  }

  window.addEventListener("load", () => {
    console.log("✅ Travel Airways Flight Logger Loaded");
    createSidePanel();
    setTimeout(updatePanelVisibility, 1000);
  });
})();

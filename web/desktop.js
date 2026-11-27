// ---------------------------------------------------------------------------
// Versione desktop: schermata per aprire il database, avanzamento della preparazione,
// trascinamento del file .db e sincronizzazione manuale con lo smartphone Android.
// ---------------------------------------------------------------------------
(function () {
  const desktop = window.desktop;
  if (!desktop) return;

  let overlay = null, title = null, message = null, button = null, syncBtn = null, spinner = null;
  let sidebarSyncBtn = null;
  let lastState = null;
  let isSyncing = false;

  // Mostra un messaggio temporaneo usando il #toast di index.html
  function showToast(text, isError = false, durationMs = 4000) {
    const toast = document.getElementById("toast");
    if (!toast) return;
    toast.textContent = text;
    toast.classList.remove("hidden");
    toast.style.backgroundColor = isError ? "#8b2635" : "";
    clearTimeout(toast._dkTimer);
    if (durationMs > 0) {
      toast._dkTimer = setTimeout(() => {
        toast.classList.add("hidden");
        toast.style.backgroundColor = "";
      }, durationMs);
    }
  }

  // Esegue la ricerca e la verifica dello smartphone su richiesta dell'utente
  async function avviaSincronizzazioneManuale() {
    if (isSyncing) return;
    if (!desktop.findAndroidDevice) {
      showToast("Funzione di ricerca non disponibile.", true);
      return;
    }

    const ipInput = document.querySelector(".dk-ip-input");
    const manualIp = ipInput ? ipInput.value.trim() : "";

    isSyncing = true;
    if (sidebarSyncBtn) {
      sidebarSyncBtn.disabled = true;
      sidebarSyncBtn.textContent = "Ricerca…";
    }
    if (syncBtn) syncBtn.disabled = true;
    if (button) button.disabled = true;
    if (spinner && overlay && !overlay.hidden) spinner.hidden = false;

    const msgRicerca = manualIp ? `Connessione all'IP ${manualIp}…` : "Ricerca dello smartphone Sentieri nella rete locale…";
    if (overlay && !overlay.hidden) showMessage(msgRicerca, false);
    else showToast(msgRicerca, false, 0);

    try {
      let baseUrl = null;
      if (manualIp) {
        const cleanIp = manualIp.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        baseUrl = cleanIp.includes(':') ? `http://${cleanIp}` : `http://${cleanIp}:8080`;
      }

      const res = await desktop.findAndroidDevice({ timeoutMs: 8000, healthPath: "/api/v1/info", baseUrl });

      if (res && res.ok) {
        const msgOk = `Connesso a ${res.device.name || 'Android'} (${res.device.baseUrl}). Download percorsi…`;
        if (overlay && !overlay.hidden) showMessage(msgOk, false);
        else showToast(msgOk, false, 0);

        // Esegue il recupero dei dati dallo smartphone Android
        const dataRes = await desktop.syncFetchAndroidData({ baseUrl: res.device.baseUrl });
        if (dataRes && dataRes.ok) {
          if (dataRes.alreadyUpToDate) {
            const msgDone = `Tutti i ${dataRes.totalSentieri || 0} percorsi sono già aggiornati sul PC.`;
            if (overlay && !overlay.hidden) showMessage(msgDone, false);
            else showToast(msgDone, false, 4000);
          } else {
            const count = dataRes.daAggiornareCount || 0;
            const msgSyncDone = `Sincronizzazione completata! Scaricati/aggiornati ${count} percorsi. Caricamento mappa…`;

            if (overlay && !overlay.hidden) showMessage(msgSyncDone, false);
            else showToast(msgSyncDone, false, 5000);

            if (typeof window.onAndroidRoutesSynced === "function") {
              window.onAndroidRoutesSynced(dataRes.sentieri);
            }

            setTimeout(() => {
              location.reload();
            }, 1200);
          }
        } else {
          throw new Error((dataRes && dataRes.error) || "Impossibile scaricare i dati dallo smartphone.");
        }
      } else {
        const errMsg = (res && res.error) || "Dispositivo Android non trovato nella rete locale.";
        if (overlay && !overlay.hidden) showMessage(errMsg, true);
        else showToast(errMsg, true, 5000);
      }
    } catch (err) {
      const errMsg = `Errore durante la sincronizzazione: ${err.message}`;
      if (overlay && !overlay.hidden) showMessage(errMsg, true);
      else showToast(errMsg, true, 5000);
    } finally {
      isSyncing = false;
      if (sidebarSyncBtn) {
        sidebarSyncBtn.disabled = false;
        sidebarSyncBtn.textContent = "Sincronizza";
      }
      if (syncBtn) syncBtn.disabled = false;
      if (button) button.disabled = false;
      if (spinner) spinner.hidden = true;
    }
  }

  // Aggiunge il pulsante "Sincronizza" nella sidebar di index.html (solo su Desktop)
  function injectSidebarSyncButton() {
    const footer = document.querySelector(".sidebar-footer");
    if (!footer || document.getElementById("dk-sidebar-sync")) return;

    sidebarSyncBtn = document.createElement("button");
    sidebarSyncBtn.id = "dk-sidebar-sync";
    sidebarSyncBtn.type = "button";
    sidebarSyncBtn.textContent = "Sincronizza";
    sidebarSyncBtn.title = "Cerca lo smartphone Android nella rete locale e sincronizza";
    sidebarSyncBtn.addEventListener("click", avviaSincronizzazioneManuale);

    // Lo inserisce prima del pulsante "Adatta vista" (#fit-all)
    const fitAllBtn = document.getElementById("fit-all");
    if (fitAllBtn) footer.insertBefore(sidebarSyncBtn, fitAllBtn);
    else footer.appendChild(sidebarSyncBtn);
  }

  function build() {
    const o = document.createElement("div");
    o.className = "dk-overlay";
    o.hidden = true;
    o.innerHTML = `
      <div class="dk-card" role="dialog" aria-modal="true" aria-labelledby="dk-title">
        <img class="dk-logo" src="4mori.png" alt="" height="56" style="height:56px;width:auto" onerror="this.remove()">
        <h1 id="dk-title">Sentieri</h1>
        <div class="dk-spinner" hidden aria-hidden="true"></div>
        <p class="dk-message" role="status"></p>
        <button type="button" class="dk-button">Apri database…</button>
        <button type="button" class="dk-button dk-sync-button" style="margin-top:8px">Sincronizza da Android…</button>
        <p class="dk-hint" style="margin-top:10px">oppure trascina qui il file .db scaricato dall’app Android</p>
      </div>`;
    document.body.appendChild(o);
    title = o.querySelector("h1");
    message = o.querySelector(".dk-message");
    button = o.querySelector(".dk-button");
    syncBtn = o.querySelector(".dk-sync-button");
    spinner = o.querySelector(".dk-spinner");

    button.addEventListener("click", async () => {
      const r = await desktop.openDatabaseDialog();
      if (r && r.error) showMessage(r.error, true);
    });

    syncBtn.addEventListener("click", avviaSincronizzazioneManuale);
    return o;
  }

  function showMessage(text, isError) {
    message.textContent = text;
    message.classList.toggle("dk-error", !!isError);
  }

  function render(s) {
    if (!overlay) overlay = build();
    if (isSyncing) return; // Non sovrascrivere i messaggi mentre la ricerca manuale è attiva

    const busy = s.state === "preparing";
    if (s.state === "ready") {
      overlay.hidden = true;
      if (lastState && lastState !== "ready") location.reload();
    } else {
      overlay.hidden = false;
      spinner.hidden = !busy;
      button.disabled = busy;
      if (syncBtn) syncBtn.disabled = busy;
      if (busy) showMessage(s.message || "Preparazione del database…", false);
      else if (s.state === "error") showMessage(s.message, true);
      else showMessage("Apri il database di Sentieri scaricato dall’app Android.", false);
    }
    lastState = s.state;
  }

  async function poll() {
    let delay = 3000;
    try {
      const res = await fetch("/api/status", { cache: "no-store" });
      const s = await res.json();
      render(s);
      if (s.state !== "ready") delay = 600;
    } catch { /* il programma si sta chiudendo */ }
    setTimeout(poll, delay);
  }

  window.addEventListener("dragover", (e) => { e.preventDefault(); });
  window.addEventListener("drop", async (e) => {
    e.preventDefault();
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    const r = await desktop.openDatabasePath(desktop.pathForFile(file));
    if (r && r.error) {
      if (!overlay) overlay = build();
      overlay.hidden = false;
      showMessage(r.error, true);
    }
  });

  // Ascolta l'eventuale comando attivato dal menu File -> Sincronizza da Android…
  if (desktop.onTriggerSync) {
    desktop.onTriggerSync(() => avviaSincronizzazioneManuale());
  }

  injectSidebarSyncButton();
  poll();
})();

// ---------------------------------------------------------------------------
// Modale Download Mappe dal Server NAS
// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  const modal = document.getElementById("map-download-modal");
  const backdrop = document.getElementById("map-download-backdrop");
  const closeBtn = document.getElementById("map-download-close");
  const tokenInput = document.getElementById("map-download-token-input");
  const tokenSaveBtn = document.getElementById("map-download-token-save");
  const refreshBtn = document.getElementById("map-download-refresh");
  const statusDiv = document.getElementById("map-download-status");
  const listDiv = document.getElementById("map-download-list");
  const progressBox = document.getElementById("map-download-progress-box");
  const progressText = document.getElementById("map-download-progress-text");
  const progressBar = document.getElementById("map-download-progress-bar");

  function closeModal() {
    if (modal) modal.classList.add("hidden");
  }

  if (backdrop) backdrop.addEventListener("click", closeModal);
  if (closeBtn) closeBtn.addEventListener("click", closeModal);

  async function loadTokenAndList() {
    if (!window.desktop) return;
    try {
      const savedToken = await window.desktop.nasGetToken();
      if (tokenInput && savedToken) {
        tokenInput.value = savedToken;
      }
      fetchMapList();
    } catch (err) {
      console.warn("[NAS] Errore caricamento token:", err.message);
    }
  }

  if (tokenSaveBtn) {
    tokenSaveBtn.addEventListener("click", async () => {
      const newToken = tokenInput?.value?.trim() || "";
      if (window.desktop && typeof window.desktop.nasSaveToken === "function") {
        await window.desktop.nasSaveToken(newToken);
        if (statusDiv) statusDiv.textContent = "Token salvato e cifrato con successo!";
        setTimeout(() => fetchMapList(), 500);
      }
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => fetchMapList());
  }

  async function fetchMapList() {
    if (!window.desktop || typeof window.desktop.nasListMaps !== "function") return;
    if (statusDiv) statusDiv.textContent = "Caricamento elenco mappe dal server NAS...";
    if (listDiv) listDiv.innerHTML = "";

    try {
      const res = await window.desktop.nasListMaps();
      if (res && res.ok && Array.isArray(res.files)) {
        if (statusDiv) statusDiv.textContent = `Trovate ${res.files.length} mappe sul server NAS:`;
        if (res.files.length === 0) {
          listDiv.innerHTML = `<div style="font-size:12px;color:#777;padding:10px">Nessuna mappa trovata nella cartella Cloud del server.</div>`;
          return;
        }

        const escapeHtml = (str) => String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

        listDiv.innerHTML = res.files.map(f => `
          <div class="map-item" style="display:flex;justify-content:space-between;align-items:center;padding:10px;background:#f8f9fa;border:1px solid #e0e0e0;border-radius:6px">
            <div>
              <strong style="display:block;font-size:13px;color:#222">${escapeHtml(f.name)}</strong>
              <span style="font-size:11px;color:#666">Dimensione: ${f.sizeMb} MB</span>
            </div>
            <button class="map-dl-btn" data-filename="${escapeHtml(f.name)}" style="padding:6px 12px;background:#386641;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:600">📥 Scarica</button>
          </div>
        `).join("");

        listDiv.querySelectorAll(".map-dl-btn").forEach(btn => {
          btn.addEventListener("click", (e) => {
            const fileName = e.target.getAttribute("data-filename");
            startMapDownload(fileName);
          });
        });
      } else {
        if (statusDiv) statusDiv.textContent = (res && res.error) || "Impossibile recuperare la lista delle mappe.";
      }
    } catch (err) {
      if (statusDiv) statusDiv.textContent = `Errore: ${err.message}`;
    }
  }

  async function startMapDownload(fileName) {
    if (!window.desktop || typeof window.desktop.nasDownloadMap !== "function") return;
    if (progressBox) progressBox.classList.remove("hidden");
    if (progressText) progressText.textContent = `Avvio download di "${fileName}"...`;
    if (progressBar) progressBar.style.width = "0%";

    try {
      const res = await window.desktop.nasDownloadMap(fileName);
      if (res && res.ok) {
        if (progressText) progressText.textContent = `✅ Download completato: ${fileName} salvata nella cartella mappe!`;
        if (progressBar) progressBar.style.width = "100%";
        if (typeof showToast === "function") showToast(`Mappa "${fileName}" scaricata con successo!`);
      } else {
        if (progressText) progressText.textContent = `❌ Errore download: ${res.error}`;
      }
    } catch (err) {
      if (progressText) progressText.textContent = `❌ Errore: ${err.message}`;
    }
  }

  if (window.desktop) {
    if (typeof window.desktop.onOpenMapDownload === "function") {
      window.desktop.onOpenMapDownload(() => {
        if (modal) modal.classList.remove("hidden");
        loadTokenAndList();
      });
    }

    if (typeof window.desktop.onMapDownloadProgress === "function") {
      window.desktop.onMapDownloadProgress(({ fileName, progress, downloadedBytes, totalBytes }) => {
        if (progressBox) progressBox.classList.remove("hidden");
        const downloadedMb = (downloadedBytes / (1024 * 1024)).toFixed(1);
        const totalMb = totalBytes > 0 ? (totalBytes / (1024 * 1024)).toFixed(1) : "?";

        if (progress >= 0) {
          if (progressText) progressText.textContent = `Scaricando "${fileName}": ${progress}% (${downloadedMb} / ${totalMb} MB)`;
          if (progressBar) progressBar.style.width = `${progress}%`;
        } else {
          if (progressText) progressText.textContent = `Scaricando "${fileName}": ${downloadedMb} MB ricevuti...`;
        }
      });
    }
  }
});
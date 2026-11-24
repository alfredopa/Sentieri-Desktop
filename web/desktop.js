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
        <div class="dk-ip-box" style="margin-top:10px;display:flex;gap:6px;justify-content:center;align-items:center">
          <input type="text" class="dk-ip-input" placeholder="IP opzionale (es. 192.168.1.168)" style="padding:6px 10px;border-radius:6px;border:1px solid #c8cdbd;font-size:12px;width:240px;text-align:center;background:#fff;color:#1d2318">
        </div>
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
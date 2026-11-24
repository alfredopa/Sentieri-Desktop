# Sentieri Desktop (Windows)

Programma per Windows che apre il file SQLite scaricato dall'app Android e mostra percorsi, waypoint,
foto, audio e grafici, con la stessa webapp che usi sul NAS. Non servono server, PHP o Internet
(Internet serve solo per le mappe online di `config.js`).

## Per l'utente finale

- **Installatore:** `Sentieri-Setup-1.0.0.exe`, un doppio clic, collegamento nel menu Start e sul desktop.
- **Portable:** `Sentieri-Portable-1.0.0.exe`, si copia e si avvia senza installare.
- Windows può mostrare l'avviso "SmartScreen" perché il programma non è firmato: scegli
  *Ulteriori informazioni → Esegui comunque*.

### Come si usa

1. **File → Apri database…** (Ctrl+O), oppure trascina il file `.db` sulla finestra. All'avvio successivo
   riapre l'ultimo database.
2. Alla prima apertura il programma fa una **copia di lavoro** del database nella sua cartella dati
   (`%APPDATA%\Sentieri\work`) e crea gli indici: con milioni di punti può richiedere alcuni minuti.
   Le volte successive è immediato, finché il file non cambia. Il file originale non viene mai modificato.
3. **Foto e audio:** il programma li cerca nelle cartelle `Foto` e `VoceWaypoint` accanto al file `.db`.
   Per usare altre cartelle: *File → Cartella foto… / Cartella audio dei waypoint…*.
4. **Mappe offline:** i file `.pmtiles` (con i nomi usati in `config.js`, ad esempio `DBGT.pmtiles`) vanno nella
   cartella `tiles` accanto al `.db`, oppure in quella scelta con *File → Cartella mappe (PMTiles)…*.
5. Se il database viene copiato dal telefono mentre l'app Android è aperta, i dati più recenti possono stare
   nel file `…-wal` accanto al `.db`: copia anche quello (il programma lo include).

## Per creare l'installatore (una volta, su un PC Windows)

Serve **Node.js 22 LTS** o più recente (https://nodejs.org). Non serve Visual Studio: SQLite è già dentro
Electron e le miniature usano una libreria precompilata.

1. Copia **`style.css`** e **`4mori.png`** dalla cartella `sentieri` del NAS dentro la cartella `web`
   (gli altri file della webapp sono già inclusi).
2. Apri un terminale nella cartella del progetto ed esegui:

   ```
   npm install
   npm start          (per provarlo)
   npm run dist       (crea gli installatori nella cartella dist)
   ```

3. In `dist` trovi `Sentieri-Setup-1.0.0.exe` e `Sentieri-Portable-1.0.0.exe`.

Se `npm run dist` si ferma con "Cannot create symbolic link", attiva la *Modalità sviluppatore* di Windows
(Impostazioni → Per sviluppatori) oppure apri il terminale come amministratore, poi riprova.

**Senza installare nulla:** metti il progetto su GitHub e avvia il workflow *Crea installatore Windows*
(Actions → Run workflow): al termine scarichi i due `.exe` dagli *artifact*.

Per un'icona tua, metti `icon.ico` (256×256) nella cartella `build`.

## Se cambi la webapp sul NAS

Copia in `web` i file aggiornati (`app.js`, `config.js`, `media.js`, `charts.js`, `style.css`, …), tranne
`index.html`: nella versione desktop usa le librerie in `web\vendor` e non ha il login.

## Cose da controllare la prima volta

Gli endpoint dati sono scritti in Node e riproducono quelli PHP. `route-fields.php` non era tra i file
ricevuti, quindi la conversione dei campi dell'elenco si basa su `columns.php`:

- `Lunghezza` in metri, `TempoTot` e `TempoInMov` in secondi, `Dislivello` e `Discesa` in metri;
- `MediaVel` viene mostrata così com'è (km/h). Se nel database è in m/s, cambia `MEDIAVEL_FATTORE` in
  `src/api.js` (3.6).

Per confrontare con il NAS, apri `http://127.0.0.1:38765/routes.php` mentre il programma è aperto e
confronta un percorso con la risposta di `routes.php` sul NAS.

## Struttura

```
main.js, preload.js     programma Electron (finestra, menu, apertura del database)
src/server.js           server locale su 127.0.0.1 (file statici, Range per PMTiles, foto e audio)
src/api.js              endpoint dati (routes, geojson, poi, foto, voce) su SQLite
src/dbprep.js           copia di lavoro e indici (gira in un thread separato)
web/                    la webapp (con le librerie in web\vendor)
test/                   prove automatiche:  npm test
```

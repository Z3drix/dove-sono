# Dove Sono?

Gioco web in stile "indovina dove ti trovi": scegli una o più aree (città, comune, provincia, regione, nazione…), imposti le regole e indovini la posizione sulla mappa a partire da foto a livello strada.

Tutto gratuito, senza chiavi né carte di credito:
- **Foto**: Google Street View (predefinita), [Panoramax](https://panoramax.fr) oppure [Mapillary](https://www.mapillary.com) (serve un token gratuito), a scelta nelle impostazioni
- **Visore 360°**: [Pannellum](https://pannellum.org)
- **Confini delle aree**: OpenStreetMap / Nominatim; continenti e mondo intero da [Natural Earth](https://www.naturalearthdata.com)
- **Filtri sui posti** (strade, gallerie, edifici): mappe vettoriali di [OpenFreeMap](https://openfreemap.org)
- **Mappe**: Leaflet + OpenStreetMap
- **Hosting**: qualsiasi hosting statico (GitHub Pages, Cloudflare Pages, Netlify)

Non c'è nulla da compilare: sono solo file HTML, CSS e JS.

## Come funziona Street View senza chiave

Il gioco sceglie un punto a caso nell'area, scarica il riquadro di copertura Street View di Google intorno a quel punto (le "linee blu" di Google Maps) e prende un pixel colorato, cioè un tratto dove Street View c'è. Poi lo mostra con il riquadro Street View che Google Maps usa per incorporare le mappe nelle pagine (`output=svembed`). Non serve nessuna chiave API, nessun account Google Cloud e nessuna carta di credito, quindi la pagina si può condividere senza rischi di costi.

Cose da sapere:
- Né i riquadri di copertura né l'incorporamento sono API ufficiali: Google potrebbe cambiarli o disattivarli in qualsiasi momento. In quel caso restano Panoramax e Mapillary.
- Ogni tanto può comparire "Street View non disponibile": usa il tasto **⚠ Non c'è Street View**, che invia una segnalazione e passa a un altro posto (vedi sotto). **Cambia posto** passa a un altro posto senza inviare niente; nessuno dei due fa perdere il round.
- La copertura comprende anche le foto sferiche caricate dagli utenti, quindi ogni tanto può capitare un interno o una galleria.
- Il riquadro con indirizzo e link a Google Maps è coperto, e il link "Segnala un problema" non è cliccabile, perché rivelerebbero il posto.
- Non si può impedire di spostarsi: la modalità "Fermo" funziona come "Libero". "Foto fissa" invece funziona (blocca ogni interazione).
- A volte, dopo aver camminato, il riquadro di Google può diventare nero (il browser ha perso il contesto grafico, per esempio con molte schede di Street View aperte). Il pulsante **↺ Partenza** ricarica la vista e riporta al punto di partenza del round.

## Le mie liste

Sotto la mappa delle aree puoi salvare la selezione attuale con un nome e ricaricarla con un clic.
Le liste restano solo nel tuo browser; per passarle ad altri:
- **Link**: copia un indirizzo del gioco che, aperto, carica la lista e la salva tra le liste di chi lo apre;
- **File**: scarica un piccolo file `.dovesono.json` da importare con "Importa una lista da file".

Una lista contiene solo il nome e i codici delle aree (codici OpenStreetMap come `R39597`, oppure `preset:europe` per i continenti), al massimo 50 aree: i confini vengono riscaricati al caricamento. Non esiste un elenco pubblico di liste.

## Segnalazioni anonime

Per capire perché ogni tanto compare "Street View non disponibile", il gioco (solo con Street View) invia dati tecnici a un Modulo Google:
- quando si preme **⚠ Non c'è Street View**, oppure si risponde "Sì, segnala" alla domanda che compare la prima volta in ogni partita che si preme **Cambia posto**: una segnalazione completa;
- alla fine di ogni round: un registro leggero (risposta data, tempo scaduto o posto cambiato), per confrontare i posti riusciti con quelli segnalati.

Cosa viene inviato: l'indirizzo del riquadro Street View (coordinate e direzione del posto), cosa dice la copertura di Google su quel punto, i tempi di caricamento, le impostazioni e le aree scelte, il tipo di browser, la lingua e le dimensioni dello schermo; nelle segnalazioni anche gli ultimi eventi della pagina (caricamenti, pagina nascosta, "Partenza" premuto). **Non** vengono inviati nome, email, account o altri dati personali.

Per usare un altro modulo, o spegnere tutto, modifica `reportFormUrl`, `reportFormEntry` e `logAllRounds` in `config.js` (vuoti = nessun invio).

## 1. Ottenere il token Mapillary (solo se usi Mapillary)

Con Street View o Panoramax questo passaggio non serve.

Nota (ottobre 2026): alcune app Mapillary appena registrate ricevono sempre zero foto anche con un token valido. Il gioco lo rileva e lo segnala; in quel caso usa Panoramax o segnalalo sul [forum di Mapillary](https://forum.mapillary.com/t/new-app-graph-api-returns-no-images-error-subcode-33/10767).


1. Crea un account su https://www.mapillary.com (anche con Facebook o email).
2. Vai su https://www.mapillary.com/dashboard/developers → **Register application**.
3. Nome e descrizione a piacere; come permessi basta **Read**.
4. Copia il **Client Token** (inizia con `MLY|`).

Puoi incollarlo nella schermata iniziale del gioco (viene salvato nel browser) oppure in `config.js`, così chi apre il sito non deve inserirlo. È un token pensato per stare nel browser, non è un segreto.

## 2. Provarlo sul tuo PC

Serve un piccolo server locale (aprire `index.html` con doppio clic non basta per alcune richieste):

```bash
python -m http.server 8080
```

Poi apri http://localhost:8080 (il comando va lanciato dentro la cartella `geoindovina`).

## 3. Pubblicarlo gratis con GitHub Pages

1. Crea un repository su GitHub (es. `dove-sono`) e carica i file di questa cartella.
2. Nel repository: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, branch `main`, cartella `/ (root)`.
3. Dopo circa un minuto il gioco è online su `https://<tuo-utente>.github.io/dove-sono/`.

In alternativa: su https://app.netlify.com/drop trascini la cartella e ottieni subito un link.

## Impostazioni disponibili

| Impostazione | Cosa fa |
|---|---|
| Fonte delle foto | Google Street View (senza chiave), Panoramax (nessun token) o Mapillary |
| Aree | Una o più aree cercate per nome, con il confine preso da OpenStreetMap, oppure i pulsanti rapidi Mondo intero / Europa / Asia / Africa / Nord America / Sud America / Oceania. L'Europa si ferma agli Urali; la Russia a est degli Urali è in Asia |
| Round | Da 1 a 50 |
| Tempo per round | In secondi, 0 = illimitato. Allo scadere vale il segnaposto piazzato, se c'è |
| Movimento | Libero (con Panoramax: frecce per passare alla foto precedente/successiva della sequenza) / solo guardarsi intorno / foto fissa |
| Punti massimi | Punti per una risposta perfetta (entro 25 m) |
| Severità | Automatica (in base alla grandezza dell'area) o distanza manuale a cui si prende metà dei punti |
| Più aree | Posizione scelta in proporzione alla superficie, oppure ogni area con la stessa probabilità |
| Solo 360° | Usa solo foto panoramiche (meno posti disponibili) |
| Confine sulla mappa | Mostra il bordo delle aree sulla mappa per indovinare |
| Bussola | Mostra o nasconde la direzione |
| Difficoltà | Ogni posto riceve un punteggio da 0 a 10: **notorietà** 0–3 (quanto si scrive dei dintorni: KB di articoli di Wikipedia inglese entro 500 m), **grandezza** del centro abitato 0–3 (città, paese, villaggio), **indizi** 0–3 (negozi, bar, chiese, uffici entro 150 m), **strada principale** 0–1. **Tutto** (predefinita): qualsiasi posto. **Facile**: punteggio ≥ 6 (centri di città, spesso vicino a luoghi noti; nei comuni piccoli basta 5). **Media**: 3–5 e niente posti famosi. **Difficile**: 0–2 ma in zona abitata. Se un livello non trova posti, la fascia si allarga di un punto alla volta. Scegliere un livello imposta anche i filtri consigliati, che poi si possono cambiare |
| Zona | Solo con la difficoltà **Personalizzata**. **Ovunque**; **Zone abitate** (un edificio entro 120 m o una zona residenziale/commerciale); **Centri di città e paesi** (entro 1,5 km dal centro di una città, 700 m di un paese, 350 m di un villaggio, dalle etichette di OpenStreetMap; le città escono più spesso); **Centro principale** (per un comune il suo centro, per regioni, nazioni e continenti i centri delle città) |
| Filtri sui posti | **Solo foto delle auto Google**: scarta le foto sferiche degli utenti (puntini isolati sulla copertura, o lontani da una strada) — solo Street View. **Niente autostrade e superstrade**, **Niente gallerie**: in base alla strada più vicina (entro 25 m) su OpenStreetMap |

## Limiti noti della prima versione

- Street View senza chiave: vedi la sezione dedicata sopra.
- Panoramax in Italia ha foto soprattutto nelle grandi città, quasi tutte "piatte" e a volte anche al chiuso (negozi, locali). Le foto stanno su più server: se uno non risponde, il gioco lo salta e usa gli altri.
- La copertura Mapillary è buona nelle città e a macchia nelle zone rurali: in aree molto piccole o poco fotografate la ricerca può fallire.
- Molte foto Mapillary sono "piatte" (dashcam), non a 360°.
- Il riquadro di attribuzione di Mapillary contiene un link alla foto originale, che rivela il posto.
- Nominatim chiede al massimo una ricerca al secondo: va bene per un uso normale.

/**
 * sanitizer.js — Libreria di anonimizzazione dei dati personali (PII)
 * ---------------------------------------------------------------------------
 * - 100% locale: nessuna chiamata di rete, nessuna dipendenza esterna.
 * - Script CLASSICO (non ES module): viene iniettato dal background tramite
 *   chrome.scripting.executeScript({ files: [...] }), che non supporta i
 *   moduli ES. Per lo stesso motivo TUTTO il codice è dentro una IIFE:
 *   se il file venisse iniettato due volte nello stesso tab, eventuali
 *   `const` a livello globale genererebbero "Identifier already declared".
 * - Espone un unico oggetto globale `GdprSanitizer` (nel service worker è
 *   importabile con importScripts("sanitizer.js"); in Node con require()).
 *
 * Uso:
 *   const { text, total, counts } = GdprSanitizer.sanitize("Scrivi a a@b.it");
 *   // text  -> "Scrivi a [EMAIL]"
 *   // total -> 1
 *   // counts-> { EMAIL: 1, TELEFONO: 0, CF_PIVA: 0, IBAN_CARTA: 0, DATA: 0 }
 *
 * LIMITI NOTI (da comunicare all'utente nell'interfaccia):
 *   - I NOMI PROPRI, gli indirizzi, le sedi e altri identificativi liberi NON
 *     vengono riconosciuti: le espressioni regolari non sono affidabili per
 *     il testo libero. L'utente deve ricontrollarli visivamente.
 *   - Le regex scelgono la prudenza: possono mascherare più del necessario
 *     (es. un codice numerico lungo) ma non garantiscono di trovare tutto.
 *   - Un IBAN straniero viene mascherato solo se il suo checksum (mod 97) è
 *     valido; un IBAN italiano/sammarinese viene mascherato anche con refusi.
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Replacement placeholders (exact text shown to the user)
  // ---------------------------------------------------------------------------
  const PLACEHOLDER = Object.freeze({
    EMAIL: "[EMAIL]",
    TELEFONO: "[TELEFONO]",
    CF_PIVA: "[CF/PIVA]",
    IBAN_CARTA: "[IBAN/CARTA]",
    DATA: "[DATA]",
    DOCUMENTO: "[DOCUMENTO]",
    PRATICA: "[PRATICA]",
    CVV: "[CVV]",
    INDIRIZZO: "[INDIRIZZO]",
    DATI_SANITARI: "[DATI SANITARI]",
    SEGRETO: "[SEGRETO]",
    CHIAVE_PRIVATA: "[CHIAVE PRIVATA]",
    NOME: "[NOME]"
  });

  // ---------------------------------------------------------------------------
  // Nomi propri italiani
  // ---------------------------------------------------------------------------
  // Due elenchi curati a mano (non copiati da dataset di licenza incerta):
  //   NOMI_SICURI   -> nomi che non sono anche parole comuni: si possono
  //                    mascherare anche da soli, in mezzo a una frase.
  //   NOMI_AMBIGUI  -> nomi che sono anche nomi comuni, aggettivi, mesi o
  //                    luoghi (Rosa, Stella, Chiara, Vittoria, Natale, Asia).
  //                    Si mascherano SOLO se seguiti da un'altra parola
  //                    maiuscola, cioè quando il contesto dice "nome e
  //                    cognome". Da soli non bastano: "una chiara spiegazione"
  //                    non deve diventare "[NOME] spiegazione".
  const NOMI_SICURI = [
    "Adele", "Adriana", "Adriano", "Agata", "Agnese", "Alberto", "Alda", "Aldo",
    "Alessandra", "Alessandro", "Alessia", "Alessio", "Alfio", "Alfonso", "Alice",
    "Amalia", "Ambrogio", "Amedeo", "Amelia", "Amerigo", "Anastasia", "Andrea",
    "Angela", "Angelica", "Angelina", "Anna", "Annalisa", "Annamaria", "Annibale",
    "Anselmo", "Antonella", "Antonietta", "Antonino", "Antonio", "Arianna",
    "Armando", "Arduino", "Arturo", "Assunta", "Attilio", "Augusto", "Aurelio",
    "Barbara", "Baldassare", "Beatrice", "Benedetta", "Benedetto", "Beniamino",
    "Benito", "Bernardino", "Bernardo", "Berta", "Biagio", "Calogero", "Camilla",
    "Camillo", "Carla", "Carlo", "Carlotta", "Carmela", "Carmelo", "Carmine",
    "Carolina", "Casimiro", "Caterina", "Cecilia", "Celestino", "Cesarina",
    "Cesare", "Cinzia", "Ciro", "Clara", "Clarissa", "Claudio", "Clelia",
    "Clemente", "Clementina", "Clotilde", "Concetta", "Corinna", "Cornelia",
    "Corrado", "Cosetta", "Cosimo", "Costantino", "Cristian", "Cristiana",
    "Cristiano", "Cristina", "Cristoforo", "Dalia", "Dalila", "Damiano", "Daniele",
    "Danilo", "Dario", "Davide", "Debora", "Delfina", "Demetrio", "Denis", "Denise",
    "Desiderio", "Diana", "Diego", "Diletta", "Dina", "Dino", "Dionisio",
    "Dolores", "Domenica", "Domenico", "Domitilla", "Donata", "Donatella",
    "Donato", "Dora", "Doriana", "Dorotea", "Edoardo", "Elena", "Eleonora",
    "Elia", "Eliana", "Elio", "Elisa", "Elisabetta", "Elvira", "Emanuela",
    "Emanuele", "Emiliano", "Emilio", "Enrica", "Enrico", "Enzo", "Erica", "Erika",
    "Ermanno", "Ernesto", "Ester", "Ettore", "Eugenio", "Ezio", "Fabiana", "Fabio",
    "Fabiola", "Fabrizio", "Fatima", "Federica", "Federico", "Ferdinando",
    "Fernanda", "Fernando", "Filippo", "Fiorenza", "Fiorenzo", "Flavio",
    "Francesca", "Francesco", "Franco", "Fulvia", "Fulvio", "Gabriele", "Gaetano",
    "Gaspare", "Gennaro", "Gerardo", "Giacomo", "Giancarlo", "Gianfranco",
    "Gianluca", "Gianluigi", "Gianmarco", "Gianna", "Gianni", "Gianpaolo",
    "Gigliola", "Gilberto", "Gilda", "Gino", "Gioacchino", "Giordano", "Giorgia",
    "Giorgio", "Giovanna", "Giovanni", "Giuditta", "Giulia", "Giuliana",
    "Giuliano", "Giulio", "Giuseppe", "Giuseppina", "Glauco", "Gloria", "Graziano",
    "Graziella", "Gregorio", "Guglielmo", "Guido", "Gustavo", "Ida", "Igor",
    "Ilaria", "Ilario", "Ileana", "Ines", "Iolanda", "Irene", "Isabella",
    "Isidoro", "Italo", "Ivan", "Ivana", "Ivano", "Jacopo", "Jessica", "Katia",
    "Lara", "Laura", "Lazzaro", "Lea", "Leda", "Leonardo", "Leopoldo", "Liana",
    "Lidia", "Lina", "Linda", "Lisa", "Livia", "Livio", "Loredana", "Lorella",
    "Lorenza", "Lorenzo", "Loretta", "Loris", "Luana", "Luca", "Lucia", "Luciano",
    "Lucrezia", "Ludovica", "Ludovico", "Luigi", "Luigia", "Luisa", "Mafalda",
    "Magda", "Manuel", "Manuela", "Mara", "Marcella", "Marcello", "Marco",
    "Maria", "Mariano", "Marilena", "Mario", "Marisa", "Marta", "Martina",
    "Marzia", "Marzio", "Massimiliano", "Massimo", "Matilde", "Matteo", "Maura",
    "Maurizio", "Mauro", "Melania", "Melissa", "Micaela", "Michele", "Michela",
    "Michelangelo", "Milena", "Mirella", "Miriam", "Mirko", "Moira", "Monica",
    "Moreno", "Nadia", "Natalia", "Natalina", "Natascia", "Nazzareno", "Nello",
    "Nerina", "Nevio", "Nicola", "Nicolò", "Nicoletta", "Nilde", "Nives", "Noemi",
    "Nora", "Olindo", "Olimpia", "Olivia", "Omar", "Orazio", "Oreste", "Ornella",
    "Oscar", "Osvaldo", "Otello", "Ottavia", "Ottavio", "Pamela", "Paola", "Paolo",
    "Pasquale", "Patrizia", "Patrizio", "Petra", "Piera", "Pierluigi", "Piero",
    "Pietro", "Pina", "Pio", "Priscilla", "Quirino", "Rachele", "Raffaele",
    "Raffaella", "Raimondo", "Renato", "Riccardo", "Rita", "Roberta", "Roberto",
    "Rocco", "Romeo", "Romina", "Rosalba", "Rosalia", "Rosanna", "Rosario",
    "Rosita", "Rossana", "Rossella", "Ruggero", "Sabina", "Sabrina", "Salvatore",
    "Samantha", "Samuele", "Sandra", "Sara", "Saverio", "Sebastiano", "Sergio",
    "Severino", "Silvana", "Silvano", "Silvia", "Silvio", "Simona", "Simonetta",
    "Simone", "Sonia", "Sonja", "Stefania", "Stefano", "Susanna", "Svetlana",
    "Tamara", "Tania", "Teresa", "Tiziana", "Tiziano", "Tobia", "Tommaso",
    "Tullio", "Ubaldo", "Ugo", "Umberto", "Ursula", "Valentina", "Valeria",
    "Valeriano", "Valerio", "Vanessa", "Vanda", "Verdiana", "Veronica",
    "Vincenza", "Vincenzo", "Virgilio", "Virna", "Vito", "Vittorio", "Vladimiro",
    "Walter", "Wanda", "Wilma", "Ylenia", "Zaira", "Zeno", "Zita", "Zoe",
    "Achille", "Adelaide", "Adolfo", "Agostino", "Aida", "Alina", "Alvise",
    "Anastasio", "Aniello", "Annarita", "Annunziata", "Antonia", "Arcangelo",
    "Arnaldo", "Aurelia", "Bartolomeo", "Basilio", "Battista", "Bice", "Brigida",
    "Brunella", "Candida", "Carmelina", "Cataldo", "Catello", "Celestina",
    "Claudia", "Concettina", "Consolata", "Damiana", "Danila", "Daria", "Delia",
    "Delfino", "Edda", "Edmondo", "Edvige", "Eligio", "Eloisa", "Elsa", "Emilia",
    "Ennio", "Enrichetta", "Ercole", "Ermelinda", "Ermes", "Eros", "Ersilia",
    "Esmeralda", "Eufemia", "Eusebio", "Evelina", "Fausto", "Fedele", "Felicita",
    "Flaminia", "Flaminio", "Flavia", "Fortunato", "Franca", "Gastone",
    "Gerolamo", "Giacinta", "Giacinto", "Giovannino", "Gisella", "Guerrino",
    "Ilda", "Imelda", "Ippolito", "Irma", "Isotta", "Laila", "Lauro", "Lavinia",
    "Leandro", "Lena", "Leo", "Leonarda", "Leonilde", "Liliana", "Lilla",
    "Luciana", "Lucilla", "Manfredi", "Mariapia", "Marianna", "Mariella",
    "Martino", "Melchiorre", "Michelina", "Mino", "Miranda", "Modesta", "Nando",
    "Nereo", "Nerio", "Nino", "Oriana", "Orietta", "Orlando", "Ottorino",
    "Palmira", "Paolina", "Pasqualina", "Pia", "Pierina", "Prospero", "Quintino",
    "Raimonda", "Ranieri", "Raul", "Rebecca", "Reginaldo", "Remo", "Renata",
    "Renzo", "Rinaldo", "Rino", "Rolando", "Romolo", "Rosalinda", "Rosetta",
    "Sabatino", "Sabino", "Salvo", "Samanta", "Sante", "Santina", "Saveria",
    "Savino", "Selene", "Serafina", "Serafino", "Severina", "Sigfrido", "Tecla",
    "Teodora", "Teodoro", "Teofilo", "Tilde", "Tino", "Tommasina", "Torquato",
    "Tullia", "Urbano", "Valentino", "Vanina", "Vincenzina", "Violetta",
    "Vitaliano", "Viviana"
  ];
  const NOMI_AMBIGUI = [
    "Alba", "Allegra", "Ambra", "Asia", "Aurora", "Azzurra", "Bianca", "Bruna",
    "Bruno", "Celeste", "Chiara", "Costanza", "Eva", "Felice", "Flora", "Fortuna",
    "Gemma", "Gioia", "Giustina", "Grazia", "India", "Iris", "Letizia", "Luna",
    "Margherita", "Marina", "Marino", "Mercedes", "Natale", "Noè", "Norma",
    "Ortensia", "Pasqua", "Primo", "Regina", "Romano", "Rosa", "Rosaria",
    "Sabato", "Sandro", "Secondo", "Serena", "Sesto", "Sofia", "Speranza",
    "Stella", "Vera", "Viola", "Virginia", "Vittoria"
  ];
  const NOMI_TUTTI = [...NOMI_SICURI, ...NOMI_AMBIGUI];
  // Alternanza senza duplicati: regex compatta e nessun ramo morto.
  const alternanza = (elenco) => [...new Set(elenco)].sort((a, b) => b.length - a.length).join("|");
  const REGEX_NOMI_SICURI = new RegExp(`(?:${alternanza(NOMI_SICURI)})`, "gu");
  const REGEX_NOMI_TUTTI = new RegExp(`(?:${alternanza(NOMI_TUTTI)})`, "gu");
  const INSIEME_NOMI_TUTTI = new Set(NOMI_TUTTI.map((nome) => nome.toLowerCase()));
  const INSIEME_NOMI_SICURI = new Set(NOMI_SICURI.map((nome) => nome.toLowerCase()));

  // ---------------------------------------------------------------------------
  // Cognomi italiani
  // ---------------------------------------------------------------------------
  // Stesso criterio dei nomi, con un problema in più: molti cognomi italiani
  // sono anche parole comuni, aggettivi o nomi di città (Rossi, Bianchi,
  // Ferrari, Villa, Costa, Ferrara, Messina). Tre difese contro i falsi
  // positivi:
  //
  //   G1. Un cognome "sicuro" che coincide con una parola comune viene
  //       declassato ad ambiguo: l'incrocio con PAROLE_COMUNI avviene al
  //       caricamento, quindi una svista nell'elenco non produce danni.
  //   G2. I cognomi ambigui si mascherano SOLO con un contesto che li
  //       qualifica (un nome proprio davanti, un titolo di cortesia): la
  //       regola "nome + cognome" esiste già e li copre.
  //   G3. Il cognome sicuro da solo si maschera solo se inizia con la
  //       maiuscola ("Franchini", "FRANCHINI"): un "franchini" tutto
  //       minuscolo dentro una frase resta com'è.
  const PAROLE_COMUNI = new Set([
    "costa", "coste", "sale", "villa", "sala", "monte", "monti", "pace", "guerra",
    "conte", "conti", "leone", "leoni", "serra", "fontana", "rosso", "rossa",
    "bruno", "bruna", "gallo", "galli", "riccio", "marino", "romano", "greca",
    "greco", "ferro", "ferri", "fava", "lupo", "lupi", "volpe", "volpi",
    "sarto", "sarti", "barbiere", "barbieri", "fornaio", "fornari", "capello",
    "capelli", "fattore", "fattori", "tedesco", "tedeschi", "turco", "turca",
    "spagnolo", "spagnola", "spagnoli", "vecchio", "vecchi", "grande", "grandi",
    "testa", "teste", "mazza", "carbone", "carboni", "riva", "rive", "spina",
    "scarpa", "scarpe", "zecca", "verde", "verdi", "vitale", "vitelli",
    "zoppo", "zoppi", "motta", "monaco", "poli", "righi", "novello", "novelli",
    "salerno", "torre", "torri", "campo", "campi", "prato", "prati", "valle",
    "valli", "ponte", "fonti", "fonte", "colle", "colli", "manzo", "manzi",
    "benedetto", "benedetti", "gentile", "gentili", "longo", "longhi",
    "bianco", "bianca", "nera", "nero", "neri", "grasso", "grassa", "grassi",
    "amato", "amata", "silvestri", "pellegrino", "pellegrini", "barone",
    "baroni", "palermo", "palumbo", "esposito", "caputo", "cattaneo",
    "morelli", "moretti", "marino", "marini", "ferrara", "ferrari", "ferrero"
  ]);

  const COGNOMI_SICURI = [
    "Franchini", "Zanichelli", "Bertolini", "Bettini", "Ferretti", "Galliani",
    "Bernardi", "Bertoldi", "Bresciani", "Brunelli", "Bucci", "Callegari",
    "Cantoni", "Carletti", "Caselli", "Castaldi", "Cecchetti", "Cipriani",
    "Cocchi", "Coletta", "Crespi", "De Filippi", "Del Prete", "Di Marco",
    "Di Stefano", "Donati", "Falconi", "Fantini", "Ferrando", "Fiorentini",
    "Fiorini", "Franceschi", "Gagliardi", "Gamberini", "Gherardi", "Giannini",
    "Gori", "Guarnieri", "Guerrini", "Guidi", "Guidotti", "Landi", "Lenzi",
    "Lorenzini", "Lucarelli", "Magni", "Malaguti", "Manetti", "Mannucci",
    "Marangoni", "Marcucci", "Mariotti", "Marzocchi", "Massari", "Matteucci",
    "Mazzanti", "Mengoni", "Merlini", "Meucci", "Miceli", "Nannini", "Nardini",
    "Nicolini", "Orlandi", "Ottaviani", "Pagani", "Pandolfi", "Paoletti",
    "Pascucci", "Pennacchi", "Perini", "Pignatelli", "Pisani", "Prosperi",
    "Quattrocchi", "Ranieri", "Ravasi", "Rinaldini", "Rocchi", "Romagnoli",
    "Ronchi", "Ruggeri", "Sabatini", "Santarelli", "Serafini", "Signorelli",
    "Simonetti", "Spinelli", "Stefanelli", "Strozzi", "Tacconi", "Tamburini",
    "Tarquini", "Tessari", "Tomaselli", "Trevisan", "Vaccaro", "Valeri",
    "Vannucci", "Vianello", "Viganò", "Vincenzi", "Zambon", "Zanella",
    "Zanetti", "Zani", "Zanon", "Zorzi", "Baldini", "Bardi", "Bellini",
    "Benassi", "Berti", "Biagi", "Biondi", "Ciani", "Comelli", "D'Amico",
    "D'Amato", "Degli Esposti", "Di Lorenzo", "Ferrucci", "Gallucci",
    "Gattuso", "Giannelli", "Giorgetti", "Guglielmi", "Lattanzi", "Mancuso",
    "Marchegiani", "Masini", "Melchiorri", "Micheli", "Montanelli",
    "Pasquali", "Pellizzari", "Petrini", "Piras", "Rastelli", "Ricciardi",
    "Ruggieri", "Sabbatini", "Silvestrini", "Tassinari", "Vaccari", "Venturi",
    "Vignoli", "Visconti", "Zampieri", "Barbato", "Beccari", "Bellandi",
    "Benvenuti", "Bergamaschi", "Bianchini", "Boldrini", "Bonaccorsi",
    "Bonifazi", "Borselli", "Bottari", "Brunori", "Cacciatori", "Calabrò",
    "Capuano", "Carraro", "Casadei", "Cecchini", "Ciampi", "Corradini",
    "Cortellini", "Dallari", "De Marchi", "De Paoli", "Del Bianco",
    "Diamanti", "Falcinelli", "Ferrigno", "Fiorelli", "Franceschini",
    "Gabrielli", "Galeazzi", "Gallerani", "Garzoni", "Giovannini", "Gonnella",
    "Gualtieri", "Lazzarini", "Leonardi", "Lombardo", "Lucidi", "Macellari",
    "Malaspina", "Manzini", "Marcolini", "Martinengo", "Mazzoleni",
    "Mercuri", "Mezzadri", "Molinari", "Montesi", "Moschetti", "Murgia",
    "Nardelli", "Nocentini", "Oddi", "Olivieri", "Onofri", "Paci", "Pagnotta",
    "Palladino", "Panzeri", "Pedretti", "Pellegatta", "Percassi", "Perrone",
    "Petrucci", "Piacentini", "Piccioni", "Pieri", "Pinelli", "Pirani",
    "Polverini", "Pozzetti", "Prandini", "Ramazzotti", "Reverberi", "Riboldi",
    "Rispoli", "Rondinelli", "Rovelli", "Ruscelli", "Sabbadini", "Salvatori",
    "Sampieri", "Santucci", "Sbaraglia", "Scarabelli", "Scarpellini",
    "Segatori", "Semprini", "Sernesi", "Silvani", "Soncini", "Soprani",
    "Sperandio", "Spighi", "Stanghellini", "Stoppani", "Tabarri",
    "Tagliaferri", "Tarabella", "Terziani", "Tomatis", "Toniato", "Tornatore",
    "Tramontano", "Travaglia", "Tremonti", "Turrini", "Ubaldi", "Ubertini",
    "Vagaggini", "Vallorani", "Vanni", "Vasarri", "Vender", "Vettori",
    "Zaccaria", "Zaghi", "Zaniboni", "Zappaterra", "Zerbini", "Zoppellari"
  ];

  const COGNOMI_AMBIGUI = [
    "Rossi", "Russo", "Ferrari", "Esposito", "Bianchi", "Romano", "Colombo",
    "Ricci", "Marino", "Greco", "Bruno", "Gallo", "Conti", "De Luca", "Costa",
    "Giordano", "Mancini", "Rizzo", "Lombardi", "Moretti", "Barbieri",
    "Fontana", "Mariani", "Rinaldi", "Caruso", "Ferrara", "Galli", "Martini",
    "Leone", "Longo", "Gentile", "Martinelli", "Vitale", "Serra", "Coppola",
    "De Santis", "D'Angelo", "Marchetti", "Parisi", "Villa", "Conte",
    "Ferraro", "Ferri", "Fabbri", "Bianco", "Marini", "Grasso", "Valentini",
    "Messina", "Sala", "De Angelis", "Gatti", "Pellegrini", "Palumbo",
    "Sanna", "Farina", "Rizzi", "Monti", "Cattaneo", "Morelli", "Amato",
    "Silvestri", "Mazza", "Testa", "Grassi", "Pellegrino", "Carbone",
    "Giuliani", "Benedetti", "Barone", "Rossetti", "Caputo", "Montanari",
    "Guerra", "Palermo", "Pace", "Neri", "Sartori", "Riva", "Spina", "Scarpa",
    "Zecca", "Verdi", "Vitelli", "Zoppi", "Motta", "Monaco", "Poli", "Righi",
    "Novelli", "Tedeschi", "Turco", "Spagnoli", "Vecchi", "Grandi", "Lupi",
    "Volpi", "Fattori", "Capelli", "Fornari", "Briganti", "Manzoni",
    "Rossini", "Salerno", "Torre", "Campo", "Prato", "Valle", "Ponte", "Colle"
  ];

  // G1: incrocio di sicurezza "sicuro" ↔ "parola comune". Un cognome che
  // compare in PAROLE_COMUNI o in COGNOMI_AMBIGUI non viene mai usato da solo.
  const AMBIGUI_INSIEME = new Set(COGNOMI_AMBIGUI.map((c) => c.toLowerCase()));
  const COGNOMI_DA_SOLI = [
    ...new Set(
      COGNOMI_SICURI.filter(
        (cognome) => !PAROLE_COMUNI.has(cognome.toLowerCase()) && !AMBIGUI_INSIEME.has(cognome.toLowerCase())
      )
    )
  ];
  const REGEX_COGNOMI_DA_SOLI = new RegExp(
    `(?<![\\p{L}\\p{N}_\\[])(?:${alternanza(COGNOMI_DA_SOLI)})(?![\\p{L}\\p{N}_])`,
    "giu"
  );

  // Cognomi ambigui (Rossi, Bianchi, Ferrari…) scritti tutti in maiuscolo.
  // Non sono attivi per impostazione predefinita: in un testo normale "ROSSI"
  // può essere l'aggettivo "rossi" scritto male o un'intestazione, quindi la
  // regola si accende solo se l'utente la chiede (opzione cognomiAmbigui).
  const REGEX_COGNOMI_AMBIGUI = new RegExp(
    `(?<![\\p{L}\\p{N}_\\[])(?:${alternanza(COGNOMI_AMBIGUI)})(?![\\p{L}\\p{N}_])`,
    "giu"
  );

  /** true se il carattere prima del match apre una frase o un elenco. */
  function inizioFrase(stringa, offset) {
    let i = offset - 1;
    while (i >= 0 && /\s/u.test(stringa[i])) i -= 1;
    if (i < 0) return true;
    return /[.!?:;\-–—•*(«"'’]/u.test(stringa[i]);
  }

  // Forme complete dei termini sanitari più comuni in italiano. Sono
  // euristiche: l'elenco non è esaustivo e può mascherare anche parole
  // innocue. Si usano forme intere (non radici) per evitare falsi positivi
  // come "Asmara" causato dalla radice "asma".
  const TERMINI_SANITARI = [
    "ipertensione", "ipertensivo", "diabete", "diabetica", "diabetico",
    "asma", "asmatico", "allergia", "allergie", "allergico", "celiachia",
    "celiaco", "epilessia", "epilettico", "depressione", "depressivo",
    "ansia", "tumore", "tumorale", "cancro", "hiv", "hcv", "epatite",
    "artrite", "artrosi", "bronchite", "polmonite", "ictus", "infarto",
    "insufficienza renale", "sclerosi multipla", "parkinson", "alzheimer",
    "endometriosi", "tiroidite", "colesterolo", "disabilità", "disabilita",
    "gravidanza", "patologia", "sindrome"
  ];
  const REGEX_TERMINI_SANITARI = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${TERMINI_SANITARI.join("|")})(?![\\p{L}\\p{N}_])`,
    "giu"
  );

  // ---------------------------------------------------------------------------
  // Funzioni di validazione (riducono i falsi positivi / validano il checksum)
  // ---------------------------------------------------------------------------

  /**
   * Algoritmo di Luhn su una stringa di sole cifre.
   * Vale per le carte di pagamento e, identico, per la Partita IVA italiana
   * (11 cifre, ultima = cifra di controllo).
   */
  function luhnValid(digits) {
    let somma = 0;
    let raddoppia = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let cifra = digits.charCodeAt(i) - 48; // '0' = 48
      if (raddoppia) {
        cifra *= 2;
        if (cifra > 9) cifra -= 9;
      }
      somma += cifra;
      raddoppia = !raddoppia;
    }
    return somma % 10 === 0;
  }

  /**
   * Checksum IBAN (ISO 13616, mod 97) su una stringa alfanumerica già
   * priva di spazi. Il calcolo è fatto a blocchi per evitare BigInt.
   */
  function ibanChecksumValid(alfanumerico) {
    const riordinato = alfanumerico.slice(4) + alfanumerico.slice(0, 4);
    let resto = 0;
    for (const carattere of riordinato.toUpperCase()) {
      const codice = carattere.charCodeAt(0);
      // Le lettere valgono A=10 ... Z=35; le cifre restano invariate.
      const valore = codice >= 65 && codice <= 90 ? String(codice - 55) : carattere;
      for (const cifra of valore) {
        resto = (resto * 10 + (cifra.charCodeAt(0) - 48)) % 97;
      }
    }
    return resto === 1;
  }

  // ---------------------------------------------------------------------------
  // Funzioni di trasformazione: ricevono il match e restituiscono la stringa
  // sostitutiva, oppure null se il match NON va mascherato (falso positivo).
  // ---------------------------------------------------------------------------

  /** IBAN estero: maschera il prefisso più lungo (15-34 caratteri) con checksum valido. */
  function trasformaIbanGenerico(match) {
    // Posizione di ogni carattere alfanumerico (gli spazi interni sono ignorati).
    const posizioni = [];
    for (let i = 0; i < match.length; i++) {
      if (/[A-Za-z0-9]/.test(match[i])) posizioni.push(i);
    }
    // Il match può includere parole successive: si prova a ridurlo finché il
    // checksum torna valido, lasciando intatto il testo in eccesso.
    for (let n = Math.min(34, posizioni.length); n >= 15; n--) {
      let candidato = "";
      for (let i = 0; i < n; i++) candidato += match[posizioni[i]];
      if (ibanChecksumValid(candidato)) {
        return PLACEHOLDER.IBAN_CARTA + match.slice(posizioni[n - 1] + 1);
      }
    }
    return null;
  }

  /** Carta di pagamento: 13-19 cifre con checksum Luhn valido o formattazione tipica. */
  function trasformaCarta(match) {
    const cifre = match.replace(/\D/g, "");
    if (cifre.length < 13 || cifre.length > 19) return null;
    // 4-4-4-N (Visa/Mastercard...) oppure 4-6-5 (American Express).
    const formattaTipica =
      /^\d{4}([ -])\d{4}\1\d{4}\1\d{1,7}$/.test(match) ||
      /^\d{4}([ -])\d{6}\1\d{5}$/.test(match);
    return luhnValid(cifre) || formattaTipica ? PLACEHOLDER.IBAN_CARTA : null;
  }

  // Etichette che, poco prima di un numero di 11 cifre, ne indicano la natura fiscale.
  const ETICHETTA_FISCALE =
    /(?:p\.?\s*iva|partita\s+iva|\bvat\b|\bc\.?\s*f\.?|cod(?:ice)?\.?\s*fisc(?:ale)?)[\s:.#°-]*$/iu;

  /**
   * Partita IVA / CF numerico (11 cifre). Un numero di 11 cifre qualunque
   * potrebbe essere altro: si maschera solo se ha il prefisso "IT", se il
   * checksum è valido oppure se è preceduto da un'etichetta fiscale.
   */
  function trasformaPartitaIva(match, offset, testo) {
    const conPrefisso = /^IT/i.test(match);
    const cifre = match.replace(/\D/g, "");
    const contesto = testo.slice(Math.max(0, offset - 30), offset);
    if (conPrefisso || luhnValid(cifre) || ETICHETTA_FISCALE.test(contesto)) {
      return PLACEHOLDER.CF_PIVA;
    }
    return null;
  }

  /** Telefono fisso italiano: 7-11 cifre complessive (prefisso 0 incluso). */
  function trasformaFissoItaliano(match, offset, stringa) {
    const numeroCifre = match.replace(/\D/g, "").length;
    if (numeroCifre < 7 || numeroCifre > 11) return null;
    // Un identificativo attaccato ai due punti ("arXiv:0901.2757", "doi:...")
    // non è un numero di telefono: è il codice di un documento.
    if (/[\p{L}]{2,}:$/u.test(stringa.slice(0, offset))) return null;
    return PLACEHOLDER.TELEFONO;
  }

  // Titoli di cortesia: se la parola prima delle iniziali è uno di questi, il
  // nome che segue è una persona ("Dott. M. Rossi") e va mascherato.
  const TITOLI_CORTESIA_MINUSCOLI = new Set([
    "sig", "sig.ra", "signor", "signora", "signore", "dott", "dott.ssa", "dottor",
    "dottoressa", "avv", "avvocato", "ing", "ingegnere", "arch", "architetto",
    "geom", "geometra", "rag", "ragioniere", "prof", "prof.ssa", "professore",
    "professoressa", "egr", "spett", "on", "onorevole", "sen", "senatore"
  ]);

  /**
   * Iniziale puntata + cognome: "J. Zierenberg", "M. J. Teper", "L. von Smekal".
   * È il modo in cui compaiono i nomi stranieri dentro citazioni, note e
   * bibliografie, dove i dizionari italiani non arrivano. Tre difese contro i
   * falsi positivi:
   *  - il cognome non deve essere una parola comune (PAROLE_COMUNI);
   *  - se il cognome è corto e seguito da punto è un'abbreviazione ("Lgs.");
   *  - se prima delle iniziali c'è a sua volta un'abbreviazione ("Phys. J. …")
   *    non è un nome, a meno che non sia un titolo di cortesia.
   */
  function trasformaInizialeCognome(match, offset, stringa) {
    const parti = match.trim().split(/\s+/u);
    const cognome = parti[parti.length - 1];
    if (PAROLE_COMUNI.has(cognome.toLowerCase())) return null;
    // Sigle brevi tutte in maiuscolo dopo un'iniziale ("P. IVA", "C. CCNL")
    // sono acronimi, non cognomi.
    if (cognome.length <= 4 && cognome === cognome.toUpperCase()) return null;
    if (stringa.startsWith(".", offset + match.length) && cognome.length <= 4) return null;
    const abbreviazione = /([\p{L}]+)\.\s*$/u.exec(stringa.slice(0, offset));
    if (abbreviazione && !TITOLI_CORTESIA_MINUSCOLI.has(abbreviazione[1].toLowerCase())) return null;
    return PLACEHOLDER.NOME;
  }

  /**
   * Maschera il valore di una credenziale etichettata conservando l'etichetta.
   * Scarta i falsi positivi in prosa: un valore di sole lettere, corto e senza
   * cifre ("token: scade", "password: ricordati") non è una credenziale.
   */
  function trasformaSegretoEtichettato(match, offset, stringa, argomenti) {
    const etichetta = argomenti[1] ?? "";
    const separatore = argomenti[2] ?? "";
    const grezzo = argomenti[3] ?? "";
    const valore = grezzo.replace(/^["']|["']$/g, "");
    const virgolettato = /^["']/.test(grezzo);
    const sembraSegreto =
      virgolettato || /\d/.test(valore) || /[^\p{L}\p{N}]/u.test(valore) || valore.length >= 12;
    if (!sembraSegreto) return null;
    return `${etichetta}${separatore}${PLACEHOLDER.SEGRETO}`;
  }

  /**
   * "Nome Cognome": il primo nome è in elenco e la parola successiva è
   * maiuscola, quindi il contesto indica una persona. Maschera entrambe.
   */
  function trasformaNomeCognome(match, offset, stringa) {
    const primo = match.split(/\s+/u)[0];
    if (!INSIEME_NOMI_TUTTI.has(primo.toLowerCase())) return null;
    if (/[[\]]/u.test(stringa[offset - 1] ?? "")) return null;
    return PLACEHOLDER.NOME;
  }

  /**
   * Nome singolo: si maschera anche a inizio frase. L'ambiguità è gestita a
   * monte: qui si usa solo NOMI_SICURI, che esclude i nomi che sono anche
   * parole comuni (Rosa, Stella, Chiara, Vittoria, Natale…) e che quindi
   * vengono intercettati solo dalla regola "nome + cognome".
   */
  function trasformaNomeSingolo(match, offset, stringa) {
    if (/[[\]]/u.test(stringa[offset - 1] ?? "")) return null;
    return PLACEHOLDER.NOME;
  }

  /** Titolo di cortesia seguito da una o più parole maiuscole. */
  function trasformaTitolo(match, offset, stringa, argomenti) {
    const titolo = argomenti[1] ?? "";
    // Il match può terminare con spazi: vanno conservati per non incollare
    // il placeholder alla parola successiva.
    const coda = /(\s*)$/u.exec(match)?.[1] ?? "";
    return `${titolo.replace(/\s+$/u, "")} ${PLACEHOLDER.NOME}${coda}`;
  }

  /** Nome proprio scritto tutto in maiuscolo (moduli, firme, intestazioni). */
  function trasformaNomeMaiuscolo(match) {
    const primo = match.split(/\s+/u)[0].toLowerCase();
    return INSIEME_NOMI_TUTTI.has(primo) ? PLACEHOLDER.NOME : null;
  }

  /**
   * Nome proprio isolato scritto in maiuscolo: capita negli estratti conto e
   * nei moduli con il layout a colonne, dove nome e cognome finiscono su righe
   * diverse, e nelle intestazioni. Si usa solo l'elenco dei nomi non ambigui,
   * così parole come ROSA, STELLA o VITTORIA restano intatte.
   */
  function trasformaNomeMaiuscoloSingolo(match) {
    return INSIEME_NOMI_SICURI.has(match.toLowerCase()) ? PLACEHOLDER.NOME : null;
  }

  /**
   * Cognome riconosciuto da solo (solo elenco dei non ambigui).
   * G3: serve l'iniziale maiuscola. Un "franchini" tutto minuscolo dentro una
   * frase è più probabilmente un refuso o un'altra parola e resta com'è.
   */
  function trasformaCognomeDaSolo(match) {
    if (!/^\p{Lu}/u.test(match)) return null;
    return PLACEHOLDER.NOME;
  }

  /**
   * Cognome ambiguo da solo (Rossi, Bianchi, Ferrari…). Attivo solo con
   * l'opzione cognomiAmbigui e solo se la parola è scritta in maiuscolo:
   * negli estratti conto e negli elenchi i nomi sono in maiuscolo, mentre nel
   * testo corrente "rossi" è quasi sempre l'aggettivo o il colore.
   */
  function trasformaCognomeAmbiguoMaiuscolo(match) {
    return /^\p{Lu}[\p{Lu}\s'’\-]+$/u.test(match) ? PLACEHOLDER.NOME : null;
  }

  // ---------------------------------------------------------------------------
  // Regole. L'ORDINE È IMPORTANTE: dalle più specifiche alle più generiche, così
  // le sequenze lunghe di cifre non vengono "spezzettate" da regole più deboli.
  // Poiché i placeholder non contengono cifre, le regole successive non possono
  // rielaborare il testo già mascherato.
  //
  // Tutte le regex usano il flag "u" (Unicode: \p{L}, \p{N}) e lookbehind per
  // ancorare l'inizio del match senza consumare caratteri. Nessun quantificatore
  // annidato: il tempo di esecuzione resta lineare anche su testi molto lunghi.
  // ---------------------------------------------------------------------------
  // Tipo di via che accetta sia "Via" sia "VIA" sia "via", senza usare il flag
  // /i (che renderebbe insensibile alle maiuscole anche \p{Lu}, togliendo il
  // vincolo sull'iniziale del nome della via).
  const TIPI_VIA = [
    "via", "viale", "piazza", "piazzale", "piazzetta", "corso", "vicolo",
    "largo", "lungomare", "strada", "contrada", "traversa", "salita", "borgo"
  ];
  const ALTERNANZA_TIPI_VIA = TIPI_VIA
    .map((parola) => parola.split("").map((c) => `[${c.toUpperCase()}${c.toLowerCase()}]`).join(""))
    .join("|");

  const REGOLE = [
    {
      // Chiave privata PEM: il blocco intero, perché anche l'intestazione è
      // identificativa del possesso. Limite di lunghezza per non consumare
      // memoria su testi enormi.
      chiave: "CHIAVE_PRIVATA",
      regex: /-----BEGIN [A-Z0-9 ]{0,20}PRIVATE KEY-----[\s\S]{0,20000}?-----END [A-Z0-9 ]{0,20}PRIVATE KEY-----/g,
      trasforma: () => PLACEHOLDER.CHIAVE_PRIVATA
    },
    {
      // Segreti con prefisso riconoscibile: il formato stesso è la prova.
      // AWS access key, GitHub, Google, Stripe, Slack, OpenAI/Anthropic.
      chiave: "SEGRETO",
      regex:
        /(?<![\p{L}\p{N}_])(?:AKIA|ASIA)[A-Z0-9]{16}(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])gh[pousr]_[A-Za-z0-9]{36,255}(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])github_pat_[A-Za-z0-9_]{60,255}(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])AIza[0-9A-Za-z_-]{35}(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])xox[baprs]-[0-9A-Za-z-]{10,80}(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,96}(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])sk-[A-Za-z0-9_-]{20,96}(?![\p{L}\p{N}_])/gu,
      trasforma: () => PLACEHOLDER.SEGRETO
    },
    {
      // JWT (tre segmenti base64url) e token Bearer: contengono l'identità
      // dell'utente o una sessione attiva.
      chiave: "SEGRETO",
      regex:
        /(?<![\p{L}\p{N}_])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])[Bb]earer\s+[A-Za-z0-9._~+/-]{16,}=*(?![\p{L}\p{N}_])/gu,
      trasforma: () => PLACEHOLDER.SEGRETO
    },
    {
      // Stringhe di connessione con credenziali incorporate.
      chiave: "SEGRETO",
      regex: /(?<![\p{L}\p{N}_])(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|mssql):\/\/[^\s"'<>]{6,}/giu,
      trasforma: () => PLACEHOLDER.SEGRETO
    },
    {
      // Credenziale etichettata ("password: ...", "api_key=..."): si conserva
      // l'etichetta e si maschera solo il valore. La validazione in
      // trasformaSegretoEtichettato scarta le frasi che non sono credenziali.
      chiave: "SEGRETO",
      regex:
        /(?<![\p{L}\p{N}_])(password|passwd|pwd|passphrase|api[ _-]?key|apikey|api[ _-]?secret|secret[ _-]?key|client[ _-]?secret|access[ _-]?token|auth[ _-]?token|refresh[ _-]?token|private[ _-]?key|token)(\s*[:=]\s*)("[^"\n]{4,128}"|'[^'\n]{4,128}'|[^\s,;]{4,128})/giu,
      trasforma: trasformaSegretoEtichettato
    },
    {
      // Credenziale in prosa: "la password è Pippo2024!", "la password del
      // portale è Pippo2024!", "il PIN è 4821".
      chiave: "SEGRETO",
      regex:
        /(?<![\p{L}\p{N}_])(password|passphrase|api[ _-]?key|pin|codice\s+di\s+accesso|chiave\s+api)((?:\s+[\p{L}\p{N}'’]+){0,4}\s+(?:è|e'|era|risulta)\s+)("[^"\n]{4,128}"|'[^'\n]{4,128}'|[^\s,;]{4,128})/giu,
      trasforma: trasformaSegretoEtichettato
    },
    {
      // Codice di sicurezza carta (CVV/CVC): numero breve, quindi va ancorato
      // all'etichetta per non confonderlo con altri numeri.
      chiave: "CVV",
      regex: /(?<![\p{L}\p{N}_])(?:cvv|cvc|codice\s+di\s+sicurezza)\s*(?:[:#]|n\.)?\s*\d{3,4}(?!\p{N})/giu,
      trasforma: () => PLACEHOLDER.CVV
    },
    {
      // Documento d'identità: numero ancorato all'etichetta (sigla + cifre).
      chiave: "DOCUMENTO",
      regex:
        /(?<![\p{L}\p{N}_])(?:carta\s+d['’]identit[àa]|documento\s+d['’]identit[àa]|passaporto|patente)\s*(?:n\.|num\.|numero)?\s*[:#]?\s*[A-Z]{1,2}\s?\d{5,8}[A-Z]{0,2}(?![\p{L}\p{N}])/giu,
      trasforma: () => PLACEHOLDER.DOCUMENTO
    },
    {
      // Sigla "C.I." o "CI" seguita dal numero del documento (case-sensitive,
      // per non confondere la parola italiana "ci").
      chiave: "DOCUMENTO",
      regex: /(?<![\p{L}\p{N}_])(?:C\.?\s?I\.?)\s*(?:n\.|num\.)?\s*[:#]?\s*[A-Z]{1,2}\s?\d{5,8}[A-Z]{0,2}(?![\p{L}\p{N}])/gu,
      trasforma: () => PLACEHOLDER.DOCUMENTO
    },
    {
      // Riferimenti contrattuali: "contratto n. IT-99482710", "pratica 12345".
      // Il numero deve avere un prefisso in lettere oppure almeno 5 cifre, per
      // non mascherare anni o importi brevi ("fattura 2023" resta visibile).
      chiave: "PRATICA",
      regex:
        /(?<![\p{L}\p{N}_])(?:contratto|pratica|ordine|ticket|fascicolo|polizza|sinistro|fattura)\s*(?:n\.|num\.|numero)?\s*[:#]?\s*(?:[A-Z]{1,4}[-\s]?\d{3,}[A-Z0-9-]*|\d{5,}[A-Z0-9-]*)(?![\p{L}\p{N}])/giu,
      trasforma: () => PLACEHOLDER.PRATICA
    },
    {
      // Indirizzo italiano: tipo di via + nome + civico, con CAP e città
      // opzionali. Richiede il civico e almeno un nome proprio con l'iniziale
      // maiuscola: così frasi come "via di sviluppo da 5 anni" o "corso di
      // laurea 3 anni" non vengono mascherate. Il tipo di via accetta sia
      // "Via" sia "VIA": negli estratti conto gli indirizzi sono spesso tutti
      // in maiuscolo, e un flag /i renderebbe \p{Lu} insensibile alle
      // maiuscole, facendo perdere il vincolo sul nome della via.
      chiave: "INDIRIZZO",
      regex: new RegExp(
        `(?<![\\p{L}\\p{N}_])(?:${ALTERNANZA_TIPI_VIA})\\s+(?:[\\p{L}\\p{M}'’\\-.]+\\s+){0,4}\\p{Lu}[\\p{L}\\p{M}'’\\-.]*\\s*,?\\s*\\d{1,4}(?:[A-Za-z]{0,2}|\\s*\\/\\s*[A-Za-z]{1,3})?(?:\\s*,\\s*\\d{5}(?:\\s+\\p{Lu}[\\p{L}\\p{M}'’\\-.]*){0,3}(?:\\s*\\(\\s*[A-Z]{2}\\s*\\))?)?(?![\\p{L}\\p{N}])`,
        "gu"
      ),
      trasforma: () => PLACEHOLDER.INDIRIZZO
    },
    {
      // CAP seguito da città e sigla di provincia ("57023 CECINA LI"), tipico
      // degli indirizzi andati a capo negli estratti conto. La sigla di
      // provincia è obbligatoria: senza, un numero di 5 cifre in una tabella
      // (importi, quantità) verrebbe mascherato per errore.
      chiave: "INDIRIZZO",
      regex: /(?<![\p{L}\p{N}_])(?<!\p{N}[.,/-])\d{5}\s+\p{Lu}[\p{L}\p{M}'’]{2,}\s+[A-Z]{2}(?![\p{L}\p{N}])/gu,
      trasforma: () => PLACEHOLDER.INDIRIZZO
    },
    {
      // Identificativo di pratica/riferimento introdotto da un'etichetta:
      // "Rif. interni: 011026.309243001", "pratica n. 45187". Identifica
      // indirettamente una persona o un rapporto, quindi va mascherato.
      // Il valore deve contenere almeno una cifra: "la pratica riguarda" è
      // una frase, non un codice.
      chiave: "PRATICA",
      regex: /(?<![\p{L}\p{N}_])(?:[Rr]if\.?\s*(?:intern[oi])?|[Rr]iferimento|[Pp]ratica|[Cc]ontratto|[Pp]olizza)\s*[:#n.]{0,3}\s*(?=[\w./-]*\d)[A-Za-z0-9][\w./-]{5,}(?![\w/])/gu,
      trasforma: () => PLACEHOLDER.PRATICA
    },
    {
      // Data di scadenza in formato MM/AA: solo se introdotta da un'etichetta,
      // per non confondere frazioni o rapporti.
      chiave: "DATA",
      regex:
        /(?<![\p{L}\p{N}_])(?:scadenza|scade|valida\s+fino\s+al)\s*[:#]?\s*(?:0[1-9]|1[0-2])\s*\/\s*\d{2}(?!\p{N})/giu,
      trasforma: () => PLACEHOLDER.DATA
    },
    {
      // Gruppo sanguigno completo ("gruppo sanguigno è 0 Rh+").
      chiave: "DATI_SANITARI",
      regex:
        /(?<![\p{L}\p{N}_])gruppo\s+sanguigno\s*(?:[:è]\s*)?(?:0|A|B|AB)(?:\s?Rh\s?[+-])?(?![\p{L}\p{N}_])/giu,
      trasforma: () => PLACEHOLDER.DATI_SANITARI
    },
    {
      // Fattore Rh isolato ("0 Rh+", "Rh negativo").
      chiave: "DATI_SANITARI",
      regex: /(?<![\p{L}\p{N}_])Rh\s?(?:\+|-|positivo|negativo)(?![\p{L}\p{N}_])/giu,
      trasforma: () => PLACEHOLDER.DATI_SANITARI
    },
    {
      // Termini sanitari comuni (patologie, terapie). Elenco euristico: non è
      // esaustivo e non sostituisce la revisione manuale.
      chiave: "DATI_SANITARI",
      regex: REGEX_TERMINI_SANITARI,
      trasforma: () => PLACEHOLDER.DATI_SANITARI
    },
    {
      // IBAN italiano/sammarinese: IT/SM + 2 cifre + 23 alfanumerici = 27 caratteri,
      // anche raggruppati con spazi. Nessun checksum: si maschera anche con refusi.
      chiave: "IBAN_CARTA",
      regex: /(?<![\p{L}\p{N}_])(?:IT|SM)\d{2}(?:[ \u00A0]?[A-Z0-9]){23}(?![A-Z0-9])/giu,
      trasforma: () => PLACEHOLDER.IBAN_CARTA
    },
    {
      // IBAN di altri paesi: forma generica, confermata dal checksum mod 97.
      chiave: "IBAN_CARTA",
      regex: /(?<![\p{L}\p{N}_])[A-Z]{2}\d{2}(?:[ \u00A0]?[A-Z0-9]){11,30}(?![A-Z0-9])/giu,
      trasforma: trasformaIbanGenerico
    },
    {
      // Carte di pagamento: 13-19 cifre con spazi o trattini opzionali.
      chiave: "IBAN_CARTA",
      regex: /(?<![\p{L}\p{N}_])(?:\d[ -]?){12,18}\d(?![\p{N}])/gu,
      trasforma: trasformaCarta
    },
    {
      // Email. Il lookbehind fa partire il match solo all'inizio della parte
      // locale, evitando una scansione quadratica su lunghe sequenze senza "@".
      chiave: "EMAIL",
      regex: /(?<![\p{L}\p{N}._%+'-])[\p{L}\p{N}._%+'-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu,
      trasforma: () => PLACEHOLDER.EMAIL
    },
    {
      // Codice fiscale persona fisica (16 caratteri), con le sostituzioni
      // previste per l'omocodia (cifre → LMNPQRSTUV).
      chiave: "CF_PIVA",
      regex:
        /(?<![\p{L}\p{N}_])[A-Z]{6}[\dLMNPQRSTUV]{2}[ABCDEHLMPRST][\dLMNPQRSTUV]{2}[A-Z][\dLMNPQRSTUV]{3}[A-Z](?![\p{L}\p{N}_])/giu,
      trasforma: () => PLACEHOLDER.CF_PIVA
    },
    {
      // Date gg/mm/aaaa (anche con "." o "-" purché coerenti), anno 1800-2099.
      chiave: "DATA",
      regex: /(?<!\p{N})(?:0?[1-9]|[12]\d|3[01])([/.-])(?:0?[1-9]|1[0-2])\1(?:1[89]\d{2}|20\d{2})(?!\p{N})/gu,
      trasforma: () => PLACEHOLDER.DATA
    },
    {
      // Date con anno a 2 cifre: solo con "/" per non confondere versioni (1.2.34).
      chiave: "DATA",
      regex: /(?<!\p{N})(?:0?[1-9]|[12]\d|3[01])\/(?:0?[1-9]|1[0-2])\/\d{2}(?!\p{N})/gu,
      trasforma: () => PLACEHOLDER.DATA
    },
    {
      // Partita IVA (11 cifre, prefisso "IT" opzionale) e CF numerico delle società.
      chiave: "CF_PIVA",
      regex: /(?<![\p{L}\p{N}_+])(?<!\p{N}[.,/-])(?:IT[ \u00A0]?)?\d{11}(?!\p{N})/giu,
      trasforma: trasformaPartitaIva
    },
    {
      // Telefono internazionale: prefisso "+" o "00" seguito da 8-15 cifre.
      // Tra le cifre sono ammessi fino a 2 separatori (es. " (0)" in "+41 (0)44").
      chiave: "TELEFONO",
      regex: /(?<![\p{L}\p{N}_])(?<!\p{N}[.,/-])(?:\+|00)(?:\d[ \u00A0.()-]{0,2}){7,14}\d(?!\p{N})/gu,
      trasforma: () => PLACEHOLDER.TELEFONO
    },
    {
      // Cellulare italiano: 3xx + 6-7 cifre, prefisso "39" opzionale.
      chiave: "TELEFONO",
      regex:
        /(?<![\p{L}\p{N}_+])(?<!\p{N}[.,/-])(?:39[ \u00A0.-]?)?3\d{2}[ \u00A0.-]?\d{3}[ \u00A0.-]?\d{3,4}(?!\p{N})/gu,
      trasforma: () => PLACEHOLDER.TELEFONO
    },
    {
      // Fisso italiano: prefisso 0 + 1-3 cifre, anche tra parentesi, separatori
      // opzionali ("06 1234 5678", "06/1234567", "(06) 1234567").
      chiave: "TELEFONO",
      regex:
        /(?<![\p{L}\p{N}_+])(?<!\p{N}[.,/-])\(?0\d{1,3}\)?(?:[ \u00A0./-]?\d{2,4}){2,3}(?!\p{N})/gu,
      trasforma: trasformaFissoItaliano
    },
    {
      // Titolo di cortesia + nome: "Dott.ssa Zanichelli", "il signor Rossi".
      // Non serve conoscere il cognome: il titolo è il contesto. Le iniziali
      // sono scritte a mano perché un flag /i renderebbe \p{Lu} insensibile
      // alle maiuscole, facendo mangiare al titolo le parole successive.
      chiave: "NOME",
      regex:
        /(?<![\p{L}\p{N}_])((?:[Ss]ig\.?\s?ra|[Ss]ig\.|[Ss]ignor(?:[ea])?|[Dd]ott\.?ssa|[Dd]ott\.?|[Dd]ottoressa|[Aa]vv\.?|[Aa]vvocato|[Ii]ng\.?|[Ii]ngegnere|[Aa]rch\.?|[Aa]rchitetto|[Gg]eom\.?|[Rr]ag\.?|[Pp]rof\.?ssa|[Pp]rof\.?|[Pp]rofessor[ea]|[Ee]gr\.?|[Ss]pett\.le)\.?)\s+((?:\p{Lu}[\p{L}\p{M}'’\-]+\s*){1,3})/gu,
      trasforma: trasformaTitolo
    },
    {
      // Iniziale puntata + cognome: "J. Zierenberg", "M. J. Teper",
      // "L. von Smekal". Copre i nomi stranieri di citazioni e bibliografie,
      // che i dizionari italiani non contengono (vedi trasformaInizialeCognome).
      chiave: "NOME",
      regex:
        /(?<![\p{L}\p{N}_\[])(?:\p{Lu}\.\s?){1,4}(?:(?:von|van|de|der|den|di|da|del|della|dello|dos|das|du|le|la|ten|ter|bin|ibn)\s+)?\p{Lu}[\p{L}\p{M}'’\-]{2,}(?![\p{L}\p{N}])/gu,
      trasforma: trasformaInizialeCognome
    },
    {
      // Nome + cognome (o nome + altra parola maiuscola). La parola successiva
      // non può essere un titolo di cortesia, altrimenti "Gentile Signora"
      // verrebbe scambiato per un nome e cognome.
      chiave: "NOME",
      regex: new RegExp(
        `(?<![\\p{L}\\p{N}_\\[])(?:${alternanza(NOMI_TUTTI)})\\s+(?!(?:[Ss]ignor|[Dd]ott|[Pp]rof|[Ii]ng|[Aa]vv|[Aa]rch|[Gg]eom|[Rr]ag|[Ee]gr|[Ss]pett)[\\p{L}]*\\.?\\s)\\p{Lu}[\\p{L}\\p{M}'’\\-]+`,
        "gu"
      ),
      trasforma: trasformaNomeCognome
    },
    {
      // Nome scritto in maiuscolo: "MARIO ROSSI" nei moduli o nelle firme.
      chiave: "NOME",
      regex: /(?<![\p{L}\p{N}_\[])\p{Lu}{3,}(?:\s+\p{Lu}[\p{L}\p{M}'’\-]{2,})+(?![\p{L}\p{N}_])/gu,
      trasforma: trasformaNomeMaiuscolo
    },
    {
      // Nome singolo in mezzo a una frase ("scrivi a Giulia").
      chiave: "NOME",
      regex: new RegExp(`(?<![\\p{L}\\p{N}_\\[])(?:${alternanza(NOMI_SICURI)})(?![\\p{L}\\p{N}_])`, "gu"),
      trasforma: trasformaNomeSingolo
    },
    {
      // Nome singolo tutto in maiuscolo: negli estratti conto e nei moduli a
      // colonne nome e cognome finiscono spesso su righe diverse, quindi la
      // regola "nome + cognome" non li vede. Solo nomi non ambigui.
      chiave: "NOME",
      regex: /(?<![\p{L}\p{N}_\[])\p{Lu}{3,}(?![\p{L}\p{N}_])/gu,
      trasforma: trasformaNomeMaiuscoloSingolo
    },
    {
      // Cognome riconosciuto da solo: "Franchini", "FRANCHINI". Usa solo
      // l'elenco dei cognomi che non sono anche parole comuni (vedi G1/G3).
      chiave: "NOME",
      regex: REGEX_COGNOMI_DA_SOLI,
      trasforma: trasformaCognomeDaSolo
    }
  ];

  // Regola facoltativa: si aggiunge in coda solo quando richiesta.
  const REGOLA_COGNOMI_AMBIGUI = {
    chiave: "NOME",
    regex: REGEX_COGNOMI_AMBIGUI,
    trasforma: trasformaCognomeAmbiguoMaiuscolo
  };
  const REGOLE_CON_AMBIGUI = [...REGOLE, REGOLA_COGNOMI_AMBIGUI];

  // Riconosce i segnaposto già inseriti, ricavandoli dalla stessa tabella usata
  // per crearli: aggiungerne uno nuovo non richiede modifiche qui.
  const REGEX_SEGNAPOSTI = new RegExp(
    `\\[(?:${[...new Set(Object.values(PLACEHOLDER))]
      .map((valore) => valore.slice(1, -1).replace(/[/\\^$.*+?()[\]{}|]/g, "\\$&"))
      .join("|")})\\]`,
    "g"
  );

  // ---------------------------------------------------------------------------
  // Parole da non toccare
  // ---------------------------------------------------------------------------
  // Prima di applicare le regole, le parole scelte dall'utente vengono sostituite
  // con un segnaposto neutro: così nessuna regola può colpirle e il testo resta
  // intatto anche quando la parola somiglia a un dato personale. Il segnaposto
  // sopravvive anche all'analisi AI (ner-logic lo protegge) e viene rimesso al
  // suo posto da rimettiEsclusioni() alla fine.
  const PREFISSO_ESCLUSO = "[ESCLUSO#";

  const escapeRegex = (testo) => testo.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

  /**
   * Sostituisce le parole da non toccare con i segnaposti neutri.
   * Ogni occorrenza riceve un segnaposto proprio: così si conserva la grafia
   * esatta ("ACME" e "acme" restano come sono).
   * @param {string} input
   * @param {string[]} elenco parole intere (confronto senza distinzione di maiuscole)
   * @returns {{testo: string, protette: string[]}} protette = valori nell'ordine dei segnaposti
   */
  function applicaEsclusioni(input, elenco) {
    let testo = input;
    const protette = [];
    for (const voce of elenco) {
      const parola = String(voce ?? "").trim();
      if (parola.length < 2) continue;
      const regex = new RegExp(
        `(?<![\\p{L}\\p{N}_])${escapeRegex(parola)}(?![\\p{L}\\p{N}_])`,
        "giu"
      );
      testo = testo.replace(regex, (trovato) => {
        protette.push(trovato);
        return `${PREFISSO_ESCLUSO}${protette.length - 1}]`;
      });
    }
    return { testo, protette };
  }

  /**
   * Rimette al loro posto le parole lasciate intatte.
   * Da chiamare dopo l'eventuale analisi AI, che vede solo i segnaposti.
   */
  function rimettiEsclusioni(testo, protette) {
    if (!protette || protette.length === 0) return testo;
    const regex = new RegExp(`\\[ESCLUSO#(\\d+)\\]`, "g");
    return testo.replace(regex, (intero, indice) => {
      const valore = protette[Number(indice)];
      return valore === undefined ? intero : valore;
    });
  }

  /**
   * Accoppia ogni segnaposto del testo mascherato al valore che ha sostituito.
   * È l'operazione inversa della mascheratura: serve a rimettere una parola
   * che non andava tolta. Il confronto funziona perché fra due segnaposto il
   * testo non cambia, quindi si allineano i pezzi letterali e ciò che resta in
   * mezzo è il valore originale. Se l'allineamento non torna (testo modificato
   * a mano, risultati inattesi) si restituisce un elenco vuoto: meglio nessun
   * ripristino che rimettere la parola sbagliata.
   * @param {string} originale Testo prima della mascheratura.
   * @param {string} mascherato Testo dopo la mascheratura.
   * @returns {Array<{start: number, end: number, valore: string}>} posizioni nel testo mascherato
   */
  function accoppiaSegnaposti(originale, mascherato) {
    const esiti = [];
    if (typeof originale !== "string" || typeof mascherato !== "string" || !originale) return esiti;
    const trovati = [...mascherato.matchAll(REGEX_SEGNAPOSTI)]
      .map((m) => ({ start: m.index, end: m.index + m[0].length }));
    if (trovati.length === 0) return esiti;

    // Pezzi letterali: quello prima di ogni segnaposto, più la coda finale.
    const segmenti = [];
    let ultimo = 0;
    for (const t of trovati) {
      segmenti.push(mascherato.slice(ultimo, t.start));
      ultimo = t.end;
    }
    segmenti.push(mascherato.slice(ultimo));

    const posizioni = [];
    let cursore = 0;
    for (let i = 0; i < segmenti.length; i += 1) {
      const segmento = segmenti[i];
      if (i === segmenti.length - 1) {
        // La coda chiude il documento: sta per forza in fondo anche nell'originale.
        if (!originale.endsWith(segmento)) return [];
        posizioni.push(originale.length - segmento.length);
        continue;
      }
      if (segmento === "") {
        posizioni.push(cursore);
        continue;
      }
      const indice = originale.indexOf(segmento, cursore);
      if (indice === -1) return [];
      posizioni.push(indice);
      cursore = indice + segmento.length;
    }

    trovati.forEach((t, i) => {
      const inizio = posizioni[i] + segmenti[i].length;
      const fine = posizioni[i + 1];
      if (fine > inizio) esiti.push({ start: t.start, end: t.end, valore: originale.slice(inizio, fine) });
    });
    return esiti;
  }

  // ---------------------------------------------------------------------------
  // API pubblica
  // ---------------------------------------------------------------------------

  /**
   * Sostituisce i dati personali riconosciuti con i placeholder.
   * @param {string} input Testo originale.
   * @param {{cognomiAmbigui?: boolean}} [opzioni]
   *   cognomiAmbigui = true maschera anche i cognomi ambigui scritti in
   *   maiuscolo ("ROSSI"): utile per estratti conto, rischioso sul testo
   *   corrente, per questo è spento per impostazione predefinita.
   * @returns {{text: string, total: number, counts: Object<string, number>}}
   *   text   = testo mascherato
   *   total  = numero complessivo di sostituzioni
   *   counts = sostituzioni per categoria (EMAIL, TELEFONO, CF_PIVA, IBAN_CARTA, DATA)
   */
  function sanitize(input, opzioni) {
    const counts = {
      EMAIL: 0,
      TELEFONO: 0,
      CF_PIVA: 0,
      IBAN_CARTA: 0,
      DATA: 0,
      DOCUMENTO: 0,
      PRATICA: 0,
      CVV: 0,
      INDIRIZZO: 0,
      DATI_SANITARI: 0,
      SEGRETO: 0,
      CHIAVE_PRIVATA: 0,
      NOME: 0
    };
    if (typeof input !== "string" || input.length === 0) {
      return { text: "", total: 0, counts, protette: [] };
    }

    let testo = input;
    let total = 0;
    const regole = opzioni && opzioni.cognomiAmbigui ? REGOLE_CON_AMBIGUI : REGOLE;
    // Le parole da non toccare escono dal testo prima delle regole e rientrano
    // alla fine: nel mezzo restano segnaposti che nessuna regola riconosce.
    let protette = [];
    if (Array.isArray(opzioni?.esclusioni) && opzioni.esclusioni.length > 0) {
      const esitoEsclusioni = applicaEsclusioni(testo, opzioni.esclusioni);
      testo = esitoEsclusioni.testo;
      protette = esitoEsclusioni.protette;
    }

    for (const regola of regole) {
      testo = testo.replace(regola.regex, (...argomenti) => {
        // Per String.replace gli ultimi due argomenti sono sempre l'offset e la
        // stringa di partenza (nessuna regex qui usa gruppi con nome).
        const match = argomenti[0];
        const offset = argomenti[argomenti.length - 2];
        const stringa = argomenti[argomenti.length - 1];
        const sostituto = regola.trasforma(match, offset, stringa, argomenti);
        if (sostituto === null) return match; // falso positivo: testo invariato
        counts[regola.chiave] += 1;
        total += 1;
        return sostituto;
      });
    }

    // Le esclusioni non vengono rimesse qui: chi chiama deve poter far passare
    // prima l'analisi AI e poi usare rimettiEsclusioni().
    return { text: testo, total, counts, protette };
  }

  const api = Object.freeze({ sanitize, accoppiaSegnaposti, rimettiEsclusioni, PLACEHOLDER });

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api; // test in Node
  } else {
    globalThis.GdprSanitizer = api; // content script / service worker
  }
})();

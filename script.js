// =========== CLÉS LOCALSTORAGE (cache local uniquement) ===========
const KEY_ETUDIANTS_AFF  = 'etudiants_misericorde';
const KEY_SESSIONS_AFF   = 'sessions_misericorde';
const KEY_PRESENCES_AFF  = 'data_presences_v5';
const KEY_ETUDIANTS_BAP  = 'etudiants_bapteme';
const KEY_SESSIONS_BAP   = 'sessions_bapteme';
const KEY_PRESENCES_BAP  = 'presences_bapteme';
const KEY_SESSIONS_COTE  = 'sessions_cotes';
const KEY_DATA_COTE      = 'cotes_data_v1';
const KEY_PROMOS_AFF     = 'promos_misericorde_v1';
const KEY_ACCUSE_TP      = 'accuses_tp_v2';
const KEY_MDP            = 'mdp_admin_misericorde';
const KEY_ENCADRANTS     = 'encadrants_misericorde';
const KEY_CODE_BAP       = 'code_acces_bapteme';
const KEY_CODE_AFF_INSC  = 'code_acces_aff_inscription';
const KEY_ACTIVE_PROMO   = 'promo_active_aff';

// =========== VARIABLES GLOBALES ===========
let etudiants        = [];
let sessions         = [];
let historique       = {};
let sessionsCotes    = [];
let cotesData        = {};
let promosAffermissement = [];
let accuseTPData     = {};
let encadrantsInscrits = [];
let motDePasse       = "";
let leconsGlobal     = []; //  Cache global des leçons pour accès au champ bloquee

let currentMode         = '';
let html5QrCode         = null;
let photoBase64         = "";
let encadrantActuel     = "";
let encadrantAuthentifie = false;
let filtreAdminPromo    = "ALL"; 

// =========== MERCREDI ===========
let etudiantsMercredi   = [];   // copie des participants affermissement
let presencesMercredi   = {};   // { 'lecon_nom': [{code, date}] }
let sessionsMercredi    = [];   // liste des leçons mercredi

const joursNoms = ['Dimanche','Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi'];
//  Toujours la date du jour réelle, même si la page est ouverte depuis plusieurs heures
function getDuJour() { return new Date().toLocaleDateString('fr-FR'); }

// =========== HELPERS SUPABASE ===========
// db est défini dans le HTML avant ce script

//  Source unique de vérité : session active depuis Supabase
async function getActiveSession() {
    try {
        const { data, error } = await db.from('sessions_affermissement').select('nom').eq('est_active', true).single();
        if(data) { localStorage.setItem(KEY_ACTIVE_PROMO, data.nom); return data.nom; }
        if(error && error.code !== 'PGRST116') console.warn('getActiveSession:', error.message);
    } catch(e) { console.warn('getActiveSession inaccessible:', e.message); }
    return localStorage.getItem(KEY_ACTIVE_PROMO) || '';
}

async function dbInsert(table, data) {
    const { data: result, error } = await db.from(table).insert(data).select().single();
    if (error) { console.error('Supabase INSERT error [' + table + ']:', error.message); throw error; }
    return result;
}
async function dbUpsert(table, data, conflictCol) {
    const { data: result, error } = await db.from(table).upsert(data, { onConflict: conflictCol }).select().single();
    if (error) { console.error('Supabase UPSERT error [' + table + ']:', error.message); throw error; }
    return result;
}
async function dbSelect(table, filters) {
    let query = db.from(table).select('*');
    if (filters) Object.entries(filters).forEach(([k,v]) => { query = query.eq(k, v); });
    const { data, error } = await query;
    if (error) { console.error('Supabase SELECT error [' + table + ']:', error.message); return []; }
    return data || [];
}
async function dbUpdate(table, match, data) {
    let query = db.from(table).update(data);
    Object.entries(match).forEach(([k,v]) => { query = query.eq(k, v); });
    const { error } = await query;
    if (error) { console.error('Supabase UPDATE error [' + table + ']:', error.message); throw error; }
}
async function dbDelete(table, match) {
    let query = db.from(table).delete();
    Object.entries(match).forEach(([k,v]) => { query = query.eq(k, v); });
    const { error } = await query;
    if (error) { console.error('Supabase DELETE error [' + table + ']:', error.message); throw error; }
}

// ✅ CORRECTION DÉFINITIVE limite 1000 lignes : pagination réelle via .range() en boucle.
// Récupère TOUTES les lignes d'une table, quel que soit leur nombre (pas de plafond fixe).
async function dbSelectAllRange(table, filters) {
    const pageSize = 1000;
    let from = 0;
    let all = [];
    while (true) {
        let query = db.from(table).select('*');
        if (filters) Object.entries(filters).forEach(([k, v]) => { query = query.eq(k, v); });
        const { data, error } = await query.range(from, from + pageSize - 1);
        if (error) { console.error('Supabase RANGE SELECT error [' + table + ']:', error.message); break; }
        if (!data || data.length === 0) break;
        all = all.concat(data);
        if (data.length < pageSize) break; // dernière page atteinte
        from += pageSize;
    }
    return all;
}

// =========== INIT & NAVIGATION ===========
function initAccueil() {
    const h = new Date().getHours();
    document.getElementById('salutation').innerText = h < 12 ? " Bonjour !" : (h < 18 ? " Bonne après-midi !" : " Bonsoir !");
    //  Réveiller Supabase dès l'ouverture (évite la mise en pause de 7 jours)
    setTimeout(async () => { try { await db.from('config_application').select('cle').limit(1); } catch(e) {} }, 500);
    // ✅ Injecter bouton Mercredi dynamiquement dans le menu encadrant
    injecterBoutonMercredi();
}

function injecterBoutonMercredi() {
    const container = document.getElementById('accueil-encadrant-btns');
    if(!container || document.getElementById('btn-mercredi-admin')) return;
    // Trouver le bouton retour ⬅️ et insérer avant lui
    const btnRetour = [...container.querySelectorAll('button')].find(b => b.innerText.includes('⬅'));
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'btn-mercredi-admin';
    btn.className = 'accueil-btn';
    btn.style.cssText = 'background:#5a4fcf;color:white;';
    btn.innerText = 'Mercredi';
    btn.onclick = choisirMercredi;
    if(btnRetour) container.insertBefore(btn, btnRetour);
    else container.appendChild(btn);
}
initAccueil();

function fermerModal(id) { document.getElementById(id).style.display = 'none'; }

function changerVue(vue, push = true) {
    if(html5QrCode) { try { html5QrCode.stop(); document.getElementById('btn-start').style.display='block'; document.getElementById('btn-stop').style.display='none'; } catch(e){} }
    
    document.getElementById('page-accueil').style.display = 'none';
    document.getElementById('section-inscription').classList.add('hidden');
    document.getElementById('section-admin').classList.add('hidden');
    document.getElementById('section-resultat').classList.add('hidden');
    document.getElementById('cote-rapport').style.display = 'none';
    document.querySelectorAll('.accueil-btns-container').forEach(el => el.classList.add('hidden'));
    
    fermerModal('modal-encadrant'); fermerModal('modal-mdp-bapteme'); fermerModal('modal-code-aff'); fermerSuiviTravail(); fermerVueGlobale();

    if (vue === 'accueil-main') {
        document.getElementById('page-accueil').style.display = 'flex';
        document.getElementById('accueil-main-btns').classList.remove('hidden');
        encadrantAuthentifie = false; encadrantActuel = "";
    } else if (vue === 'accueil-participant') {
        document.getElementById('page-accueil').style.display = 'flex';
        document.getElementById('accueil-participant-btns').classList.remove('hidden');
    } else if (vue === 'accueil-affermissement') {
        document.getElementById('page-accueil').style.display = 'flex';
        document.getElementById('accueil-affermissement-btns').classList.remove('hidden');
    } else if (vue === 'accueil-encadrant-menu') {
        if (!encadrantAuthentifie) { changerVue('accueil-main', false); verifierEncadrant(); return; }
        document.getElementById('page-accueil').style.display = 'flex';
        document.getElementById('accueil-encadrant-btns').classList.remove('hidden');
    } else if (vue === 'inscription') {
        document.getElementById('section-inscription').classList.remove('hidden');
        document.querySelectorAll('.affermissement-only').forEach(el => el.style.display = (currentMode === 'bapteme') ? 'none' : 'block');
        document.querySelectorAll('.bapteme-only').forEach(el => el.style.display = (currentMode === 'bapteme') ? 'block' : 'none');
        document.getElementById('titre-inscription').innerText = currentMode === 'bapteme' ? ' Inscription Baptême' : ' Inscription Affermissement';
        viderFormulaire();
        if(currentMode === 'affermissement') {
            document.getElementById('check-ancien').checked = false;
            remplirSessionsInscription();
        }
    } else if (vue === 'admin') {
        if (!encadrantAuthentifie) { changerVue('accueil-main', false); return; }
        document.getElementById('section-admin').classList.remove('hidden');
    } else if (vue === 'mercredi-admin') {
        if (!encadrantAuthentifie) { changerVue('accueil-main', false); return; }
        document.getElementById('section-admin').classList.remove('hidden');
    } else if (vue === 'resultat') {
        document.getElementById('section-resultat').classList.remove('hidden');
    }
    
    if (push) history.pushState({ vue: vue, mode: currentMode, encadrant: encadrantActuel, auth: encadrantAuthentifie }, '', '');
}

window.addEventListener('popstate', (e) => {
    if (e.state && e.state.vue) {
        currentMode = e.state.mode; encadrantActuel = e.state.encadrant; encadrantAuthentifie = e.state.auth;
        changerVue(e.state.vue, false);
        if (e.state.vue === 'admin') lancerSessionAdmin(encadrantActuel, false);
    } else { changerVue('accueil-main', false); }
});
window.onload = () => { history.replaceState({ vue: 'accueil-main', mode: '', encadrant: '', auth: false }, '', ''); };

// =========== PARTICIPANT - ACCÈS ===========
function participantBapteme() { currentMode = 'bapteme'; document.getElementById('code-acces-bapteme').value = ''; document.getElementById('modal-mdp-bapteme').style.display = 'flex'; }
async function validerAccesBapteme() {
    // Vérification du code depuis Supabase
    const rows = await dbSelect('config_application', { cle: 'code_acces_bapteme' });
    let code = rows.length > 0 ? rows[0].valeur : (localStorage.getItem(KEY_CODE_BAP) || "bap123");
    if(document.getElementById('code-acces-bapteme').value.trim() !== code) return alert("Code incorrect !");
    fermerModal('modal-mdp-bapteme'); changerVue('inscription');
}
function participantAffermissement() { currentMode = 'affermissement'; changerVue('accueil-affermissement'); }
function demanderCodeInscriptionAff() { document.getElementById('code-acces-aff').value = ''; document.getElementById('modal-code-aff').style.display = 'flex'; }
async function validerAccesAff() {
    const rows = await dbSelect('config_application', { cle: 'code_acces_affermissement' });
    let code = rows.length > 0 ? rows[0].valeur : (localStorage.getItem(KEY_CODE_AFF_INSC) || "aff123");
    if(document.getElementById('code-acces-aff').value.trim() !== code) return alert("Code incorrect !");
    fermerModal('modal-code-aff'); currentMode = 'affermissement'; changerVue('inscription');
}

// =========== SUIVI TRAVAUX (PARTICIPANT) ===========
function ouvrirModalSuiviTravail() {
    document.getElementById('code-suivi-input').value = ''; document.getElementById('resultat-suivi-participant').innerHTML = '';
    document.getElementById('modal-suivi-travail').style.display = 'flex';
}
function fermerSuiviTravail() { fermerModal('modal-suivi-travail'); }

async function afficherSuiviParticipant() {
    const code = document.getElementById('code-suivi-input').value.trim();
    if(!code || code.length < 4) return alert("Entrez votre code !");

    document.getElementById('resultat-suivi-participant').innerHTML = '<p style="color:#006070;">Chargement...</p>';

    try {
        // 1. Trouver le participant dans Supabase — ilike pour éviter problème CHAR(4)
        const { data: parts } = await db.from('participants_affermissement').select('*').ilike('code', code.trim()).limit(1);
        if(!parts || parts.length === 0) return alert("Code introuvable.");
        const etu = parts[0];

        // 2. Lire la session active depuis Supabase
        const activeSession = await getActiveSession();

        // 3. Charger UNIQUEMENT les leçons de type "cote" et leurs sous-dossiers
        const { data: toutesLecons } = await db.from('lecons_affermissement').select('*').order('ordre');
        const { data: sousDoss } = await db.from('sous_dossiers_cote').select('*').order('ordre');
        
        // Filtrer pour garder seulement les leçons de côte
        const idsAvecSd = new Set((sousDoss||[]).map(sd => sd.lecon_id));
        const lecons = (toutesLecons||[]).filter(l => 
            l.type === 'cote' || ((!l.type) && idsAvecSd.has(l.id))
        );

        // 4. Charger les côtes du participant depuis Supabase
        const { data: cotesRows } = await db.from('cotes').select('*').eq('participant_id', etu.id);

        let html = `<div style="background:#e8f4f8;padding:10px;border-radius:6px;margin-bottom:10px;">
            <b>${etu.nom.toUpperCase()} ${etu.prenom}</b><br>
            <span style="font-size:12px;color:#555;">Session Active : <b style="color:#006070;">${activeSession || 'N/A'}</b></span>
        </div>`;

        if(!lecons || lecons.length === 0) {
            html += `<p style="font-size:12px;">Aucun TP enregistré.</p>`;
        } else {
            lecons.forEach(lecon => {
                const sousDeLecon = (sousDoss || []).filter(sd => sd.lecon_id === lecon.id);
                if(sousDeLecon.length === 0) return;
                html += `<div style="margin-top:10px;color:#006070;"><b>${lecon.nom}</b></div>`;
                sousDeLecon.forEach(sd => {
                    const coteRow = (cotesRows || []).find(c => c.sous_dossier_id === sd.id);
                    let status = `<span style="color:#dc3545;font-weight:bold;">NON FAIT</span>`;
                    if(coteRow && coteRow.valeur) {
                        status = `<span style="color:#28a745;font-weight:bold;">FAIT (${coteRow.valeur})</span>`;
                    } else if(coteRow && coteRow.accuse_reception) {
                        status = `<span style="color:#fd7e14;font-weight:bold;">ACCUSÉ (En attente de cote)</span>`;
                    }
                    html += `<div class="suivi-travail-item"><span>${sd.nom}</span> ${status}</div>`;
                });
            });
        }
        document.getElementById('resultat-suivi-participant').innerHTML = html;
    } catch(e) {
        document.getElementById('resultat-suivi-participant').innerHTML = `<p style="color:red;">Erreur : ${e.message}</p>`;
    }
}

// =========== ENCADRANT LOGIN ===========
function verifierEncadrant() {
    if (encadrantAuthentifie) changerVue('accueil-encadrant-menu');
    else { document.getElementById('encad-prenom').value = ""; document.getElementById('encad-mdp').value = ""; document.getElementById('modal-encadrant').style.display = 'flex'; }
}

async function inscrireEncadrantGlobal() {
    const p = document.getElementById('encad-prenom').value.trim(); 
    const m = document.getElementById('encad-mdp').value.trim();
    if(!p || !m) return alert("Remplissez tout !");

    // Vérifier le mot de passe admin depuis Supabase
    const rows = await dbSelect('config_application', { cle: 'mot_de_passe_admin' });
    const mdpAdmin = rows.length > 0 ? rows[0].valeur : motDePasse;
    if(m !== mdpAdmin) return alert("Mots de passe incorrect !");

    try {
        // Sauvegarder l'encadrant dans Supabase
        await dbUpsert('encadrants', { prenom: p, password_hash: m, role: 'encadrant', actif: true }, 'prenom');
        if(!encadrantsInscrits.includes(p.toLowerCase())) { 
            encadrantsInscrits.push(p.toLowerCase()); 
            localStorage.setItem(KEY_ENCADRANTS, JSON.stringify(encadrantsInscrits)); 
        }
        alert("Vous êtes inscrit !");
        encadrantAuthentifie = true; encadrantActuel = p; 
        fermerModal('modal-encadrant'); changerVue('accueil-encadrant-menu');
    } catch(e) {
        alert("Erreur lors de l'inscription : " + e.message);
    }
}

async function connecterEncadrantGlobal() {
    const p = document.getElementById('encad-prenom').value.trim(); 
    const m = document.getElementById('encad-mdp').value.trim();
    if(!p || !m) return alert("Remplissez tout !");

    // Vérifier le mot de passe admin
    const rows = await dbSelect('config_application', { cle: 'mot_de_passe_admin' });
    const mdpAdmin = rows.length > 0 ? rows[0].valeur : motDePasse;
    if(m !== mdpAdmin) return alert("MDP incorrect !");

    // Vérifier que l'encadrant existe dans Supabase
    const encRows = await dbSelect('encadrants', { prenom: p });
    if(encRows.length === 0) return alert("Non inscrit !");

    encadrantAuthentifie = true; encadrantActuel = p; 
    fermerModal('modal-encadrant'); changerVue('accueil-encadrant-menu');
}

function choisirAdmin(mode) { 
    currentMode = mode; 
    if(mode === 'bapteme') filtreAdminPromo = "ALL";
    lancerSessionAdmin(encadrantActuel); 
    changerVue('admin'); 
}

async function choisirMercredi() {
    currentMode = 'mercredi';
    lancerSessionAdmin(encadrantActuel);
    changerVue('mercredi-admin');
}

// =========== DATA GESTION — Charge depuis Supabase + cache local ===========
async function chargerDonnees() {
    if(currentMode === 'bapteme') {
        //  OPTIMISATION : charger participants, leçons et présences en parallèle
        // ✅ CORRECTION : pagination réelle via .range() — aucune limite fixe de lignes
        const [parts, lecons, presences] = await Promise.all([
            dbSelect('participants_bapteme'),
            dbSelect('lecons_bapteme'),
            dbSelectAllRange('presences_bapteme')
        ]);

        etudiants = parts.map(p => ({
            code: p.code, nom: p.nom, postnom: p.postnom || '', prenom: p.prenom,
            telephone: p.telephone, adresse: p.adresse, etatCivil: p.etat_civil,
            profession: p.profession, _id: p.id
        }));

        sessions = lecons.sort((a,b)=>(a.ordre||0)-(b.ordre||0)).map(l => l.nom);
        if(sessions.length === 0) sessions = ["BAPTEME 1"];

        historique = {};
        for(const pr of presences) {
            const lecon = lecons.find(l => l.id === pr.lecon_id);
            const nomLecon = lecon ? lecon.nom : 'BAPTEME 1';
            const part = etudiants.find(e => e._id === pr.participant_id);
            if(!part) continue;
            if(!historique[nomLecon]) historique[nomLecon] = [];
            const dateStr = pr.date_presence.split('T')[0];
            const [y,m,d] = dateStr.split('-');
            historique[nomLecon].push({ code: part.code, date: `${d}/${m}/${y}`, encadrant: '' });
        }

    } else if(currentMode === 'mercredi') {
        // Charger participants affermissement + présences mercredi
        const sessActNom = await getActiveSession();
        const [parts, sessRows, lecons, presences] = await Promise.all([
            dbSelect('participants_affermissement'),
            dbSelect('sessions_affermissement'),
            db.from('lecons_affermissement').select('*').eq('type', 'mercredi').then(r => r.data || []),
            dbSelectAllRange('presences_mercredi')
        ]);

        const sessActive = sessRows.find(s => s.est_active === true);

        etudiants = parts.map(p => {
            const sa = sessRows.find(s => s.id === p.session_active_id);
            return {
                code: p.code, nom: p.nom, postnom: p.postnom || '', prenom: p.prenom,
                telephone: p.telephone, adresse: p.adresse, etatCivil: p.etat_civil,
                profession: p.profession, telUrgence: p.telephone_urgence || '',
                salle: p.salle || '', photo: p.photo_url || '',
                sessionInscription: sa ? sa.nom : '',
                promos: sa ? [sa.nom] : [],
                _id: p.id
            };
        });

        sessions = lecons.sort((a,b)=>(a.ordre||0)-(b.ordre||0)).map(l => l.nom);
        if(sessions.length === 0) sessions = ["MERCREDI 1"];

        historique = {};
        for(const pr of presences) {
            const lecon = lecons.find(l => l.id === pr.lecon_id);
            const nomLecon = lecon ? lecon.nom : sessions[0];
            const part = etudiants.find(e => e._id === pr.participant_id);
            if(!part) continue;
            if(!historique[nomLecon]) historique[nomLecon] = [];
            const dateStr = pr.date_presence.split('T')[0];
            const [y,m,d] = dateStr.split('-');
            historique[nomLecon].push({ code: part.code, date: `${d}/${m}/${y}`, encadrant: '', promo: sessActive ? sessActive.nom : '' });
        }

    } else if(currentMode === 'affermissement' || currentMode === 'cote') {
        //  OPTIMISATION : charger tout en parallèle (1 aller-retour au lieu de 6)
        // ✅ CORRECTION : pagination réelle via .range() — aucune limite fixe de lignes
        const [parts, sessRows, lecons, sousDossiers, presences, cotesRows] = await Promise.all([
            dbSelect('participants_affermissement'),
            dbSelect('sessions_affermissement'),
            dbSelect('lecons_affermissement'),
            dbSelect('sous_dossiers_cote'),
            dbSelectAllRange('presences_affermissement'),
            dbSelectAllRange('cotes')
        ]);

        // Participants
        etudiants = parts.map(p => {
            const sessActive = sessRows.find(s => s.id === p.session_active_id);
            return {
                code: p.code, nom: p.nom, postnom: p.postnom || '', prenom: p.prenom,
                telephone: p.telephone, adresse: p.adresse, etatCivil: p.etat_civil,
                profession: p.profession, telUrgence: p.telephone_urgence || '',
                salle: p.salle || '', photo: p.photo_url || '',
                sessionInscription: sessActive ? sessActive.nom : '',
                promos: sessActive ? [sessActive.nom] : [],
                _id: p.id
            };
        });

        // Sessions / promos
        promosAffermissement = sessRows.sort((a,b)=> new Date(a.date_creation)-new Date(b.date_creation)).map(s => s.nom);
        if(!promosAffermissement.includes("Session 23")) promosAffermissement.push("Session 23");
        const sessActiveRow = sessRows.find(s => s.est_active === true);
        if(sessActiveRow) localStorage.setItem(KEY_ACTIVE_PROMO, sessActiveRow.nom);

        // ✅ SÉPARATION CORRECTE : utiliser le champ "type" pour distinguer
        // type = 'cote' ou NULL avec sous-dossiers → côte
        // type = 'presence' ou NULL sans sous-dossiers → présence
        // NULL = leçons créées avant la migration → on regarde si elles ont des sous-dossiers

        const idsAvecSousDoss = new Set(sousDossiers.map(sd => sd.lecon_id));
        leconsGlobal = lecons; // ✅ Mettre à jour le cache global

        // ✅ SÉPARATION STRICTE des types de leçons
        const leconsPresence = lecons.filter(l => 
            l.type === 'presence' || 
            (l.type === null && !idsAvecSousDoss.has(l.id)) ||
            (l.type === undefined && !idsAvecSousDoss.has(l.id))
            // NB: type 'mercredi' et 'cote' sont EXCLUS ici
        );
        const leconsCote = lecons.filter(l => 
            l.type === 'cote' || 
            (l.type === null && idsAvecSousDoss.has(l.id)) ||
            (l.type === undefined && idsAvecSousDoss.has(l.id))
        );
        // IDs des leçons de présence affermissement uniquement (pas mercredi, pas cote)
        const idsLeconsPresence = new Set(leconsPresence.map(l => l.id));

        // sessions = leçons de présence uniquement (sans mercredi)
        sessions = leconsPresence.sort((a,b)=>(a.ordre||0)-(b.ordre||0)).map(l => l.nom);
        if(sessions.length === 0) sessions = ["LECON 1"];

        // ✅ Présences affermissement : exclure les présences des leçons mercredi
        historique = {};
        for(const pr of presences) {
            const lecon = lecons.find(l => l.id === pr.lecon_id);
            if(!lecon) continue;
            // ✅ CORRECTION : ignorer les leçons de type 'mercredi' dans l'historique affermissement
            if(lecon.type === 'mercredi') continue;
            // Ignorer aussi les leçons qui ne sont pas dans leconsPresence
            if(!idsLeconsPresence.has(lecon.id)) continue;
            const nomLecon = lecon.nom;
            const part = etudiants.find(e => e._id === pr.participant_id);
            const sess = sessRows.find(s => s.id === pr.session_id);
            if(!part) continue;
            if(!historique[nomLecon]) historique[nomLecon] = [];
            const dateStr = pr.date_presence.split('T')[0];
            const [y,m,d] = dateStr.split('-');
            historique[nomLecon].push({ code: part.code, date: `${d}/${m}/${y}`, encadrant: '', promo: sess ? sess.nom : '' });
        }

        // sessionsCotes = leçons de type "cote" — gardées même sans sous-dossiers
        sessionsCotes = leconsCote.sort((a,b)=>(a.ordre||0)-(b.ordre||0)).map(l => ({
            nom: l.nom,
            sous: sousDossiers.filter(sd => sd.lecon_id === l.id)
                              .sort((a,b)=>(a.ordre||0)-(b.ordre||0))
                              .map(sd => sd.nom),
            _id: l.id
        }));
        // ✅ Plus de .filter(sc => sc.sous.length > 0) — une leçon côte reste visible même sans sous-dossiers

        // Côtes
        cotesData = {}; accuseTPData = {};
        for(const c of cotesRows) {
            const sd = sousDossiers.find(s => s.id === c.sous_dossier_id);
            const lecon = lecons.find(l => sd && l.id === sd.lecon_id);
            const part = etudiants.find(e => e._id === c.participant_id);
            if(!sd || !lecon || !part) continue;
            const nomLecon = lecon.nom; const nomSd = sd.nom;
            if(!cotesData[nomLecon]) cotesData[nomLecon] = {};
            if(!cotesData[nomLecon][nomSd]) cotesData[nomLecon][nomSd] = [];
            cotesData[nomLecon][nomSd].push({ code: part.code, cote: c.valeur || '' });
            if(c.accuse_reception) {
                if(!accuseTPData[nomLecon]) accuseTPData[nomLecon] = {};
                if(!accuseTPData[nomLecon][nomSd]) accuseTPData[nomLecon][nomSd] = [];
                if(!accuseTPData[nomLecon][nomSd].includes(part.code)) accuseTPData[nomLecon][nomSd].push(part.code);
            }
        }

        // Sync localStorage minimal (pour affichage rapide seulement)
        localStorage.setItem(KEY_PROMOS_AFF, JSON.stringify(promosAffermissement));
    }
}

// localStorage : cache minimal uniquement — les données réelles sont dans Supabase
function sauvegarderDonneesLocal() {
    // On ne sauvegarde PAS les données sensibles (participants, présences, côtes)
    // On garde seulement les préférences légères
    localStorage.setItem(KEY_PROMOS_AFF, JSON.stringify(promosAffermissement));
}
// Alias pour compatibilité
function sauvegarderDonnees() { sauvegarderDonneesLocal(); }

// =========== ADMIN SETUP ===========
async function lancerSessionAdmin(prenom, pushState = true) {
    encadrantActuel = prenom;
    document.getElementById('nom-encadrant-affiche').innerText = "Connecté : " + encadrantActuel;
    
    // Afficher un indicateur de chargement
    document.getElementById('admin-title').innerText = "Chargement...";
    await chargerDonnees();

    const estBapteme = (currentMode === 'bapteme');
    const estCote    = (currentMode === 'cote');
    const estAff     = (currentMode === 'affermissement');

    document.getElementById('admin-title').innerText = " Admin - " + currentMode.toUpperCase();
    document.querySelectorAll('.affermissement-only').forEach(el => el.style.display = estAff ? 'block' : 'none');

    const estMercredi = (currentMode === 'mercredi');
    document.getElementById('btn-delete-all-bap').style.display  = estBapteme ? 'inline-block' : 'none';
    document.getElementById('btn-changer-mdp-inscr').style.display = (estCote || estMercredi) ? 'none' : 'inline-block';
    document.getElementById('btn-changer-mdp-admin').style.display = estAff ? 'inline-block' : 'none';
    // Masquer suppression participant en mode mercredi
    if(estMercredi) {
        const btnSuppr = document.getElementById('btn-toggle-suppr');
        if(btnSuppr) btnSuppr.style.display = 'none';
        const btnScan = document.getElementById('btn-start');
        if(btnScan) btnScan.style.display = 'none';
        document.getElementById('admin-title').innerText = " Admin - MERCREDI";
    }

    //  Lire le code d'accès depuis Supabase
    if(!estCote) {
        const cleCfg = estBapteme ? 'code_acces_bapteme' : 'code_acces_affermissement';
        const cfgRows = await dbSelect('config_application', { cle: cleCfg });
        const codeInscr = cfgRows.length > 0 ? cfgRows[0].valeur : '(non défini)';
        document.getElementById('display-mdp-inscr').innerText = "MDP actuel Formulaire : " + codeInscr;
    } else {
        document.getElementById('display-mdp-inscr').innerText = "";
    }

    if(estAff || estCote) { rafraichirListePromosAdmin(); }

    if(estCote) {
        document.getElementById('section-presence').style.display = 'none';
        document.getElementById('section-cote').style.display     = 'block';
        document.getElementById('section-participants-admin').style.display = 'none';
        document.getElementById('gestion-promos').classList.add('hidden');
        document.getElementById('boite-session-active').style.display = 'none';
        let btnNew = document.querySelector('[onclick="togglePromos()"]'); if(btnNew) btnNew.style.display = 'none';
        let btnDos = document.querySelector('[onclick="toggleDossiers()"]'); if(btnDos) btnDos.style.display = '';
        updateSelectCotes();
        let selCoteFiltre = document.getElementById('cote-promo-filter');
        selCoteFiltre.innerHTML = `<option value="ALL">Toutes les sessions</option>` + promosAffermissement.map(p => `<option value="${p}">${p}</option>`).join('');
        selCoteFiltre.value = filtreAdminPromo;
        //  Lire la session active depuis Supabase
        const activeSessionCote = await getActiveSession();
        document.getElementById('admin-title').innerText = ' Admin - TRAVAUX | Session: ' + (activeSessionCote || '(aucune)');
    } else if(estBapteme) {
        document.getElementById('section-presence').style.display = 'block';
        document.getElementById('section-cote').style.display     = 'none';
        document.getElementById('section-participants-admin').style.display = 'block';
        document.getElementById('boite-session-active').style.display = 'none';
        let btnNew = document.querySelector('[onclick="togglePromos()"]'); if(btnNew) btnNew.style.display = 'none';
        let btnDos = document.querySelector('[onclick="toggleDossiers()"]'); if(btnDos) btnDos.style.display = '';
        document.getElementById('btn-releve-final').style.display = 'none';
        updateSessionSelect();
    } else {
        document.getElementById('section-presence').style.display = 'block';
        document.getElementById('section-cote').style.display     = 'none';
        document.getElementById('section-participants-admin').style.display = 'block';
        document.getElementById('boite-session-active').style.display = 'block';
        document.getElementById('btn-releve-final').style.display = 'block';
        let btnNew = document.querySelector('[onclick="togglePromos()"]'); if(btnNew) btnNew.style.display = '';
        let btnDos = document.querySelector('[onclick="toggleDossiers()"]'); if(btnDos) btnDos.style.display = '';
        updateSessionSelect();
    }
}

function rafraichirFiltresAdmin() {
    filtreAdminPromo = document.getElementById('admin-promo-filter').value;
    afficherListeEtudiants(); 
}
function rafraichirFiltresCote() {
    filtreAdminPromo = document.getElementById('cote-promo-filter').value;
    let selAdmin = document.getElementById('admin-promo-filter');
    if(selAdmin) selAdmin.value = filtreAdminPromo;
}
function syncFiltreDropdown() {
    let selFiltre = document.getElementById('admin-promo-filter');
    if(!selFiltre) return;
    let prev = selFiltre.value;
    selFiltre.innerHTML = `<option value="ALL">Toutes les sessions (Global)</option>` + promosAffermissement.map(p => `<option value="${p}">${p}</option>`).join('');
    if(promosAffermissement.includes(prev)) selFiltre.value = prev;
    else { selFiltre.value = "ALL"; filtreAdminPromo = "ALL"; }
}
function getEtudiantsFiltres() {
    if(currentMode === 'mercredi') return etudiants;
    if(currentMode === 'bapteme') return etudiants;
    if(filtreAdminPromo === "ALL") return etudiants;
    return etudiants.filter(e => e.sessionInscription === filtreAdminPromo || (e.promos && e.promos.includes(filtreAdminPromo)));
}

// =========== GESTION SESSIONS (ANNÉES/PROMOS) ===========
function togglePromos() { document.getElementById('gestion-promos').classList.toggle('hidden'); rafraichirListePromosAdmin(); }
function rafraichirListePromosAdmin() {
    document.getElementById('liste-promos-admin').innerHTML = promosAffermissement.map((p, i) => 
        `<span style="background:#eee;padding:3px 8px;border-radius:12px;margin:2px;display:inline-block;">${p} <button type="button" style="background:none;color:red;border:none;cursor:pointer;font-weight:bold;" onclick="supprimerPromo(${i})">✕</button></span>`
    ).join('');
    syncFiltreDropdown();
    let selActive = document.getElementById('admin-session-active');
    //  Lire la session active depuis localStorage (mis à jour depuis Supabase dans chargerDonnees)
    let currentActive = localStorage.getItem(KEY_ACTIVE_PROMO);
    if(promosAffermissement.length > 0) {
        if(!currentActive || !promosAffermissement.includes(currentActive)) {
            currentActive = promosAffermissement[promosAffermissement.length - 1];
        }
        selActive.innerHTML = promosAffermissement.map(p => `<option value="${p}">${p}</option>`).join('');
        selActive.value = currentActive;
    } else {
        selActive.innerHTML = `<option value="">(Aucune session)</option>`;
    }
}

async function ajouterPromo() {
    let val = document.getElementById('nouvelle-promo').value.trim();
    if(!val || promosAffermissement.includes(val)) return;
    try {
        // Sauvegarder dans Supabase
        await dbInsert('sessions_affermissement', { nom: val, est_active: false });
        promosAffermissement.push(val);
        sauvegarderDonneesLocal();
        rafraichirListePromosAdmin();
        document.getElementById('nouvelle-promo').value = "";
    } catch(e) {
        alert("Erreur lors de la création de la session : " + e.message);
    }
}

async function supprimerPromo(idx) { 
    if(!confirm("Supprimer cette Session d'année ?")) return;
    let sessionSupprimee = promosAffermissement[idx];
    try {
        // Supprimer dans Supabase
        await dbDelete('sessions_affermissement', { nom: sessionSupprimee });
        promosAffermissement.splice(idx, 1); 
        sauvegarderDonneesLocal();
        let selFiltre = document.getElementById('admin-promo-filter');
        if(selFiltre) {
            selFiltre.innerHTML = `<option value="ALL">Toutes les sessions (Global)</option>` + promosAffermissement.map(p => `<option value="${p}">${p}</option>`).join('');
            if(filtreAdminPromo === sessionSupprimee) { filtreAdminPromo = "ALL"; selFiltre.value = "ALL"; }
        }
        rafraichirListePromosAdmin();
    } catch(e) {
        alert("Erreur lors de la suppression : " + e.message);
    }
}

async function changerSessionActive() {
    let sel = document.getElementById('admin-session-active'); 
    if(!sel || !sel.value) return;
    const nomSession = sel.value;
    try {
        // 1. Désactiver TOUTES les sessions dans Supabase
        await db.from('sessions_affermissement').update({ est_active: false }).neq('nom', '___AUCUNE___');
        // 2. Activer la session choisie dans Supabase
        await db.from('sessions_affermissement').update({ est_active: true }).eq('nom', nomSession);
        // 3. Sauvegarder aussi en local pour accès rapide
        localStorage.setItem(KEY_ACTIVE_PROMO, nomSession);
        alert(" Session active mise à jour : " + nomSession + "\nTous les appareils verront cette session.");
    } catch(e) {
        // En cas d'erreur Supabase, sauvegarder quand même en local
        localStorage.setItem(KEY_ACTIVE_PROMO, nomSession);
        alert("Session active changée localement. Vérifiez votre connexion Supabase.");
    }
}

async function modifierCodeAcces() {
    let cle = (currentMode === 'bapteme') ? 'code_acces_bapteme' : 'code_acces_affermissement';
    const nouveau = prompt("Nouveau code d'accès :"); 
    if(!nouveau) return;
    try {
        await dbUpdate('config_application', { cle: cle }, { valeur: nouveau.trim() });
        if(currentMode === 'bapteme') localStorage.setItem(KEY_CODE_BAP, nouveau.trim());
        else localStorage.setItem(KEY_CODE_AFF_INSC, nouveau.trim());
        document.getElementById('display-mdp-inscr').innerText = "MDP Formulaire : " + nouveau.trim();
        alert("Code modifié avec succès !");
    } catch(e) { alert("Erreur : " + e.message); }
}

async function modifierMotDePasse() {
    const ancien = prompt("Mot de passe Admin actuel :"); 
    const rows = await dbSelect('config_application', { cle: 'mot_de_passe_admin' });
    const mdpActuel = rows.length > 0 ? rows[0].valeur : motDePasse;
    if(ancien !== mdpActuel) return alert("Incorrect !");
    const nouveau = prompt("Nouveau mot de passe Admin :"); if(!nouveau) return;
    const conf = prompt("Confirmez :"); if(nouveau !== conf) return alert("Ne correspondent pas !");
    try {
        await dbUpdate('config_application', { cle: 'mot_de_passe_admin' }, { valeur: nouveau.trim() });
        motDePasse = nouveau.trim();
        alert(" Mot de passe Admin modifié ! Tous les encadrants devront utiliser le nouveau mot de passe.");
    } catch(e) { alert("Erreur : " + e.message); }
}

async function deleteAllBaptemes() {
    if(prompt("ATTENTION ! Tapez 'RESET' pour supprimer TOUS les baptisés.") !== "RESET") return;
    try {
        // Supprimer toutes les présences puis tous les participants bapteme
        const parts = await dbSelect('participants_bapteme');
        for(const p of parts) {
            await dbDelete('presences_bapteme', { participant_id: p.id });
        }
        // Supprimer les participants (ON DELETE CASCADE gère les présences)
        const { error } = await db.from('participants_bapteme').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        if(error) throw error;
        etudiants = []; sessions = ["BAPTEME 1"]; historique = {}; 
        sauvegarderDonneesLocal(); 
        alert("Tout a été effacé."); 
        lancerSessionAdmin(encadrantActuel);
    } catch(e) { alert("Erreur : " + e.message); }
}

// =========== FORMULAIRE INSCRIPTION ===========
function previewPhotoFile(input) {
    if(input.files && input.files[0]) {
        const reader = new FileReader();
        reader.onload = function(e) {
            const img = new Image(); img.onload = function() {
                const canvas = document.createElement('canvas'); const MAX = 250; let w = img.width, h = img.height;
                if(w > h) { h = h*MAX/w; w = MAX; } else { w = w*MAX/h; h = MAX; }
                canvas.width = w; canvas.height = h; canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                photoBase64 = canvas.toDataURL('image/jpeg', 0.7); document.getElementById('photo-preview').innerHTML = `<img src="${photoBase64}">`;
            }; img.src = e.target.result;
        }; reader.readAsDataURL(input.files[0]);
    }
}

function fermerFormulaireInscription() { changerVue(currentMode === 'bapteme' ? 'accueil-participant' : 'accueil-affermissement'); }

async function remplirSessionsInscription() {
    // ✅ Charger les sessions depuis Supabase
    const sessRows = await dbSelect('sessions_affermissement');
    promosAffermissement = sessRows.sort((a,b)=> new Date(a.date_creation)-new Date(b.date_creation)).map(s => s.nom);
    if(!promosAffermissement.includes("Session 23")) promosAffermissement.push("Session 23");

    // ✅ Session active depuis Supabase (est_active = true)
    const sessActive = sessRows.find(s => s.est_active === true);
    let activeSession = sessActive ? sessActive.nom : (promosAffermissement.length > 0 ? promosAffermissement[promosAffermissement.length - 1] : "Aucune");
    localStorage.setItem(KEY_ACTIVE_PROMO, activeSession); // sync local

    let isAncien = document.getElementById('check-ancien').checked;
    
    document.getElementById('form-nouveau').classList.toggle('hidden', isAncien);
    document.getElementById('form-ancien').classList.toggle('hidden', !isAncien);
    document.getElementById('info-nouveau-session').classList.toggle('hidden', isAncien);
    document.getElementById('info-ancien-session').classList.toggle('hidden', !isAncien);
    document.getElementById('display-active-session').innerText = activeSession;
    document.getElementById('display-active-session-ancien').innerText = activeSession;
    
    if(isAncien) {
        let oldSel = document.getElementById('ancienne-session-select');
        oldSel.innerHTML = '<option value="">-- Sélectionnez --</option>' + promosAffermissement.map(p => `<option value="${p}">${p}</option>`).join('');
    }
}

// ─── INSCRIPTION PRINCIPALE — SAUVEGARDE DANS SUPABASE ───────────────────
async function sInscrire() {
    try {
        let isAncien = (currentMode === 'affermissement' && document.getElementById('check-ancien').checked);
        //  Session active depuis Supabase
        let activeSession = await getActiveSession();
        let errDiv = document.getElementById('erreur-inscription');
        errDiv.style.display = 'none';
        
        if(isAncien) {
            // ── CAS PARTICIPANT ANCIEN ─────────────────────────────────
            let codeAncien = document.getElementById('code-ancien').value.trim();
            let oldSess = document.getElementById('ancienne-session-select').value;
            
            if(!codeAncien) { errDiv.innerText = "Veuillez entrer votre code !"; errDiv.style.display = 'block'; return; }
            if(!oldSess) { errDiv.innerText = "Veuillez choisir votre ancienne session !"; errDiv.style.display = 'block'; return; }
            if(!activeSession) { errDiv.innerText = "Aucune session active configurée."; errDiv.style.display = 'block'; return; }
            
            // ✅ Chercher directement dans Supabase — ilike pour éviter problème CHAR(4)
            const { data: ancRows } = await db.from('participants_affermissement').select('*').ilike('code', codeAncien.trim()).limit(1);
            if(!ancRows || ancRows.length === 0) { errDiv.innerText = "Code introuvable. Si vous êtes nouveau, décochez la case."; errDiv.style.display = 'block'; return; }
            const etu = ancRows[0];
            
            // Trouver l'ID de la session active dans Supabase
            const sessRows = await dbSelect('sessions_affermissement', { nom: activeSession });
            if(sessRows.length === 0) { errDiv.innerText = "Session active introuvable dans la base."; errDiv.style.display = 'block'; return; }
            const sessionId = sessRows[0].id;

            // Mettre à jour la session active du participant dans Supabase
            await dbUpdate('participants_affermissement', { code: codeAncien }, { session_active_id: sessionId });
            
            // Ajouter dans le pivot participant_sessions
            try {
                await dbInsert('participant_sessions', { participant_id: etu.id, session_id: sessionId });
            } catch(e) { /* déjà inscrit dans cette session, OK */ }

            // Mettre à jour local
            if(!etu.promos) etu.promos = [etu.sessionInscription || "Session 23"];
            if(!etu.promos.includes(activeSession)) etu.promos.push(activeSession);
            etu.sessionInscription = activeSession;
            sauvegarderDonneesLocal();
            afficherResultatInscription(etu.nom, etu.prenom, etu.code);

        } else {
            // ── CAS NOUVEAU PARTICIPANT ────────────────────────────────
            const n = document.getElementById('nom').value.trim(); 
            const pr = document.getElementById('prenom').value.trim();
            const ec = document.getElementById('etat-civil').value; 
            const prof = document.getElementById('profession').value;
            const tel = document.getElementById('telephone').value.trim();
            
            if(!n) { errDiv.innerText = "Le nom est obligatoire !"; errDiv.style.display = 'block'; return; }
            if(!pr) { errDiv.innerText = "Le prénom est obligatoire !"; errDiv.style.display = 'block'; return; }
            if(!tel) { errDiv.innerText = "Le téléphone est obligatoire !"; errDiv.style.display = 'block'; return; }
            if(!ec) { errDiv.innerText = "L'état civil est obligatoire !"; errDiv.style.display = 'block'; return; }
            if(!prof) { errDiv.innerText = "La profession est obligatoire !"; errDiv.style.display = 'block'; return; }
            
            if(currentMode === 'affermissement') {
                const adresse = document.getElementById('adresse').value.trim();
                const telUrg = document.getElementById('tel-urgence').value.trim();
                if(!adresse) { errDiv.innerText = "L'adresse est obligatoire !"; errDiv.style.display = 'block'; return; }
                if(!telUrg) { errDiv.innerText = "Le téléphone d'urgence est obligatoire !"; errDiv.style.display = 'block'; return; }
            }
            if(currentMode === 'bapteme') {
                const adresseBap = document.getElementById('adresse-bap').value.trim();
                if(!adresseBap) { errDiv.innerText = "L'adresse est obligatoire !"; errDiv.style.display = 'block'; return; }
            }
            if(currentMode === 'affermissement' && !activeSession) { 
                errDiv.innerText = "Aucune session active ! L'encadrant doit en configurer une."; 
                errDiv.style.display = 'block'; return; 
            }
            
            // ✅ Vérification doublons directement dans Supabase — requêtes ciblées
            const partTableCheck = currentMode === 'bapteme' ? 'participants_bapteme' : 'participants_affermissement';
            
            // Vérifier le nom+prénom (insensible à la casse)
            const { data: doublonNomRows } = await db.from(partTableCheck)
                .select('nom,prenom')
                .ilike('nom', n)
                .ilike('prenom', pr)
                .limit(1);
            if(doublonNomRows && doublonNomRows.length > 0) { 
                errDiv.innerText = " " + n.toUpperCase() + " " + pr + " est déjà inscrit(e) !"; 
                errDiv.style.display = 'block'; return; 
            }
            
            // Vérifier le téléphone
            if(tel) {
                const { data: doublonTelRows } = await db.from(partTableCheck)
                    .select('nom,prenom')
                    .eq('telephone', tel)
                    .limit(1);
                if(doublonTelRows && doublonTelRows.length > 0) { 
                    errDiv.innerText = " Ce numéro est déjà utilisé par " + doublonTelRows[0].nom.toUpperCase() + " " + doublonTelRows[0].prenom + " !"; 
                    errDiv.style.display = 'block'; return; 
                }
            }
            
            // ✅ Code généré exclusivement par Supabase côté serveur — unique garanti
            let code;
            const fnCode = currentMode === 'affermissement' ? 'generer_code_unique_aff' : 'generer_code_unique_bap';
            const { data: codeData, error: codeErr } = await db.rpc(fnCode);
            if(codeErr || !codeData) {
                errDiv.innerText = "Impossible de générer le code. Vérifiez votre connexion et réessayez.";
                errDiv.style.display = 'block';
                return;
            }
            code = codeData;

            if(currentMode === 'affermissement') {
                // Trouver l'ID de la session active
                const sessRows = await dbSelect('sessions_affermissement', { nom: activeSession });
                if(sessRows.length === 0) { errDiv.innerText = "Session active introuvable."; errDiv.style.display = 'block'; return; }
                const sessionId = sessRows[0].id;

                // ✅ Insérer dans Supabase — le code est déjà unique garanti
                let inserted = null;
                let tentatives = 0;
                while(!inserted && tentatives < 5) {
                    tentatives++;
                    if(tentatives > 1) {
                        // Regénérer un code si nécessaire (fallback)
                        const { data: cd } = await db.rpc('generer_code_unique_aff');
                        if(cd) code = cd;
                    }
                    try {
                        inserted = await dbInsert('participants_affermissement', {
                            code: code,
                            nom: n,
                            postnom: document.getElementById('postnom').value.trim() || null,
                            prenom: pr,
                            telephone: tel,
                            telephone_urgence: document.getElementById('tel-urgence').value.trim(),
                            adresse: document.getElementById('adresse').value.trim(),
                            etat_civil: ec,
                            profession: prof,
                            salle: document.getElementById('salle').value || null,
                            photo_url: photoBase64 || null,
                            session_active_id: sessionId
                        });
                    } catch(eIns) {
                        if(eIns.code === '23505') continue;
                        throw eIns;
                    }
                }
                if(!inserted) throw new Error("Impossible de créer le participant. Réessayez.");

                // Ajouter dans le pivot participant_sessions
                await dbInsert('participant_sessions', { participant_id: inserted.id, session_id: sessionId });

                // Mise à jour cache local
                let etuObj = { 
                    code, nom: n, postnom: document.getElementById('postnom').value.trim(),
                    prenom: pr, telephone: tel, etatCivil: ec, profession: prof,
                    adresse: document.getElementById('adresse').value.trim(),
                    telUrgence: document.getElementById('tel-urgence').value.trim(),
                    salle: document.getElementById('salle').value,
                    photo: photoBase64,
                    sessionInscription: activeSession, promos: [activeSession],
                    _id: inserted.id
                };
                etudiants.push(etuObj);
                sauvegarderDonneesLocal();
                afficherResultatInscription(n, pr, code);

            } else if(currentMode === 'bapteme') {
                // ✅ Code généré par Supabase côté serveur — unique garanti
                let inserted = null;
                let tentatives = 0;
                while(!inserted && tentatives < 5) {
                    tentatives++;
                    if(tentatives > 1) {
                        const { data: cd } = await db.rpc('generer_code_unique_bap');
                        if(cd) code = cd;
                    }
                    try {
                        inserted = await dbInsert('participants_bapteme', {
                            code: code,
                            nom: n,
                            postnom: document.getElementById('postnom').value.trim() || null,
                            prenom: pr,
                            telephone: tel,
                            adresse: document.getElementById('adresse-bap').value.trim(),
                            etat_civil: ec,
                            profession: prof
                        });
                    } catch(eInsert) {
                        if(eInsert.code === '23505') continue;
                        throw eInsert;
                    }
                }
                if(!inserted) throw new Error("Impossible de créer le participant. Réessayez.");

                // Mise à jour cache local
                let etuObj = { 
                    code, nom: n, postnom: document.getElementById('postnom').value.trim(),
                    prenom: pr, telephone: tel, etatCivil: ec, profession: prof,
                    adresse: document.getElementById('adresse-bap').value.trim(),
                    _id: inserted.id
                };
                etudiants.push(etuObj);
                sauvegarderDonneesLocal();
                afficherResultatInscription(n, pr, code);
            }
        }
    } catch(err) {
        console.error("Erreur inscription:", err);
        alert("Erreur lors de l'inscription : " + err.message);
    }
}

function viderFormulaire() {
    ['nom','postnom','prenom','telephone','adresse','tel-urgence','code-ancien','adresse-bap'].forEach(id => {
        let el = document.getElementById(id); if(el) el.value = "";
    });
    let ecEl = document.getElementById('etat-civil'); if(ecEl) ecEl.selectedIndex = 0;
    let profEl = document.getElementById('profession'); if(profEl) profEl.selectedIndex = 0;
    let salleEl = document.getElementById('salle'); if(salleEl) salleEl.selectedIndex = 0;
    photoBase64 = "";
    let prev = document.getElementById('photo-preview'); if(prev) prev.innerHTML = " Ajouter une photo";
    let errDiv = document.getElementById('erreur-inscription'); if(errDiv) { errDiv.innerText = ""; errDiv.style.display = 'none'; }
}

function afficherResultatInscription(nom, prenom, code) {
    document.getElementById('affiche-nom').innerText = nom.toUpperCase()+" "+prenom;
    document.getElementById('affiche-code').innerText = code;
    document.getElementById("qrcode").innerHTML = ""; new QRCode(document.getElementById("qrcode"), code);
    viderFormulaire();
    changerVue('resultat');
}

// =========== GESTION DOSSIERS / TP ===========
function toggleDossiers() { document.getElementById('gestion-dossiers').classList.toggle('hidden'); refreshDossiersList(); }

async function creerDossier() {
    const n = document.getElementById('nom-dossier').value.trim(); 
    if(!n) return alert("Entrez un nom !");
    try {
        if(currentMode === 'cote') {
            // ✅ Type "cote" — visible uniquement dans admin côte, PAS dans présences
            const inserted = await dbInsert('lecons_affermissement', { nom: n, type: 'cote', ordre: sessionsCotes.length + 1 });
            sessionsCotes.push({ nom: n, sous: [], _id: inserted.id });
            updateSelectCotes();
        } else if(currentMode === 'bapteme') {
            await dbInsert('lecons_bapteme', { nom: n, ordre: sessions.length + 1 });
            sessions.push(n);
            updateSessionSelect();
        } else if(currentMode === 'mercredi') {
            // ✅ CORRECTION : Type "mercredi" — visible uniquement dans admin mercredi, PAS dans affermissement
            const inserted = await dbInsert('lecons_affermissement', { nom: n, type: 'mercredi', ordre: sessions.length + 1 });
            sessions.push(n);
            updateSessionSelect();
        } else {
            // ✅ Type "presence" — visible uniquement dans admin affermissement, PAS dans côtes
            const inserted = await dbInsert('lecons_affermissement', { nom: n, type: 'presence', ordre: sessions.length + 1 });
            sessions.push(n);
            updateSessionSelect();
        }
        sauvegarderDonneesLocal();
        document.getElementById('nom-dossier').value = "";
        refreshDossiersList();
    } catch(e) { alert("Erreur : " + e.message); }
}

function refreshDossiersList() {
    if(currentMode === 'cote') {
        document.getElementById('liste-dossiers-admin').innerHTML = sessionsCotes.map((s, idx) => {
            let sousHtml = (s.sous||[]).map((sd, sdi) => 
                `<div style="margin-left:20px;font-size:12px;color:#555;display:flex;justify-content:space-between;border-bottom:1px dashed #eee;padding:2px 0;">
                 <span>- ${sd}</span>
                 <button type="button" style="background:none;color:red;border:none;cursor:pointer;" data-sidx="${idx}" data-sdidx="${sdi}" onclick="supprimerSousDossier(parseInt(this.dataset.sidx), parseInt(this.dataset.sdidx))">✕</button>
                 </div>`
            ).join('');
            return `<div style="border:1px solid #ddd;padding:5px;margin-bottom:5px;border-radius:5px;">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <b>${s.nom}</b>
                    <div style="display:flex;gap:4px;">
                        <button type="button" style="background:#17a2b8;color:white;border:none;border-radius:3px;padding:2px 6px;font-size:12px;" data-idx="${idx}" onclick="renommerDossierCote(parseInt(this.dataset.idx))">✏️</button>
                        <button type="button" style="background:#dc3545;color:white;border:none;border-radius:3px;padding:2px 5px;" data-idx="${idx}" onclick="supprimerDossierCote(parseInt(this.dataset.idx))">✕</button>
                    </div>
                </div>
                ${sousHtml}
                <div style="display:flex;gap:5px;margin-top:5px;">
                    <input type="text" id="sous-nom-${idx}" placeholder="Nouv. sous-dossier" style="padding:4px;font-size:11px;">
                    <button type="button" data-idx="${idx}" onclick="ajouterSousDossier(parseInt(this.dataset.idx))" style="padding:4px;font-size:11px;background:#17a2b8;color:white;border:none;border-radius:3px;">+ Ajouter</button>
                </div>
            </div>`;
        }).join('');
    } else {
        document.getElementById('liste-dossiers-admin').innerHTML = sessions.map((s, idx) => {
            // ✅ Trouver si la leçon est bloquée
            const leconObj = leconsGlobal.find(l => l.nom === s);
            const estBloquee = leconObj ? leconObj.bloquee : false;
            return `<div style="display:flex;justify-content:space-between;align-items:center;padding:5px;border-bottom:1px solid #eee;">
             <span><b>${s}</b>${estBloquee ? ' <span style="color:#dc3545;font-size:11px;">🔒 BLOQUÉE</span>' : ''}</span>
             <div style="display:flex;gap:4px;">
                 <button type="button" style="background:${estBloquee?'#28a745':'#dc3545'};color:white;border:none;border-radius:3px;padding:2px 6px;font-size:11px;" data-idx="${idx}" onclick="toggleBlocageLecon(parseInt(this.dataset.idx))">${estBloquee?'🔓 Débloquer':'🔒 Bloquer'}</button>
                 <button type="button" style="background:#17a2b8;color:white;border:none;border-radius:3px;padding:2px 6px;font-size:12px;" data-idx="${idx}" onclick="renommerDossier(parseInt(this.dataset.idx))">✏️</button>
                 <button type="button" style="background:#dc3545;color:white;border:none;border-radius:3px;padding:2px 5px;" data-idx="${idx}" onclick="supprimerDossier(parseInt(this.dataset.idx))">✕</button>
             </div>
             </div>`;
        }).join('');
    }
}

async function supprimerDossier(idx) {
    const nom = sessions[idx];
    if(!nom) return;
    if(!confirm("Supprimer « "+nom+" » ? Toutes les présences liées seront aussi supprimées.")) return;
    try {
        const table = currentMode === 'bapteme' ? 'lecons_bapteme' : 'lecons_affermissement';
        await dbDelete(table, { nom: nom });
        sessions.splice(idx, 1);
        delete historique[nom];
        sauvegarderDonneesLocal();
        updateSessionSelect();
        refreshDossiersList();
    } catch(e) { alert("Erreur suppression : " + e.message); }
}

async function toggleBlocageLecon(idx) {
    const nom = sessions[idx];
    if(!nom) return;
    try {
        const table = currentMode === 'bapteme' ? 'lecons_bapteme' : 'lecons_affermissement';
        const rows = await dbSelect(table, { nom: nom });
        if(rows.length === 0) return alert("Leçon introuvable.");
        const estBloquee = rows[0].bloquee || false;
        const nouvelEtat = !estBloquee;
        await dbUpdate(table, { nom: nom }, { bloquee: nouvelEtat });
        // Mettre à jour l'objet local dans leconsGlobal
        const lObj = leconsGlobal.find(l => l.nom === nom);
        if(lObj) lObj.bloquee = nouvelEtat;
        alert((nouvelEtat ? "🔒 Leçon bloquée" : "🔓 Leçon débloquée") + " : " + nom);
        refreshDossiersList();
    } catch(e) { alert("Erreur : " + e.message); }
}

async function renommerDossier(idx) {
    const ancienNom = sessions[idx];
    if(!ancienNom) return;
    const nouveauNom = prompt("Nouveau nom pour « " + ancienNom + " » :", ancienNom);
    if(!nouveauNom || nouveauNom.trim() === ancienNom) return;
    const n = nouveauNom.trim();
    if(sessions.includes(n)) return alert("Ce nom existe déjà !");
    try {
        const table = currentMode === 'bapteme' ? 'lecons_bapteme' : 'lecons_affermissement';
        await dbUpdate(table, { nom: ancienNom }, { nom: n });
        if(historique[ancienNom]) { historique[n] = historique[ancienNom]; delete historique[ancienNom]; }
        sessions[idx] = n;
        sauvegarderDonneesLocal();
        updateSessionSelect();
        refreshDossiersList();
    } catch(e) { alert("Erreur renommage : " + e.message); }
}

async function renommerDossierCote(idx) {
    const ancienNom = sessionsCotes[idx].nom;
    const nouveauNom = prompt("Nouveau nom pour « " + ancienNom + " » :", ancienNom);
    if(!nouveauNom || nouveauNom.trim() === ancienNom) return;
    const n = nouveauNom.trim();
    if(sessionsCotes.some(s => s.nom === n)) return alert("Ce nom existe déjà !");
    try {
        await dbUpdate('lecons_affermissement', { nom: ancienNom }, { nom: n });
        // Mettre à jour cotesData et accuseTPData
        if(cotesData[ancienNom]) { cotesData[n] = cotesData[ancienNom]; delete cotesData[ancienNom]; }
        if(accuseTPData[ancienNom]) { accuseTPData[n] = accuseTPData[ancienNom]; delete accuseTPData[ancienNom]; }
        sessionsCotes[idx].nom = n;
        sauvegarderDonneesLocal();
        updateSelectCotes();
        refreshDossiersList();
    } catch(e) { alert("Erreur renommage : " + e.message); }
}

async function supprimerDossierCote(idx) { 
    if(!confirm("Supprimer cette leçon et ses cotes ?")) return;
    try {
        let sNom = sessionsCotes[idx].nom;
        // Supprimer la leçon dans Supabase (CASCADE supprime les sous_dossiers et cotes)
        await dbDelete('lecons_affermissement', { nom: sNom });
        sessionsCotes.splice(idx, 1); 
        delete cotesData[sNom]; 
        delete accuseTPData[sNom]; 
        sauvegarderDonneesLocal(); 
        updateSelectCotes(); 
        refreshDossiersList();
    } catch(e) { alert("Erreur : " + e.message); }
}

async function ajouterSousDossier(idx) { 
    const sn = document.getElementById(`sous-nom-${idx}`).value.trim(); 
    if(!sn) return;
    try {
        // Trouver l'ID de la leçon dans Supabase
        const leconRows = await dbSelect('lecons_affermissement', { nom: sessionsCotes[idx].nom });
        if(leconRows.length === 0) throw new Error("Leçon introuvable");
        await dbInsert('sous_dossiers_cote', { lecon_id: leconRows[0].id, nom: sn, ordre: (sessionsCotes[idx].sous||[]).length + 1 });
        if(!sessionsCotes[idx].sous) sessionsCotes[idx].sous = []; 
        sessionsCotes[idx].sous.push(sn); 
        sauvegarderDonneesLocal(); 
        updateSelectCotes(); 
        refreshDossiersList();
    } catch(e) { alert("Erreur : " + e.message); }
}

async function supprimerSousDossier(sIdx, sdIdx) { 
    let sNom = sessionsCotes[sIdx].nom; 
    let sdNom = sessionsCotes[sIdx].sous[sdIdx]; 
    if(!confirm("Supprimer « "+sdNom+" » ?")) return;
    try {
        // Trouver et supprimer le sous-dossier dans Supabase
        const leconRows = await dbSelect('lecons_affermissement', { nom: sNom });
        if(leconRows.length > 0) {
            const { data: sdRows } = await db.from('sous_dossiers_cote').select('*').eq('lecon_id', leconRows[0].id).eq('nom', sdNom);
            if(sdRows && sdRows.length > 0) await dbDelete('sous_dossiers_cote', { id: sdRows[0].id });
        }
        sessionsCotes[sIdx].sous.splice(sdIdx, 1); 
        if(cotesData[sNom] && cotesData[sNom][sdNom]) delete cotesData[sNom][sdNom]; 
        sauvegarderDonneesLocal(); 
        updateSelectCotes(); 
        refreshDossiersList();
    } catch(e) { alert("Erreur : " + e.message); }
}

function updateSessionSelect() { document.getElementById('select-session').innerHTML = sessions.map(s => `<option value="${s}">${s}</option>`).join(''); }
function updateSelectCotes() { document.getElementById('select-session-cote').innerHTML = sessionsCotes.map(s => `<option value="${s.nom}">${s.nom}</option>`).join(''); updateSousDossierSelect(); }
function updateSousDossierSelect() { let s = document.getElementById('select-session-cote').value; let sess = sessionsCotes.find(x => x.nom === s); document.getElementById('select-sous-dossier-cote').innerHTML = (sess && sess.sous) ? sess.sous.map(sd => `<option value="${sd}">${sd}</option>`).join('') : ""; }

// =========== COTES & ACCUSÉ TP ===========
let participantCodeCote = '';
function afficherSuggestionsCote() {
    const val = document.getElementById('recherche-cote-nom').value.trim().toLowerCase(); const box = document.getElementById('suggestions-cote');
    if(val.length < 1) return box.classList.add('hidden');
    const res = getEtudiantsFiltres().filter(e => (e.nom+" "+e.prenom).toLowerCase().includes(val));
    box.innerHTML = res.map(e => `<div class="suggestion-item" onclick="selectionnerCote('${e.code}', '${e.nom.replace(/'/g,"\\'")} ${e.prenom.replace(/'/g,"\\'")}')"><span>${e.nom.toUpperCase()} ${e.prenom}</span></div>`).join('');
    box.classList.remove('hidden');
}
function selectionnerCote(code, nomAffichage) {
    participantCodeCote = code; document.getElementById('recherche-cote-nom').value = nomAffichage; document.getElementById('suggestions-cote').classList.add('hidden');
    let s = document.getElementById('select-session-cote').value; let sd = document.getElementById('select-sous-dossier-cote').value;
    document.getElementById('valeur-cote').value = "";
    if(cotesData[s] && cotesData[s][sd]) { let existing = cotesData[s][sd].find(c => c.code === code); if(existing && existing.cote) document.getElementById('valeur-cote').value = existing.cote; }
}

async function accuserReceptionTP() {
    if(!participantCodeCote) return alert("Veuillez sélectionner un participant d'abord !");
    let s = document.getElementById('select-session-cote').value; let sd = document.getElementById('select-sous-dossier-cote').value;
    if(!s || !sd) return alert("Sélectionnez une leçon et un sous-dossier de TP !");
    
    try {
        // Trouver les IDs dans Supabase
        const leconRows = await dbSelect('lecons_affermissement', { nom: s });
        if(leconRows.length === 0) throw new Error("Leçon introuvable");
        const { data: sdRows } = await db.from('sous_dossiers_cote').select('*').eq('lecon_id', leconRows[0].id).eq('nom', sd);
        if(!sdRows || sdRows.length === 0) throw new Error("Sous-dossier introuvable");
        const partRows = await dbSelect('participants_affermissement', { code: participantCodeCote });
        if(partRows.length === 0) throw new Error("Participant introuvable");

        // ✅ Session active depuis Supabase
        const activeSession = await getActiveSession();
        let sessionId = null;
        if(activeSession) {
            const sessRows = await dbSelect('sessions_affermissement', { nom: activeSession });
            if(sessRows.length > 0) sessionId = sessRows[0].id;
        }

        // ✅ UPSERT dans Supabase — côte avec accusé de réception
        await db.from('cotes').upsert({
            participant_id: partRows[0].id,
            sous_dossier_id: sdRows[0].id,
            session_id: sessionId,
            accuse_reception: true,
            updated_at: new Date().toISOString()
        }, { onConflict: 'participant_id,sous_dossier_id,session_id' });

        // Mise à jour locale
        if(!accuseTPData[s]) accuseTPData[s] = {}; if(!accuseTPData[s][sd]) accuseTPData[s][sd] = [];
        if(!accuseTPData[s][sd].includes(participantCodeCote)) accuseTPData[s][sd].push(participantCodeCote);
        sauvegarderDonneesLocal();
        alert("Accusé de réception enregistré !");
    } catch(e) { alert("Erreur : " + e.message); }
}

async function validerCote() {
    if(!participantCodeCote) return alert("Veuillez sélectionner un participant !");
    let s = document.getElementById('select-session-cote').value; let sd = document.getElementById('select-sous-dossier-cote').value;
    if(!s || !sd) return alert("Sélectionnez une leçon et un sous-dossier !");
    let cote = document.getElementById('valeur-cote').value;
    // ✅ Session active depuis Supabase
    let activeSession = await getActiveSession();
    
    try {
        // Trouver les IDs dans Supabase
        const leconRows = await dbSelect('lecons_affermissement', { nom: s });
        if(leconRows.length === 0) throw new Error("Leçon introuvable");
        const { data: sdRows } = await db.from('sous_dossiers_cote').select('*').eq('lecon_id', leconRows[0].id).eq('nom', sd);
        if(!sdRows || sdRows.length === 0) throw new Error("Sous-dossier introuvable");
        const partRows = await dbSelect('participants_affermissement', { code: participantCodeCote });
        if(partRows.length === 0) throw new Error("Participant introuvable");

        let sessionId = null;
        if(activeSession) {
            const sessRows = await dbSelect('sessions_affermissement', { nom: activeSession });
            if(sessRows.length > 0) sessionId = sessRows[0].id;
        }

        // ✅ UPSERT dans Supabase — côte avec valeur
        await db.from('cotes').upsert({
            participant_id: partRows[0].id,
            sous_dossier_id: sdRows[0].id,
            session_id: sessionId,
            valeur: cote,
            updated_at: new Date().toISOString()
        }, { onConflict: 'participant_id,sous_dossier_id,session_id' });

        // Mise à jour locale
        if(!cotesData[s]) cotesData[s] = {}; if(!cotesData[s][sd]) cotesData[s][sd] = [];
        let list = cotesData[s][sd]; let idx = list.findIndex(c => c.code === participantCodeCote);
        let entry = { code: participantCodeCote, cote: cote, session: activeSession };
        if(idx >= 0) list[idx] = entry; else list.push(entry);
        sauvegarderDonneesLocal();
        alert("Cote enregistrée !");
        document.getElementById('recherche-cote-nom').value = ""; document.getElementById('valeur-cote').value = ""; participantCodeCote = "";
    } catch(e) { alert("Erreur : " + e.message); }
}

// =========== PRÉSENCE — SAUVEGARDE DANS SUPABASE ========================
let scanEnCours = false; // Verrou anti-doublon scanner

function demarrerScanner() { 
    if(!html5QrCode) html5QrCode = new Html5Qrcode("reader"); 
    scanEnCours = false;
    html5QrCode.start({facingMode:"environment"},{fps:10}, text => {
        if(scanEnCours) return; // Ignorer si déjà en traitement
        scanEnCours = true;
        validerPresence(text).finally(() => {
            // Remettre le verrou à false après 3 secondes pour permettre un nouveau scan
            setTimeout(() => { scanEnCours = false; }, 3000);
        });
    }); 
    document.getElementById('btn-start').style.display='none'; 
    document.getElementById('btn-stop').style.display='block'; 
}
function arreterScanner() { 
    if(html5QrCode) html5QrCode.stop(); 
    scanEnCours = false;
    document.getElementById('btn-start').style.display='block'; 
    document.getElementById('btn-stop').style.display='none'; 
}

function ouvrirLightbox(src, nom) {
    document.getElementById('lightbox-img').src = src;
    document.getElementById('lightbox-name').innerText = nom;
    document.getElementById('photo-lightbox').classList.add('active');
}
function fermerLightbox(e) {
    if(e.target === document.getElementById('photo-lightbox') || e.target.classList.contains('close-lightbox') || e.target.closest('.close-lightbox')) {
        document.getElementById('photo-lightbox').classList.remove('active');
    }
}

async function validerPresence(code) {
    code = code ? code.trim() : ""; if(!code) return alert("Entrez un code !");

    let curSess = document.getElementById('select-session').value; 
    if(!curSess) return alert("Aucune session sélectionnée");

    // ✅ MODE MERCREDI : traitement regroupé côté serveur (1 seul appel réseau via RPC)
    // Les modes affermissement et bapteme ne sont PAS touchés — logique inchangée plus bas.
    if(currentMode === 'mercredi') {
        try {
            const now = new Date();
            const jour = now.getDay();
            const diffVersLundi = (jour === 0) ? -6 : 1 - jour;
            const lundi = new Date(now); lundi.setDate(now.getDate() + diffVersLundi);
            const mercredi = new Date(lundi); mercredi.setDate(lundi.getDate() + 2);
            const dateISO = mercredi.getFullYear() + '-' +
                             String(mercredi.getMonth()+1).padStart(2,'0') + '-' +
                             String(mercredi.getDate()).padStart(2,'0');

            const { data, error } = await db.rpc('valider_presence_mercredi', {
                p_code: code,
                p_lecon_nom: curSess,
                p_encadrant_prenom: encadrantActuel,
                p_date_presence: dateISO
            });

            if(error) { alert("Erreur présence : " + error.message); return; }

            switch(data && data.status) {
                case 'code_inconnu':
                    alert(" Code Inconnu ! Ce code n'existe pas dans la base de données.");
                    return;
                case 'lecon_introuvable':
                    alert("Erreur présence : Leçon introuvable dans la base. Vérifiez que la leçon existe.");
                    return;
                case 'bloquee':
                    alert("🔒 Cette leçon est bloquée. Aucune présence ne peut être enregistrée.\nContactez l'administrateur pour la débloquer.");
                    return;
                case 'deja_prise':
                    alert("ℹ️ " + data.nom.toUpperCase() + " " + data.prenom + "\n\nPrésence déjà prise pour aujourd'hui.\n(Si ce n'est pas normal, vérifiez le relevé individuel.)");
                    return;
                case 'ok':
                    if(html5QrCode) { 
                        try { html5QrCode.stop(); document.getElementById('btn-start').style.display='block'; document.getElementById('btn-stop').style.display='none'; } catch(e2){} 
                    }
                    alert("✔ Présence validée : " + data.nom.toUpperCase() + " " + data.prenom);
                    document.getElementById('code-manuel').value = "";
                    return;
                default:
                    alert("Erreur présence : réponse inattendue du serveur.");
                    return;
            }
        } catch(e) { alert("Erreur présence : " + e.message); return; }
    }

    let activePromo = (currentMode === 'affermissement') ? (await getActiveSession()) : '';

    try {
        // ✅ Chercher le participant directement dans Supabase
        // .trim() sur la comparaison pour éviter les espaces CHAR(4) de PostgreSQL
        const partTable = currentMode === 'bapteme' ? 'participants_bapteme' : 'participants_affermissement';
        const { data: partRows } = await db.from(partTable).select('*').ilike('code', code.trim()).limit(1);
        if(!partRows || partRows.length === 0) {
            alert(" Code Inconnu ! Ce code n'existe pas dans la base de données.");
            return;
        }
        const etu = partRows[0];

        // Vérification session filtrée (affermissement seulement) — depuis Supabase
        if(currentMode === 'affermissement' && filtreAdminPromo !== "ALL") {
            const sessFiltre = await dbSelect('sessions_affermissement', { nom: filtreAdminPromo });
            if(sessFiltre.length > 0) {
                const pivot = await dbSelect('participant_sessions', { participant_id: etu.id, session_id: sessFiltre[0].id });
                if(pivot.length === 0) return alert("Ce participant n'appartient pas à la session filtrée (" + filtreAdminPromo + ").");
            }
        }

        // Trouver l'ID de la leçon dans Supabase — filtrer par type pour éviter conflits de nom
        const leconTable = currentMode === 'bapteme' ? 'lecons_bapteme' : 'lecons_affermissement';
        const presTable2 = currentMode === 'mercredi' ? 'presences_mercredi' : (currentMode === 'bapteme' ? 'presences_bapteme' : 'presences_affermissement');
        let leconRows;
        if(currentMode === 'mercredi') {
            const { data: lr } = await db.from('lecons_affermissement').select('*').eq('nom', curSess).eq('type', 'mercredi').limit(1);
            leconRows = lr || [];
            if(leconRows.length === 0) {
                const { data: lr2 } = await db.from('lecons_affermissement').select('*').eq('nom', curSess).limit(1);
                leconRows = lr2 || [];
            }
        } else if(currentMode === 'affermissement') {
            // Chercher uniquement dans les leçons de présence
            const { data: lr } = await db.from(leconTable).select('*').eq('nom', curSess).neq('type', 'cote').limit(1);
            leconRows = lr || [];
            // Fallback : si pas trouvé avec filtre type, chercher sans filtre (leçons sans type)
            if(leconRows.length === 0) {
                const { data: lr2 } = await db.from(leconTable).select('*').eq('nom', curSess).is('type', null).limit(1);
                leconRows = lr2 || [];
            }
        } else {
            leconRows = await dbSelect(leconTable, { nom: curSess });
        }
        if(leconRows.length === 0) throw new Error("Leçon introuvable dans la base. Vérifiez que la leçon existe.");

        // ✅ VÉRIFIER SI LA LEÇON EST BLOQUÉE
        if(leconRows[0].bloquee === true) {
            alert(" Cette leçon est bloquée. Aucune présence ne peut être enregistrée.\nContactez l'administrateur pour la débloquer.");
            return;
        }

        // Trouver l'ID encadrant
        const encRows = await dbSelect('encadrants', { prenom: encadrantActuel });
        const encId = encRows.length > 0 ? encRows[0].id : null;

        // ✅ CORRECTION DATE : utiliser la date locale, pas UTC
        const now = new Date();
        let dateISO = now.getFullYear() + '-' + 
                        String(now.getMonth() + 1).padStart(2, '0') + '-' + 
                        String(now.getDate()).padStart(2, '0');
        // En mode mercredi : forcer la date au mercredi de la semaine courante
        if(currentMode === 'mercredi') {
            const jour = now.getDay(); // 0=dim, 3=mer, 6=sam
            const diffVersLundi = (jour === 0) ? -6 : 1 - jour;
            const lundi = new Date(now); lundi.setDate(now.getDate() + diffVersLundi);
            const mercredi = new Date(lundi); mercredi.setDate(lundi.getDate() + 2);
            dateISO = mercredi.getFullYear() + '-' +
                      String(mercredi.getMonth()+1).padStart(2,'0') + '-' +
                      String(mercredi.getDate()).padStart(2,'0');
        }

        // Trouver l'ID session active
        let sessionId = null;
        if(currentMode === 'affermissement' && activePromo) {
            const sessRows = await dbSelect('sessions_affermissement', { nom: activePromo });
            if(sessRows.length > 0) sessionId = sessRows[0].id;
        }

        // ✅ INSÉRER dans Supabase
        const presTable = currentMode === 'mercredi' ? 'presences_mercredi' : (currentMode === 'bapteme' ? 'presences_bapteme' : 'presences_affermissement');
        const presData = { participant_id: etu.id, lecon_id: leconRows[0].id, date_presence: dateISO, encadrant_id: encId };
        if(currentMode === 'affermissement') presData.session_id = sessionId;
        if(currentMode === 'mercredi' && sessionId) presData.session_id = sessionId;

        const { error } = await db.from(presTable).insert(presData);
        
        if(error) {
            if(error.code === '23505') {
                // Présence déjà enregistrée aujourd'hui — message clair
                alert(" " + etu.nom.toUpperCase() + " " + etu.prenom + "\n\nPrésence déjà prise pour aujourd'hui.\n(Si ce n'est pas normal, vérifiez le relevé individuel.)");
            } else {
                alert("Erreur présence : " + error.message);
            }
            return;
        }

        // Arrêter le scanner après scan réussi
        if(html5QrCode) { 
            try { html5QrCode.stop(); document.getElementById('btn-start').style.display='block'; document.getElementById('btn-stop').style.display='none'; } catch(e2){} 
        }
        
        alert(" Présence validée : " + etu.nom.toUpperCase() + " " + etu.prenom);
        document.getElementById('code-manuel').value = "";
        
    } catch(e) {
        alert("Erreur présence : " + e.message);
    }
}

// =========== RELEVES & GESTION PARTICIPANT ===========
function genererInfoEditable(etu) {
    return `<div class="releve-contact" style="text-align:left;">
        <div style="background:#006070;color:white;border-radius:8px;padding:8px 12px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;">
            <span style="font-size:12px;font-weight:bold;">CODE &amp; QR MANUEL</span>
            <span style="font-size:1.6em;font-weight:bold;letter-spacing:8px;">${etu.code}</span>
        </div>
        <div><span class="label">Nom :</span> <input class="edit-field" id="edit-nom-${etu.code}" value="${etu.nom}" style="width:110px;"> <input class="edit-field" id="edit-prenom-${etu.code}" value="${etu.prenom}" style="width:110px;"></div>
        <div><span class="label"> Tél :</span> <input class="edit-field" id="edit-tel-${etu.code}" value="${etu.telephone||''}" style="width:120px;"></div>
        <div><span class="label"> État civil :</span>
            <select class="edit-field" id="edit-etat-${etu.code}" style="width:120px;">
                <option value="Célibataire" ${etu.etatCivil==='Célibataire'?'selected':''}>Célibataire</option>
                <option value="Marié(e)" ${etu.etatCivil==='Marié(e)'?'selected':''}>Marié(e)</option>
                <option value="Veuve" ${etu.etatCivil==='Veuve'?'selected':''}>Veuve</option>
                <option value="Veuf" ${etu.etatCivil==='Veuf'?'selected':''}>Veuf</option>
            </select>
        </div>
        <div><span class="label"> Profession :</span>
            <select class="edit-field" id="edit-prof-${etu.code}" style="width:150px;">
                <option value="Étudiant(e)" ${etu.profession==='Étudiant(e)'?'selected':''}>Étudiant(e)</option>
                <option value="Travailleur(se)" ${etu.profession==='Travailleur(se)'?'selected':''}>Travailleur(se)</option>
                <option value="Chercheur(se) d'emploi" ${etu.profession==="Chercheur(se) d'emploi"?'selected':''}>Chercheur(se) d'emploi</option>
            </select>
        </div>
        ${etu.sessionInscription ? `<div><span class="label"> Session Active :</span> <span style="font-size:12px;color:#555;font-weight:bold;">${etu.sessionInscription}</span></div>` : ''}
        ${etu.adresse ? `<div><span class="label"> Adresse :</span> <span style="font-size:12px;color:#333;">${etu.adresse}</span></div>` : ''}
        ${etu.telUrgence ? `<div><span class="label"> Tél urgence :</span> <span style="font-size:12px;color:#333;">${etu.telUrgence}</span></div>` : ''}
        <div style="margin-top:6px;"><button type="button" class="btn-save-edit" onclick="sauvegarderModifParticipant('${etu.code}')"> Sauvegarder modifications</button></div>
    </div>`;
}

async function sauvegarderModifParticipant(code) {
    const idx = etudiants.findIndex(e => e.code === code); if(idx < 0) return;
    const etu = etudiants[idx];
    const newNom = document.getElementById(`edit-nom-${code}`).value.trim();
    const newPrenom = document.getElementById(`edit-prenom-${code}`).value.trim();
    const newTel = document.getElementById(`edit-tel-${code}`).value.trim();
    const newEtat = document.getElementById(`edit-etat-${code}`).value;
    const newProf = document.getElementById(`edit-prof-${code}`).value;

    try {
        const table = currentMode === 'bapteme' ? 'participants_bapteme' : 'participants_affermissement';
        // ✅ CORRECTION : utiliser l'id UUID au lieu du code pour éviter tout risque de doublon
        await dbUpdate(table, { id: etu._id || etu.id }, { 
            nom: newNom, prenom: newPrenom, telephone: newTel, 
            etat_civil: newEtat, profession: newProf 
        });
        etudiants[idx].nom = newNom; etudiants[idx].prenom = newPrenom;
        etudiants[idx].telephone = newTel; etudiants[idx].etatCivil = newEtat;
        etudiants[idx].profession = newProf;
        sauvegarderDonneesLocal();
        alert("Informations mises à jour !");
        if(currentMode === 'cote') genererReleveCote(code); else genererReleve(code);
    } catch(e) { alert("Erreur modification : " + e.message); }
}

function getJourNom(dateStr) { try { let p = dateStr.split('/'); return joursNoms[new Date(p[2], p[1]-1, p[0]).getDay()]; } catch(e) { return ''; } }

function genererReleve(code) {
    const etu = etudiants.find(e => e.code === code); if(!etu) return;
    let ph = etu.photo ? `<img src="${etu.photo}" class="releve-photo" onclick="ouvrirLightbox('${etu.photo}', '${etu.nom.toUpperCase()} ${etu.prenom}')">` : '';
    let html = `<div class="releve-card"><div class="releve-header"><h3> RELEVÉ INDIVIDUEL - PRÉSENCES</h3>${ph}${genererInfoEditable(etu)}<p class="nom-eleve">${etu.nom.toUpperCase()} ${etu.prenom}</p><div style="background:#006070;color:white;display:inline-block;padding:6px 16px;border-radius:8px;font-size:1.3em;letter-spacing:6px;font-weight:bold;margin:8px 0;"> ${etu.code}</div></div>`;
    const activePromo = (currentMode === 'affermissement') ? (localStorage.getItem(KEY_ACTIVE_PROMO) || '') : '';
    sessions.forEach(s => {
        let lpAll = historique[s] || [];
        let lp = (currentMode === 'affermissement' && activePromo) ? lpAll.filter(p => !p.promo || p.promo === activePromo) : lpAll;
        // ✅ CORRECTION SAMEDI : rattacher samedi au dimanche précédent dans le relevé
        if(currentMode === 'affermissement') {
            lp = lp.map(p => {
                const parts = p.date.split('/');
                const dateObj = new Date(parseInt(parts[2]), parseInt(parts[1])-1, parseInt(parts[0]));
                if(dateObj.getDay() === 6) {
                    const dim = new Date(dateObj); dim.setDate(dateObj.getDate() - 6);
                    return { ...p, date: String(dim.getDate()).padStart(2,'0')+'/'+String(dim.getMonth()+1).padStart(2,'0')+'/'+dim.getFullYear() };
                }
                return p;
            });
        }
        const du = [...new Set(lp.map(p => p.date))].sort((a,b) => { let [ja,ma,aa]=a.split('/'); let [jb,mb,ab]=b.split('/'); return new Date(aa,ma-1,ja) - new Date(ab,mb-1,jb); });
        const dp = lp.filter(p => p.code === code); const pc = du.length>0 ? Math.round((dp.length/du.length)*100) : 0;
        if(du.length > 0) {
            html += `<div style="background:#fff;border:1px solid #ddd;padding:8px;border-radius:5px;margin:5px 0;"><b style="color:#006070;"> ${s}</b> - ${pc}% de présence`;
            du.forEach((date,idx) => {
                const prs = dp.find(p => p.date === date); let txt = prs && prs.encadrant ? ` ${prs.encadrant} — ${getJourNom(date)} ${date}` : ` J${idx+1} — ${getJourNom(date)} ${date}`;
                html += `<div class="detail-date ${prs?'date-present':'date-absent'}"><span>${txt}</span><span>${prs?'✔ Présent':'✘ Absent'}</span></div>`;
            }); html += `</div>`;
        }
    }); document.getElementById('contenu-releve').innerHTML = html + "</div>";
}

function genererReleveCote(code) {
    const etu = etudiants.find(e => e.code === code); if(!etu) return;
    let ph = etu.photo ? `<img src="${etu.photo}" class="releve-photo" onclick="ouvrirLightbox('${etu.photo}', '${etu.nom.toUpperCase()} ${etu.prenom}')">` : '';
    let html = `<div class="releve-card"><div class="releve-header"><h3> RELEVÉ INDIVIDUEL - COTES & TP</h3>${ph}${genererInfoEditable(etu)}<p class="nom-eleve">${etu.nom.toUpperCase()} ${etu.prenom}</p><div style="background:#006070;color:white;display:inline-block;padding:6px 16px;border-radius:8px;font-size:1.3em;letter-spacing:6px;font-weight:bold;margin:8px 0;"> ${etu.code}</div></div><h4 style="color:#006070;"> Détail par TP :</h4>`;
    sessionsCotes.forEach(st => {
        html += `<div style="background:#fff;border:1px solid #ddd;padding:8px;border-radius:5px;margin:5px 0;"><b style="color:#006070;">${st.nom}</b>`;
        if(st.sous && st.sous.length > 0) {
            st.sous.forEach(sd => {
                let coteVal = "-";
                let isAccuse = (accuseTPData[st.nom] && accuseTPData[st.nom][sd] && accuseTPData[st.nom][sd].includes(code));
                if(cotesData[st.nom] && cotesData[st.nom][sd]) { let cObj = cotesData[st.nom][sd].find(c => c.code === code); if(cObj) coteVal = cObj.cote; }
                let statutTxt = coteVal !== "-" ? `<strong style="color:${coteVal==='TB'||coteVal==='E'?'green':'#333'}">${coteVal}</strong>` : (isAccuse ? `<span style="color:#fd7e14;font-size:11px;">Accusé (attente)</span>` : `-`);
                html += `<div style="display:flex;justify-content:space-between;border-top:1px dashed #eee;margin-top:4px;padding-top:4px;"><span style="font-size:12px;">${sd}</span>${statutTxt}</div>`;
            });
        } else { html += `<div style="font-size:11px;color:#999;">Aucun sous-dossier</div>`; }
        html += `</div>`;
    }); document.getElementById('contenu-releve').innerHTML = html + "</div>";
}

function genererReleveFinal(code) {
    const etu = etudiants.find(e => e.code === code); let tJ=0, tP=0, details=[];
    const activePromo = (currentMode === 'affermissement') ? (localStorage.getItem(KEY_ACTIVE_PROMO) || '') : '';
    sessions.forEach(s => {
        let lpAll = historique[s]||[];
        let lp = (currentMode === 'affermissement' && activePromo) ? lpAll.filter(p => !p.promo || p.promo === activePromo) : lpAll;
        const du = [...new Set(lp.map(p => p.date))];
        const np = lp.filter(p => p.code === code).length;
        tJ+=du.length; tP+=np; if(du.length>0) details.push({nom:s, j:du.length, p:np, pc:Math.round((np/du.length)*100)});
    });
    const pG = tJ>0?Math.round((tP/tJ)*100):0;
    let html = `<div class="releve-card"><div class="releve-header"><h3> RELEVÉ FINAL GÉNÉRAL</h3><p class="nom-eleve">${etu.nom.toUpperCase()} ${etu.prenom}</p></div>
        <div class="pourcentage-box ${pG>=80?'pourcent-excellent':(pG>=75?'pourcent-bon':'pourcent-faible')}">${pG}%</div><h4 style="color:#006070;">Par dossier :</h4>`;
    details.forEach(d => { html += `<div style="background:#fff;border:1px solid #ddd;padding:8px;border-radius:5px;margin:5px 0;display:flex;justify-content:space-between;"><div><b>${d.nom}</b><br>${d.p}P sur ${d.j} séance(s)</div><b style="color:${d.pc>=80?'green':(d.pc>=75?'#856404':'red')}">${d.pc}%</b></div>`; });
    document.getElementById('contenu-releve-final').innerHTML = html + "</div>";
}

function getCodeFromSearch() {
    const input = document.getElementById('recherche-nom'); let code = input.dataset.code;
    if(!code) { const val = input.value.trim().toLowerCase(); const etu = getEtudiantsFiltres().find(e => (e.nom+" "+e.prenom).toLowerCase().includes(val)); if(etu) code = etu.code; }
    input.value = ""; input.dataset.code = ""; return code;
}
async function rechercherParticipant() {
    const c = getCodeFromSearch(); if(!c) return alert("Introuvable");
    // ✅ Recharger depuis Supabase avant d'afficher pour avoir les données à jour
    await chargerDonnees();
    if(currentMode === 'cote') genererReleveCote(c); else genererReleve(c);
    document.getElementById('releve-final').classList.add('hidden');
    document.getElementById('releve-individuel').classList.remove('hidden');
    document.getElementById('cote-rapport').style.display = 'flex';
}
async function rechercherReleveFinal() {
    const c = getCodeFromSearch(); if(!c) return alert("Introuvable");
    // ✅ Recharger depuis Supabase avant d'afficher
    await chargerDonnees();
    genererReleveFinal(c);
    document.getElementById('releve-individuel').classList.add('hidden');
    document.getElementById('releve-final').classList.remove('hidden');
    document.getElementById('cote-rapport').style.display = 'flex';
}
function afficherSuggestions() {
    const val = document.getElementById('recherche-nom').value.trim().toLowerCase(); const box = document.getElementById('suggestions');
    if(val.length < 1) return box.classList.add('hidden');
    const res = getEtudiantsFiltres().filter(e => (e.nom+" "+e.prenom).toLowerCase().includes(val));
    box.innerHTML = res.map(e => `<div class="suggestion-item" onclick="selectionnerSuggestion('${e.code}')"><span>${e.nom.toUpperCase()} ${e.prenom}</span></div>`).join('');
    box.classList.remove('hidden');
}
function selectionnerSuggestion(code) {
    const etu = etudiants.find(e => e.code === code); document.getElementById('recherche-nom').value = etu.nom+" "+etu.prenom; document.getElementById('recherche-nom').dataset.code = code; document.getElementById('suggestions').classList.add('hidden');
}
document.addEventListener('click', e => { if(!e.target.closest('.search-container')) { document.getElementById('suggestions').classList.add('hidden'); document.getElementById('suggestions-cote').classList.add('hidden'); } });
function fermerReleve() { document.getElementById('releve-individuel').classList.add('hidden'); if(document.getElementById('releve-final').classList.contains('hidden')) document.getElementById('cote-rapport').style.display = 'none'; }
function fermerReleveFinal() { document.getElementById('releve-final').classList.add('hidden'); if(document.getElementById('releve-individuel').classList.contains('hidden')) document.getElementById('cote-rapport').style.display = 'none'; }

async function toggleListeEtudiants() { document.getElementById('liste-etudiants-suppr').classList.toggle('hidden'); afficherListeEtudiants(); }
function afficherListeEtudiants() {
    const filtre = document.getElementById('filtre-suppr').value.trim().toLowerCase();
    let etudiantsFiltres = getEtudiantsFiltres();
    if(filtre) etudiantsFiltres = etudiantsFiltres.filter(e => (e.nom+" "+e.prenom).toLowerCase().includes(filtre));
    document.getElementById('contenu-liste-etudiants').innerHTML = etudiantsFiltres.map(e =>
        `<div style="display:flex;justify-content:space-between;border-bottom:1px solid #eee;padding:5px;align-items:center;">
            <div><b>${e.nom.toUpperCase()} ${e.prenom}</b><br><span style="font-size:11px;color:#888;">${e.sessionInscription||''}</span></div>
            <button type="button" style="background:none;border:none;color:red;cursor:pointer;width:auto;" onclick="supprimerEtudiant('${e.code}')">✕</button>
        </div>`
    ).join('');
}
async function supprimerEtudiant(code) {
    if(!confirm("Supprimer ce participant ?")) return;
    try {
        const table = currentMode === 'bapteme' ? 'participants_bapteme' : 'participants_affermissement';
        await dbDelete(table, { code: code });
        etudiants = etudiants.filter(e => e.code !== code);
        if(currentMode === 'bapteme' || currentMode === 'affermissement') { for(let s in historique) historique[s] = historique[s].filter(p => p.code !== code); }
        sauvegarderDonneesLocal(); afficherListeEtudiants();
    } catch(e) { alert("Erreur suppression : " + e.message); }
}

// =========== VUE GLOBALE EXCEL ===========
function getCouleurPourcentage(pct) { if (pct >= 80) return "background-color: #d4edda; color: #155724;"; if (pct >= 75) return "background-color: #fff3cd; color: #856404;"; return "background-color: #f8d7da; color: #721c24;"; }
async function ouvrirVueGlobale() {
    // ✅ Recharger depuis Supabase pour avoir toutes les données à jour
    await chargerDonnees();
    injecterBoutonExcel(); // ✅ Crée le bouton Excel dynamiquement (rien à toucher dans le HTML)
    if(currentMode === 'cote') ouvrirVueGlobaleCote(); 
    else if(currentMode === 'mercredi') ouvrirVueGlobaleMercredi();
    else ouvrirVueGlobalePresence();
}

// ✅ Insère le bouton "Télécharger Excel" dans le header de la modale, créé entièrement en JS
function injecterBoutonExcel() {
    const header = document.querySelector('#modal-vue-globale .header-vue-globale > div');
    if(!header) return;
    if(document.getElementById('btn-excel-dynamique')) return; // déjà créé, ne pas dupliquer
    const btnExcel = document.createElement('button');
    btnExcel.type = 'button';
    btnExcel.id = 'btn-excel-dynamique';
    btnExcel.className = 'btn-pdf';
    btnExcel.style.margin = '0';
    btnExcel.style.background = '#1d6f42';
    btnExcel.innerText = ' Télécharger Excel';
    btnExcel.onclick = telechargerExcel;
    const btnFermer = header.querySelector('.btn-close-globale');
    if(btnFermer) header.insertBefore(btnExcel, btnFermer);
    else header.appendChild(btnExcel);
}

// ✅ Charge dynamiquement la bibliothèque SheetJS (xlsx) si elle n'est pas déjà chargée
function chargerLibrairieExcel() {
    return new Promise((resolve, reject) => {
        if(window.XLSX) return resolve();
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Impossible de charger la librairie Excel"));
        document.head.appendChild(script);
    });
}

function ouvrirVueGlobalePresence() {
    const container = document.getElementById('table-excel-container'); let html = `<table class="excel-table">`; let structure = []; const couleurGrille = '#b4c6e7'; let totalDatesGlobalCount = 0;
    // ✅ CORRECTION : lire activePromo depuis le cache local déjà synchronisé par chargerDonnees
    // chargerDonnees() a déjà lu depuis Supabase et mis à jour localStorage avant d'arriver ici
    const activePromo = localStorage.getItem(KEY_ACTIVE_PROMO) || '';
    sessions.forEach(s => {
        let lpAll = historique[s]||[];
        let lp = (currentMode === 'affermissement' && activePromo) ? lpAll.filter(p => !p.promo || p.promo === activePromo) : lpAll;

        // ✅ CORRECTION SAMEDI : rattacher la présence du samedi au dimanche précédent
        // Le samedi qui suit un dimanche = rattrapage de ce dimanche, pas une nouvelle séance
        if(currentMode === 'affermissement') {
            lp = lp.map(p => {
                const parts = p.date.split('/');
                const dateObj = new Date(parseInt(parts[2]), parseInt(parts[1])-1, parseInt(parts[0]));
                if(dateObj.getDay() === 6) { // samedi
                    const dimanche = new Date(dateObj);
                    dimanche.setDate(dateObj.getDate() - 6); // dimanche précédent
                    const dd = String(dimanche.getDate()).padStart(2,'0');
                    const mm = String(dimanche.getMonth()+1).padStart(2,'0');
                    const yyyy = dimanche.getFullYear();
                    return { ...p, date: `${dd}/${mm}/${yyyy}`, estRattrapage: true };
                }
                return p;
            });
        }

        let dates = [...new Set(lp.map(x=>x.date))].sort((a,b) => { let [ja,ma,aa]=a.split('/'); let [jb,mb,ab]=b.split('/'); return new Date(aa,ma-1,ja) - new Date(ab,mb-1,jb); });
        structure.push({ session: s, dates: dates, lp: lp, color: couleurGrille }); totalDatesGlobalCount += dates.length;
    });
    html += `<tr class="excel-header-row1"><th rowspan="2" style="background:#006070;color:white;font-size:12px;min-width:30px;">N°</th><th rowspan="2" class="col-prenom">PRENOMS</th><th rowspan="2" class="col-nom">NOMS</th>`;
    structure.forEach(st => { html += `<th colspan="${st.dates.length+2}" style="background:${st.color}; font-size:13px; color:#000;">${st.session.toUpperCase()}</th>`; });
    html += `<th rowspan="2" style="background:#ffc107; font-size:13px; color:#000;">% GLOBAL</th></tr><tr>`;
    structure.forEach(st => {
        st.dates.forEach(d => { let parts = d.split('/'); let mois = ['janv','févr','mars','avr','mai','juin','juil','août','sept','oct','nov','déc']; html += `<th style="background:${st.color}; font-size:10px; color:#000;">${parts[0]}-${mois[parseInt(parts[1])-1]}</th>`; });
        html += `<th style="background:${st.color}; font-size:10px; color:#000;">TOT</th><th style="background:${st.color}; font-size:10px; color:#000;">%</th>`;
    }); html += `</tr>`;
    let tousEtudiants = [...getEtudiantsFiltres()].sort((a,b) => a.prenom.localeCompare(b.prenom));
    let num = 1;
    // ✅ Compteur de présents par date, pour chaque séance/colonne
    structure.forEach(st => { st.presentsParDate = {}; st.dates.forEach(d => st.presentsParDate[d] = 0); });
    tousEtudiants.forEach(etu => {
        html += `<tr><td style="text-align:center;font-weight:bold;color:#006070;font-size:12px;background:#e8f4f8;">${num++}</td><td class="col-prenom" style="background:#fff;">${etu.prenom.toUpperCase()}</td><td class="col-nom" style="background:#fff;">${etu.nom.toUpperCase()} ${etu.postnom||""}</td>`;
        let totalPresencesGlobal = 0;
        structure.forEach(st => {
            let totalP = 0;
            st.dates.forEach(d => { if(st.lp.find(p => p.code === etu.code && p.date === d)) { html += `<td style="background:${st.color};">1</td>`; totalP++; totalPresencesGlobal++; st.presentsParDate[d]++; } else { html += `<td></td>`; } });
            let pct = st.dates.length > 0 ? Math.round((totalP / st.dates.length) * 100) : 0; html += `<td class="excel-total">${totalP>0?totalP:''}</td><td class="excel-total" style="${getCouleurPourcentage(pct)}">${pct}%</td>`;
        });
        let pctGlobal = totalDatesGlobalCount > 0 ? Math.round((totalPresencesGlobal / totalDatesGlobalCount) * 100) : 0; html += `<td class="excel-total" style="${getCouleurPourcentage(pctGlobal)}; font-size:14px;"><b>${pctGlobal}%</b></td></tr>`;
    });
    html += `<tr style="background:#006070;"><td colspan="3" style="color:white;font-weight:bold;font-size:13px;padding:6px;text-align:left;">TOTAL : ${tousEtudiants.length} participant(s)</td>${structure.map(st=>`<td colspan="${st.dates.length+2}" style="color:white;font-weight:bold;text-align:center;font-size:12px;">${st.dates.length} séance(s)</td>`).join('')}<td style="color:white;"></td></tr>`;
    // ✅ NOUVELLE LIGNE : nombre de présents pour chaque date/séance
    html += `<tr style="background:#28a745;"><td colspan="3" style="color:white;font-weight:bold;font-size:12px;padding:6px;text-align:left;"> PRÉSENTS PAR SÉANCE</td>`;
    structure.forEach(st => {
        st.dates.forEach(d => { html += `<td style="color:white;font-weight:bold;text-align:center;font-size:12px;background:#28a745;">${st.presentsParDate[d]}</td>`; });
        html += `<td colspan="2" style="background:#28a745;"></td>`;
    });
    html += `<td style="background:#28a745;"></td></tr>`;
    container.innerHTML = html + `</table>`; document.getElementById('modal-vue-globale').style.display = 'flex';
    // Sauvegarder la structure pour l'export Excel
    window._dernièreStructurePresence = { structure, tousEtudiants, type: 'presence' };
}

function ouvrirVueGlobaleCote() {
    const container = document.getElementById('table-excel-container'); let html = `<table class="excel-table">`; const couleurGrille = '#b4c6e7'; let totalSousDossiersGlobalCount = 0;
    html += `<tr class="excel-header-row1"><th rowspan="2" style="background:#006070;color:white;font-size:12px;min-width:30px;">N°</th><th rowspan="2" class="col-prenom">PRENOMS</th><th rowspan="2" class="col-nom">NOMS</th>`;
    sessionsCotes.forEach(st => { let colspan = (st.sous && st.sous.length > 0) ? st.sous.length + 1 : 2; html += `<th colspan="${colspan}" style="background:${couleurGrille}; font-size:13px; color:#000;">${st.nom.toUpperCase()}</th>`; if(st.sous && st.sous.length > 0) totalSousDossiersGlobalCount += st.sous.length; });
    html += `<th rowspan="2" style="background:#ffc107; font-size:13px; color:#000;">% GLOBAL</th></tr><tr>`;
    sessionsCotes.forEach(st => {
        if(!st.sous || st.sous.length === 0) { html += `<th style="background:${couleurGrille};">-</th><th style="background:${couleurGrille}; font-size:10px; color:#000;">%</th>`; } else { st.sous.forEach(sd => { html += `<th style="background:${couleurGrille}; font-size:10px; color:#000;">${sd}</th>`; }); html += `<th style="background:${couleurGrille}; font-size:10px; color:#000;">%</th>`; }
    }); html += `</tr>`;
    let tousEtudiants = [...getEtudiantsFiltres()].sort((a,b) => a.prenom.localeCompare(b.prenom));
    let num = 1;
    tousEtudiants.forEach(etu => {
        html += `<tr><td style="text-align:center;font-weight:bold;color:#006070;font-size:12px;background:#e8f4f8;">${num++}</td><td class="col-prenom" style="background:#fff;">${etu.prenom.toUpperCase()}</td><td class="col-nom" style="background:#fff;">${etu.nom.toUpperCase()} ${etu.postnom||""}</td>`;
        let totalGradesGlobal = 0;
        sessionsCotes.forEach(st => {
            if(!st.sous || st.sous.length === 0) { html += `<td></td><td class="excel-total" style="${getCouleurPourcentage(0)}">0%</td>`; } else {
                let gradesCount = 0;
                st.sous.forEach(sd => {
                    let coteVal = ""; if(cotesData[st.nom] && cotesData[st.nom][sd]) { let cObj = cotesData[st.nom][sd].find(c => c.code === etu.code); if(cObj && cObj.cote) { coteVal = cObj.cote; gradesCount++; totalGradesGlobal++; } }
                    html += `<td><b>${coteVal}</b></td>`;
                });
                let pct = Math.round((gradesCount / st.sous.length) * 100); html += `<td class="excel-total" style="${getCouleurPourcentage(pct)}"><b>${pct}%</b></td>`;
            }
        });
        let pctGlobal = totalSousDossiersGlobalCount > 0 ? Math.round((totalGradesGlobal / totalSousDossiersGlobalCount) * 100) : 0; html += `<td class="excel-total" style="${getCouleurPourcentage(pctGlobal)}; font-size:14px;"><b>${pctGlobal}%</b></td></tr>`;
    });
    html += `<tr style="background:#006070;"><td colspan="3" style="color:white;font-weight:bold;font-size:13px;padding:6px;text-align:left;">TOTAL : ${tousEtudiants.length} participant(s)</td>${sessionsCotes.map(st=>`<td colspan="${(st.sous&&st.sous.length>0)?st.sous.length+1:2}" style="color:white;font-weight:bold;text-align:center;font-size:12px;">${(st.sous&&st.sous.length)||0} TP(s)</td>`).join('')}<td style="color:white;"></td></tr>`;
    container.innerHTML = html + `</table>`; document.getElementById('modal-vue-globale').style.display = 'flex';
    // Sauvegarder pour l'export Excel
    window._dernièreStructurePresence = { tousEtudiants, type: 'cote' };
}
function fermerVueGlobale() { document.getElementById('modal-vue-globale').style.display = 'none'; }

// =========== SUIVI GÉNÉRAL MERCREDI ===========
function ouvrirVueGlobaleMercredi() {
    const container = document.getElementById('table-excel-container');
    let html = `<table class="excel-table">`;
    let structure = [];
    const couleurGrille = '#c3e6cb';
    let totalDatesGlobalCount = 0;

    sessions.forEach(s => {
        let lp = historique[s] || [];
        let dates = [...new Set(lp.map(x=>x.date))].sort((a,b) => {
            let [ja,ma,aa]=a.split('/'); let [jb,mb,ab]=b.split('/');
            return new Date(aa,ma-1,ja) - new Date(ab,mb-1,jb);
        });
        structure.push({ session: s, dates, lp, color: couleurGrille });
        totalDatesGlobalCount += dates.length;
    });

    html += `<tr class="excel-header-row1">
        <th rowspan="2" style="background:#006070;color:white;font-size:12px;min-width:30px;">N°</th>
        <th rowspan="2" class="col-prenom">PRENOMS</th>
        <th rowspan="2" class="col-nom">NOMS</th>`;
    structure.forEach(st => { html += `<th colspan="${st.dates.length+2}" style="background:${st.color};font-size:13px;color:#000;">${st.session.toUpperCase()}</th>`; });
    html += `<th rowspan="2" style="background:#ffc107;font-size:13px;color:#000;">% GLOBAL</th></tr><tr>`;
    structure.forEach(st => {
        st.dates.forEach(d => {
            let parts = d.split('/');
            let mois = ['janv','févr','mars','avr','mai','juin','juil','août','sept','oct','nov','déc'];
            html += `<th style="background:${st.color};font-size:10px;color:#000;">${parts[0]}-${mois[parseInt(parts[1])-1]}</th>`;
        });
        html += `<th style="background:${st.color};font-size:10px;color:#000;">TOT</th><th style="background:${st.color};font-size:10px;color:#000;">%</th>`;
    });
    html += `</tr>`;

    let tousEtudiants = [...etudiants].sort((a,b) => a.prenom.localeCompare(b.prenom));
    let num = 1;
    structure.forEach(st => { st.presentsParDate = {}; st.dates.forEach(d => st.presentsParDate[d] = 0); });

    tousEtudiants.forEach(etu => {
        html += `<tr>
            <td style="text-align:center;font-weight:bold;color:#006070;font-size:12px;background:#e8f4f8;">${num++}</td>
            <td class="col-prenom" style="background:#fff;">${etu.prenom.toUpperCase()}</td>
            <td class="col-nom" style="background:#fff;">${etu.nom.toUpperCase()} ${etu.postnom||""}</td>`;
        let totalPresencesGlobal = 0;
        structure.forEach(st => {
            let totalP = 0;
            st.dates.forEach(d => {
                if(st.lp.find(p => p.code === etu.code && p.date === d)) {
                    html += `<td style="background:${st.color};">1</td>`; totalP++; totalPresencesGlobal++; st.presentsParDate[d]++;
                } else { html += `<td></td>`; }
            });
            let pct = st.dates.length > 0 ? Math.round((totalP / st.dates.length) * 100) : 0;
            html += `<td class="excel-total">${totalP>0?totalP:''}</td><td class="excel-total" style="${getCouleurPourcentage(pct)}">${pct}%</td>`;
        });
        let pctGlobal = totalDatesGlobalCount > 0 ? Math.round((totalPresencesGlobal / totalDatesGlobalCount) * 100) : 0;
        html += `<td class="excel-total" style="${getCouleurPourcentage(pctGlobal)};font-size:14px;"><b>${pctGlobal}%</b></td></tr>`;
    });

    html += `<tr style="background:#006070;">
        <td colspan="3" style="color:white;font-weight:bold;font-size:13px;padding:6px;text-align:left;">TOTAL : ${tousEtudiants.length} participant(s)</td>
        ${structure.map(st=>`<td colspan="${st.dates.length+2}" style="color:white;font-weight:bold;text-align:center;font-size:12px;">${st.dates.length} séance(s)</td>`).join('')}
        <td style="color:white;"></td></tr>`;

    html += `<tr style="background:#28a745;"><td colspan="3" style="color:white;font-weight:bold;font-size:12px;padding:6px;text-align:left;"> PRÉSENTS PAR SÉANCE</td>`;
    structure.forEach(st => {
        st.dates.forEach(d => { html += `<td style="color:white;font-weight:bold;text-align:center;font-size:12px;background:#28a745;">${st.presentsParDate[d]}</td>`; });
        html += `<td colspan="2" style="background:#28a745;"></td>`;
    });
    html += `<td style="background:#28a745;"></td></tr>`;

    container.innerHTML = html + `</table>`;
    document.getElementById('modal-vue-globale').style.display = 'flex';
    window._dernièreStructurePresence = { structure, tousEtudiants, type: 'mercredi' };
}

// =========== EXPORT EXCEL ===========
async function telechargerExcel() {
    const data = window._dernièreStructurePresence;
    if(!data) return alert("Aucune donnée à exporter. Ouvrez d'abord le Suivi Général.");

    try {
        await chargerLibrairieExcel(); // ✅ Charge XLSX dynamiquement si besoin
    } catch(e) {
        return alert("Impossible de charger l'export Excel. Vérifiez votre connexion internet.");
    }

    const joursAbrev = ['dim','lun','mar','mer','jeu','ven','sam'];

    if(data.type === 'presence') {
        // ── Construire les en-têtes : N°, Prénom, Nom, puis chaque date avec son jour ──
        const headerRow1 = ['N°', 'PRENOMS', 'NOMS'];
        const headerRow2 = ['', '', ''];
        data.structure.forEach(st => {
            st.dates.forEach(d => {
                headerRow1.push(st.session.toUpperCase());
                let [j,m,a] = d.split('/');
                let jourSemaine = joursAbrev[new Date(a, m-1, j).getDay()];
                headerRow2.push(`${jourSemaine} ${d}`);
            });
            headerRow1.push(st.session.toUpperCase(), st.session.toUpperCase());
            headerRow2.push('TOTAL', '%');
        });
        headerRow1.push('GLOBAL'); headerRow2.push('%');

        const rows = [headerRow1, headerRow2];

        // ── Une ligne par participant ──
        let num = 1;
        let totalDatesGlobal = data.structure.reduce((s,st)=>s+st.dates.length,0);
        data.tousEtudiants.forEach(etu => {
            const row = [num++, etu.prenom.toUpperCase(), etu.nom.toUpperCase() + (etu.postnom?(' '+etu.postnom):'')];
            let totalGlobal = 0;
            data.structure.forEach(st => {
                let totalSession = 0;
                st.dates.forEach(d => {
                    const present = st.lp.find(p => p.code === etu.code && p.date === d);
                    row.push(present ? 1 : '');
                    if(present) { totalSession++; totalGlobal++; }
                });
                const pct = st.dates.length > 0 ? Math.round((totalSession/st.dates.length)*100) : 0;
                row.push(totalSession, pct + '%');
            });
            const pctGlobal = totalDatesGlobal > 0 ? Math.round((totalGlobal/totalDatesGlobal)*100) : 0;
            row.push(pctGlobal + '%');
            rows.push(row);
        });

        // ── Ligne TOTAL participants ──
        const ligneTotal = ['', '', 'TOTAL : ' + data.tousEtudiants.length + ' participant(s)'];
        data.structure.forEach(st => { st.dates.forEach(()=>ligneTotal.push('')); ligneTotal.push(st.dates.length + ' séance(s)', ''); });
        ligneTotal.push('');
        rows.push(ligneTotal);

        // ── Ligne PRÉSENTS PAR SÉANCE ──
        const lignePresents = ['', '', 'PRÉSENTS PAR SÉANCE'];
        data.structure.forEach(st => { st.dates.forEach(d => lignePresents.push(st.presentsParDate[d])); lignePresents.push('', ''); });
        lignePresents.push('');
        rows.push(lignePresents);

        const ws = XLSX.utils.aoa_to_sheet(rows);
        // Largeur des colonnes pour bien lire noms/prénoms
        ws['!cols'] = [{wch:5},{wch:18},{wch:22}, ...headerRow1.slice(3).map(()=>({wch:10}))];
        // Fusionner les cellules d'en-tête par séance
        ws['!merges'] = ws['!merges'] || [];
        let colIdx = 3;
        data.structure.forEach(st => {
            const span = st.dates.length + 2;
            ws['!merges'].push({ s: { r:0, c:colIdx }, e: { r:0, c:colIdx+span-1 } });
            colIdx += span;
        });

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Suivi Présences");
        XLSX.writeFile(wb, "Suivi_General_Presences.xlsx");

    } else {
        // Export simple pour le mode côte (par TP)
        alert("Export Excel disponible uniquement pour le suivi des présences pour le moment.");
    }
}

function telechargerPDF(elementId, nomFichier) {
    const el = document.getElementById(elementId);
    const btns = document.querySelectorAll('.btn-pdf, .close-report-btn, .btn-close-globale, .btn-save-edit');
    btns.forEach(b => b.style.display = 'none');
    
    // ✅ CORRECTION PDF : sauvegarder et forcer la taille réelle de l'élément
    // pour capturer tout le contenu même hors écran (problème sur téléphone)
    const prevOverflow = el.style.overflow;
    const prevMaxHeight = el.style.maxHeight;
    const prevHeight = el.style.height;
    el.style.overflow = 'visible';
    el.style.maxHeight = 'none';
    el.style.height = 'auto';

    // Faire défiler vers le haut avant la capture
    window.scrollTo(0, 0);
    
    html2canvas(el, { 
        scale: 2, 
        useCORS: true, 
        backgroundColor: '#ffffff',
        scrollX: 0,
        scrollY: 0,
        windowWidth: el.scrollWidth,
        windowHeight: el.scrollHeight,
        width: el.scrollWidth,
        height: el.scrollHeight
    }).then(canvas => {
        // Restaurer les styles
        el.style.overflow = prevOverflow;
        el.style.maxHeight = prevMaxHeight;
        el.style.height = prevHeight;
        btns.forEach(b => b.style.display = '');
        
        const { jsPDF } = window.jspdf;
        const imgW = canvas.width;
        const imgH = canvas.height;
        
        // Calculer le nombre de pages nécessaires
        const pdf = new jsPDF('p', 'mm', 'a4');
        const pageW = pdf.internal.pageSize.getWidth() - 10;
        const pageH = pdf.internal.pageSize.getHeight() - 10;
        const ratio = pageW / imgW;
        const imgHeightMM = imgH * ratio;
        
        if(imgHeightMM <= pageH) {
            // Tout tient sur une page
            pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 5, 5, pageW, imgHeightMM);
        } else {
            // Plusieurs pages
            let posY = 0;
            while(posY < imgH) {
                const sliceH = Math.min(pageH / ratio, imgH - posY);
                const pageCanvas = document.createElement('canvas');
                pageCanvas.width = imgW;
                pageCanvas.height = sliceH;
                pageCanvas.getContext('2d').drawImage(canvas, 0, posY, imgW, sliceH, 0, 0, imgW, sliceH);
                if(posY > 0) pdf.addPage();
                pdf.addImage(pageCanvas.toDataURL('image/png'), 'PNG', 5, 5, pageW, sliceH * ratio);
                posY += sliceH;
            }
        }
        pdf.save(nomFichier + '.pdf');
    }).catch(() => {
        el.style.overflow = prevOverflow;
        el.style.maxHeight = prevMaxHeight;
        el.style.height = prevHeight;
        btns.forEach(b => b.style.display = '');
        alert("Erreur PDF");
    });
}

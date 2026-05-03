"""
BestPriceTank — Index.html Patcher
Führe dieses Script einmal aus, es macht alle Änderungen automatisch.

Benutzung:
  1. Dieses Script (patch.py) in denselben Ordner wie index.html legen
  2. Terminal öffnen, in den Ordner navigieren
  3. python3 patch.py
  4. index_neu.html wird erstellt — prüfen, dann umbenennen zu index.html
"""

import re

print("BestPriceTank Index-Patcher startet...")

with open("index.html", "r", encoding="utf-8") as f:
    html = f.read()

errors = []

# ── ÄNDERUNG 1: ER_KEY entfernen ─────────────────────────────────────────────
old = "const ER_KEY = '3b6be993697eeea74f5db4a0';"
new = "// ER_KEY entfernt — Kurse kommen vom eigenen Endpoint"
if old in html:
    html = html.replace(old, new)
    print("✅ 1/7 ER_KEY entfernt")
else:
    errors.append("❌ 1/7 ER_KEY nicht gefunden")

# ── ÄNDERUNG 2: loadRates() ersetzen ─────────────────────────────────────────
old = """async function loadRates(){
  try{
    const r=await fetch(`https://v6.exchangerate-api.com/v6/${ER_KEY}/latest/EUR`);
    const d=await r.json();
    if(d.result==='success'){
      BPT_RATES.PLN=+d.conversion_rates.PLN.toFixed(3);
      BPT_RATES.CZK=+d.conversion_rates.CZK.toFixed(3);
      updateStrip();
      renderMapMarkers(); // refresh PLN/CZK sub-prices
    }
  }catch(e){}
}"""

new = """async function loadRates(){
  try{
    const r = await fetch('/.netlify/functions/dp-prices');
    const d = await r.json();
    if(d.pln_eur_rate > 0) BPT_RATES.PLN = d.pln_eur_rate;
    if(d.czk_eur_rate > 0) BPT_RATES.CZK = d.czk_eur_rate;
    updateStrip();
    renderMapMarkers();
  }catch(e){}
}

// CZ-Preise aus pl-prices.json laden und mit live CZK-Kurs umrechnen
async function loadCZPrices(){
  try{
    const r = await fetch('/data/pl-prices.json');
    const d = await r.json();
    if(!d.cz) return;
    const rate = BPT_RATES.CZK || 25.20;
    const czDiesel = +(d.cz.diesel / rate).toFixed(3);
    const czE5     = +(d.cz.e5     / rate).toFixed(3);
    const czLpg    = +(d.cz.lpg    / rate).toFixed(3);
    const czE10    = +((d.cz.diesel + 1.00) / rate).toFixed(3);
    PRICES.diesel.cz = czDiesel;
    PRICES.e5.cz     = czE5;
    PRICES.e10.cz    = czE10;
    PRICES.lpg.cz    = czLpg;
    STATIONS.filter(s => s.country === 'cz').forEach(s => {
      s.diesel = czDiesel;
      s.e5     = czE5;
      s.e10    = czE10;
      s.lpg    = czLpg;
    });
    renderMapMarkers();
    renderStationList();
    console.log(`✅ CZ Preise: Diesel ${czDiesel}€ · E5 ${czE5}€ · Kurs ${rate} CZK/EUR`);
  }catch(e){ console.warn('CZ Preise:', e.message); }
}"""

if "https://v6.exchangerate-api.com" in html:
    html = html.replace(old, new)
    print("✅ 2/7 loadRates() + loadCZPrices() ersetzt")
else:
    errors.append("❌ 2/7 loadRates nicht gefunden")

# ── ÄNDERUNG 3: DP-Fetch URL — lat/lng/rad entfernen ─────────────────────────
old = "const dpurl=`/.netlify/functions/dp-prices?lat=${coords.lat}&lng=${coords.lng}&rad=${rad}`;"
new = "const dpurl = `/.netlify/functions/dp-prices`;"
if old in html:
    html = html.replace(old, new)
    print("✅ 3/7 dpurl Parameter entfernt (CDN-Cache aktiv)")
else:
    errors.append("❌ 3/7 dpurl nicht gefunden")

# ── ÄNDERUNG 4: dist_km — immer selbst berechnen ─────────────────────────────
old = "const km = s.dist_km || +haversine({lat:base.lat,lng:base.lng},{lat:s.lat,lng:s.lng}).toFixed(1);"
new = "const km = +haversine({lat:base.lat,lng:base.lng},{lat:s.lat,lng:s.lng}).toFixed(1);"
if old in html:
    html = html.replace(old, new)
    print("✅ 4/7 dist_km Berechnung korrigiert")
else:
    errors.append("❌ 4/7 dist_km nicht gefunden")

# ── ÄNDERUNG 5: PRICES CZ Werte aktualisieren (ONO 30.04.2026) ───────────────
old = "  diesel:{de:1.649,pl:1.440,cz:1.477,label:'Diesel'},"
new = "  diesel:{de:1.649,pl:1.440,cz:1.619,label:'Diesel'},"
if old in html:
    html = html.replace(old, new)
    print("✅ 5/7 PRICES.diesel.cz aktualisiert")
else:
    errors.append("❌ 5/7 PRICES diesel cz nicht gefunden")

html = html.replace(
    "  e5:    {de:1.699,pl:1.479,cz:1.497,label:'Super E5'},",
    "  e5:    {de:1.699,pl:1.479,cz:1.579,label:'Super E5'},"
)
html = html.replace(
    "  e10:   {de:1.669,pl:1.459,cz:1.487,label:'Super E10'},",
    "  e10:   {de:1.669,pl:1.459,cz:1.659,label:'Super E10'},"
)
html = html.replace(
    "  lpg:   {de:0.979,pl:0.937,cz:0.813,label:'LPG'}",
    "  lpg:   {de:0.979,pl:0.937,cz:0.891,label:'LPG'}"
)

# ── ÄNDERUNG 6: CZ Stationen aktualisieren ────────────────────────────────────
replacements = [
    ("diesel:1.477,e5:1.497,e10:1.487,lpg:0.813,logo:'M'",
     "diesel:1.619,e5:1.579,e10:1.659,lpg:0.891,logo:'M'"),
    ("diesel:1.497,e5:1.517,e10:1.507,lpg:0.829,logo:'E'",
     "diesel:1.639,e5:1.599,e10:1.679,lpg:0.907,logo:'E'"),
    ("diesel:1.481,e5:1.503,e10:1.491,lpg:0.821,logo:'ON'",
     "diesel:1.619,e5:1.579,e10:1.659,lpg:0.891,logo:'ON'"),
    ("diesel:1.483,e5:1.505,e10:1.493,lpg:0.819,logo:'BZ'",
     "diesel:1.623,e5:1.583,e10:1.663,lpg:0.887,logo:'BZ'"),
    ("diesel:1.473,e5:1.495,e10:1.483,lpg:0.818,logo:'🐚',best:false},",
     "diesel:1.615,e5:1.575,e10:1.655,lpg:0.887,logo:'🐚',best:false},"),
]
cz_ok = True
for old_r, new_r in replacements:
    if old_r in html:
        html = html.replace(old_r, new_r)
    else:
        cz_ok = False
if cz_ok:
    print("✅ 6/7 CZ Stationen aktualisiert (ONO Preise 30.04.2026)")
else:
    errors.append("❌ 6/7 Manche CZ Stationen nicht gefunden")

# ── ÄNDERUNG 7: Boot-Sequenz — CZ Preise nach Rates laden ────────────────────
old = "setTimeout(()=>{loadRates();refreshPrices();}, 800);"
new = """setTimeout(async ()=>{
  await loadRates();
  await loadCZPrices();
  refreshPrices();
}, 800);"""

if old in html:
    html = html.replace(old, new)
    print("✅ 7/7 Boot-Sequenz aktualisiert")
else:
    errors.append("❌ 7/7 Boot-Sequenz nicht gefunden")

# ── Ergebnis ──────────────────────────────────────────────────────────────────
print()
if errors:
    print("⚠️  Folgende Änderungen konnten nicht automatisch gemacht werden:")
    for e in errors:
        print(" ", e)
    print("\nDiese müssen manuell in index.html gemacht werden.")
else:
    print("🎉 Alle 7 Änderungen erfolgreich!")

with open("index_neu.html", "w", encoding="utf-8") as f:
    f.write(html)

print(f"\n📄 index_neu.html erstellt ({len(html):,} Zeichen)")
print("Prüfe die Datei, dann:")
print("  mv index_neu.html index.html")
print("  git add index.html && git commit -m 'fix: ER_KEY entfernt, CZ Live-Preise, CDN-Cache' && git push")

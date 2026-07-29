/*
 * catalog.js — per-supplier product/price data.
 *
 * The server injects ONE supplier's catalogue into the page (see server.js), chosen by the
 * SUPPLIER env var. That way each deployment/URL only ever sends its own supplier's prices to
 * the browser — true separation with no login. SUPPLIER options: "southern" (default),
 * "mattressshire", "combined" (internal — shows both via the supplier picker).
 *
 * Structure per SKU: { id, name, builds:[ { id, label, full, depths:[labels], grid:{ single/double/king/sking:[prices aligned to depths] } } ] }
 */

// ---- Depth-label sets (aligned to each build's price arrays) ----
const DFULL  = ['2″ (5cm)', '3″ (7.5cm)', '4″ (10cm)', '5″ (12.5cm)', '6″ (15cm)', '8″ (20cm)', '10″ (25cm)'];
const D1TOP  = ['5″+1″ (6″ / 15cm)', '7″+1″ (8″ / 20cm)', '9″+1″ (10″ / 25cm)'];
const D2TOP  = ['4″+2″ (6″ / 15cm)', '6″+2″ (8″ / 20cm)', '8″+2″ (10″ / 25cm)'];
const DGRAND = ['6″+2″ (8″ / 20cm)', '8″+2″ (10″ / 25cm)'];
const DBODYT = ['1″ (2.5cm)', '2″ (5cm)', '3″ (7.5cm)', '4″ (10cm)', '5″ (12.5cm)'];
const DCOOLT = ['2″ (5cm)', '3″ (7.5cm)'];
const DNOVO  = ['6″ (15cm)', '8″ (20cm)', '10″ (25cm)'];

// ---- Southern Production (from the Southern price sheets) ----
const SOUTHERN_SKUS = [
  { id: "essential", name: "Essential", builds: [
    { id: "ess-white", label: "30/130 White", full: "30/130 White", codeMatch: "30/130", depths: DFULL, grid: {
      single: [50,56,63,70,80,90,105], double: [62,70,80,90,100,115,135],
      king: [69,77,87,97,110,125,150], sking: [85,95,105,120,135,155,190] } },
    { id: "ess-blue", label: "33/175 Blue", full: "33/175 Blue", codeMatch: "33/175", depths: DFULL, grid: {
      single: [60,66,73,80,90,100,115], double: [72,80,90,100,110,125,145],
      king: [79,87,97,107,120,135,160], sking: [95,105,115,130,145,165,200] } }
  ]},
  { id: "novo", name: "Novo", builds: [
    { id: "novo", label: "RF39/120 Peach", full: "33/175 Blue + 30/130 White + RF39/120 Peach", depths: DNOVO, grid: {
      single: [110,120,135], double: [130,145,165],
      king: [140,155,180], sking: [165,185,220] } }
  ]},
  { id: "body", name: "Body", builds: [
    { id: "body-1v40", label: "1″ Vasco 40", full: "33/175 Blue + RF39/120 Peach + 1″ Vasco 40", codeMatch: '1" vasco 40', depths: D1TOP, grid: {
      single: [115,128,140], double: [135,150,165], king: [145,160,180], sking: [170,190,210] } },
    { id: "body-2v40", label: "2″ Vasco 40", full: "33/175 Blue + RF39/120 Peach + 2″ Vasco 40", codeMatch: '2" vasco 40', depths: D2TOP, grid: {
      single: [120,135,150], double: [145,165,185], king: [155,175,200], sking: [185,210,235] } }
  ]},
  { id: "cool", name: "Cool", builds: [
    { id: "cool-1fr", label: "1″ FR50/125", full: "33/175 Blue + RF39/120 Peach + 1″ FR50/125", codeMatch: '1" fr50/125', depths: D1TOP, grid: {
      single: [160,167.5,196], double: [195,210.25,243.5], king: [210,224.5,262.5], sking: [230,248.25,291] } },
    { id: "cool-2fr", label: "2″ FR50/125", full: "33/175 Blue + RF39/120 Peach + 2″ FR50/125", codeMatch: '2" fr50/125', depths: D2TOP, grid: {
      single: [160,175,205], double: [195,220,255], king: [210,235,275], sking: [230,260,305] } }
  ]},
  { id: "grand", name: "Grand", builds: [
    { id: "grand-v40", label: "2″ Vasco 40", full: "33/175 + RF39/120 + 2″ Vasco 40", codeMatch: "vasco 40 top", depths: DGRAND, grid: {
      single: [130,145], double: [160,180], king: [170,195], sking: [205,230] } },
    { id: "grand-v60", label: "2″ Vasco 60", full: "33/175 + RF39/120 + 2″ Vasco 60", codeMatch: "vasco 60 top", depths: DGRAND, grid: {
      single: [182.5,214], double: [229.75,266.5], king: [245.5,287.5], sking: [271.75,319] } }
  ]},
  { id: "bodyt", name: "BodyT", builds: [
    { id: "bodyt", label: "Vasco 40 (topper)", full: "Vasco 40", depths: DBODYT, grid: {
      single: [40,50,60,75,85], double: [55,65,78,95,105], king: [62,70,82,100,110], sking: [74,88,104,120,130] } }
  ]},
  { id: "coolt", name: "CoolT", builds: [
    { id: "coolt", label: "FR50/125 (topper)", full: "FR50/125", depths: DCOOLT, grid: {
      single: [70,80], double: [100,110], king: [110,120], sking: [130,145] } }
  ]}
];

// ---- Mattressshire Production (from Mattressshire's price sheets) ----
const M_6810 = ['6″ (15cm)', '8″ (20cm)', '10″ (25cm)'];
const M_10   = ['10″ (25cm)'];
const MATTRESSSHIRE_SKUS = [
  { id: "comfi", name: "Comfi", builds: [
    { id: "comfi", label: "Blue & White Foam", full: "Blue & White Foam", depths: M_6810, grid: {
      single: [100,112,130], double: [124,142,166],
      king: [136,154,184], sking: [190,214,250] } }
  ]},
  { id: "imperial", name: "Imperial", codeWatch: "tufting", builds: [
    { id: "imperial", label: "2000 Pocket Memory + Gel", full: "2000 Pocket Memory + Gel", depths: M_10, grid: {
      single: [235], double: [260], king: [285], sking: [410] } }
  ]}
];

// ---- Add-ons / surcharges (per supplier) ----
// types: "qty" (price × quantity), "steps" (price looked up by quantity from prices[]),
//        "choice" (pick one option), "toggle" (on/off), "misc" (free description + amount)
const SOUTHERN_EXTRAS = [
  { id: "cornercut",   name: "Corner cut-off",                     price: 12, type: "qty", unit: "per corner", max: 8 },
  { id: "roundcorner", name: "Round corner",                       price: 15, type: "qty", unit: "per corner", max: 8 },
  { id: "threestep",   name: "3-step cut",                         price: 40, type: "qty", unit: "each", sub: "“words cannot explain”", max: 8 },
  { id: "template",    name: "Cut to template",                    type: "choice",
    options: [ { label: "Topper template — £30", price: 30 }, { label: "Mattress template — £50", price: 50 } ] },
  { id: "bolster",     name: "Extra cover for bolster",            price: 20, type: "qty", unit: "each", max: 8 },
  { id: "ziplink",     name: "Zip / fabric link",                  price: 30, type: "qty", unit: "each", max: 8 },
  { id: "topper",      name: "Increase topper depth (+2.5cm max)", price: 10, type: "toggle" },
  { id: "darkgrey",    name: "Dark-grey fabric",                   price: 15, type: "toggle", sub: "up to king size" },
  { id: "chamfer",     name: "Chamfer cut",                        price: 25, type: "qty", unit: "per chamfer", sub: "boat mattresses etc.", max: 8 },
  { id: "underside",   name: "Underside / undercut",               price: 40, type: "qty", unit: "per undercut", max: 8 },
  { id: "circular",    name: "Circular mattress",                   price: 60, type: "toggle", sub: "pro-rata + £60" },
  { id: "misc",        name: "Miscellaneous",                       type: "misc" }
];

const MATTRESSSHIRE_EXTRAS = [
  // Cuts are priced by the NUMBER of cuts (prices[qty]) — index 0 = none.
  { id: "cuts",         name: "Cuts",                              type: "steps", sub: "priced by number of cuts",
    prices: [0, 20, 30, 40, 50, 60, 70, 80, 90, 100] },
  { id: "bolstertopbot",name: "Bolster — fabric top & bottom",     price: 25,   type: "qty", unit: "per bolster", max: 8 },
  { id: "tufting",      name: "Tufting",                           price: 12.5, type: "qty", unit: "each", max: 8 },
  { id: "ziplink",      name: "Zip & link",                        price: 45,   type: "qty", unit: "each", max: 8 },
  { id: "fabriclink",   name: "Fabric link",                       price: 35,   type: "qty", unit: "each", max: 8 },
  { id: "extracover2pc",name: "Extra cover (2-piece mattress)",    price: 20,   type: "qty", unit: "each", max: 8 },
  { id: "misc",         name: "Miscellaneous",                     type: "misc" }
];

const SOUTHERN      = { key: "southern",      name: "Southern Production",     badge: "#0c7c6f", skus: SOUTHERN_SKUS,      extras: SOUTHERN_EXTRAS };
const MATTRESSSHIRE = { key: "mattressshire", name: "Mattressshire Production", badge: "#7c3aed", skus: MATTRESSSHIRE_SKUS, extras: MATTRESSSHIRE_EXTRAS };

module.exports = {
  southern:      SOUTHERN,
  mattressshire: MATTRESSSHIRE,
  // internal combined view (for your own double-checking only — don't share this URL with suppliers)
  combined:      { key: "combined", name: "All suppliers", multi: true, badge: "#334155",
                   suppliers: [SOUTHERN, MATTRESSSHIRE],
                   skus: SOUTHERN_SKUS.concat(MATTRESSSHIRE_SKUS),
                   extras: SOUTHERN_EXTRAS }
};

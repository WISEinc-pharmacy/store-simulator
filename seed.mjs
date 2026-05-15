/**
 * 越谷（南越谷）・清瀬の新店舗データをFirestoreに投入するスクリプト
 * Google OAuth refresh token -> Firebase signInWithIdp -> Firestore REST API
 * Usage: node seed.mjs
 *
 * 事前準備: .env ファイルを作成して以下の環境変数を設定してください
 *   .env.example を参照
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// .env ファイルを自動読み込み（存在する場合）
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#\s][^=]*)=(.*)/);
    if (m) process.env[m[1].trim()] ??= m[2].trim().replace(/^["']|["']$/g, '');
  }
}

const PROJECT_ID = "wise-store-sim";
const API_KEY = "AIzaSyCzJVHWz8e4iyhcblnJIw-xCiCGYNC2b8I"; // Firebase Web SDK キー（クライアント公開用・問題なし）

// Google OAuth 認証情報（.env または環境変数から取得）
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

if (!GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
  console.error('❌ 環境変数が未設定です。.env.example を参照して .env ファイルを作成してください。');
  console.error('   必須: GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN');
  process.exit(1);
}

// --- Shared master & staffTypes ---
const master = {
  techFeePerRx: 1838,
  drugCostPerRx: 4434,
  techFeePerHC: 17556,
  drugCostPerHC: 18564,
};

const staffTypes = [
  { name: "管理薬剤師", monthlySalary: 550000 },
  { name: "常勤薬剤師", monthlySalary: 450000 },
  { name: "パート薬剤師", monthlySalary: 250000 },
  { name: "一般事務", monthlySalary: 230000 },
  { name: "訪問薬剤師", monthlySalary: 550000 },
  { name: "パート事務", monthlySalary: 180000 },
];

// --- calcRow ---
function calcRow(r, settings) {
  const m = master, s = settings, st = staffTypes;
  r.techOutpatient = (r.rxCount || 0) * m.techFeePerRx;
  r.drugOutpatient = (r.rxCount || 0) * m.drugCostPerRx;
  r.techHomecare = (r.homecareCount || 0) * m.techFeePerHC;
  r.drugHomecare = (r.homecareCount || 0) * m.drugCostPerHC;
  r.regionalSupport = r.month >= s.regionalStartMonth ? s.regionalSupport : 0;
  r.concentrationRate = Math.max(0, (s.baseConcentration || 50) - (r.homecareCount || 0) * (s.concentrationDecay || 0.06));
  r.revenue = r.techOutpatient + r.regionalSupport + r.techHomecare + r.drugOutpatient + r.drugHomecare;
  r.cogs = Math.round(r.revenue * s.costRatio);
  r.grossProfit = r.revenue - r.cogs;
  r.staffOutpatient = (s.staffOutpatientList || []).reduce((sum, e) => {
    const t = st[e.typeIdx]; if (!t) return sum;
    return sum + t.monthlySalary * (e.count || 0);
  }, 0);
  r.staffHomecare = (s.staffHomecareList || []).reduce((sum, e) => {
    const t = st[e.typeIdx]; if (!t) return sum;
    if (e.startMonth && r.month < e.startMonth) return sum;
    return sum + t.monthlySalary * (e.count || 0);
  }, 0);
  r.rent = s.rent;
  r.otherOutpatient = Math.round(r.techOutpatient * s.otherCostRatio);
  r.otherHomecare = Math.round(r.techHomecare * s.otherCostRatio);
  r.operatingProfit = r.grossProfit - r.staffOutpatient - r.staffHomecare - r.rent - r.otherOutpatient - r.otherHomecare;
  r.opProfitNoRegional = r.operatingProfit - r.regionalSupport;
  const tech = r.techOutpatient + r.techHomecare, staff = r.staffOutpatient + r.staffHomecare;
  r.techLaborRatio = tech > 0 ? (staff / tech * 100) : 0;
  return r;
}

function buildMonths(rxCountFn, homecareFn, settings) {
  return Array.from({ length: 48 }, (_, i) => {
    const month = i + 1;
    const r = {
      month,
      year: Math.ceil(month / 12),
      phase: Math.ceil(month / 12) <= 1 ? 1 : Math.ceil(month / 12) <= 2 ? 2 : Math.ceil(month / 12) <= 3 ? 3 : 4,
      rxCount: rxCountFn(month),
      homecareCount: homecareFn(month),
      note: "",
    };
    return calcRow(r, settings);
  });
}

// =============================================================
// Firestore value conversion
// =============================================================
function toFirestoreValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === "boolean") return { booleanValue: val };
  if (typeof val === "number") {
    if (Number.isInteger(val)) return { integerValue: String(val) };
    return { doubleValue: val };
  }
  if (typeof val === "string") return { stringValue: val };
  if (val instanceof Date) return { timestampValue: val.toISOString() };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFirestoreValue) } };
  if (typeof val === "object") {
    const fields = {};
    for (const [k, v] of Object.entries(val)) {
      fields[k] = toFirestoreValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function toFirestoreDoc(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    fields[k] = toFirestoreValue(v);
  }
  return { fields };
}

// =============================================================
// Auth: Google OAuth -> Firebase
// =============================================================
async function getGoogleAccessToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

async function signInWithGoogle(googleAccessToken) {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      postBody: `access_token=${googleAccessToken}&providerId=google.com`,
      requestUri: "http://localhost",
      returnIdpCredential: true,
      returnSecureToken: true,
    }),
  });
  if (!res.ok) throw new Error(`Firebase signIn failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  console.log(`Signed in as: ${data.email}`);
  return data.idToken;
}

// =============================================================
// Firestore write
// =============================================================
async function createDocument(collectionId, docData, idToken) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${collectionId}`;
  const body = toFirestoreDoc(docData);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${idToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Firestore write failed: ${res.status} ${err}`);
  }
  const result = await res.json();
  return result.name.split("/").pop();
}

// =============================================================
// Store data definitions
// =============================================================

// --- 越谷 ---
const koshigayaInvestment = {
  equipment: [
    { label: "仲介手数料", value: 5500000, detail: "案件発見者への手数料" },
    { label: "分包機類", value: 5214000, detail: "ユヤマ Twin-R93V分包機+什器一式（税込）", pdfUrl: "https://drive.google.com/file/d/1jiL5PORCrz6Bhd-l00jneuna_mnnDcSS/view" },
    { label: "内装費", value: 1858000, detail: "渋谷内装 壁撤去+パーテーション+長尺シート+修繕（税込）", pdfUrl: "https://drive.google.com/file/d/1qRl1WXcfVh2lCs1lzlfdHzRgtqVAn0MV/view" },
    { label: "レセコン・電子処方箋", value: 1650000, detail: "モイネット Pharmy Connect 2台+オン資+電子処方箋（税込・年間26.4万別途）" },
    { label: "什器一式", value: 2618067, detail: "中日販売 調剤棚・カウンター・待合ソファ・運搬組立（税抜）", pdfUrl: "https://drive.google.com/file/d/1WVzGB1-ZXB98fc_xScPu2ealB0AI1K4Q/view" },
  ],
  working: [
    { label: "運転資金（人件費）", value: 3432000 },
    { label: "運転資金（固定費）", value: 365760 },
    { label: "運転資金（売掛金）", value: 16817400 },
    { label: "テナント初期費用", value: 6204000 },
    { label: "行政申請", value: 100000 },
  ],
  depreciationMonths: 120,
};

const koshigayaConservativeSettings = {
  costRatio: 0.6525,
  regionalSupport: 0,
  regionalStartMonth: 999,
  rent: 440000,
  otherCostRatio: 0.08,
  baseConcentration: 100,
  concentrationDecay: 0,
  staffOutpatientList: [
    { typeIdx: 0, count: 1 },  // 管理薬剤師 550,000
    { typeIdx: 1, count: 1 },  // 常勤薬剤師 450,000
    { typeIdx: 3, count: 2 },  // 一般事務 230,000 x2
  ],
  staffHomecareList: [],
};

const koshigayaStandardSettings = {
  costRatio: 0.6525,
  regionalSupport: 0,
  regionalStartMonth: 999,
  rent: 440000,
  otherCostRatio: 0.08,
  baseConcentration: 100,
  concentrationDecay: 0.2,
  staffOutpatientList: [
    { typeIdx: 0, count: 1 },
    { typeIdx: 1, count: 1 },
    { typeIdx: 3, count: 2 },
    { typeIdx: 2, count: 1 },  // パート薬剤師
  ],
  staffHomecareList: [
    { typeIdx: 4, count: 1, startMonth: 8 },
  ],
};

function koshigayaStdHomecare(month) {
  if (month < 6) return 0;
  if (month >= 24) return 50;
  return Math.round(1 + (50 - 1) * (month - 6) / (24 - 6));
}

const koshigayaOptimisticSettings = {
  costRatio: 0.6525,
  regionalSupport: 0,
  regionalStartMonth: 999,
  rent: 440000,
  otherCostRatio: 0.08,
  baseConcentration: 100,
  concentrationDecay: 0,
  staffOutpatientList: [
    { typeIdx: 0, count: 1 },
    { typeIdx: 1, count: 4 },
    { typeIdx: 3, count: 1 },
    { typeIdx: 5, count: 1 },
  ],
  staffHomecareList: [],
};

const koshigayaDoc = {
  name: "越谷（南越谷）",
  master: { ...master },
  staffTypes: JSON.parse(JSON.stringify(staffTypes)),
  investment: koshigayaInvestment,
  scenarios: [
    {
      name: "楽観",
      settings: koshigayaOptimisticSettings,
      months: buildMonths(() => 1430, () => 0, koshigayaOptimisticSettings),
    },
    {
      name: "標準",
      settings: koshigayaStandardSettings,
      months: buildMonths(() => 900, koshigayaStdHomecare, koshigayaStandardSettings),
    },
    {
      name: "保守",
      settings: koshigayaConservativeSettings,
      months: buildMonths(() => 900, () => 0, koshigayaConservativeSettings),
    },
  ],
  updatedAt: new Date(),
  updatedBy: "claude-code@seed",
};

// --- 清瀬 ---
const kiyoseInvestment = {
  equipment: [
    { label: "分包機類", value: 8000000 },
    { label: "内装費（スケルトン）", value: 10000000 },
  ],
  working: [
    { label: "運転資金（人件費）", value: 2112000 },
    { label: "運転資金（固定費）", value: 222000 },
    { label: "運転資金（売掛金）", value: 6585000 },
    { label: "テナント初期費用", value: 3556200 },
    { label: "行政申請", value: 100000 },
  ],
  depreciationMonths: 120,
};

const kiyoseConservativeSettings = {
  costRatio: 0.6525,
  regionalSupport: 0,
  regionalStartMonth: 999,
  rent: 473000,
  otherCostRatio: 0.08,
  baseConcentration: 100,
  concentrationDecay: 0,
  staffOutpatientList: [
    { typeIdx: 0, count: 1 },
    { typeIdx: 1, count: 1 },
    { typeIdx: 5, count: 1 },
  ],
  staffHomecareList: [],
};

const kiyoseStandardSettings = {
  costRatio: 0.6525,
  regionalSupport: 281600,
  regionalStartMonth: 29,
  rent: 473000,
  otherCostRatio: 0.08,
  baseConcentration: 100,
  concentrationDecay: 0.185,
  staffOutpatientList: [
    { typeIdx: 0, count: 1 },
    { typeIdx: 1, count: 1 },
    { typeIdx: 5, count: 1 },
  ],
  staffHomecareList: [
    { typeIdx: 4, count: 1, startMonth: 14 },
  ],
};

function kiyoseStdHomecare(month) {
  if (month < 3) return 0;
  if (month >= 48) return 100;
  return Math.round((month - 3) / (48 - 3) * 100);
}

const kiyoseOptimisticSettings = {
  costRatio: 0.6525,
  regionalSupport: 512000,
  regionalStartMonth: 1,
  rent: 473000,
  otherCostRatio: 0.08,
  baseConcentration: 50,
  concentrationDecay: 0,
  staffOutpatientList: [
    { typeIdx: 0, count: 1 },
    { typeIdx: 1, count: 1 },
    { typeIdx: 2, count: 1 },
    { typeIdx: 3, count: 2 },
    { typeIdx: 5, count: 2 },
  ],
  staffHomecareList: [
    { typeIdx: 4, count: 1, startMonth: 15 },
  ],
};

function kiyoseOptHomecare(month) {
  if (month < 15) return 0;
  return Math.round((month - 15) / (48 - 15) * 50);
}

const kiyoseDoc = {
  name: "清瀬",
  master: { ...master },
  staffTypes: JSON.parse(JSON.stringify(staffTypes)),
  investment: kiyoseInvestment,
  scenarios: [
    {
      name: "楽観",
      settings: kiyoseOptimisticSettings,
      months: buildMonths(() => 1600, kiyoseOptHomecare, kiyoseOptimisticSettings),
    },
    {
      name: "標準",
      settings: kiyoseStandardSettings,
      months: buildMonths(() => 880, kiyoseStdHomecare, kiyoseStandardSettings),
    },
    {
      name: "保守",
      settings: kiyoseConservativeSettings,
      months: buildMonths(() => 880, () => 0, kiyoseConservativeSettings),
    },
  ],
  updatedAt: new Date(),
  updatedBy: "claude-code@seed",
};

// =============================================================
// Main
// =============================================================
async function seed() {
  console.log("Getting Google access token...");
  const googleToken = await getGoogleAccessToken();

  console.log("Signing into Firebase with Google...");
  const idToken = await signInWithGoogle(googleToken);

  console.log("Writing to Firestore...");
  const id1 = await createDocument("store_simulations", koshigayaDoc, idToken);
  console.log(`OK: 越谷（南越谷） -> ${id1}`);

  const id2 = await createDocument("store_simulations", kiyoseDoc, idToken);
  console.log(`OK: 清瀬 -> ${id2}`);

  console.log("Done. 2 documents created.");
}

seed().catch(e => { console.error(e); process.exit(1); });

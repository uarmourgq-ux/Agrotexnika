const express = require("express");
const multer = require("multer");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.set("trust proxy", true);
app.use(express.json());

// ---------- Sozlamalar ----------
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const FILES_DIR = path.join(DATA_DIR, "files");
const INDEX_FILE = path.join(DATA_DIR, "index.json");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");

fs.mkdirSync(FILES_DIR, { recursive: true });
if (!fs.existsSync(INDEX_FILE)) fs.writeFileSync(INDEX_FILE, "[]");

// ---------- Oddiy fayl-storage ----------
function readIndex() {
  try {
    return JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
  } catch (e) {
    return [];
  }
}
function writeIndex(list) {
  fs.writeFileSync(INDEX_FILE, JSON.stringify(list, null, 2));
}
function newId() {
  return crypto.randomBytes(5).toString("hex"); // 10 ta belgi
}
function itemType(item) {
  return item && item.type === "html" ? "html" : "pdf"; // eski yozuvlar PDF hisoblanади
}
function filePath(id, type = "pdf") {
  return path.join(FILES_DIR, id + (type === "html" ? ".html" : ".pdf"));
}
function demoMarkedHtml(buffer) {
  let html = buffer.toString("utf8");
  const banner = `<div id="demo-document-warning" style="position:sticky;top:0;z-index:2147483647;background:#7f1d1d;color:#fff;text-align:center;padding:10px 12px;font:700 14px/1.4 Arial,sans-serif;letter-spacing:.3px;border-bottom:3px solid #fecaca">НАМУНА — РАСМИЙ ҲУЖЖАТ ЭМАС</div>`;
  if (!/<html[\s>]/i.test(html)) html = `<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`;
  if (/<body[^>]*>/i.test(html)) html = html.replace(/<body([^>]*)>/i, (m) => m + banner);
  else html = html.replace(/<html([^>]*)>/i, (m) => m + `<body>${banner}`);
  return Buffer.from(html, "utf8");
}
// Qator + fayl bor-yo'qligi
function findRow(id) {
  const list = readIndex();
  const item = list.find((f) => f.id === id);
  if (!item) return null;
  const type = itemType(item);
  const file = filePath(item.id, type);
  return { list, item, type, file, hasFile: fs.existsSync(file) };
}

// QR ichiga yoziladigan manzil
function baseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  return proto + "://" + req.get("host");
}

// Fayl nomini header uchun xavfsiz qilish
function cd(type, name) {
  const ascii = name.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "");
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// Multer nomni latin1 berib qo'yadi — UTF-8 ga qaytaramiz
function utf8Name(originalname) {
  return Buffer.from(originalname, "latin1").toString("utf8");
}

// ---------- Parol (faqat admin uchun) ----------
function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const [type, value] = header.split(" ");
  if (type === "Basic" && value) {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    const pass = decoded.slice(decoded.indexOf(":") + 1);
    if (pass === ADMIN_PASSWORD) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Admin"');
  res.status(401).send("Parol talab qilinadi");
}

// ---------- Fayl yuklash ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const ok = ext === ".pdf" || ext === ".html" || ext === ".htm";
    cb(ok ? null : new Error("Faqat PDF yoki HTML fayl yuklash mumkin"), ok);
  },
});

// ---------- PDF.js fayllari (/vendor) ----------
// Telefonda PDF yuklab olinmasdan, brauzerning o'zida ko'rinishi uchun
const PDFJS_DIR = path.dirname(require.resolve("pdfjs-dist/package.json"));
const oneYear = { maxAge: "365d", immutable: true };
app.use("/vendor", express.static(path.join(PDFJS_DIR, "legacy", "build"), oneYear));
app.use("/vendor/cmaps", express.static(path.join(PDFJS_DIR, "cmaps"), oneYear));
app.use(
  "/vendor/standard_fonts",
  express.static(path.join(PDFJS_DIR, "standard_fonts"), oneYear)
);

// ==========================================================
//  ADMIN QISMI — parol bilan
// ==========================================================
app.get("/", auth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// Ro'yxat
app.get("/api/files", auth, (req, res) => {
  const base = baseUrl(req);
  res.json(
    readIndex().map((f) => ({
      id: f.id,
      name: f.name,
      size: f.size || 0,
      created: f.created,
      type: itemType(f),
      hasFile: fs.existsSync(filePath(f.id, itemType(f))),
      url: `${base}/p/${f.id}`,
    }))
  );
});

// Bo'sh qator (uyacha) qo'shish — QR darhol tayyor bo'ladi, PDF keyin yuklanadi
app.post("/api/rows", auth, (req, res) => {
  const list = readIndex();
  const name = String((req.body && req.body.name) || "").trim();
  const item = {
    id: newId(),
    name: name || "Маълумотнома " + (list.length + 1),
    size: 0,
    created: new Date().toISOString(),
  };
  list.push(item);
  writeIndex(list);
  res.json({ ok: true, id: item.id });
});

// Bir nechta PDF birdan — har biriga yangi qator
app.post("/api/upload", auth, upload.array("files", 10), (req, res) => {
  const list = readIndex();
  let added = 0;
  for (const file of req.files || []) {
    const id = newId();
    const ext = path.extname(file.originalname).toLowerCase();
    const type = ext === ".html" || ext === ".htm" ? "html" : "pdf";
    const stored = type === "html" ? demoMarkedHtml(file.buffer) : file.buffer;
    fs.writeFileSync(filePath(id, type), stored);
    list.push({
      id,
      type,
      name: utf8Name(file.originalname),
      size: stored.length,
      created: new Date().toISOString(),
    });
    added++;
  }
  writeIndex(list);
  res.json({ ok: true, added });
});

// Bitta qatorga PDF yoki HTML yuklash/almashtirish — QR o'zgarmaydi
function saveUploadedFile(req, res) {
  const row = findRow(req.params.id);
  if (!row) return res.status(404).json({ error: "Қатор топилмади" });
  if (!req.file) return res.status(400).json({ error: "Файл танланмаган" });
  const ext = path.extname(req.file.originalname).toLowerCase();
  const type = ext === ".html" || ext === ".htm" ? "html" : "pdf";
  const stored = type === "html" ? demoMarkedHtml(req.file.buffer) : req.file.buffer;
  // Remove old extension variant so a row never has two active document types.
  for (const oldType of ["pdf", "html"]) {
    try { fs.unlinkSync(filePath(row.item.id, oldType)); } catch (e) {}
  }
  fs.writeFileSync(filePath(row.item.id, type), stored);
  row.item.type = type;
  row.item.name = utf8Name(req.file.originalname);
  row.item.size = stored.length;
  writeIndex(row.list);
  res.json({ ok: true, name: row.item.name, type });
}
app.post("/api/files/:id/file", auth, upload.single("file"), saveUploadedFile);
// Old clients may continue to use this endpoint for PDFs.
app.post("/api/files/:id/pdf", auth, upload.single("file"), (req, res) => {
  if (req.file && !/\.pdf$/i.test(req.file.originalname)) {
    return res.status(400).json({ error: "Бу манзил орқали фақат PDF юкланади" });
  }
  return saveUploadedFile(req, res);
});

// Qator nomini o'zgartirish
app.patch("/api/files/:id", auth, (req, res) => {
  const row = findRow(req.params.id);
  if (!row) return res.status(404).json({ error: "Топилмади" });
  const name = String((req.body && req.body.name) || "").trim();
  if (!name) return res.status(400).json({ error: "Ном бўш" });
  row.item.name = name;
  writeIndex(row.list);
  res.json({ ok: true });
});

// Qatorni (PDF + QR) o'chirish
app.delete("/api/files/:id", auth, (req, res) => {
  const list = readIndex();
  const i = list.findIndex((f) => f.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: "Топилмади" });
  const [item] = list.splice(i, 1);
  for (const type of ["pdf", "html"]) {
    try { fs.unlinkSync(filePath(item.id, type)); } catch (e) {}
  }
  writeIndex(list);
  res.json({ ok: true });
});

// ==========================================================
//  OCHIQ QISM — parolsiz (QR shu yerga olib boradi)
// ==========================================================

function infoPage(res, code, title, text) {
  res
    .status(code)
    .send(
      '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<div style="font-family:system-ui,sans-serif;text-align:center;padding:48px 24px;color:#333">' +
        "<h2>" + title + "</h2><p>" + text + "</p></div>"
    );
}

// QR-kod rasmi (PDF hali yuklanmagan bo'lsa ham ishlaydi)
app.get("/qr/:id", async (req, res) => {
  const id = req.params.id.replace(/\.png$/i, "");
  const row = findRow(id);
  if (!row) return res.status(404).send("Топилмади");
  try {
    const png = await QRCode.toBuffer(`${baseUrl(req)}/p/${id}`, {
      width: 600,
      margin: 2,
      errorCorrectionLevel: "M",
    });
    res.type("png");
    if (req.query.download) {
      const base = row.item.name.replace(/\.(pdf|html?)$/i, "");
      res.set("Content-Disposition", cd("attachment", `QR-${base}.png`));
    }
    res.send(png);
  } catch (e) {
    res.status(500).send("QR яратишда хатолик");
  }
});

// QR shu manzilga olib boradi — PDF.js ko'ruvchisi bilan sahifa ochiladi
app.get("/p/:id", (req, res) => {
  const row = findRow(req.params.id);
  if (!row) {
    return infoPage(res, 404, "Маълумотнома топилмади", "Бу QR-код эскирган ёки ўчирилган.");
  }
  if (!row.hasFile) {
    return infoPage(res, 404, "Маълумотнома ҳали юкланмаган", "Бу QR-код учун PDF файл кейинроқ юкланади.");
  }
  if (row.type === "html") {
    // Uploaded HTML runs in a restricted sandbox, isolated from the admin app.
    res.set("Content-Security-Policy", "sandbox allow-scripts; default-src 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com; font-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'");
    res.set("X-Content-Type-Options", "nosniff");
    res.type("html");
    return res.sendFile(row.file);
  }
  res.sendFile(path.join(__dirname, "public", "viewer.html"));
});

// Ko'ruvchi uchun fayl nomi
app.get("/info/:id", (req, res) => {
  const row = findRow(req.params.id);
  if (!row || !row.hasFile) return res.status(404).json({ error: "Топилмади" });
  res.json({ id: row.item.id, name: row.item.name, type: row.type });
});

// PDF faylning o'zi (ko'ruvchi shundan o'qiydi; ?download=1 — yuklab olish)
app.get("/f/:id", (req, res) => {
  const row = findRow(req.params.id);
  if (!row || !row.hasFile) {
    return infoPage(res, 404, "Маълумотнома топилмади", "Файл ўчирилган ёки ҳали юкланмаган.");
  }
  if (row.type === "html") {
    res.set("Content-Security-Policy", "sandbox allow-scripts; default-src 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com; font-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'");
    res.set("X-Content-Type-Options", "nosniff");
    res.type("html");
    if (req.query.download) return res.set("Content-Disposition", cd("attachment", row.item.name)).sendFile(row.file);
    return res.sendFile(row.file);
  }
  res.type("application/pdf");
  res.set("Content-Disposition", cd(req.query.download ? "attachment" : "inline", row.item.name));
  res.sendFile(row.file);
});

app.get("/healthz", (req, res) => res.send("ok"));

// Xatoliklar
app.use((err, req, res, next) => {
  res.status(400).json({ error: err.message || "Хатолик" });
});

app.listen(PORT, () => console.log("Server ишлаяпти: порт " + PORT));

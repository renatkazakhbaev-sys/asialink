/* Принимает новые посты из Telegram-канала и добавляет товары в каталог (Firestore, документ meta/catalog). */
let _db;
function getDb() {
  if (_db) return _db;
  const admin = require("firebase-admin");
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FB_PROJECT_ID,
        clientEmail: process.env.FB_CLIENT_EMAIL,
        privateKey: (process.env.FB_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
      }),
    });
  }
  _db = admin.firestore();
  return _db;
}

const LABELS = {
  name: ["название", "name"],
  cat: ["категория", "category"],
  price: ["цена", "price"],
  old: ["старая цена", "old"],
  desc: ["описание", "description"],
  tags: ["теги", "tags", "ключевые слова"],
  badge: ["метка", "badge"],
  stock: ["остаток", "stock"],
};

function parse(text) {
  const out = {};
  let cur = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const m = raw.match(/^\s*([^:：\n]{2,20})\s*[:：]\s*(.*)$/);
    if (m) {
      const lab = m[1].trim().toLowerCase();
      const key = Object.keys(LABELS).find((k) => LABELS[k].includes(lab));
      if (key) { cur = key; out[key] = m[2].trim(); continue; }
    }
    if (cur === "desc" && raw.trim()) out.desc += "\n" + raw.trim();
  }
  return out;
}

/* "45 ¥" -> сумы по курсу и наценке; "150 000 сум" -> как есть */
function parseMoney(s, env) {
  if (!s) return 0;
  const clean = String(s).replace(/\s/g, "").replace(",", ".");
  const num = parseFloat((clean.match(/[\d.]+/) || [])[0]);
  if (!(num > 0)) return 0;
  if (/сум|so'?m|uzs/i.test(clean)) return Math.round(num);
  const rate = parseFloat(env.CNY_TO_UZS);
  const mk = parseFloat(env.MARKUP_PERCENT || "0") || 0;
  if (!(rate > 0)) return 0;
  return Math.round((num * rate * (1 + mk / 100)) / 1000) * 1000;
}

function choosePhoto(sizes) {
  const ok = sizes.filter((s) => s.width <= 1000);
  return (ok.length ? ok[ok.length - 1] : sizes[0]).file_id;
}

async function notify(text) {
  const chat = process.env.OWNER_CHAT_ID;
  if (!chat || !process.env.BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text }),
    });
  } catch (e) { console.error("notify failed", e); }
}

/* CHANNEL можно писать как @name, name, t.me/name или https://t.me/name — всё приводим к виду name */
const normChannel = (v) => String(v || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^t\.me\//, "").replace(/^@/, "");

function allowedChat(chat) {
  const want = normChannel(process.env.CHANNEL);
  if (!want) return false; // без настройки CHANNEL не принимаем ничего
  return String(chat.id) === want || (!!chat.username && chat.username.toLowerCase() === want);
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 200, body: "ok" };
  if (!process.env.WEBHOOK_SECRET || event.headers["x-telegram-bot-api-secret-token"] !== process.env.WEBHOOK_SECRET) {
    console.log("REJECTED: secret_token не совпадает с WEBHOOK_SECRET");
    return { statusCode: 401, body: "unauthorized" };
  }

  let u;
  try { u = JSON.parse(event.body); } catch (e) { return { statusCode: 200, body: "bad json" }; }
  const m = u.channel_post || u.edited_channel_post;
  const isEdit = !u.channel_post && !!u.edited_channel_post;
  if (!m) { console.log("SKIP: это не пост канала, ключи обновления:", Object.keys(u).join(",")); return { statusCode: 200, body: "skip" }; }
  if (!allowedChat(m.chat)) {
    console.log("SKIP: канал не совпадает. Пришло: id=" + m.chat.id + " username=" + (m.chat.username || "нет") + "; в CHANNEL записано: " + (process.env.CHANNEL || "(пусто)"));
    return { statusCode: 200, body: "skip" };
  }

  const text = m.caption || m.text || "";
  const f = parse(text);
  const id = m.media_group_id ? "g" + m.media_group_id : "m" + m.message_id;
  let result;

  try {
    const db = getDb();
    const ref = db.doc("meta/catalog");
    result = await db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      let items = (snap.exists && snap.data().items) || [];
      let it = items.find((x) => x.id === id);
      if (!it) { it = { id, photos: [], created: (m.date || Math.floor(Date.now() / 1000)) * 1000 }; items.push(it); }

      if (m.photo && m.photo.length) {
        const fid = choosePhoto(m.photo);
        // при редактировании одиночного поста фото заменяется на новое
        if (isEdit && !m.media_group_id) it.photos = [fid];
        else if (!it.photos.includes(fid)) it.photos.push(fid);
      }
      if (f.name) it.name = f.name.slice(0, 120);
      if (f.cat) it.cat = f.cat.slice(0, 40);
      if (f.desc !== undefined) it.desc = f.desc.slice(0, 1500);
      if (f.tags !== undefined) it.tags = f.tags.slice(0, 300);
      if (f.badge !== undefined) it.badge = f.badge.slice(0, 20);
      if (f.stock !== undefined) it.stock = parseInt(f.stock, 10) || 0;
      if (f.price !== undefined) it.price = parseMoney(f.price, process.env);
      if (f.old !== undefined) it.old = parseMoney(f.old, process.env);

      // чистим «пустышки» (фото без подписи) старше суток
      const now = Date.now();
      items = items.filter((x) => x.name || now - (x.created || now) < 864e5);
      t.set(ref, { items, updatedAt: now });
      return { name: it.name, price: it.price, hasFields: !!f.name || f.price !== undefined };
    });
  } catch (e) {
    console.error("write failed", e);
    await notify("⚠️ Не удалось сохранить товар на сайт: " + (e.message || e));
    return { statusCode: 200, body: "error" };
  }

  console.log((isEdit ? "EDIT " : "NEW ") + "SAVED:", JSON.stringify(result));
  if (result.hasFields) {
    if (result.name && result.price > 0) await notify(`✅ На сайте: ${result.name} — ${result.price.toLocaleString("ru-RU")} сум`);
    else if (result.name) await notify(`⚠️ «${result.name}» не показан на сайте: не удалось определить цену. Проверьте строку «Цена:» (например 45 ¥ или 150000 сум) и курс CNY_TO_UZS.`);
  }
  return { statusCode: 200, body: "ok" };
};

exports._parse = parse;
exports._parseMoney = parseMoney;
exports._choosePhoto = choosePhoto;

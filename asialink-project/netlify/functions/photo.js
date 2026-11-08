/* Отдаёт фото товара из Telegram, не раскрывая токен бота.
   /.netlify/functions/photo?id=FILE_ID   — фото
   /.netlify/functions/photo?test=1       — проверка токена бота (покажет логин бота или ошибку) */
const TYPES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

const json = (code, obj) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  body: JSON.stringify(obj),
});

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const token = (process.env.BOT_TOKEN || "").trim().replace(/^["']|["']$/g, "");
  if (!token) return json(500, { error: "BOT_TOKEN не задан или не подхватился. Проверьте переменную в Netlify и сделайте Deploys → Trigger deploy → Deploy site." });

  try {
    if (q.test) {
      const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const j = await r.json();
      return json(200, j.ok ? { ok: true, bot: j.result.username } : { ok: false, telegram_error: j.description });
    }

    const id = q.id;
    if (!id || id.length > 300) return json(400, { error: "нужен параметр id" });

    const r = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(id)}`);
    const j = await r.json();
    if (!j.ok || !j.result || !j.result.file_path) return json(404, { error: "getFile: " + (j.description || "нет file_path") });

    const path = j.result.file_path;
    const f = await fetch(`https://api.telegram.org/file/bot${token}/${path}`);
    if (!f.ok) return json(404, { error: "скачивание файла: HTTP " + f.status });

    const buf = Buffer.from(await f.arrayBuffer());
    const ext = (path.split(".").pop() || "jpg").toLowerCase();
    return {
      statusCode: 200,
      headers: {
        "Content-Type": TYPES[ext] || "image/jpeg",
        "Cache-Control": "public, max-age=31536000, immutable",
        "Netlify-CDN-Cache-Control": "public, s-maxage=31536000, immutable",
      },
      body: buf.toString("base64"),
      isBase64Encoded: true,
    };
  } catch (e) {
    console.error(e);
    return json(502, { error: "ошибка функции: " + (e.message || e) });
  }
};

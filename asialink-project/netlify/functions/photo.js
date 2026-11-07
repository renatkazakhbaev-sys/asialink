/* Отдаёт фото товара из Telegram, не раскрывая токен бота. Использование: /.netlify/functions/photo?id=FILE_ID */
const TYPES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

exports.handler = async (event) => {
  const id = (event.queryStringParameters || {}).id;
  const token = process.env.BOT_TOKEN;
  if (!id || id.length > 300 || !token) return { statusCode: 400, body: "bad request" };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(id)}`);
    const j = await r.json();
    if (!j.ok || !j.result || !j.result.file_path) return { statusCode: 404, body: "not found" };
    const path = j.result.file_path;
    const f = await fetch(`https://api.telegram.org/file/bot${token}/${path}`);
    if (!f.ok) return { statusCode: 404, body: "not found" };
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
    return { statusCode: 502, body: "error" };
  }
};

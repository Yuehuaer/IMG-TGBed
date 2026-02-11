/**
 * 批量轉存接口：接收外部圖片 URL，由 Telegram Bot 抓取後寫入 KV，供 /list 管理
 * 僅處理 POST；鑒權：?pwd= 或 Authorization 需等於 env.BASIC_PASS
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...headers },
  });
}

function errResponse(message, status) {
  return jsonResponse({ error: message }, status);
}

/** 從請求中取得密碼：URL 參數 pwd 或 Header Authorization (Bearer) */
function getPassword(request) {
  const url = new URL(request.url);
  const pwd = url.searchParams.get("pwd");
  if (pwd != null && pwd !== "") return pwd;
  const auth = request.headers.get("Authorization");
  if (auth && auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return null;
}

/** 鑒權：必須等於 env.BASIC_PASS */
function checkAuth(request, env) {
  if (env.BASIC_PASS == null || env.BASIC_PASS === "") return true;
  const pwd = getPassword(request);
  return pwd === env.BASIC_PASS;
}

/** 從 URL 推斷圖片副檔名，預設 .jpg */
function getExtensionFromUrl(urlStr) {
  try {
    const path = new URL(urlStr).pathname;
    const m = path.match(/\.([a-z0-9]+)$/i);
    if (m) return m[1].toLowerCase();
  } catch (_) {}
  return "jpg";
}

/** 從 TG sendPhoto 返回的 result 中取 file_id（取 result.photo 中尺寸最大的） */
function getFileIdFromPhoto(result) {
  if (!result || !result.photo || !Array.isArray(result.photo) || result.photo.length === 0)
    return null;
  const largest = result.photo.reduce((prev, cur) =>
    (prev && (prev.file_size || 0) > (cur.file_size || 0)) ? prev : cur
  );
  return largest.file_id;
}

/** 從同一 result.photo 取 file_size（可選） */
function getFileSizeFromPhoto(result) {
  if (!result || !result.photo || !Array.isArray(result.photo) || result.photo.length === 0)
    return 0;
  const largest = result.photo.reduce((prev, cur) =>
    (prev && (prev.file_size || 0) > (cur.file_size || 0)) ? prev : cur
  );
  return largest.file_size || 0;
}

/** 生成隨機文件名（當無 title 時） */
function randomFileName(ext) {
  const id = Math.random().toString(36).slice(2, 10);
  return `image_${id}.${ext}`;
}

/**
 * 單條：調用 sendPhoto(photo=url)，解析 file_id，寫入 KV，返回新圖床鏈接或錯誤
 */
async function processOne(item, env, baseUrl) {
  const { url: imageUrl, title } = item;
  if (!imageUrl || typeof imageUrl !== "string") {
    return { url: imageUrl, success: false, error: "missing or invalid url" };
  }

  const apiUrl = `https://api.telegram.org/bot${env.TG_Bot_Token}/sendPhoto`;
  const body = new URLSearchParams({
    chat_id: String(env.TG_Chat_ID),
    photo: imageUrl.trim(),
    caption: title != null ? String(title).slice(0, 1024) : "",
  });

  let res;
  try {
    res = await fetch(apiUrl, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  } catch (e) {
    return { url: imageUrl, success: false, error: e.message || "network error" };
  }

  let data;
  try {
    data = await res.json();
  } catch (_) {
    return { url: imageUrl, success: false, error: "invalid response from Telegram" };
  }

  if (!data.ok || !data.result) {
    const desc = data.description || "Telegram API error";
    return { url: imageUrl, success: false, error: desc };
  }

  const result = data.result;
  const fileId = getFileIdFromPhoto(result);
  if (!fileId) {
    return { url: imageUrl, success: false, error: "no file_id in response" };
  }

  const ext = getExtensionFromUrl(imageUrl);
  const kvKey = `${fileId}.${ext}`;
  const fileName = (title != null && String(title).trim()) ? String(title).trim() : randomFileName(ext);
  const fileSize = getFileSizeFromPhoto(result);
  const messageId = result.message_id;

  if (env.img_url) {
    const metadata = {
      TimeStamp: Date.now(),
      ListType: "None",
      Label: "None",
      liked: false,
      fileName,
      fileSize,
      storageType: "telegram",
      telegramMessageId: messageId,
    };
    await env.img_url.put(kvKey, "", { metadata });
  }

  const newLink = `${baseUrl}/file/${kvKey}`;
  return { url: imageUrl, success: true, src: newLink, fileName };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!checkAuth(request, env)) {
    return errResponse("Unauthorized", 401);
  }

  if (!env.TG_Bot_Token || !env.TG_Chat_ID) {
    return errResponse("TG_Bot_Token or TG_Chat_ID not configured", 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return errResponse("Invalid JSON body", 400);
  }

  const list = body?.list;
  if (!Array.isArray(list) || list.length === 0) {
    return errResponse("body must be { list: [ { url, title? } ] } with at least one item", 400);
  }

  const url = new URL(request.url);
  const baseUrl = url.origin;
  const results = [];

  for (const item of list) {
    const one = await processOne(item, env, baseUrl);
    results.push(one);
  }

  return jsonResponse({ results });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: { ...CORS_HEADERS, "Access-Control-Max-Age": "86400" },
  });
}

/**
 * 列出 img_url KV 中所有圖片/文件的 JSON 列表
 * 校驗：URL 參數 ?pwd= 需等於 env.BASIC_PASS
 * 支持 cursor 分頁，並發獲取每個 key 的元數據
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const LIST_PAGE_SIZE = 1000; // KV list() 單次最多 1000
const BATCH_SIZE = 50;       // 並發 getWithMetadata 每批數量，避免過多並發

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...headers },
  });
}

function errResponse(message, status) {
  return jsonResponse({ error: message }, status);
}

/** 用 cursor 遍歷 KV list，收集本頁所有 key 名稱 */
async function listAllKeys(kv, cursor = undefined) {
  const keys = [];
  let nextCursor = cursor;
  do {
    const result = await kv.list({ limit: LIST_PAGE_SIZE, cursor: nextCursor });
    for (const k of result.keys) keys.push(k.name);
    nextCursor = result.list_complete ? null : result.cursor;
  } while (nextCursor);
  return keys;
}

/** 單個 key 取元數據並組成一條記錄 */
function buildItem(origin, keyName, metadata, valueText) {
  let extra = {};
  if (valueText && valueText.trim()) {
    try {
      extra = JSON.parse(valueText);
    } catch (_) {}
  }
  const m = metadata || {};
  const url = `${origin}/file/${encodeURIComponent(keyName)}`;
  const fileName = m.fileName || extra.fileName || keyName;
  const uploadTime = m.TimeStamp != null ? m.TimeStamp : (extra.uploadTime ?? extra.TimeStamp ?? null);
  return {
    key: keyName,
    url,
    fileName,
    uploadTime: uploadTime != null ? (typeof uploadTime === 'number' ? uploadTime : parseInt(uploadTime, 10)) : null,
    ...(m.storageType && { storageType: m.storageType }),
  };
}

/** 分批並發執行 getWithMetadata */
async function fetchAllWithMetadata(kv, keyNames) {
  const results = [];
  for (let i = 0; i < keyNames.length; i += BATCH_SIZE) {
    const batch = keyNames.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (name) => {
        const r = await kv.getWithMetadata(name, { type: "text" });
        return { name, value: r?.value ?? null, metadata: r?.metadata ?? null };
      })
    );
    results.push(...batchResults);
  }
  return results;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // 安全校驗：?pwd= 必須等於 BASIC_PASS
  const pwd = url.searchParams.get("pwd");
  if (env.BASIC_PASS != null && env.BASIC_PASS !== "") {
    if (pwd !== env.BASIC_PASS) {
      return errResponse("Unauthorized", 401);
    }
  }

  if (!env.img_url) {
    return errResponse("KV namespace img_url not configured", 500);
  }

  try {
    const cursor = url.searchParams.get("cursor") || undefined;
    const keyNames = await listAllKeys(env.img_url, cursor);
    const fetched = await fetchAllWithMetadata(env.img_url, keyNames);
    const origin = url.origin;
    const list = fetched.map(({ name, value, metadata }) =>
      buildItem(origin, name, metadata, value)
    );

    return jsonResponse({
      list,
      total: list.length,
    });
  } catch (e) {
    console.error("list error:", e);
    return errResponse(e.message || "Internal error", 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      "Access-Control-Max-Age": "86400",
    },
  });
}

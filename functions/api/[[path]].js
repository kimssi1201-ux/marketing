const TRACKING_PATTERNS = [
  /^utm_/i, /^_gl$/i, /^fbclid$/i, /^gclid$/i, /^gbraid$/i, /^wbraid$/i,
  /^spm$/i, /^scm$/i, /^searchId$/i, /^traceid$/i, /^clickTrackInfo$/i,
  /^algo_/i, /^aff_/i, /^affect_/i, /^from_page$/i, /^module$/i,
  /^pha_manifest$/i, /^disableNav$/i, /^_immersiveMode$/i, /^sourceType$/i,
];

const PROVIDERS = [
  {
    id: "coupang",
    name: "쿠팡파트너스",
    supported: true,
    matches: (url) => /(^|\.)coupang\.com$/i.test(url.hostname),
    normalize(url) {
      const clean = new URL(url.toString());
      const keep = new Set(["itemId", "vendorItemId"]);
      [...clean.searchParams.keys()].forEach((key) => {
        if (!keep.has(key)) clean.searchParams.delete(key);
      });
      clean.hash = "";
      return clean.toString();
    },
  },
  {
    id: "aliexpress",
    name: "알리익스프레스",
    supported: false,
    matches: (url) => /(^|\.)aliexpress\.com$/i.test(url.hostname),
    normalize(url) {
      const clean = new URL(url.toString());
      const keep = new Set(["productIds"]);
      [...clean.searchParams.keys()].forEach((key) => {
        if (!keep.has(key)) clean.searchParams.delete(key);
      });
      clean.hash = "";
      return clean.toString();
    },
  },
  {
    id: "myrealtrip",
    name: "마이리얼트립",
    supported: false,
    matches: (url) => /(^|\.)myrealtrip\.com$/i.test(url.hostname),
    normalize: genericNormalize,
  },
  {
    id: "tenping",
    name: "텐핑",
    supported: false,
    matches: (url) => /(^|\.)10ping\.kr$/i.test(url.hostname) || /(^|\.)tenping\.kr$/i.test(url.hostname),
    normalize: genericNormalize,
  },
];

function parseUrls(input) {
  return Array.isArray(input)
    ? input.map(String).map((url) => url.trim()).filter(Boolean)
    : String(input || "").split(/\s+/).map((url) => url.trim()).filter(Boolean);
}

function genericNormalize(url) {
  const clean = new URL(url.toString());
  if (/trip\.com$/i.test(clean.hostname)) {
    const keep = new Set(["checkin", "checkout", "adult", "children", "city"]);
    [...clean.searchParams.keys()].forEach((key) => {
      if (!keep.has(key)) clean.searchParams.delete(key);
    });
  } else if (/agoda\./i.test(clean.hostname)) {
    const keep = new Set(["checkIn", "checkOut", "rooms", "adults", "children", "los"]);
    [...clean.searchParams.keys()].forEach((key) => {
      if (!keep.has(key)) clean.searchParams.delete(key);
    });
  } else if (/ohou\.se$/i.test(clean.hostname) || /tstation\.com$/i.test(clean.hostname)) {
    clean.search = "";
  } else {
    [...clean.searchParams.keys()].forEach((key) => {
      if (TRACKING_PATTERNS.some((pattern) => pattern.test(key))) clean.searchParams.delete(key);
    });
  }
  clean.hash = "";
  return clean.toString();
}

function detect(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const provider = PROVIDERS.find((item) => item.matches(url));
    if (provider) {
      return {
        originalUrl: rawUrl,
        provider: provider.id,
        providerName: provider.name,
        supported: provider.supported,
        normalizedUrl: provider.normalize(url),
        reason: provider.supported ? undefined : "변환 API 연결 준비 중입니다. 지금은 정리 기능을 사용할 수 있습니다.",
      };
    }
    return {
      originalUrl: rawUrl,
      provider: "unknown",
      providerName: "미지원",
      supported: false,
      normalizedUrl: genericNormalize(url),
      reason: "공식 변환 대상은 아니지만 추적 파라미터 정리는 가능합니다.",
    };
  } catch {
    return { originalUrl: rawUrl, provider: "unknown", providerName: "잘못된 URL", supported: false, reason: "URL 형식을 확인하세요." };
  }
}

function signedDate() {
  return new Date().toISOString().slice(2, 19).replace(/[-:]/g, "") + "Z";
}

async function hmac(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function coupangAuth(method, pathWithQuery, credentials) {
  if (!credentials?.accessKey || !credentials?.secretKey) throw new Error("쿠팡 Access Key와 Secret Key가 필요합니다.");
  const date = signedDate();
  const signature = await hmac(credentials.secretKey, date + method + pathWithQuery.replace(/\?/g, ""));
  return `CEA algorithm=HmacSHA256, access-key=${credentials.accessKey}, signed-date=${date}, signature=${signature}`;
}

async function coupangFetch(method, path, credentials, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    return await fetch(`https://api-gateway.coupang.com${path}`, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: await coupangAuth(method, path, credentials),
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function verify(provider, credentials) {
  if (provider !== "coupang") return { ok: false, code: "PROVIDER_NOT_READY", message: "이 제휴사는 변환 연결 준비 중입니다." };
  const path = "/v2/providers/affiliate_open_api/apis/openapi/v1/products/search?keyword=%EC%83%9D%EC%88%98&limit=1";
  const res = await coupangFetch("GET", path, credentials);
  return { ok: res.ok, code: res.ok ? "OK" : "VERIFY_FAILED", message: res.ok ? "연결 테스트에 성공했습니다." : "키를 확인하지 못했습니다." };
}

async function convert(provider, urls, credentials, subId) {
  if (provider !== "coupang") {
    return urls.map((originalUrl) => ({ originalUrl, status: "error", code: "PROVIDER_NOT_READY", message: "이 제휴사는 아직 정리 기능만 지원합니다." }));
  }
  const normalized = urls.map((raw) => PROVIDERS[0].normalize(new URL(raw)));
  const body = { coupangUrls: normalized };
  if (subId) body.subId = subId;
  const path = "/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink";
  const res = await coupangFetch("POST", path, credentials, body);
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = payload.message || payload.rMessage || "쿠팡 API 호출에 실패했습니다.";
    return normalized.map((originalUrl) => ({ originalUrl, status: "error", code: "COUPANG_API_ERROR", message }));
  }
  const data = Array.isArray(payload.data) ? payload.data : [];
  return normalized.map((originalUrl) => {
    const item = data.find((entry) => entry.originalUrl === originalUrl || entry.landingUrl === originalUrl) || data.shift();
    return item?.shortenUrl
      ? { originalUrl, status: "ok", shortUrl: item.shortenUrl, landingUrl: item.landingUrl || originalUrl, title: item.productName || "쿠팡 제휴 링크", imageUrl: item.imageUrl }
      : { originalUrl, status: "error", code: "NOT_ELIGIBLE", message: "변환 결과가 없습니다. 미지급 상품이거나 지원되지 않는 URL일 수 있습니다." };
  });
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function onRequest(context) {
  const { request } = context;
  if (request.method === "OPTIONS") return new Response(null, { headers: { "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });
  const url = new URL(request.url);
  if (url.pathname === "/api/health") return json({ ok: true });
  if (request.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  const body = await request.json().catch(() => ({}));
  const urls = parseUrls(body.urls);
  if (url.pathname === "/api/detect") return json({ results: urls.map(detect) });
  if (url.pathname === "/api/clean") return json({ results: urls.map((originalUrl) => {
    try { return { originalUrl, status: "ok", cleanUrl: detect(originalUrl).normalizedUrl }; }
    catch { return { originalUrl, status: "error", code: "INVALID_URL", message: "URL 형식을 확인하세요." }; }
  }) });
  if (url.pathname === "/api/verify") return json(await verify(body.provider, body.credentials || {}));
  if (url.pathname === "/api/convert") return json({ results: await convert(body.provider, urls, body.credentials || {}, body.subId || "") });
  return json({ error: "NOT_FOUND" }, 404);
}

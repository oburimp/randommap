/**
 * 오늘 뭐 먹지 — Places 프록시 (Cloudflare Workers)
 *
 * 클라이언트는 이 워커만 호출합니다. Google API 키는 브라우저에 절대 내려가지 않습니다.
 *
 * 필요한 설정
 *   wrangler secret put GOOGLE_KEY        # Places API (New) 키
 *   [vars] ALLOWED_ORIGINS = "https://내도메인,https://내계정.github.io"
 *
 * 엔드포인트
 *   POST /nearby  {lat,lng}      → 정규화된 식당 목록
 *   GET  /photo?name=places/…    → 구글 CDN 이미지로 302
 *
 * 과금 주의
 *   아래 FIELDS에 평점·리뷰 수·사진·전화번호가 들어 있어 이 요청은
 *   Nearby Search Enterprise SKU로 청구됩니다(무료 한도가 가장 낮은 등급).
 *   필드를 빼면 등급이 내려가지만, 이 앱은 평점 필터가 핵심이라 유지합니다.
 *   대신 좌표를 격자로 반올림해 캐시 적중률을 올려 실제 호출 수를 줄입니다.
 */

const FIELDS = [
  "places.id",
  "places.displayName",
  "places.rating",
  "places.userRatingCount",
  "places.location",
  "places.photos",
  "places.primaryType",
  "places.primaryTypeDisplayName",
  "places.googleMapsUri",
  "places.nationalPhoneNumber",
  "places.currentOpeningHours.openNow",
].join(",");

const SEARCH_RADIUS = 1200; // 클라 슬라이더 최대치보다 넉넉히. 반경 조절은 클라에서 필터링.

// 카페로 분류할 primaryType. 한 번의 호출로 음식점+카페를 같이 받아 category로 나눕니다.
const CAFE_TYPES = new Set([
  "cafe", "coffee_shop", "bakery", "tea_house",
  "dessert_shop", "ice_cream_shop", "donut_shop",
]);
const NEARBY_TTL = 60 * 60; // 1시간. 길게 잡을수록 저렴하지만 "지금 영업 중"이 오래된 값이 됩니다.
const PHOTO_TTL = 60 * 60 * 12;
const PHOTO_NAME = /^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/;

export default {
  async fetch(request, env, ctx) {
    const allowed = (env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const origin = request.headers.get("Origin") || "";
    const ok = allowed.length === 0 || allowed.includes(origin);

    const cors = {
      "Access-Control-Allow-Origin": ok && origin ? origin : allowed[0] || "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (!ok) return json({ error: "origin_not_allowed" }, 403, cors);
    if (!env.GOOGLE_KEY) return json({ error: "key_not_configured" }, 500, cors);

    const url = new URL(request.url);
    try {
      if (url.pathname === "/nearby" && request.method === "POST")
        return await nearby(request, env, ctx, cors);
      if (url.pathname === "/photo" && request.method === "GET")
        return await photo(url, env, ctx, cors);
    } catch (e) {
      return json({ error: "upstream_failed", detail: String(e.message || e) }, 502, cors);
    }
    return json({ error: "not_found" }, 404, cors);
  },
};

const json = (body, status, headers) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
  });

async function nearby(request, env, ctx, cors) {
  const body = await request.json().catch(() => ({}));
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
    return json({ error: "bad_coordinates" }, 400, cors);

  // 좌표를 약 110m 격자로 반올림해 캐시 적중률을 올리고 실제 API 호출을 줄입니다.
  const gLat = lat.toFixed(3);
  const gLng = lng.toFixed(3);
  const cacheKey = new Request(`https://cache.local/nearby/${gLat}/${gLng}`);
  const cache = caches.default;

  const hit = await cache.match(cacheKey);
  if (hit) {
    const out = new Response(hit.body, hit);
    Object.entries(cors).forEach(([k, v]) => out.headers.set(k, v));
    out.headers.set("X-Cache", "HIT");
    return out;
  }

  const res = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": env.GOOGLE_KEY,
      "X-Goog-FieldMask": FIELDS,
    },
    body: JSON.stringify({
      includedTypes: ["restaurant", "cafe", "bakery"],
      maxResultCount: 20,
      languageCode: "ko",
      regionCode: "KR",
      rankPreference: "DISTANCE",
      locationRestriction: {
        circle: { center: { latitude: +gLat, longitude: +gLng }, radius: SEARCH_RADIUS },
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    return json({ error: "places_error", status: res.status, detail: text.slice(0, 400) }, 502, cors);
  }

  const data = await res.json();
  const places = (data.places || []).map((p) => ({
    id: p.id,
    name: p.displayName?.text || "이름 없음",
    category: CAFE_TYPES.has(p.primaryType) ? "cafe" : "food",
    type: p.primaryTypeDisplayName?.text || "음식점",
    rating: p.rating || 0,
    count: p.userRatingCount || 0,
    lat: p.location?.latitude,
    lng: p.location?.longitude,
    open: p.currentOpeningHours?.openNow,
    photo: p.photos?.[0]?.name || null,
    uri: p.googleMapsUri || null,
    tel: p.nationalPhoneNumber || null,
  }));

  const payload = { center: { lat: +gLat, lng: +gLng }, places };
  const stored = new Response(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${NEARBY_TTL}`,
    },
  });
  ctx.waitUntil(cache.put(cacheKey, stored.clone()));

  const out = new Response(stored.body, stored);
  Object.entries(cors).forEach(([k, v]) => out.headers.set(k, v));
  out.headers.set("X-Cache", "MISS");
  return out;
}

async function photo(url, env, ctx, cors) {
  const name = url.searchParams.get("name") || "";
  if (!PHOTO_NAME.test(name)) return json({ error: "bad_photo_name" }, 400, cors);
  const h = Math.min(400, Math.max(80, parseInt(url.searchParams.get("h") || "220", 10)));

  const cacheKey = new Request(`https://cache.local/photo/${encodeURIComponent(name)}/${h}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  let uri = hit ? (await hit.json()).uri : null;

  if (!uri) {
    const res = await fetch(
      `https://places.googleapis.com/v1/${name}/media` +
        `?maxHeightPx=${h}&maxWidthPx=${h}&skipHttpRedirect=true&key=${env.GOOGLE_KEY}`
    );
    if (!res.ok) return json({ error: "photo_error", status: res.status }, 502, cors);
    uri = (await res.json()).photoUri;
    if (!uri) return json({ error: "no_photo_uri" }, 502, cors);
    ctx.waitUntil(
      cache.put(
        cacheKey,
        new Response(JSON.stringify({ uri }), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": `public, max-age=${PHOTO_TTL}`,
          },
        })
      )
    );
  }

  // 이미지 바이트는 워커를 거치지 않고 구글 CDN에서 직접 받게 합니다.
  return new Response(null, {
    status: 302,
    headers: { ...cors, Location: uri, "Cache-Control": `public, max-age=${PHOTO_TTL}` },
  });
}

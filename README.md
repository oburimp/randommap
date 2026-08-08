# 오늘 뭐 먹지 · 반경 룰렛

내 주변 식당을 반경·평점·리뷰 수·종류로 걸러 슬롯머신으로 뽑아 주는 PWA입니다.
Google API 키는 브라우저에 내려가지 않고 Cloudflare Worker 안에만 있습니다.

```
index.html              앱 본체 (여기 맨 위 CONFIG만 채우면 됩니다)
sw.js                   서비스 워커 — 앱 껍데기 캐시, 검색 결과는 캐시하지 않음
manifest.webmanifest    PWA 매니페스트
icon-192.png            아이콘
icon-512.png
icon-maskable-512.png   안드로이드 적응형 아이콘
apple-touch-icon.png    iOS 홈 화면 아이콘
worker.js               Cloudflare Worker — Places 프록시
wrangler.toml           Worker 배포 설정
```

키를 아직 안 만들었어도 그대로 열면 데모 데이터로 전부 동작합니다.

---

## 1. Google Cloud

1. 프로젝트를 만들고 **결제를 사용 설정**합니다. Places API (New)는 결제 계정 없이는 호출이 거부됩니다.
2. **Places API (New)** 를 사용 설정합니다. 지도까지 쓸 거면 **Maps JavaScript API** 도 켭니다.
3. API 키를 두 개 따로 만듭니다. 용도를 섞으면 한쪽을 조일 때 다른 쪽이 같이 막힙니다.

   | 키 | 두는 곳 | 제한 |
   |---|---|---|
   | Places 키 | Worker secret | API 제한 = Places API (New) **만** |
   | Maps 키 (선택) | `index.html`의 `CONFIG.MAPS_KEY` | API 제한 = Maps JavaScript API, HTTP 리퍼러 = 내 도메인 |

   Places 키는 서버에서만 쓰므로 리퍼러 제한을 걸 수 없습니다. 대신 **절대 커밋하지 마세요.**
4. 결제 → 예산 및 알림에서 예산을 걸고 50 / 90 / 100 % 알림을 켭니다. 무료 한도는 자동으로 멈추지 않습니다.

## 2. Worker 배포

```bash
npm i -g wrangler
wrangler login

# wrangler.toml 의 ALLOWED_ORIGINS 를 실제 배포 주소로 바꾼 뒤
wrangler secret put GOOGLE_KEY     # Places 키 붙여넣기
wrangler deploy
```

배포되면 `https://<이름>.<계정>.workers.dev` 주소가 나옵니다. 확인:

```bash
curl -X POST https://<주소>/nearby \
  -H "Origin: https://내도메인" -H "Content-Type: application/json" \
  -d '{"lat":37.5665,"lng":126.9780}'
```

`places` 배열이 오면 성공입니다. `origin_not_allowed`가 오면 `ALLOWED_ORIGINS`에 그 주소를 넣으세요.

## 3. 정적 호스팅

`index.html` 맨 위를 채웁니다.

```js
const CONFIG = {
  PROXY: "https://<이름>.<계정>.workers.dev",
  MAPS_KEY: ""   // 비워 두면 내장 캔버스 지도 (무료)
};
```

그다음 리포지토리 전체를 GitHub Pages나 Cloudflare Pages에 올립니다. **https 필수** — http나 `file://` 로 열면 브라우저가 위치 권한과 서비스 워커를 둘 다 막습니다.

## 4. 비용

호출당 요금이 아니라 **필드마스크가 등급을 정합니다.** 요청에 Essentials와 Pro 필드가 섞이면 더 높은 등급으로 청구됩니다.

이 앱은 평점·리뷰 수·사진·전화번호를 요청하므로 **Nearby Search Enterprise** 로 잡힙니다. 등급별 무료 한도는 월 10,000(Essentials) / 5,000(Pro) / 1,000(Enterprise)이고, 매월 1일 초기화되며 이월되지 않습니다. 2025년 3월부터 예전의 $200 통합 크레딧은 없어졌습니다.

정확한 최신 단가는 Google Maps Platform 요금 페이지에서 확인하세요. 대략 Nearby Search가 1,000콜당 $32(Pro)~$35(Enterprise) 선입니다.

**이 코드가 호출을 줄이는 방법**

- 좌표를 소수점 3자리(약 110m) 격자로 반올림해 캐시 키를 만듭니다. 같은 골목에서 여러 명이 검색해도 1콜입니다.
- Worker 캐시 1시간 + 브라우저 sessionStorage. 반경 슬라이더나 필터를 아무리 만져도 **재검색이 일어나지 않습니다.** 전부 클라이언트에서 거릅니다.
- 구글 사진은 별도 SKU라, 당첨된 한 곳만 불러옵니다. 릴과 목록 썸네일은 이름에서 만들어 낸 이미지라 비용이 0입니다.
- 지도는 기본이 내장 캔버스라 Maps JavaScript API 요금이 발생하지 않습니다.

**조절 손잡이**

`worker.js`의 `NEARBY_TTL`. 길게 잡으면 싸지지만 '지금 영업 중' 값이 그만큼 오래된 정보가 됩니다. 기본 1시간은 그 절충입니다.

## 5. 무단 사용 막기

Worker에 `ALLOWED_ORIGINS`가 있지만 Origin 헤더는 브라우저 밖에서 위조됩니다. 링크를 널리 뿌릴 거라면 Cloudflare 대시보드에서 이 Worker 경로에 **Rate limiting rule** 을 하나 거세요. IP당 분당 20건 정도면 정상 사용에는 걸리지 않고 스크립트 남용은 막힙니다.

## 6. 한국에서 쓸 때

Google의 한국 식당 평점 커버리지는 카카오·네이버보다 얕습니다. 동네 상권에서 '4.5+'를 걸면 후보가 두세 곳으로 줄어드는 일이 흔합니다.

카카오 로컬 API와 네이버 지역검색 API는 커버리지가 좋지만 **평점을 주지 않습니다.** 평점 기반으로 가는 이상 대안이 없어서, 대신 최소 리뷰 수 필터를 넣었습니다. 리뷰 8개짜리 별 4.8보다 리뷰 300개짜리 별 4.2가 대체로 안전한 선택입니다.

후보가 0이 되면 앱이 어느 조건을 풀면 몇 곳이 나오는지 계산해서 알려 줍니다.

## 7. 배포 전 점검

- [ ] `CONFIG.PROXY` 채움
- [ ] Places 키가 소스 어디에도 없음 (`grep -ri "AIza" .` 로 확인)
- [ ] `ALLOWED_ORIGINS`가 실제 배포 주소와 일치
- [ ] Google Cloud 예산 알림 켜짐
- [ ] https로 접속했을 때 위치 권한 창이 뜸
- [ ] 안드로이드 크롬에서 설치 버튼이 뜸 / iOS는 공유 → 홈 화면에 추가
- [ ] `sw.js` 수정 시 `VERSION` 문자열을 올려야 갱신됨

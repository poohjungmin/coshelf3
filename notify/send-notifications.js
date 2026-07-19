// GitHub Actions 스케줄(15분 주기)로 실행되어, 알림을 켠 기기 중 지금
// 시각이 등록된 알림 시각을 지난 기기를 찾아 Web Push를 보낸다.
// 시간대는 이 앱의 대상 사용자 기준으로 Asia/Seoul(KST) 고정이다.
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const webpush = require("web-push");

// index.html에 커밋된 공개키와 동일한 값 (공개키는 비밀값이 아니다)
const VAPID_PUBLIC_KEY =
  "BK6fdHiu4ODniRLL7orFnYtbHbc6jLMYZXj30oc-YqvEdOpFt-sTHIe4GXTI6k3FBi9XsxsNnaKv4P4TbBVIZBg";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT;

if (!VAPID_PRIVATE_KEY || !VAPID_SUBJECT) {
  throw new Error("VAPID_PRIVATE_KEY / VAPID_SUBJECT 환경변수가 필요합니다.");
}
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  throw new Error("FIREBASE_SERVICE_ACCOUNT 환경변수가 필요합니다.");
}

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
const app = initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore(app);

function kstNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return { dateStr: `${map.year}-${map.month}-${map.day}`, hhmm: `${map.hour}:${map.minute}` };
}

// 클라이언트(index.html)의 computeDday와 동일한 기준(자정 KST)으로 계산한다.
function computeDday(expiryStr, todayDateStr) {
  const expiry = new Date(`${expiryStr}T00:00:00+09:00`);
  const today = new Date(`${todayDateStr}T00:00:00+09:00`);
  return Math.round((expiry.getTime() - today.getTime()) / 86400000);
}

function dDayLabel(day) {
  return day === 0 ? "오늘 소비기한" : `소비기한 ${day}일 전`;
}

async function sendPush(subscription, payload) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return { ok: true };
  } catch (err) {
    return { ok: false, statusCode: err.statusCode };
  }
}

async function processDevice(docSnap) {
  const device = docSnap.data();
  const logPrefix = `[send-notifications] ${docSnap.id}:`;

  if (!device.subscription) {
    console.log(`${logPrefix} 구독 없음 - 건너뜀`);
    return;
  }

  const { dateStr: todayStr, hhmm: nowHHMM } = kstNow();
  // rules: [{ day: 0|1, time: "HH:MM" }] - 시점(하루 전/당일)과 시각이 묶인
  // 규칙 단위. 예전의 days[]×times[] 교차 조합 방식을 대체한다.
  const rules = Array.isArray(device.rules) ? device.rules : [];
  const products = Array.isArray(device.products) ? device.products : [];
  const notifiedRules = { ...(device.notifiedRules || {}) };
  let changed = false;
  let subscriptionExpired = false;

  console.log(
    `${logPrefix} rules=${JSON.stringify(rules)} products=${products.length}개 ` +
      `notifiedRules=${JSON.stringify(notifiedRules)}`
  );

  for (const rule of rules) {
    if (subscriptionExpired) break;
    const ruleKey = `${rule.day}_${rule.time}`;

    if (nowHHMM < rule.time) {
      console.log(`${logPrefix} ${ruleKey} - 아직 안 지남 (현재 ${nowHHMM})`);
      continue;
    }
    if (notifiedRules[ruleKey] === todayStr) {
      console.log(`${logPrefix} ${ruleKey} - 오늘 이미 처리함`);
      continue;
    }

    const matched = products.filter((p) => computeDday(p.expiryDate, todayStr) === rule.day);
    console.log(
      `${logPrefix} ${ruleKey} 처리 중 - 매칭 제품 ${matched.length}개 ` +
        `(제품별 D-day: ${products.map((p) => `${p.brand ?? ""}${p.product ?? ""}=${computeDday(p.expiryDate, todayStr)}`).join(", ")})`
    );

    let shouldMarkDone = true;

    if (matched.length > 0) {
      const firstLabel = [matched[0].brand, matched[0].product].filter(Boolean).join(" ") || "제품";
      const body =
        matched.length === 1
          ? `${firstLabel}의 ${dDayLabel(computeDday(matched[0].expiryDate, todayStr))}입니다.`
          : `${firstLabel} 외 ${matched.length - 1}개 제품의 소비기한이 임박했습니다.`;

      const result = await sendPush(device.subscription, {
        title: "Coshelf 소비기한 알림",
        body,
        url: "./",
      });
      console.log(`${logPrefix} push 발송 결과: ${JSON.stringify(result)}`);

      if (!result.ok) {
        if (result.statusCode === 404 || result.statusCode === 410) {
          // 브라우저/OS에서 이미 만료된 구독 - 다음 앱 실행 때 재구독하도록 비운다.
          // 재구독 전까지는 어차피 보낼 수 없으므로 오늘 처리 완료로 표시한다.
          await docSnap.ref.update({ subscription: null });
          console.log(`${logPrefix} 만료된 구독 정리`);
          subscriptionExpired = true;
        } else {
          // 네트워크 오류 등 일시적 실패로 추정 - 오늘 처리 완료로 표시하지 않아
          // 15분 뒤 다음 실행에서 같은 규칙에 대해 다시 시도하게 한다.
          console.warn(`${logPrefix} ${ruleKey} 발송 실패(일시적으로 추정) - 다음 실행에 재시도`);
          shouldMarkDone = false;
        }
      }
    }

    if (shouldMarkDone) {
      notifiedRules[ruleKey] = todayStr;
      changed = true;
    }
  }

  if (changed) {
    await docSnap.ref.update({ notifiedRules });
  }
}

async function main() {
  const { dateStr: todayStr, hhmm: nowHHMM } = kstNow();
  const snapshot = await db.collection("devices").where("enabled", "==", true).get();
  console.log(`[send-notifications] 활성 기기 ${snapshot.size}개, 현재 KST ${todayStr} ${nowHHMM}`);

  const results = await Promise.allSettled(snapshot.docs.map(processDevice));
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length > 0) {
    failed.forEach((r) => console.error("[send-notifications] 기기 처리 실패:", r.reason));
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[send-notifications] 실행 실패:", e);
    process.exit(1);
  });

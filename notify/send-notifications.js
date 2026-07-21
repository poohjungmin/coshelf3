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

// iOS가 이미 앱 이름(Coshelf)을 알림 상단에 표시해주므로, 제목에 앱 이름을
// 중복해서 넣지 않는다.
const NOTIFICATION_TITLE = "소비기한 알림";

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

// 남은 일수를 자연스러운 문장으로 표현한다("0일 남았습니다" 같은 어색한
// 표현 대신 오늘/내일은 따로, 그 외에는 "N일 남았습니다").
function ddayPhrase(day) {
  if (day === 0) return "오늘까지입니다";
  if (day === 1) return "내일까지입니다";
  return `${day}일 남았습니다`;
}

async function sendPush(subscription, payload) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return { ok: true };
  } catch (err) {
    return { ok: false, statusCode: err.statusCode };
  }
}

// 규칙 기반(소비기한 N일 전) 알림을 처리한다. 성공/실패에 따라 notifiedRules를
// 갱신하고, 구독이 만료됐으면 true를 반환해 이후 처리를 건너뛰게 한다.
async function processRules(docSnap, device, todayStr, nowHHMM, logPrefix) {
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
      const phrase = ddayPhrase(rule.day);
      const body =
        matched.length === 1
          ? `${firstLabel}의 소비기한이 ${phrase}`
          : `${firstLabel} 외 ${matched.length - 1}개 제품의 소비기한이 ${phrase}`;

      const result = await sendPush(device.subscription, {
        title: NOTIFICATION_TITLE,
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
  return { subscriptionExpired };
}

// 소비기한이 지난 제품 요약 알림을 처리한다. 제품별로 여러 건 보내지 않고
// "N개 있습니다" 하나로 요약해서, 지정 시각이 지난 뒤 하루에 한 번만 보낸다.
async function processExpiredSummary(docSnap, device, todayStr, nowHHMM, logPrefix) {
  const es = device.expiredSummary;
  if (!es || !es.enabled || typeof es.time !== "string") {
    return;
  }
  if (device.notifiedExpiredDate === todayStr) {
    console.log(`${logPrefix} 지난 제품 요약 - 오늘 이미 처리함`);
    return;
  }
  if (nowHHMM < es.time) {
    console.log(`${logPrefix} 지난 제품 요약 - 아직 안 지남 (현재 ${nowHHMM}, 설정 ${es.time})`);
    return;
  }

  const products = Array.isArray(device.products) ? device.products : [];
  const expiredCount = products.filter((p) => computeDday(p.expiryDate, todayStr) < 0).length;
  console.log(`${logPrefix} 지난 제품 요약 - 지난 제품 ${expiredCount}개`);

  if (expiredCount === 0) {
    // 보낼 내용이 없으므로 오늘 처리 완료로만 표시하고 끝낸다.
    await docSnap.ref.update({ notifiedExpiredDate: todayStr });
    return;
  }

  const result = await sendPush(device.subscription, {
    title: NOTIFICATION_TITLE,
    body: `소비기한이 지난 제품이 ${expiredCount}개 있습니다.`,
    url: "./",
  });
  console.log(`${logPrefix} 지난 제품 요약 push 발송 결과: ${JSON.stringify(result)}`);

  if (result.ok) {
    await docSnap.ref.update({ notifiedExpiredDate: todayStr });
  } else if (result.statusCode === 404 || result.statusCode === 410) {
    // 구독이 만료됨 - 정리하고, 오늘은 어차피 못 보내니 처리 완료로 표시한다.
    await docSnap.ref.update({ subscription: null, notifiedExpiredDate: todayStr });
    console.log(`${logPrefix} 지난 제품 요약 발송 중 만료된 구독 정리`);
  } else {
    // 네트워크 오류 등 일시적 실패로 추정 - 다음 실행에서 재시도할 수 있도록
    // 오늘 처리 완료로 표시하지 않는다.
    console.warn(`${logPrefix} 지난 제품 요약 발송 실패(일시적으로 추정) - 다음 실행에 재시도`);
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

  const { subscriptionExpired } = await processRules(docSnap, device, todayStr, nowHHMM, logPrefix);
  if (subscriptionExpired) {
    // 구독이 방금 만료 처리됐으면 이번 실행에서는 더 보낼 수 없으니 건너뛴다.
    return;
  }

  await processExpiredSummary(docSnap, device, todayStr, nowHHMM, logPrefix);
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

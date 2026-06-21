const {onRequest} = require("firebase-functions/v2/https");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const {defineSecret} = require("firebase-functions/params");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");
const Stripe = require("stripe");

admin.initializeApp();

const db = admin.firestore();
const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");
const stripeWebhookSecret = defineSecret("STRIPE_WEBHOOK_SECRET");
const dailyWorkerSecret = defineSecret("DAILY_WORKER_SECRET");
const DAILY_ROOM_WORKER = "https://charisma-rooms.bthorpe99.workers.dev";
const FREE_CALL_LIMIT = 4;
const ACCESS_WINDOW_MS = 24 * 60 * 60 * 1000;
const QUEUE_TTL_MS = 10 * 60 * 1000;
const ALLOWED_ORIGINS = new Set(["https://trycharisma.live", "https://www.trycharisma.live"]);

const PRICE_TO_REWARD = {
  membership: {isMember: true, walletDelta: 0, label: "Charisma Membership"},
  grace500: {isMember: false, walletDelta: 500, label: "500 Grace Points"},
  grace1200: {isMember: false, walletDelta: 1200, label: "1,200 Grace Points"},
  grace3000: {isMember: false, walletDelta: 3000, label: "3,000 Grace Points"}
};

const INTEREST_KEYS = {
  "Women": "woman",
  "Men": "man",
  "Nonbinary people": "nonbinary",
  "Trans women": "trans woman",
  "Trans men": "trans man",
  "Gender-fluid people": "gender-fluid",
  "Queer people": "queer",
  "Open to all": "all"
};

const IDENTITY_KEYS = {
  "Woman": "woman",
  "Man": "man",
  "Nonbinary": "nonbinary",
  "Trans woman": "trans woman",
  "Trans man": "trans man",
  "Gender-fluid": "gender-fluid",
  "Queer": "queer"
};

const GIFT_PRICES = {
  "Petal": 50,
  "Candle": 75,
  "Moonlit": 100,
  "Tender": 150,
  "Bouquet": 200,
  "Reserve": 500
};

function getStripe() {
  const key = stripeSecretKey.value();
  if (!key) throw new Error("Missing STRIPE_SECRET_KEY");
  return new Stripe(key, {apiVersion: "2024-06-20"});
}

function cors(req, res) {
  const origin = req.get("origin") || "";
  if (ALLOWED_ORIGINS.has(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
  }
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return true;
  }
  return false;
}

async function requireUser(req) {
  const header = req.get("authorization") || "";
  if (!header.startsWith("Bearer ")) throw Object.assign(new Error("Sign in is required."), {status: 401});
  return admin.auth().verifyIdToken(header.slice(7));
}

function apiError(res, err) {
  const status = err.status || 500;
  if (status >= 500) logger.error(err);
  res.status(status).json({ok: false, error: status >= 500 ? "Something went wrong. Try again." : err.message});
}

function cleanString(value, max = 80) {
  return String(value || "").trim().slice(0, max);
}

function wants(viewer, candidate) {
  const preferences = Array.isArray(viewer.interestedIn) ? viewer.interestedIn : [];
  const identity = IDENTITY_KEYS[candidate.identity] || "";
  if (!preferences.length || !identity) return false;
  return preferences.includes("Open to all") || preferences.some(item => INTEREST_KEYS[item] === identity);
}

function compatible(a, b) {
  return wants(a, b) && wants(b, a);
}

function coarseArea(location) {
  const lat = Number(location && location.lat);
  const lng = Number(location && location.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  // Some desktop browsers report Null Island when location is unavailable.
  if (Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001) return null;
  return {latBucket: Math.round(lat * 10), lngBucket: Math.round(lng * 10)};
}

function nearbyArea(a, b) {
  if (!a || !b) return true;
  return Math.abs(a.latBucket - b.latBucket) <= 1 && Math.abs(a.lngBucket - b.lngBucket) <= 1;
}

function accessState(member, now = Date.now()) {
  const start = member.callWindowStart?.toMillis?.() || 0;
  const reset = !start || now - start >= ACCESS_WINDOW_MS;
  return {
    callsUsed: reset ? 0 : Number(member.callsUsed || 0),
    windowStart: reset ? admin.firestore.Timestamp.fromMillis(now) : member.callWindowStart
  };
}

function canCall(member) {
  if (member.isMember || member.role === "Woman") return true;
  return accessState(member).callsUsed < FREE_CALL_LIMIT;
}

async function requireMatchedPair(uid, targetUid, matchId) {
  if (!targetUid || targetUid === uid || !matchId) {
    throw Object.assign(new Error("A valid live match is required."), {status: 400});
  }
  const match = await db.collection("matches").doc(matchId).get();
  const participants = match.exists && Array.isArray(match.data().participants) ? match.data().participants : [];
  if (!participants.includes(uid) || !participants.includes(targetUid)) {
    throw Object.assign(new Error("That action is not connected to your match."), {status: 403});
  }
}

async function createVideoRoom(room) {
  const response = await fetch(DAILY_ROOM_WORKER, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${dailyWorkerSecret.value()}`
    },
    body: JSON.stringify({room})
  });
  if (!response.ok) throw Object.assign(new Error("Secure video room could not be created."), {status: 503});
  const data = await response.json();
  const urls = Array.isArray(data.urls) ? data.urls : [];
  if (urls.length !== 2 || urls.some(url => !String(url).startsWith("https://trycharisma.daily.co/") || !String(url).includes("?t="))) {
    throw Object.assign(new Error("Video provider returned an invalid room."), {status: 503});
  }
  return urls;
}

function profileFromMember(member) {
  return {
    name: cleanString(member.displayName || "Charisma member", 40),
    role: cleanString(member.role, 20),
    identity: cleanString(member.identity, 30),
    interestedIn: Array.isArray(member.interestedIn) ? member.interestedIn.slice(0, 8) : [],
    orientation: cleanString(member.orientation, 30),
    intent: cleanString(member.intent, 40)
  };
}

async function startMatch(uid, body) {
  const memberRef = db.collection("members").doc(uid);
  const requestRef = db.collection("matchRequests").doc(uid);
  const memberSnap = await memberRef.get();
  if (!memberSnap.exists) throw Object.assign(new Error("Complete your account and profile first."), {status: 409});
  const member = memberSnap.data();
  if (Number(member.age) < 18 || !member.termsAcceptedAt) throw Object.assign(new Error("Confirm that you are 18+ and accept the terms first."), {status: 409});
  if (!canCall(member)) throw Object.assign(new Error("Your four free calls are used. Wait 24 hours or activate membership."), {status: 429});

  const language = cleanString(body.language, 8);
  const region = cleanString(body.region, 60);
  if (!language || !region) throw Object.assign(new Error("Choose a language and region first."), {status: 400});
  const area = coarseArea(body.location);
  const profile = profileFromMember(member);
  if (!profile.identity || !profile.interestedIn.length) throw Object.assign(new Error("Choose your identity and matching preferences first."), {status: 409});

  const waiting = await db.collection("matchRequests").where("status", "==", "waiting").limit(50).get();
  const blocked = new Set(member.blockedUids || []);
  const cutoff = Date.now() - QUEUE_TTL_MS;
  const candidates = waiting.docs
    .filter(doc => doc.id !== uid)
    .map(doc => ({id: doc.id, ref: doc.ref, ...doc.data()}))
    .filter(item => item.language === language && item.region === region)
    .filter(item => (item.updatedAt?.toMillis?.() || 0) >= cutoff)
    .filter(item => !blocked.has(item.id) && !(item.blockedUids || []).includes(uid))
    .filter(item => nearbyArea(area, item.area))
    .filter(item => compatible(profile, item));

  logger.info("match_queue_attempt", {
    waitingCount: waiting.size,
    candidateCount: candidates.length,
    hasUsableLocation: Boolean(area),
    language,
    region
  });

  for (const candidate of candidates) {
    const room = `charisma-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const [selfCallUrl, candidateCallUrl] = await createVideoRoom(room);
    const matchId = `match-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const candidateMemberRef = db.collection("members").doc(candidate.id);
    try {
      await db.runTransaction(async tx => {
        const [candidateRequestSnap, selfMemberSnap, candidateMemberSnap] = await Promise.all([
          tx.get(candidate.ref), tx.get(memberRef), tx.get(candidateMemberRef)
        ]);
        if (!candidateRequestSnap.exists || candidateRequestSnap.data().status !== "waiting") {
          throw Object.assign(new Error("MATCH_TAKEN"), {code: "MATCH_TAKEN"});
        }
        if (!candidateMemberSnap.exists || !canCall(candidateMemberSnap.data()) || !canCall(selfMemberSnap.data())) {
          throw Object.assign(new Error("MATCH_UNAVAILABLE"), {code: "MATCH_TAKEN"});
        }
        const now = admin.firestore.FieldValue.serverTimestamp();
        const common = {matchId, room, language, region, status: "matched", updatedAt: now};
        tx.set(db.collection("matches").doc(matchId), {
          room, language, region, status: "ready", participants: [uid, candidate.id],
          names: {[uid]: profile.name, [candidate.id]: candidate.name || "Nearby match"}, createdAt: now
        });
        tx.set(requestRef, {...common, callUrl: selfCallUrl, uid, matchedUid: candidate.id, name: profile.name, matchedName: candidate.name || "Nearby match"}, {merge: true});
        tx.set(candidate.ref, {...common, callUrl: candidateCallUrl, matchedUid: uid, matchedName: profile.name}, {merge: true});

        [[memberRef, selfMemberSnap.data()], [candidateMemberRef, candidateMemberSnap.data()]].forEach(([ref, data]) => {
          if (data.isMember || data.role === "Woman") return;
          const access = accessState(data);
          tx.set(ref, {callsUsed: access.callsUsed + 1, callWindowStart: access.windowStart, updatedAt: now}, {merge: true});
        });
      });
      return {matched: true, room, callUrl: selfCallUrl, matchedUid: candidate.id, matchedName: candidate.name || "Nearby match"};
    } catch (err) {
      if (err.code !== "MATCH_TAKEN") throw err;
    }
  }

  await requestRef.set({
    uid, ...profile, language, region, area, blockedUids: member.blockedUids || [], status: "waiting",
    createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  return {matched: false};
}

exports.matchApi = onRequest({cors: false, invoker: "public", maxInstances: 20, secrets: [dailyWorkerSecret]}, async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ok: false, error: "Method not allowed."});
  try {
    const user = await requireUser(req);
    const action = cleanString(req.body?.action, 30);
    if (action === "start") {
      if (!user.email_verified) throw Object.assign(new Error("Verify your email before entering live matching."), {status: 403});
      return res.json({ok: true, ...(await startMatch(user.uid, req.body || {}))});
    }
    if (action === "leave") {
      await db.collection("matchRequests").doc(user.uid).set({status: "left", updatedAt: admin.firestore.FieldValue.serverTimestamp()}, {merge: true});
      return res.json({ok: true});
    }
    if (action === "report" || action === "block") {
      const targetUid = cleanString(req.body?.targetUid, 128);
      const matchId = cleanString(req.body?.matchId, 128);
      await requireMatchedPair(user.uid, targetUid, matchId);
      const memberRef = db.collection("members").doc(user.uid);
      const batch = db.batch();
      batch.set(memberRef, {blockedUids: admin.firestore.FieldValue.arrayUnion(targetUid), updatedAt: admin.firestore.FieldValue.serverTimestamp()}, {merge: true});
      batch.set(db.collection("matchRequests").doc(user.uid), {status: "left", updatedAt: admin.firestore.FieldValue.serverTimestamp()}, {merge: true});
      if (action === "report") {
        const reportRef = db.collection("reports").doc();
        batch.set(reportRef, {
          reporterUid: user.uid, targetUid, matchId,
          reason: cleanString(req.body?.reason || "User reported during live call", 500),
          status: "new", createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
      await batch.commit();
      return res.json({ok: true});
    }
    if (action === "sendGift") {
      const targetUid = cleanString(req.body?.targetUid, 128);
      const matchId = cleanString(req.body?.matchId, 128);
      const gift = cleanString(req.body?.gift, 40);
      const price = Number(req.body?.price);
      if (!targetUid || !gift || GIFT_PRICES[gift] !== price) throw Object.assign(new Error("Invalid gift."), {status: 400});
      await requireMatchedPair(user.uid, targetUid, matchId);
      const memberRef = db.collection("members").doc(user.uid);
      await db.runTransaction(async tx => {
        const snap = await tx.get(memberRef);
        if (!snap.exists || Number(snap.data().wallet || 0) < price) throw Object.assign(new Error("Not enough Grace Points."), {status: 409});
        tx.update(memberRef, {wallet: admin.firestore.FieldValue.increment(-price), updatedAt: admin.firestore.FieldValue.serverTimestamp()});
        tx.set(memberRef.collection("giftsSent").doc(), {targetUid, matchId, gift, price, createdAt: admin.firestore.FieldValue.serverTimestamp()});
        tx.set(db.collection("members").doc(targetUid).collection("giftsReceived").doc(), {fromUid: user.uid, matchId, gift, price, createdAt: admin.firestore.FieldValue.serverTimestamp()});
      });
      return res.json({ok: true});
    }
    throw Object.assign(new Error("Unknown action."), {status: 400});
  } catch (err) {
    apiError(res, err);
  }
});

exports.accountApi = onRequest({cors: false, invoker: "public", maxInstances: 10}, async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ok: false, error: "Method not allowed."});
  try {
    const user = await requireUser(req);
    if (req.body?.action !== "delete") throw Object.assign(new Error("Unknown action."), {status: 400});
    const matches = await db.collection("matches").where("participants", "array-contains", user.uid).limit(250).get();
    const matchBatch = db.batch();
    matches.docs.forEach(doc => matchBatch.delete(doc.ref));
    if (!matches.empty) await matchBatch.commit();
    await Promise.all([
      db.recursiveDelete(db.collection("members").doc(user.uid)),
      db.collection("matchRequests").doc(user.uid).delete().catch(() => {})
    ]);
    await admin.auth().deleteUser(user.uid);
    res.json({ok: true});
  } catch (err) {
    apiError(res, err);
  }
});

function rewardFromSession(session) {
  const metadataKind = session.metadata?.charismaReward;
  if (metadataKind && PRICE_TO_REWARD[metadataKind]) return PRICE_TO_REWARD[metadataKind];
  const amount = Number(session.amount_total || 0);
  if (session.mode === "subscription") return PRICE_TO_REWARD.membership;
  if (amount === 499) return PRICE_TO_REWARD.grace500;
  if (amount === 999) return PRICE_TO_REWARD.grace1200;
  if (amount === 1999) return PRICE_TO_REWARD.grace3000;
  return null;
}

async function resolveUid(session) {
  if (session.client_reference_id) {
    const user = await admin.auth().getUser(session.client_reference_id).catch(() => null);
    if (user) return user.uid;
  }
  const email = session.customer_details?.email || session.customer_email || "";
  if (!email) return null;
  const user = await admin.auth().getUserByEmail(email).catch(() => null);
  return user?.uid || null;
}

async function applyCheckout(uid, session, reward) {
  const ref = db.collection("members").doc(uid);
  const paymentRef = ref.collection("stripePayments").doc(session.id);
  await db.runTransaction(async tx => {
    const existing = await tx.get(paymentRef);
    if (existing.exists) return;
    const update = {
      stripeCustomerId: String(session.customer || ""), stripeSubscriptionId: String(session.subscription || ""),
      lastStripeSessionId: session.id, lastStripePaymentStatus: session.payment_status || "",
      membershipStatus: reward.isMember ? "active" : undefined,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    Object.keys(update).forEach(key => update[key] === undefined && delete update[key]);
    if (reward.isMember) update.isMember = true;
    if (reward.walletDelta) update.wallet = admin.firestore.FieldValue.increment(reward.walletDelta);
    tx.set(ref, update, {merge: true});
    tx.set(paymentRef, {
      stripeSessionId: session.id, rewardLabel: reward.label, walletDelta: reward.walletDelta,
      isMember: reward.isMember, amountTotal: session.amount_total || 0, currency: session.currency || "usd",
      paymentIntentId: String(session.payment_intent || ""),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });
}

async function updateSubscription(subscription) {
  const id = String(subscription.id || "");
  if (!id) return;
  const members = await db.collection("members").where("stripeSubscriptionId", "==", id).limit(1).get();
  if (members.empty) return;
  const active = ["active", "trialing"].includes(subscription.status);
  await members.docs[0].ref.set({
    isMember: active, membershipStatus: subscription.status,
    membershipEndsAt: subscription.current_period_end ? admin.firestore.Timestamp.fromMillis(subscription.current_period_end * 1000) : null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, {merge: true});
}

exports.stripeWebhook = onRequest({cors: false, invoker: "public", secrets: [stripeSecretKey, stripeWebhookSecret]}, async (req, res) => {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");
  let event;
  try {
    event = getStripe().webhooks.constructEvent(req.rawBody, req.get("stripe-signature"), stripeWebhookSecret.value());
  } catch (err) {
    logger.error("Stripe webhook verification failed", err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const reward = rewardFromSession(session);
      const uid = await resolveUid(session);
      if (reward && uid && (session.payment_status === "paid" || session.mode === "subscription")) await applyCheckout(uid, session, reward);
    } else if (event.type.startsWith("customer.subscription.")) {
      await updateSubscription(event.data.object);
    } else if (event.type === "invoice.payment_failed") {
      const subscriptionId = String(event.data.object.subscription || "");
      if (subscriptionId) await updateSubscription({id: subscriptionId, status: "past_due"});
    } else if (event.type === "charge.refunded") {
      const paymentIntentId = String(event.data.object.payment_intent || "");
      if (paymentIntentId) {
        const payments = await db.collectionGroup("stripePayments").where("paymentIntentId", "==", paymentIntentId).limit(1).get();
        if (!payments.empty) {
          const paymentRef = payments.docs[0].ref;
          const memberRef = paymentRef.parent.parent;
          await db.runTransaction(async tx => {
            const [paymentSnap, memberSnap] = await Promise.all([tx.get(paymentRef), tx.get(memberRef)]);
            if (paymentSnap.data()?.refundApplied) return;
            const payment = paymentSnap.data() || {};
            const member = memberSnap.data() || {};
            const update = {lastRefundAt: admin.firestore.FieldValue.serverTimestamp(), paymentReviewRequired: true};
            if (payment.isMember) Object.assign(update, {isMember: false, membershipStatus: "refunded"});
            if (payment.walletDelta) update.wallet = Math.max(0, Number(member.wallet || 0) - Number(payment.walletDelta || 0));
            tx.set(memberRef, update, {merge: true});
            tx.set(paymentRef, {refundApplied: true, refundedAt: admin.firestore.FieldValue.serverTimestamp()}, {merge: true});
          });
        }
      }
    }
    res.json({received: true});
  } catch (err) {
    logger.error("Stripe event processing failed", err);
    res.status(500).send("Webhook processing failed");
  }
});

exports.cleanupMatchQueue = onSchedule("every 5 minutes", async () => {
  const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - QUEUE_TTL_MS);
  const stale = await db.collection("matchRequests").where("updatedAt", "<", cutoff).limit(250).get();
  if (stale.empty) return;
  const batch = db.batch();
  stale.docs.forEach(doc => batch.delete(doc.ref));
  await batch.commit();
});

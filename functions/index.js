const {onRequest} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");
const Stripe = require("stripe");

admin.initializeApp();

const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");
const stripeWebhookSecret = defineSecret("STRIPE_WEBHOOK_SECRET");

const PRICE_TO_REWARD = {
  membership: {isMember: true, walletDelta: 0, label: "Charisma Membership"},
  grace500: {isMember: false, walletDelta: 500, label: "500 Grace Points"},
  grace1200: {isMember: false, walletDelta: 1200, label: "1,200 Grace Points"},
  grace3000: {isMember: false, walletDelta: 3000, label: "3,000 Grace Points"}
};

function getStripe() {
  const key = stripeSecretKey.value();
  if (!key) throw new Error("Missing STRIPE_SECRET_KEY");
  return new Stripe(key, {apiVersion: "2024-06-20"});
}

function rewardFromSession(session) {
  const metadataKind = session.metadata && session.metadata.charismaReward;
  if (metadataKind && PRICE_TO_REWARD[metadataKind]) return PRICE_TO_REWARD[metadataKind];

  const amount = Number(session.amount_total || 0);
  const mode = session.mode;
  if (mode === "subscription") return PRICE_TO_REWARD.membership;
  if (amount === 499) return PRICE_TO_REWARD.grace500;
  if (amount === 999) return PRICE_TO_REWARD.grace1200;
  if (amount === 1999) return PRICE_TO_REWARD.grace3000;
  return null;
}

async function findMemberByEmail(email) {
  if (!email) return null;
  const auth = admin.auth();
  try {
    const user = await auth.getUserByEmail(email);
    return user.uid;
  } catch (err) {
    logger.warn("No Firebase Auth user for Stripe email", {email, code: err.code});
    return null;
  }
}

async function applyReward(uid, email, reward, session) {
  const ref = admin.firestore().collection("members").doc(uid);
  const paymentRef = ref.collection("stripePayments").doc(session.id);

  await admin.firestore().runTransaction(async tx => {
    const existing = await tx.get(paymentRef);
    if (existing.exists) return;

    const update = {
      email,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastStripeSessionId: session.id,
      lastStripePaymentStatus: session.payment_status || "",
      lastStripeMode: session.mode || ""
    };

    if (reward.isMember) update.isMember = true;
    if (reward.walletDelta) {
      update.wallet = admin.firestore.FieldValue.increment(reward.walletDelta);
    }

    tx.set(ref, update, {merge: true});
    tx.set(paymentRef, {
      stripeSessionId: session.id,
      rewardLabel: reward.label,
      walletDelta: reward.walletDelta,
      isMember: reward.isMember,
      amountTotal: session.amount_total || 0,
      currency: session.currency || "usd",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });
}

exports.stripeWebhook = onRequest({cors: false, secrets: [stripeSecretKey, stripeWebhookSecret]}, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  let event;
  try {
    const stripe = getStripe();
    const signature = req.get("stripe-signature");
    const webhookSecret = stripeWebhookSecret.value();
    if (!webhookSecret) throw new Error("Missing STRIPE_WEBHOOK_SECRET");
    event = stripe.webhooks.constructEvent(req.rawBody, signature, webhookSecret);
  } catch (err) {
    logger.error("Stripe webhook verification failed", err);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  if (event.type !== "checkout.session.completed") {
    res.json({received: true, ignored: event.type});
    return;
  }

  const session = event.data.object;
  const email = session.customer_details?.email || session.customer_email || "";
  const uid = await findMemberByEmail(email);
  const reward = rewardFromSession(session);

  if (!uid || !reward) {
    logger.warn("Stripe session could not be applied", {
      sessionId: session.id,
      email,
      hasUid: Boolean(uid),
      hasReward: Boolean(reward),
      amount: session.amount_total,
      mode: session.mode
    });
    res.json({received: true, applied: false});
    return;
  }

  await applyReward(uid, email, reward, session);
  res.json({received: true, applied: true});
});

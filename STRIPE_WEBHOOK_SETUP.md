# Stripe Webhook Setup

The frontend can send people to Stripe, but Stripe must tell Firebase when a purchase is real. This webhook does that.

## What The Function Handles

- `checkout.session.completed`
- Membership subscription purchases
- Grace Point purchases by amount:
  - `$4.99` -> `500` points
  - `$9.99` -> `1,200` points
  - `$19.99` -> `3,000` points

The webhook finds the Firebase Auth user by the Stripe checkout email and updates:

`members/{uid}`

It also records processed sessions under:

`members/{uid}/stripePayments/{checkoutSessionId}`

That prevents double-crediting if Stripe retries the same webhook.

## Firebase Secret Setup

Do not paste these secrets into `index.html`.

Firebase Functions generally requires the Firebase CLI and the Firebase Blaze plan because the function talks to Stripe.

Install CLI if needed:

```powershell
npm.cmd install -g firebase-tools
firebase login
```

From the repo folder, run:

```powershell
firebase functions:secrets:set STRIPE_SECRET_KEY
firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
```

Paste your Stripe secret key into `STRIPE_SECRET_KEY`.

You will get the webhook secret after creating the webhook endpoint in Stripe.

## Deploy Function

```powershell
firebase deploy --only functions
```

After deploy, Firebase gives you a URL for:

`stripeWebhook`

## Stripe Dashboard Setup

In Stripe Dashboard:

`Developers` -> `Webhooks` -> `Add endpoint`

Endpoint URL:

```txt
https://YOUR-FUNCTION-URL/stripeWebhook
```

Select event:

```txt
checkout.session.completed
```

After creating it, copy the signing secret that starts with:

```txt
whsec_
```

Then run:

```powershell
firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
firebase deploy --only functions
```

## Important Current Limitation

Stripe Payment Links identify the buyer by checkout email. The user must use the same email in Stripe that they used for Charisma Firebase Auth.

The stronger production version is to create Checkout Sessions from Firebase Functions and attach the Firebase UID as Stripe metadata.

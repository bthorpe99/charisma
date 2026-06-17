# Charisma Supabase Setup

Charisma can now create real member accounts with Supabase Auth when the public project values are added.

## 1. Create a free Supabase project

Go to https://supabase.com and create a project named `charisma`.

## 2. Copy only the public browser values

In Supabase, open:

`Project Settings` -> `API`

Copy these two public values:

- Project URL
- anon public key

Do not paste the service role key into the website. The service role key is private server-only access.

## 3. Paste them into `index.html`

Find:

```js
const SUPABASE_URL="";
const SUPABASE_ANON_KEY="";
```

Paste:

```js
const SUPABASE_URL="https://YOUR-PROJECT.supabase.co";
const SUPABASE_ANON_KEY="YOUR-ANON-PUBLIC-KEY";
```

## 4. What works after that

- Membership return from Stripe unlocks the account setup card.
- Email/password creates a Supabase Auth user.
- Profile metadata is sent into the Supabase user record.
- Browser fallback still works if Supabase is not configured.

## 5. Next production step

Add Stripe webhooks with a backend function so membership and Grace Point purchases are verified by Stripe instead of trusted from URL parameters.

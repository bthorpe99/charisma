# Charisma Firebase Setup

Charisma can now create real member accounts with Firebase Auth and save member profile data to Firestore.

## 1. Create or open your Firebase project

Go to https://console.firebase.google.com and open your Charisma project.

## 2. Enable email/password login

Open:

`Build` -> `Authentication` -> `Sign-in method`

Enable:

- Email/Password

## 3. Create Firestore

Open:

`Build` -> `Firestore Database`

Create a database. Start in test mode for quick beta testing, then lock rules down before public launch.

Starter beta rules:

```txt
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /members/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    match /matchRequests/{userId} {
      allow read: if true;
      allow create, update, delete: if true;
    }
    match /matches/{matchId} {
      allow read, write: if true;
    }
  }
}
```

Those open `matchRequests` and `matches` rules are only for quick beta testing of the live nearby queue. Before public launch, require Firebase Auth and restrict each match to its participants.

## 4. Public web config

The Charisma Firebase web config for `charisma-c88cf` is already pasted into `index.html`.

If you ever need to replace it, open:

`Project settings` -> `General` -> `Your apps` -> Web app

Copy the Firebase config values and paste them into `FIREBASE_CONFIG`.

## 5. Paste them into `index.html`

Find:

```js
const FIREBASE_CONFIG={
  apiKey:"",
  authDomain:"",
  projectId:"",
  storageBucket:"",
  messagingSenderId:"",
  appId:""
};
```

Paste your values:

```js
const FIREBASE_CONFIG={
  apiKey:"YOUR_API_KEY",
  authDomain:"YOUR_PROJECT.firebaseapp.com",
  projectId:"YOUR_PROJECT_ID",
  storageBucket:"YOUR_PROJECT.appspot.com",
  messagingSenderId:"YOUR_SENDER_ID",
  appId:"YOUR_APP_ID"
};
```

Do not paste Firebase Admin SDK private keys into the website.

## 6. What works after that

- Stripe membership return unlocks the member account card.
- Email/password creates a Firebase Auth user.
- Charisma writes profile, wallet, membership, and gift history to `members/{uid}` in Firestore.
- Charisma writes live nearby search requests to `matchRequests/{uid}` and matched rooms to `matches/{matchId}`.
- If Firebase config is blank, the app still uses the local beta fallback.

## 7. Next production step

Add Stripe webhooks with a backend function so membership and Grace Point purchases are verified by Stripe instead of trusted from URL parameters.

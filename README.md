# AMKCuts

## Free Hosting Setup

This project can be hosted for free on Firebase Hosting.

Best free URL options:

- `https://test-323a0.web.app` using the existing project site
- `https://amkcuts.web.app` if you create a Firebase Hosting site named `amkcuts` inside the same Firebase project

## What stays free

- `index.html`, `app.js`, and `style.css` can be served from Firebase Hosting
- Firestore rules and indexes can be deployed on the free tier
- The app already supports a Firestore-only flow

## What is not free

- `functions/` uses Firebase Cloud Functions and Twilio
- Do not deploy `functions/` if you want to stay on the free tier

## Quick deploy

1. Install Firebase CLI and log in

```bash
npm install -g firebase-tools
firebase login
firebase use test-323a0
```

2. Deploy Hosting plus Firestore config

```bash
firebase deploy --only hosting,firestore:rules,firestore:indexes
```

3. Open your live site

- Default site: `https://test-323a0.web.app`
- Desired branded site: `https://amkcuts.web.app` if you create that Hosting site first

## Manage Booking Flow

- Customer enters phone + booking code.
- App queries Firestore directly using `client.phoneNormalized` + `bookingCode`.
- Cancel/reschedule are implemented as constrained updates, not document deletes.

## Security Note

This is safer than fully open deletes, but still weaker than server-side OTP verification.
If you need stronger protection later, re-introduce a backend verification layer.

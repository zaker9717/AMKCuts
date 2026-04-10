# AMKCuts

## Firestore-Only (Spark-Friendly) Setup

This project runs without Cloud Functions or Twilio.

It uses:

- Firestore rules in `firestore.rules`
- Firestore indexes in `firestore.indexes.json`
- Client-side booking management in `app.js`

## 1) Install Firebase CLI and login

```bash
npm install -g firebase-tools
firebase login
firebase use test-323a0
```

## 2) Deploy Firestore rules + indexes (Spark-safe)

```bash
firebase deploy --only firestore:rules,firestore:indexes
```

Do not run `firebase deploy --only functions:...` on Spark, because Cloud Functions requires Blaze billing.

## Manage Booking Flow (No OTP)

- Customer enters phone + booking code.
- App queries Firestore directly using `client.phoneNormalized` + `bookingCode`.
- Cancel/reschedule are implemented as constrained updates (soft-cancel), not document deletes.

## Lightweight Hardening Included

- Manage lookup validates input format and applies a short client cooldown.
- Firestore blocks direct `delete` on `bookings`.
- Firestore allows `update` only for cancellation/reschedule-style transitions with matching `manageProof`.

## Security Note

This is safer than fully open deletes, but still weaker than server-side OTP verification.
If you need stronger protection against abuse, re-introduce a backend verification layer later.

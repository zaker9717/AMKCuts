const crypto = require("crypto");
const admin = require("firebase-admin");
const functions = require("firebase-functions");
const twilio = require("twilio");

admin.initializeApp();
const db = admin.firestore();

const BOOKINGS_COLLECTION = "bookings";
const OTP_SESSIONS_COLLECTION = "manageOtpSessions";
const ACCESS_TOKENS_COLLECTION = "manageAccessTokens";
const OTP_RATE_COLLECTION = "manageOtpRate";

const OTP_TTL_MINUTES = 10;
const ACCESS_TOKEN_TTL_MINUTES = 20;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN_SECONDS = 45;

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

function isValidBookingCode(code) {
  return /^\d{6}$/.test(String(code || "").trim());
}

function isValidDate(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(date || ""));
}

function toE164FromDigits(phoneDigits) {
  if (!/^\d{7,15}$/.test(phoneDigits)) {
    throw new functions.https.HttpsError("invalid-argument", "Phone number format is invalid.");
  }
  return `+${phoneDigits}`;
}

function generateNumericCode(length) {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += Math.floor(Math.random() * 10);
  }
  return out;
}

function hashOtp(otp) {
  return crypto.createHash("sha256").update(String(otp)).digest("hex");
}

function randomToken(size = 32) {
  return crypto.randomBytes(size).toString("hex");
}

function getTwilioClient() {
  const cfg = functions.config();
  const sid = cfg?.twilio?.sid;
  const token = cfg?.twilio?.token;
  const from = cfg?.twilio?.from;

  if (!sid || !token || !from) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Twilio is not configured. Set twilio.sid, twilio.token, and twilio.from with firebase functions:config:set."
    );
  }

  return {
    client: twilio(sid, token),
    from,
  };
}

async function findBookingByPhoneAndCode(phoneNormalized, bookingCode) {
  const snap = await db
    .collection(BOOKINGS_COLLECTION)
    .where("client.phoneNormalized", "==", phoneNormalized)
    .where("bookingCode", "==", bookingCode)
    .limit(1)
    .get();

  if (snap.empty) {
    throw new functions.https.HttpsError("not-found", "No booking matches those details.");
  }

  const doc = snap.docs[0];
  return { id: doc.id, data: doc.data() };
}

function validateManagedCancelPayload(data) {
  const phoneNormalized = normalizePhone(data?.phone || data?.phoneNormalized || "");
  const bookingCode = String(data?.bookingCode || "").trim();
  const bookingId = String(data?.bookingId || "").trim();

  if (!/^[0-9]{7,15}$/.test(phoneNormalized)) {
    throw new functions.https.HttpsError("invalid-argument", "Phone number is invalid.");
  }
  if (!isValidBookingCode(bookingCode)) {
    throw new functions.https.HttpsError("invalid-argument", "Booking code must be 6 digits.");
  }
  if (!bookingId) {
    throw new functions.https.HttpsError("invalid-argument", "bookingId is required.");
  }

  return { phoneNormalized, bookingCode, bookingId };
}

async function assertOtpRateLimit(phoneNormalized) {
  const ref = db.collection(OTP_RATE_COLLECTION).doc(phoneNormalized);
  const nowMs = Date.now();
  const snap = await ref.get();

  if (snap.exists) {
    const lastSentAt = snap.data()?.lastSentAt;
    const lastMs = lastSentAt?.toMillis ? lastSentAt.toMillis() : 0;
    if (lastMs && nowMs - lastMs < OTP_RESEND_COOLDOWN_SECONDS * 1000) {
      throw new functions.https.HttpsError(
        "resource-exhausted",
        `Please wait ${OTP_RESEND_COOLDOWN_SECONDS} seconds before requesting a new code.`
      );
    }
  }

  await ref.set({
    lastSentAt: admin.firestore.Timestamp.fromMillis(nowMs),
  }, { merge: true });
}

async function consumeAccessToken(accessToken, bookingId) {
  const tokenRef = db.collection(ACCESS_TOKENS_COLLECTION).doc(accessToken);

  return db.runTransaction(async (tx) => {
    const tokenSnap = await tx.get(tokenRef);
    if (!tokenSnap.exists) {
      throw new functions.https.HttpsError("permission-denied", "Access token is invalid.");
    }

    const tokenData = tokenSnap.data();
    if (tokenData.used) {
      throw new functions.https.HttpsError("permission-denied", "Access token was already used.");
    }

    const nowMs = Date.now();
    const expiresMs = tokenData.expiresAt?.toMillis ? tokenData.expiresAt.toMillis() : 0;
    if (!expiresMs || nowMs > expiresMs) {
      throw new functions.https.HttpsError("permission-denied", "Access token expired.");
    }

    if (tokenData.bookingId !== bookingId) {
      throw new functions.https.HttpsError("permission-denied", "Access token does not match this booking.");
    }

    tx.update(tokenRef, {
      used: true,
      usedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return tokenData;
  });
}

exports.requestManageOtp = functions.region("us-central1").https.onCall(async (data) => {
  const phoneRaw = String(data?.phone || "");
  const bookingCode = String(data?.bookingCode || "").trim();
  const phoneNormalized = normalizePhone(phoneRaw);

  if (!/^\d{7,15}$/.test(phoneNormalized)) {
    throw new functions.https.HttpsError("invalid-argument", "Phone number is invalid.");
  }
  if (!isValidBookingCode(bookingCode)) {
    throw new functions.https.HttpsError("invalid-argument", "Booking code must be 6 digits.");
  }

  const booking = await findBookingByPhoneAndCode(phoneNormalized, bookingCode);
  await assertOtpRateLimit(phoneNormalized);

  const otp = generateNumericCode(6);
  const otpHash = hashOtp(otp);
  const sessionId = randomToken(16);
  const nowMs = Date.now();

  await db.collection(OTP_SESSIONS_COLLECTION).doc(sessionId).set({
    bookingId: booking.id,
    bookingCode,
    phoneNormalized,
    otpHash,
    attempts: 0,
    verified: false,
    createdAt: admin.firestore.Timestamp.fromMillis(nowMs),
    expiresAt: admin.firestore.Timestamp.fromMillis(nowMs + OTP_TTL_MINUTES * 60 * 1000),
  });

  const { client, from } = getTwilioClient();
  await client.messages.create({
    body: `AMK Cuts code: ${otp}. It expires in ${OTP_TTL_MINUTES} minutes.`,
    from,
    to: toE164FromDigits(phoneNormalized),
  });

  return {
    sessionId,
    expiresInSeconds: OTP_TTL_MINUTES * 60,
  };
});

exports.verifyManageOtp = functions.region("us-central1").https.onCall(async (data) => {
  const sessionId = String(data?.sessionId || "").trim();
  const otp = String(data?.otp || "").trim();

  if (!sessionId || !/^\d{6}$/.test(otp)) {
    throw new functions.https.HttpsError("invalid-argument", "Session and OTP are required.");
  }

  const sessionRef = db.collection(OTP_SESSIONS_COLLECTION).doc(sessionId);
  const sessionSnap = await sessionRef.get();
  if (!sessionSnap.exists) {
    throw new functions.https.HttpsError("not-found", "OTP session not found.");
  }

  const session = sessionSnap.data();
  const nowMs = Date.now();
  const expiresMs = session.expiresAt?.toMillis ? session.expiresAt.toMillis() : 0;

  if (!expiresMs || nowMs > expiresMs) {
    throw new functions.https.HttpsError("deadline-exceeded", "OTP has expired.");
  }
  if (session.verified) {
    throw new functions.https.HttpsError("already-exists", "OTP already verified.");
  }
  if ((session.attempts || 0) >= OTP_MAX_ATTEMPTS) {
    throw new functions.https.HttpsError("permission-denied", "Too many attempts. Request a new OTP.");
  }

  const incomingHash = hashOtp(otp);
  if (incomingHash !== session.otpHash) {
    await sessionRef.update({ attempts: admin.firestore.FieldValue.increment(1) });
    throw new functions.https.HttpsError("permission-denied", "Invalid OTP.");
  }

  const accessToken = randomToken(24);
  await db.runTransaction(async (tx) => {
    tx.update(sessionRef, {
      verified: true,
      verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    tx.set(db.collection(ACCESS_TOKENS_COLLECTION).doc(accessToken), {
      bookingId: session.bookingId,
      phoneNormalized: session.phoneNormalized,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromMillis(nowMs + ACCESS_TOKEN_TTL_MINUTES * 60 * 1000),
      used: false,
    });
  });

  return {
    accessToken,
    expiresInSeconds: ACCESS_TOKEN_TTL_MINUTES * 60,
  };
});

exports.cancelBooking = functions.region("us-central1").https.onCall(async (data) => {
  const accessToken = String(data?.accessToken || "").trim();
  const bookingId = String(data?.bookingId || "").trim();

  if (!accessToken || !bookingId) {
    throw new functions.https.HttpsError("invalid-argument", "accessToken and bookingId are required.");
  }

  await consumeAccessToken(accessToken, bookingId);
  const bookingRef = db.collection(BOOKINGS_COLLECTION).doc(bookingId);
  const snap = await bookingRef.get();
  if (!snap.exists) {
    throw new functions.https.HttpsError("not-found", "Booking not found.");
  }

  await bookingRef.delete();
  return { success: true };
});

exports.cancelManagedBooking = functions.region("us-central1").https.onCall(async (data) => {
  const { phoneNormalized, bookingCode, bookingId } = validateManagedCancelPayload(data);
  const booking = await findBookingByPhoneAndCode(phoneNormalized, bookingCode);

  if (booking.id !== bookingId) {
    throw new functions.https.HttpsError("permission-denied", "Booking details do not match.");
  }

  await db.collection(BOOKINGS_COLLECTION).doc(bookingId).delete();
  return { success: true };
});

exports.rescheduleBooking = functions.region("us-central1").https.onCall(async (data) => {
  const accessToken = String(data?.accessToken || "").trim();
  const bookingId = String(data?.bookingId || "").trim();
  const newDate = String(data?.newDate || "").trim();
  const newHour = Number(data?.newHour);
  const newLabel = String(data?.newLabel || "").trim();

  if (!accessToken || !bookingId || !isValidDate(newDate) || !Number.isInteger(newHour) || newHour < 0 || newHour > 23) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid reschedule payload.");
  }

  await consumeAccessToken(accessToken, bookingId);

  const oldRef = db.collection(BOOKINGS_COLLECTION).doc(bookingId);
  const newBookingId = `${newDate}_${newHour}`;
  const newRef = db.collection(BOOKINGS_COLLECTION).doc(newBookingId);

  if (newBookingId === bookingId) {
    throw new functions.https.HttpsError("failed-precondition", "Please choose a different time slot.");
  }

  await db.runTransaction(async (tx) => {
    const [oldSnap, newSnap] = await Promise.all([tx.get(oldRef), tx.get(newRef)]);

    if (!oldSnap.exists) {
      throw new functions.https.HttpsError("not-found", "Original booking was not found.");
    }
    if (newSnap.exists) {
      throw new functions.https.HttpsError("already-exists", "That new slot is already booked.");
    }

    const oldData = oldSnap.data();
    tx.set(newRef, {
      ...oldData,
      date: newDate,
      hour: newHour,
      label: newLabel || oldData.label || "",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.delete(oldRef);
  });

  return { success: true, bookingId: newBookingId };
});

exports.rescheduleManagedBooking = functions.region("us-central1").https.onCall(async (data) => {
  const { phoneNormalized, bookingCode, bookingId } = validateManagedCancelPayload(data);
  const newDate = String(data?.newDate || "").trim();
  const newHour = Number(data?.newHour);
  const newLabel = String(data?.newLabel || "").trim();

  if (!isValidDate(newDate) || !Number.isInteger(newHour) || newHour < 0 || newHour > 23) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid reschedule payload.");
  }

  const booking = await findBookingByPhoneAndCode(phoneNormalized, bookingCode);
  if (booking.id !== bookingId) {
    throw new functions.https.HttpsError("permission-denied", "Booking details do not match.");
  }

  const oldRef = db.collection(BOOKINGS_COLLECTION).doc(bookingId);
  const newBookingId = `${newDate}_${newHour}`;
  const newRef = db.collection(BOOKINGS_COLLECTION).doc(newBookingId);

  if (newBookingId === bookingId) {
    throw new functions.https.HttpsError("failed-precondition", "Please choose a different time slot.");
  }

  await db.runTransaction(async (tx) => {
    const [oldSnap, newSnap] = await Promise.all([tx.get(oldRef), tx.get(newRef)]);

    if (!oldSnap.exists) {
      throw new functions.https.HttpsError("not-found", "Original booking was not found.");
    }
    if (newSnap.exists) {
      throw new functions.https.HttpsError("already-exists", "That new slot is already booked.");
    }

    const oldData = oldSnap.data();
    tx.set(newRef, {
      ...oldData,
      date: newDate,
      hour: newHour,
      label: newLabel || oldData.label || "",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.delete(oldRef);
  });

  return { success: true, bookingId: newBookingId };
});

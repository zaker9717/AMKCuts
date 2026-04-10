// BarberApp JavaScript
// All logic extracted from the original React code, adapted for vanilla JS

const SERVICES = [
    { id: "fade", name: "Fade", duration: 60 },
    { id: "cut", name: "Haircut", duration: 60 },
    { id: "beard", name: "Beard Trim", duration: 60 },
    { id: "cutbeard", name: "Cut + Beard", duration: 60 },
    { id: "lineup", name: "Line Up", duration: 60 },
];
const PRICING = {
    address: "90 Degré Barbershop — 354 Bd Cartier O, Laval",
    haircut: "$20",
    beard: "+$5 beard",
};
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const FULL_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const HOURS = Array.from({ length: 24 }, (_, i) => {
    const h = i % 12 === 0 ? 12 : i % 12;
    const ampm = i < 12 ? "AM" : "PM";
    return { value: i, label: `${h}:00 ${ampm}` };
});

// --- FIREBASE SETUP (compat SDK loaded in index.html) ---
const firebaseConfig = {
    apiKey: "AIzaSyCvvy79sO08nQ_qH2fydW1H_LEMI-CYMOk",
    authDomain: "test-323a0.firebaseapp.com",
    projectId: "test-323a0",
    storageBucket: "test-323a0.firebasestorage.app",
    messagingSenderId: "437177309817",
    appId: "1:437177309817:web:b14e49d1bfbd2e3131d2a8",
    measurementId: "G-TV2NDMQ9HX"
};

const BOOKINGS_COLLECTION = "bookings";
const SETTINGS_COLLECTION = "settings";
const AVAILABILITY_DOC_ID = "availability";
const MANAGE_LOOKUP_COOLDOWN_MS = 5000;
const CANCELLED_BOOKINGS_STORAGE_KEY = "barber_cancelled_bookings";
let db = null;

if (typeof firebase !== "undefined" && firebase.apps) {
    if (!firebase.apps.length) {
        firebase.initializeApp(firebaseConfig);
    }
    db = firebase.firestore();
    try {
        // Fixes Firestore Listen/channel CORS issues in some local browser environments.
        db.settings({ experimentalForceLongPolling: true, useFetchStreams: false });
    } catch (e) {
        // Ignore if settings were already frozen by first Firestore use.
        console.warn("Firestore settings were already initialized.", e);
    }
} else {
    console.warn("Firebase compat SDK was not found. Falling back to localStorage only.");
}

function generateSlots(start, end, duration, booked = []) {
    const slots = [];
    for (let h = start; h + Math.ceil(duration / 60) <= end; h++) {
        const label = HOURS[h].label;
        const isBooked = booked.includes(h);
        slots.push({ hour: h, label, available: !isBooked });
    }
    return slots;
}
function getNextDays(count = 14) {
    const days = [];
    const today = new Date();
    for (let i = 0; i < count; i++) {
        const d = new Date(today);
        d.setDate(today.getDate() + i);
        days.push(d);
    }
    return days;
}
function getDayKey(date) {
    return date.toISOString().split("T")[0];
}

function normalizePhone(phone) {
    return String(phone || "").replace(/\D/g, "");
}

function generateBookingCode() {
    // Human-friendly 6-digit code to retrieve/manage a booking later.
    return String(Math.floor(100000 + Math.random() * 900000));
}

// --- LocalStorage persistence for bookings ---
function saveBookings() {
    localStorage.setItem("barber_bookings", JSON.stringify(bookings));
}

function loadCancelledBookings() {
    try {
        return new Set(JSON.parse(localStorage.getItem(CANCELLED_BOOKINGS_STORAGE_KEY) || "[]"));
    } catch (e) {
        return new Set();
    }
}

function saveCancelledBookings(cancelledIds) {
    localStorage.setItem(CANCELLED_BOOKINGS_STORAGE_KEY, JSON.stringify(Array.from(cancelledIds)));
}

let cancelledBookingIds = loadCancelledBookings();

// Reset old local-only cancellation markers now that Firestore cancellations are authoritative.
if (cancelledBookingIds.size) {
    cancelledBookingIds = new Set();
    saveCancelledBookings(cancelledBookingIds);
}

function isLocallyCancelledBooking(bookingId) {
    return !!bookingId && cancelledBookingIds.has(bookingId);
}

function markBookingCancelledLocally(bookingId) {
    if (!bookingId) return;
    cancelledBookingIds.add(bookingId);
    saveCancelledBookings(cancelledBookingIds);
}

function clearBookingCancelledLocally(bookingId) {
    if (!bookingId || !cancelledBookingIds.has(bookingId)) return;
    cancelledBookingIds.delete(bookingId);
    saveCancelledBookings(cancelledBookingIds);
}

function pruneCancelledBookingsFromState() {
    let changed = false;
    Object.keys(bookings).forEach((dateKey) => {
        const filtered = (bookings[dateKey] || []).filter((booking) => {
            if (isLocallyCancelledBooking(booking._id)) {
                changed = true;
                return false;
            }
            return true;
        });
        if (filtered.length) {
            bookings[dateKey] = filtered;
        } else if (bookings[dateKey]) {
            delete bookings[dateKey];
            changed = true;
        }
    });
    return changed;
}

function loadBookings() {
    const data = localStorage.getItem("barber_bookings");
    if (data) {
        try {
            bookings = JSON.parse(data);
        } catch (e) {
            bookings = {};
        }
    }
    if (pruneCancelledBookingsFromState()) {
        saveBookings();
    }
}

function normalizeBooking(raw, docId) {
    const hour = Number(raw?.hour);
    const status = raw?.status === "cancelled" ? "cancelled" : "active";
    return {
        _id: docId || raw?._id,
        hour,
        label: raw?.label || HOURS[hour]?.label || "",
        bookingCode: String(raw?.bookingCode || ""),
        status,
        client: {
            name: raw?.client?.name || "",
            phone: raw?.client?.phone || "",
            phoneNormalized: raw?.client?.phoneNormalized || normalizePhone(raw?.client?.phone || ""),
            email: raw?.client?.email || ""
        },
        service: {
            id: raw?.service?.id || "",
            name: raw?.service?.name || "Service",
            duration: Number(raw?.service?.duration) || 60
        },
        date: raw?.date || ""
    };
}

async function loadBookingsFromFirestore() {
    if (!db) {
        loadBookings();
        return;
    }
    try {
        const snapshot = await db.collection(BOOKINGS_COLLECTION).get();
        const grouped = {};
        snapshot.forEach((doc) => {
            const booking = normalizeBooking(doc.data(), doc.id);
            if (!booking.date || booking.status === "cancelled") return;
            if (!grouped[booking.date]) grouped[booking.date] = [];
            grouped[booking.date].push(booking);
        });
        Object.values(grouped).forEach((arr) => arr.sort((a, b) => a.hour - b.hour));
        bookings = grouped;
        saveBookings();
    } catch (error) {
        const code = String(error?.code || "").toLowerCase();
        if (code === "permission-denied") {
            console.warn("Firestore read blocked by rules. Using local cache until rules are deployed.");
            loadBookings();
            return;
        }
        console.error("Failed to load bookings from Firestore. Using local cache.", error);
        loadBookings();
    }
}

function isFirestoreUnavailableError(error) {
    const code = String(error?.code || "").toLowerCase();
    const msg = String(error?.message || "").toLowerCase();

    // Keep slot-conflict behavior strict; only fallback for infrastructure/service issues.
    if (msg.includes("slot was just booked")) return false;

    return (
        code === "unavailable" ||
        code === "failed-precondition" ||
        msg.includes("firestore api has not been used") ||
        msg.includes("firestore.googleapis.com") ||
        msg.includes("network") ||
        msg.includes("offline")
    );
}

function mapManagedBookingError(error) {
    const code = String(error?.code || "").toLowerCase();
    const msg = String(error?.message || "");

    if (code.includes("permission-denied")) {
        return new Error("Cancellation was denied by Firestore. Confirm you used the same phone and booking code, then try again.");
    }
    if (code.includes("not-found")) {
        return new Error("Booking was not found. It may already be cancelled.");
    }
    if (code.includes("failed-precondition") || code.includes("aborted")) {
        return new Error("This booking changed while you were editing it. Refresh and try again.");
    }
    if (code.includes("internal")) {
        return new Error("Server is temporarily unavailable. Please try again.");
    }
    return new Error(msg || "Could not update this booking right now.");
}

async function saveBookingToFirestore(booking) {
    if (!db) {
        return { ...normalizeBooking(booking), _id: `${booking.date}_${booking.hour}` };
    }

    const bookingId = `${booking.date}_${booking.hour}`;
    const ref = db.collection(BOOKINGS_COLLECTION).doc(bookingId);
    const payload = normalizeBooking(booking, bookingId);
    const createPayload = {
        hour: payload.hour,
        label: payload.label,
        bookingCode: payload.bookingCode,
        client: payload.client,
        service: payload.service,
        date: payload.date,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    try {
        const existing = await ref.get();
        if (existing.exists) {
            const existingStatus = String(existing.data()?.status || "active").toLowerCase();
            if (existingStatus !== "cancelled") {
                throw new Error("This slot was just booked. Please choose another time.");
            }
            // Rebook by replacing a previously-cancelled slot doc.
            await ref.set(createPayload);
        } else if (typeof ref.create === "function") {
            await ref.create(createPayload);
        } else {
            await ref.set(createPayload);
        }
    } catch (error) {
        const code = String(error?.code || "").toLowerCase();
        const msg = String(error?.message || "").toLowerCase();

        if (code === "already-exists" || msg.includes("already exists") || msg.includes("just booked")) {
            throw new Error("This slot was just booked. Please choose another time.");
        }
        if (code === "permission-denied") {
            throw new Error("Booking is blocked by Firestore rules. Deploy the latest firestore rules, then refresh.");
        }
        throw error;
    }

    return payload;
}

async function rescheduleBookingInFirestore(booking, newDate, newHour, newLabel, manageProof) {
    if (!db || !booking?._id) {
        throw new Error("Firestore is not available for rescheduling.");
    }

    const newBookingId = `${newDate}_${newHour}`;
    if (newBookingId === booking._id) {
        throw new Error("Please choose a different time slot.");
    }

    const oldRef = db.collection(BOOKINGS_COLLECTION).doc(booking._id);
    const newRef = db.collection(BOOKINGS_COLLECTION).doc(newBookingId);

    await db.runTransaction(async (transaction) => {
        const [oldSnap, newSnap] = await Promise.all([transaction.get(oldRef), transaction.get(newRef)]);
        if (!oldSnap.exists) {
            throw new Error("Original booking was not found.");
        }
        if (newSnap.exists) {
            throw new Error("That new slot is already booked.");
        }

        const oldData = normalizeBooking(oldSnap.data(), booking._id);
        const rawPhone = String(oldData?.client?.phone || booking?.client?.phone || manageLookupPhone || "").trim();
        const normalizedPhone = normalizePhone(oldData?.client?.phoneNormalized || rawPhone);
        if (!/^\d{7,15}$/.test(normalizedPhone)) {
            throw new Error("Booking phone format is invalid. Please contact AMK Cuts to reschedule this appointment.");
        }

        const candidateCode = String(oldData?.bookingCode || booking?.bookingCode || "").trim();
        const bookingCode = /^\d{6}$/.test(candidateCode) ? candidateCode : generateBookingCode();

        const safePayload = {
            hour: newHour,
            label: newLabel || oldData.label || HOURS[newHour]?.label || "",
            bookingCode,
            status: "active",
            client: {
                name: String(oldData?.client?.name || booking?.client?.name || "Client").trim() || "Client",
                phone: rawPhone || normalizedPhone,
                phoneNormalized: normalizedPhone,
                email: String(oldData?.client?.email || booking?.client?.email || "")
            },
            service: {
                id: String(oldData?.service?.id || booking?.service?.id || "cut"),
                name: String(oldData?.service?.name || booking?.service?.name || "Service"),
                duration: Number(oldData?.service?.duration || booking?.service?.duration || 60)
            },
            date: newDate,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        transaction.set(newRef, safePayload);
        transaction.delete(oldRef);
    });

    return newBookingId;
}

// State
let view = "book"; // book | admin | confirm
let step = 1;
let selectedService = null;
let selectedDay = null;
let selectedSlot = null;
let clientInfo = { name: "", phone: "", email: "" };
let bookings = {};
let adminPass = "";
let adminUnlocked = false;
let adminError = "";
const PASSWORD = "Minihols20";
let availability = {
    0: { open: false, start: 9, end: 18 },
    1: { open: true, start: 9, end: 18 },
    2: { open: true, start: 9, end: 18 },
    3: { open: true, start: 9, end: 18 },
    4: { open: true, start: 9, end: 18 },
    5: { open: true, start: 9, end: 19 },
    6: { open: true, start: 10, end: 17 },
};

function sanitizeAvailabilityDay(dayConfig, fallback) {
    const base = fallback || { open: false, start: 9, end: 18 };
    const open = typeof dayConfig?.open === "boolean" ? dayConfig.open : base.open;
    const start = Number.isInteger(dayConfig?.start) ? dayConfig.start : base.start;
    const end = Number.isInteger(dayConfig?.end) ? dayConfig.end : base.end;

    return {
        open,
        start: Math.min(23, Math.max(0, start)),
        end: Math.min(23, Math.max(0, end))
    };
}

function applyAvailabilityPatch(source) {
    if (!source || typeof source !== "object") return;
    for (let i = 0; i < 7; i++) {
        const key = String(i);
        if (source[key] || source[i]) {
            availability[i] = sanitizeAvailabilityDay(source[key] || source[i], availability[i]);
        }
    }
}

function getAvailabilityFirestorePayload() {
    const days = {};
    for (let i = 0; i < 7; i++) {
        days[String(i)] = sanitizeAvailabilityDay(availability[i], { open: false, start: 9, end: 18 });
    }
    return {
        days,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
}

async function saveAvailabilityToFirestore() {
    if (!db) return false;
    try {
        await db.collection(SETTINGS_COLLECTION).doc(AVAILABILITY_DOC_ID).set(getAvailabilityFirestorePayload(), { merge: true });
        return true;
    } catch (error) {
        console.warn("Failed to save availability to Firestore, local cache will still be used.", error);
        return false;
    }
}

async function loadAvailabilityFromFirestore() {
    if (!db) return false;
    try {
        const snap = await db.collection(SETTINGS_COLLECTION).doc(AVAILABILITY_DOC_ID).get();
        if (!snap.exists) return false;

        const data = snap.data() || {};
        applyAvailabilityPatch(data.days || {});
        localStorage.setItem('barber_availability', JSON.stringify(availability));
        return true;
    } catch (error) {
        console.warn("Failed to load availability from Firestore, using local cache.", error);
        return false;
    }
}

function saveAvailability() {
    localStorage.setItem('barber_availability', JSON.stringify(availability));
    void saveAvailabilityToFirestore();
}

function loadAvailability() {
    const data = localStorage.getItem('barber_availability');
    if (data) {
        try {
            const parsed = JSON.parse(data);
            applyAvailabilityPatch(parsed);
        } catch (e) { }
    }
}
let adminTab = "schedule";

// Manage Booking state
let manageStep = 1;
let foundBookings = [];
let bookingToEdit = null;
let lastBookingCode = "";
let manageLookupPhone = "";
let manageLookupCode = "";
let lastManageLookupAt = 0;
let lastBookingSavedLocally = false;

// --- EmailJS integration ---
// Add this to your HTML <head> if not already present:
// <script src="https://cdn.jsdelivr.net/npm/emailjs-com@3/dist/email.min.js"></script>
if (typeof emailjs === 'undefined') {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/emailjs-com@3/dist/email.min.js';
    script.onload = () => emailjs.init('LOVFUzRn4YxIvIQeR');
    document.head.appendChild(script);
} else {
    emailjs.init('LOVFUzRn4YxIvIQeR');
}

function sendBookingEmail() {
    // Wait for emailjs to be loaded
    if (typeof emailjs === 'undefined') {
        setTimeout(sendBookingEmail, 500);
        return;
    }

    const firstName = (clientInfo.name || '').trim().split(/\s+/)[0] || 'Client';
    const bookingCode = lastBookingCode || '';
    const serviceName = selectedService?.name || '';
    const mapUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(PRICING.address)}`;

    const templateParams = {
        // New template placeholders
        first_name: firstName,
        appointment_id: bookingCode,
        service: serviceName,
        date: selectedDay?.toLocaleDateString() || '',
        time: selectedSlot?.label || '',
        barber: 'AMK Cuts',
        price: serviceName.toLowerCase().includes('beard') ? '$25' : '$20',
        location: PRICING.address,
        cancellation_policy: 'To cancel or reschedule, use your Booking ID in Manage Booking.',
        contact_phone: clientInfo.phone || '',
        contact_email: clientInfo.email || '',
        map_url: mapUrl,
        website_link: window.location.origin,
        email: clientInfo.email || '',

        // Backward-compatible variables used by older templates
        name: clientInfo.name,
        phone: clientInfo.phone,
        booking_code: bookingCode
    };
    // Send to client (auto reply)
    if (clientInfo.email) {
        emailjs.send('service_8q12g6q', 'template_57biiq8', templateParams)
            .then(function (response) {
                console.log('Auto-reply sent to client!', response.status, response.text);
            }, function (error) {
                console.error('Failed to send auto-reply:', error);
            });
    }
    // Send to owner (barber notification)
    emailjs.send('service_8q12g6q', 'template_hpoky5f', templateParams)
        .then(function (response) {
            console.log('Booking notification sent to owner!', response.status, response.text);
        }, function (error) {
            console.error('Failed to send booking notification:', error);
        });
}

// --- Firestore booking helpers ---
function addBookingLocally(booking) {
    if (!bookings[booking.date]) bookings[booking.date] = [];
    bookings[booking.date].push(booking);
    bookings[booking.date].sort((a, b) => a.hour - b.hour);
    saveBookings();
}

async function addBooking(booking) {
    const localBooking = { ...normalizeBooking(booking), _id: `${booking.date}_${booking.hour}`, status: "active" };

    if (!db) {
        addBookingLocally(localBooking);
        return { ...localBooking, _savedLocallyOnly: true };
    }

    try {
        const saved = await saveBookingToFirestore(booking);
        await loadBookingsFromFirestore();
        return { ...saved, _savedLocallyOnly: false };
    } catch (error) {
        if (isFirestoreUnavailableError(error)) {
            console.warn("Firestore unavailable, saving booking locally.", error);
            addBookingLocally(localBooking);
            return { ...localBooking, _savedLocallyOnly: true };
        }
        throw error;
    }
}

function removeBookingLocally(bookingId) {
    if (!bookingId) return;
    Object.keys(bookings).forEach((dateKey) => {
        bookings[dateKey] = (bookings[dateKey] || []).filter((b) => b._id !== bookingId);
        if (bookings[dateKey].length === 0) delete bookings[dateKey];
    });
    saveBookings();
}

function cancelBookingLocally(bookingId) {
    removeBookingLocally(bookingId);
}

function upsertBookingLocally(booking) {
    removeBookingLocally(booking._id);
    addBookingLocally(booking);
}

function isValidManageLookupInput(phoneDigits, bookingCode) {
    return /^\d{7,15}$/.test(phoneDigits) && /^\d{6}$/.test(bookingCode);
}

function sanitizeManageProof(inputProof = {}, booking = null, docData = null) {
    const fallbackRawPhone = String(
        docData?.client?.phone ||
        booking?.client?.phone ||
        inputProof.phone ||
        manageLookupPhone ||
        ""
    ).trim();

    const fallbackPhoneNormalized = normalizePhone(
        docData?.client?.phoneNormalized ||
        booking?.client?.phoneNormalized ||
        inputProof.phoneNormalized ||
        fallbackRawPhone
    );

    const bookingCode = String(
        docData?.bookingCode ||
        booking?.bookingCode ||
        inputProof.bookingCode ||
        manageLookupCode ||
        ""
    ).trim();

    const proof = {
        bookingCode,
        phoneNormalized: fallbackPhoneNormalized
    };

    if (fallbackRawPhone) {
        proof.phone = fallbackRawPhone;
    }

    return proof;
}

function getManageProof(booking = null) {
    return sanitizeManageProof({}, booking, null);
}

function buildManageProofFromDocData(docData, fallbackProof = {}, booking = null) {
    return sanitizeManageProof(fallbackProof, booking, docData);
}

async function findBookingsByPhoneAndCode(phoneRaw, bookingCodeRaw) {
    const targetPhone = normalizePhone(phoneRaw);
    const targetCode = String(bookingCodeRaw || "").trim();

    if (!isValidManageLookupInput(targetPhone, targetCode)) return [];

    if (!db) {
        return Object.entries(bookings)
            .flatMap(([date, appts]) => appts.map((a) => ({ ...a, date })))
            .filter((b) => {
                const normalizedStored = b?.client?.phoneNormalized || normalizePhone(b?.client?.phone);
                return b?.status !== "cancelled" && normalizedStored === targetPhone && String(b?.bookingCode || "") === targetCode;
            })
            .sort((a, b) => (a.date === b.date ? a.hour - b.hour : a.date.localeCompare(b.date)));
    }

    const snapshot = await db
        .collection(BOOKINGS_COLLECTION)
        .where("client.phoneNormalized", "==", targetPhone)
        .where("bookingCode", "==", targetCode)
        .limit(10)
        .get();

    const matches = [];
    snapshot.forEach((doc) => {
        const booking = normalizeBooking(doc.data(), doc.id);
        if (booking.status !== "cancelled") matches.push(booking);
    });

    return matches.sort((a, b) => (a.date === b.date ? a.hour - b.hour : a.date.localeCompare(b.date)));
}

function createManagedBookingError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
}

function isPossiblyValidProofForLookup(proof) {
    return isValidManageLookupInput(String(proof?.phoneNormalized || ""), String(proof?.bookingCode || ""));
}

async function cancelBookingInFirestore(booking, manageProof) {
    const ref = db.collection(BOOKINGS_COLLECTION).doc(booking._id);

    try {
        await ref.delete();
        return { _alreadyCancelled: false, _deleted: true };
    } catch (deleteError) {
        // Backward-compatible fallback for stricter deployed rules: mark cancelled, then delete.
        const snap = await ref.get();
        if (!snap.exists) {
            return { _alreadyCancelled: true, _deleted: true };
        }

        const proof = buildManageProofFromDocData(snap.data(), manageProof, booking);
        if (!isPossiblyValidProofForLookup(proof)) {
            throw createManagedBookingError("failed-precondition", "Lookup proof is invalid for cancellation.");
        }

        await ref.update({
            status: "cancelled",
            cancelledAt: firebase.firestore.FieldValue.serverTimestamp(),
            manageProof: proof
        });

        await ref.delete();
        return { _alreadyCancelled: false, _deleted: true };
    }
}

async function cancelManagedBooking(booking, manageProof) {
    if (!booking?._id) throw new Error("Booking id is missing.");

    if (!db) {
        cancelBookingLocally(booking._id);
        return { _savedLocallyOnly: true };
    }

    const canonicalProof = sanitizeManageProof(manageProof || {}, booking, null);

    try {
        const result = await cancelBookingInFirestore(booking, canonicalProof);
        cancelBookingLocally(booking._id);
        return { _savedLocallyOnly: false, _alreadyCancelled: !!result?._alreadyCancelled };
    } catch (error) {
        const code = String(error?.code || "").toLowerCase();

        if (code === "permission-denied") {
            try {
                const latestSnap = await db.collection(BOOKINGS_COLLECTION).doc(booking._id).get();
                if (!latestSnap.exists) {
                    throw createManagedBookingError("not-found", "Booking was not found.");
                }

                const latestData = latestSnap.data() || {};
                const latestStatus = String(latestData.status || "active").toLowerCase();
                if (latestStatus === "cancelled") {
                    cancelBookingLocally(booking._id);
                    return { _savedLocallyOnly: false, _alreadyCancelled: true };
                }

                const retryProof = buildManageProofFromDocData(latestData, canonicalProof, booking);
                if (!isPossiblyValidProofForLookup(retryProof)) {
                    throw createManagedBookingError("failed-precondition", "Lookup proof is invalid for cancellation.");
                }

                await db.collection(BOOKINGS_COLLECTION).doc(booking._id).update({
                    status: "cancelled",
                    cancelledAt: firebase.firestore.FieldValue.serverTimestamp(),
                    manageProof: retryProof
                });

                cancelBookingLocally(booking._id);
                return { _savedLocallyOnly: false, _usedFreshProofRetry: true };
            } catch (retryError) {
                if (!isFirestoreUnavailableError(retryError)) {
                    throw mapManagedBookingError(retryError);
                }
            }
        }

        if (isFirestoreUnavailableError(error)) {
            console.warn("Firestore unavailable, applying local cancellation fallback.", error);
            cancelBookingLocally(booking._id);
            return { _savedLocallyOnly: true };
        }

        throw mapManagedBookingError(error);
    }
}

async function rescheduleManagedBooking(booking, newDate, newSlot, manageProof) {
    if (!booking?._id) throw new Error("Booking id is missing.");

    const newBooking = normalizeBooking({
        ...booking,
        _id: `${newDate}_${newSlot.hour}`,
        date: newDate,
        hour: newSlot.hour,
        label: newSlot.label,
        status: "active"
    }, `${newDate}_${newSlot.hour}`);

    if (!db) {
        cancelBookingLocally(booking._id);
        addBookingLocally(newBooking);
        return newBooking;
    }

    try {
        const newBookingId = await rescheduleBookingInFirestore(booking, newDate, newSlot.hour, newSlot.label, manageProof);
        return { ...newBooking, _id: newBookingId };
    } catch (error) {
        if (isFirestoreUnavailableError(error)) {
            console.warn("Firestore unavailable, applying local reschedule fallback.", error);
            cancelBookingLocally(booking._id);
            addBookingLocally(newBooking);
            return newBooking;
        }
        throw error;
    }
}

// --- Patch booking actions ---
// Load static availability now; bookings are loaded on window.onload.
loadAvailability();

// Helper to update the UI
function render() {
    console.log('[DEBUG] render() called, view:', view, 'step:', step);
    const root = document.getElementById('app-root');
    if (!root) return;
    root.innerHTML = '';

    // Header
    const header = document.createElement('header');
    header.className = 'header';
    header.innerHTML = `
        <span class="logo" id="logo-amk">AMK CUTS</span>
        <nav class="nav">
            <button class="nav-btn${view === 'book' ? ' active' : ''}" id="nav-book">Book</button>
            <button class="nav-btn${view === 'manage' ? ' active' : ''}" id="nav-manage">Manage Booking</button>
        </nav>
    `;
    root.appendChild(header);

    // Hidden admin trigger: click logo 3 times
    if (!window._amkLogoClicks) window._amkLogoClicks = 0;
    const logo = document.getElementById('logo-amk');
    if (logo) {
        logo.onclick = () => {
            window._amkLogoClicks++;
            if (window._amkLogoClicks >= 3) {
                window._amkLogoClicks = 0;
                view = 'admin';
                render();
            }
            setTimeout(() => { window._amkLogoClicks = 0; }, 2000);
        };
    }
    const navBook = document.getElementById('nav-book');
    if (navBook) navBook.onclick = () => {
        view = 'book';
        step = 1;
        selectedService = null;
        selectedDay = null;
        selectedSlot = null;
        clientInfo = { name: '', phone: '', email: '' };
        render();
    };
    const navManage = document.getElementById('nav-manage');
    if (navManage) navManage.onclick = () => {
        view = 'manage';
        manageStep = 1;
        foundBookings = [];
        bookingToEdit = null;
        manageLookupPhone = "";
        manageLookupCode = "";
        render();
    };

    // Main
    const main = document.createElement('main');
    main.className = 'main';

    if (view === 'book') {
        // Step bar
        if (step < 4) {
            const stepBar = document.createElement('div');
            stepBar.className = 'step-bar';
            for (let s = 1; s <= 3; s++) {
                const dot = document.createElement('div');
                dot.className = 'step-dot' + (step > s ? ' done' : step === s ? ' active' : '');
                dot.textContent = s;
                stepBar.appendChild(dot);
                if (s < 3) {
                    const line = document.createElement('div');
                    line.className = 'step-line' + (step > s ? ' done' : '');
                    stepBar.appendChild(line);
                }
            }
            main.appendChild(stepBar);
        }
        // Step 1: Choose Service
        if (step === 1) {
            const title = document.createElement('div');
            title.className = 'section-title';
            title.textContent = 'Choose a Service';
            main.appendChild(title);
            const grid = document.createElement('div');
            grid.className = 'service-grid';
            SERVICES.forEach(s => {
                const card = document.createElement('div');
                card.className = 'service-card' + (selectedService && selectedService.id === s.id ? ' selected' : '');
                card.innerHTML = `<div class="service-name">${s.name}</div>`;
                card.onclick = () => { selectedService = s; render(); };
                grid.appendChild(card);
            });
            main.appendChild(grid);
            const btnRow = document.createElement('div');
            btnRow.className = 'btn-row';
            const nextBtn = document.createElement('button');
            nextBtn.className = 'btn';
            nextBtn.textContent = 'Next';
            nextBtn.disabled = !selectedService;
            nextBtn.onclick = () => { step = 2; render(); };
            btnRow.appendChild(nextBtn);
            main.appendChild(btnRow);
            // Pricing
            const pricing = document.createElement('div');
            pricing.className = 'pricing-table';
            pricing.innerHTML = `
                <div class="pricing-table-title">${PRICING.address}</div>
                <div class="pricing-row"><span>Any Haircut</span><span>${PRICING.haircut}</span></div>
                <div class="pricing-row"><span>Add Beard</span><span>${PRICING.beard}</span></div>
            `;
            main.appendChild(pricing);
        }
        // Step 2: Pick Day & Time
        if (step === 2) {
            const title = document.createElement('div');
            title.className = 'section-title';
            title.textContent = 'Pick a Day & Time';
            main.appendChild(title);
            // Days
            const dayScroll = document.createElement('div');
            dayScroll.className = 'day-scroll';
            const nextDays = getNextDays(14);
            const availableDays = nextDays.filter(d => availability[d.getDay()]?.open);
            availableDays.forEach(d => {
                const chip = document.createElement('div');
                chip.className = 'day-chip' + (selectedDay && getDayKey(selectedDay) === getDayKey(d) ? ' selected' : '');
                chip.innerHTML = `<div class="dow">${DAYS[d.getDay()]}</div><div class="date-num">${d.getDate()}</div><div class="month">${d.toLocaleString('default', { month: 'short' })}</div>`;
                chip.onclick = () => { selectedDay = d; selectedSlot = null; render(); };
                dayScroll.appendChild(chip);
            });
            main.appendChild(dayScroll);
            // Slots
            if (selectedDay) {
                const slotGrid = document.createElement('div');
                slotGrid.className = 'slot-grid';
                const slots = (() => {
                    const dow = selectedDay.getDay();
                    const av = availability[dow];
                    if (!av || !av.open) return [];
                    const bookedHours = (bookings[getDayKey(selectedDay)] || []).map(b => b.hour);
                    return generateSlots(av.start, av.end, selectedService?.duration || 30, bookedHours);
                })();
                slots.forEach(slot => {
                    const btn = document.createElement('button');
                    btn.className = 'slot-btn' + (selectedSlot && selectedSlot.hour === slot.hour ? ' selected' : '');
                    btn.textContent = slot.label;
                    btn.disabled = !slot.available;
                    btn.onclick = () => { selectedSlot = slot; render(); };
                    slotGrid.appendChild(btn);
                });
                if (slots.length === 0) {
                    const noSlots = document.createElement('div');
                    noSlots.style.gridColumn = '1/-1';
                    noSlots.style.color = '#888';
                    noSlots.style.textAlign = 'center';
                    noSlots.textContent = 'No slots available.';
                    slotGrid.appendChild(noSlots);
                }
                main.appendChild(slotGrid);
            }
            // Buttons
            const btnRow = document.createElement('div');
            btnRow.className = 'btn-row';
            const backBtn = document.createElement('button');
            backBtn.className = 'btn-outline';
            backBtn.textContent = '← Back';
            backBtn.onclick = () => { step = 1; render(); };
            btnRow.appendChild(backBtn);
            const nextBtn = document.createElement('button');
            nextBtn.className = 'btn';
            nextBtn.textContent = 'Next';
            nextBtn.disabled = !(selectedDay && selectedSlot);
            nextBtn.onclick = () => { step = 3; render(); };
            btnRow.appendChild(nextBtn);
            main.appendChild(btnRow);
        }
        // Step 3: Your Details
        if (step === 3) {
            const title = document.createElement('div');
            title.className = 'section-title';
            title.textContent = 'Your Details';
            main.appendChild(title);
            // Name
            const groupName = document.createElement('div');
            groupName.className = 'form-group';
            groupName.innerHTML = '<label>Full Name</label>';
            const nameInput = document.createElement('input');
            nameInput.placeholder = 'Jordan Smith';
            nameInput.value = clientInfo.name;
            groupName.appendChild(nameInput);
            main.appendChild(groupName);
            // Phone
            const groupPhone = document.createElement('div');
            groupPhone.className = 'form-group';
            groupPhone.innerHTML = '<label>Phone Number</label>';
            const phoneInput = document.createElement('input');
            phoneInput.placeholder = '(555) 000-0000';
            phoneInput.value = clientInfo.phone;
            groupPhone.appendChild(phoneInput);
            main.appendChild(groupPhone);
            // Email
            const groupEmail = document.createElement('div');
            groupEmail.className = 'form-group';
            groupEmail.innerHTML = '<label>Email (for reminder)</label>';
            const emailInput = document.createElement('input');
            emailInput.placeholder = 'you@email.com';
            emailInput.value = clientInfo.email;
            groupEmail.appendChild(emailInput);
            main.appendChild(groupEmail);
            // Reminder note
            const reminder = document.createElement('div');
            reminder.className = 'reminder-note';
            reminder.textContent = 'A reminder will be sent to your email 24 hours before.';
            main.appendChild(reminder);
            // Buttons
            const btnRow = document.createElement('div');
            btnRow.className = 'btn-row';
            const backBtn = document.createElement('button');
            backBtn.className = 'btn-outline';
            backBtn.textContent = '← Back';
            backBtn.onclick = () => { step = 2; render(); };
            btnRow.appendChild(backBtn);
            const bookBtn = document.createElement('button');
            bookBtn.className = 'btn';
            bookBtn.textContent = 'Book';
            bookBtn.disabled = !(clientInfo.name && clientInfo.phone);
            bookBtn.onclick = async () => {
                // Confirm booking
                if (!selectedDay || !selectedSlot || !selectedService) return;
                const booking = {
                    hour: selectedSlot.hour,
                    label: selectedSlot.label,
                    bookingCode: generateBookingCode(),
                    client: { ...clientInfo },
                    service: selectedService,
                    date: getDayKey(selectedDay)
                };

                bookBtn.disabled = true;
                try {
                    let savedBooking;
                    if (typeof addBooking === "function") {
                        savedBooking = await addBooking(booking);
                    } else {
                        console.warn("addBooking is unavailable at runtime; using local fallback.");
                        const localBooking = { ...normalizeBooking(booking), _id: `${booking.date}_${booking.hour}`, status: "active" };
                        addBookingLocally(localBooking);
                        savedBooking = { ...localBooking, _savedLocallyOnly: true };
                    }
                    lastBookingCode = savedBooking?.bookingCode || booking.bookingCode;
                    lastBookingSavedLocally = !!savedBooking?._savedLocallyOnly;
                    sendBookingEmail();
                    step = 4;
                    render();
                } catch (error) {
                    console.error("Booking failed:", error);
                    render();
                    alert(error?.message || "Could not save booking. Please try again.");
                }
            };
            btnRow.appendChild(bookBtn);
            main.appendChild(btnRow);
            // --- Input event handlers for smooth typing ---
            nameInput.oninput = function (e) {
                clientInfo.name = e.target.value;
                bookBtn.disabled = !(clientInfo.name && clientInfo.phone);
            };
            phoneInput.oninput = function (e) {
                clientInfo.phone = e.target.value;
                bookBtn.disabled = !(clientInfo.name && clientInfo.phone);
            };
            emailInput.oninput = function (e) {
                clientInfo.email = e.target.value;
            };
        }
        // Step 4: Confirmation
        if (step === 4) {
            const card = document.createElement('div');
            card.className = 'confirm-card';
            card.innerHTML = `
                <div class="checkmark">✔️</div>
                <h2>You're Booked!</h2>
                <p>See you soon, ${clientInfo.name.split(' ')[0] || ''}.</p>
                <div class="confirm-detail">
                    <div class="confirm-row"><span>Service</span><span>${selectedService?.name || ''}</span></div>
                    <div class="confirm-row"><span>Date</span><span>${selectedDay?.toLocaleDateString()}</span></div>
                    <div class="confirm-row"><span>Time</span><span>${selectedSlot?.label || ''}</span></div>
                    <div class="confirm-row"><span>Booking code</span><span>${lastBookingCode || '-'}</span></div>
                    ${clientInfo.email ? `<div class="confirm-row"><span>Reminder sent to</span><span>${clientInfo.email}</span></div>` : ''}
                </div>
                <p style="color:#555;font-size:12px">Keep your booking code. You need it to manage this appointment later.</p>
                ${lastBookingSavedLocally ? '<p style="color:#fbbf24;font-size:12px;margin-top:8px">Saved locally on this device because Firebase is unavailable right now.</p>' : ''}
                <div style="margin-top:24px"><button class="btn" id="book-another">Book Another</button></div>
            `;
            main.appendChild(card);
            setTimeout(() => {
                const btn = document.getElementById('book-another');
                if (btn) btn.onclick = () => {
                    step = 1;
                    selectedService = null;
                    selectedDay = null;
                    selectedSlot = null;
                    clientInfo = { name: '', phone: '', email: '' };
                    lastBookingCode = '';
                    lastBookingSavedLocally = false;
                    render();
                };
            }, 0);
        }
    } else if (view === 'admin') {
        // Admin login
        if (!adminUnlocked) {
            const login = document.createElement('div');
            login.className = 'admin-login';
            login.innerHTML = `
                <h2>ADMIN ACCESS</h2>
                <p>Enter your password to manage your schedule.</p>
                <div class="form-group"><input type="password" id="admin-pass" placeholder="Password"></div>
                ${adminError ? `<div class="error-msg">${adminError}</div>` : ''}
                <div style="margin-top:16px"><button class="btn" id="unlock-admin" style="width:100%">Unlock</button></div>
            `;
            main.appendChild(login);
            setTimeout(() => {
                document.getElementById('unlock-admin').onclick = () => {
                    const pass = document.getElementById('admin-pass').value;
                    if (pass === PASSWORD) {
                        adminUnlocked = true;
                        adminError = '';
                    } else {
                        adminError = 'Incorrect password.';
                    }
                    render();
                };
            }, 0);
        } else {
            // Admin panel
            const hero = document.createElement('div');
            hero.className = 'hero';
            hero.style.marginBottom = '32px';
            hero.innerHTML = '<h1>AMK <span class="gold">SCHEDULE</span></h1>';
            main.appendChild(hero);
            // Tabs
            const tabs = document.createElement('div');
            tabs.className = 'tabs';
            tabs.innerHTML = `
                <button class="tab-btn${adminTab === 'schedule' ? ' active' : ''}" id="tab-schedule">Schedule</button>
                <button class="tab-btn${adminTab === 'appointments' ? ' active' : ''}" id="tab-appointments">Appointments</button>
            `;
            main.appendChild(tabs);
            setTimeout(() => {
                document.getElementById('tab-schedule').onclick = () => { adminTab = 'schedule'; render(); };
                document.getElementById('tab-appointments').onclick = () => { adminTab = 'appointments'; render(); };
            }, 0);
            if (adminTab === 'schedule') {
                // Weekly hours table
                const title = document.createElement('div');
                title.className = 'section-title';
                title.textContent = 'Weekly Hours';
                main.appendChild(title);
                const table = document.createElement('table');
                table.className = 'avail-table';
                table.innerHTML = `<thead><tr><th>Day</th><th>Open</th><th>From</th><th>To</th></tr></thead><tbody></tbody>`;
                const tbody = table.querySelector('tbody');
                FULL_DAYS.forEach((day, i) => {
                    const av = availability[i];
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td><span class="day-label">${day}</span></td>
                        <td><label class="toggle"><input type="checkbox" id="open-${i}"${av.open ? ' checked' : ''}><span class="toggle-slider"></span></label></td>
                        <td><select class="time-select" id="start-${i}"${!av.open ? ' disabled' : ''}>${HOURS.slice(5, 21).map(h => `<option value="${h.value}"${h.value === av.start ? ' selected' : ''}>${h.label}</option>`).join('')}</select></td>
                        <td><select class="time-select" id="end-${i}"${!av.open ? ' disabled' : ''}>${HOURS.slice(5, 23).map(h => `<option value="${h.value}"${h.value === av.end ? ' selected' : ''}>${h.label}</option>`).join('')}</select></td>
                    `;
                    tbody.appendChild(tr);
                });
                main.appendChild(table);
                setTimeout(() => {
                    FULL_DAYS.forEach((day, i) => {
                        document.getElementById(`open-${i}`).onchange = e => {
                            availability[i].open = e.target.checked;
                            saveAvailability();
                            render();
                        };
                        document.getElementById(`start-${i}`).onchange = e => {
                            availability[i].start = parseInt(e.target.value);
                            saveAvailability();
                            render();
                        };
                        document.getElementById(`end-${i}`).onchange = e => {
                            availability[i].end = parseInt(e.target.value);
                            saveAvailability();
                            render();
                        };
                    });
                }, 0);
                const note = document.createElement('p');
                note.style.color = '#444';
                note.style.fontSize = '12px';
                note.style.marginTop = '16px';
                note.textContent = 'Changes apply immediately.';
                main.appendChild(note);
            }
            if (adminTab === 'appointments') {
                const title = document.createElement('div');
                title.className = 'section-title';
                title.textContent = 'Upcoming Appointments';
                main.appendChild(title);
                // Flatten bookings
                const allBookings = Object.entries(bookings).flatMap(([date, appts]) =>
                    appts.map(a => ({ ...a, date }))
                ).sort((a, b) => a.date.localeCompare(b.date));
                if (allBookings.length === 0) {
                    const empty = document.createElement('div');
                    empty.className = 'empty-state';
                    empty.innerHTML = '<div>📅</div>No appointments yet.';
                    main.appendChild(empty);
                } else {
                    const list = document.createElement('div');
                    list.className = 'appt-list';
                    allBookings.forEach(appt => {
                        const item = document.createElement('div');
                        item.className = 'appt-item';
                        item.innerHTML = `
                            <div>
                                <div class="appt-name">${appt.client.name}</div>
                                <div class="appt-meta">${new Date(appt.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</div>
                                <div class="appt-meta">${appt.client.phone}${appt.client.email ? ' | ' + appt.client.email : ''}</div>
                                <div><span class="appt-badge">${appt.service.name}</span></div>
                            </div>
                        `;
                        list.appendChild(item);
                    });
                    main.appendChild(list);
                }
            }
        }
    } else if (view === 'manage') {
        // Step 1: Enter phone number
        if (manageStep === 1) {
            const title = document.createElement('div');
            title.className = 'section-title';
            title.textContent = 'Find Your Booking';
            main.appendChild(title);
            const group = document.createElement('div');
            group.className = 'form-group';
            group.innerHTML = '<label>Phone Number</label>';
            const phoneInput = document.createElement('input');
            phoneInput.placeholder = '(555) 000-0000';
            phoneInput.value = manageLookupPhone;
            group.appendChild(phoneInput);
            main.appendChild(group);

            const codeGroup = document.createElement('div');
            codeGroup.className = 'form-group';
            codeGroup.innerHTML = '<label>Booking Code</label>';
            const codeInput = document.createElement('input');
            codeInput.placeholder = '6-digit code';
            codeInput.value = manageLookupCode;
            codeGroup.appendChild(codeInput);
            main.appendChild(codeGroup);

            const hint = document.createElement('p');
            hint.style.color = '#888';
            hint.style.fontSize = '12px';
            hint.style.marginTop = '6px';
            hint.textContent = 'Enter the same phone number and booking code used at checkout.';
            main.appendChild(hint);

            const btnRow = document.createElement('div');
            btnRow.className = 'btn-row';
            const findBtn = document.createElement('button');
            findBtn.className = 'btn';
            findBtn.textContent = 'Find Booking';
            findBtn.onclick = async () => {
                const targetPhone = normalizePhone(phoneInput.value);
                const targetCode = String(codeInput.value || '').trim();

                if (!isValidManageLookupInput(targetPhone, targetCode)) {
                    alert('Enter a valid phone number and 6-digit booking code.');
                    return;
                }

                if (Date.now() - lastManageLookupAt < MANAGE_LOOKUP_COOLDOWN_MS) {
                    alert('Please wait a few seconds before trying again.');
                    return;
                }

                findBtn.disabled = true;
                manageLookupPhone = phoneInput.value;
                manageLookupCode = targetCode;
                lastManageLookupAt = Date.now();

                try {
                    foundBookings = await findBookingsByPhoneAndCode(phoneInput.value, targetCode);
                    manageStep = 2;
                    render();
                } catch (error) {
                    console.error('Failed to find bookings:', error);
                    findBtn.disabled = false;
                    alert(error?.message || 'Could not find bookings right now. Please try again.');
                }
            };
            btnRow.appendChild(findBtn);
            main.appendChild(btnRow);
        }

        // Step 2: Show bookings
        if (manageStep === 2) {
            const title = document.createElement('div');
            title.className = 'section-title';
            title.textContent = 'Your Appointments';
            main.appendChild(title);
            if (foundBookings.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'empty-state';
                empty.innerHTML = '<div>😕</div>No bookings found for this phone.';
                main.appendChild(empty);
            } else {
                foundBookings.forEach((appt, i) => {
                    const item = document.createElement('div');
                    item.className = 'appt-item';
                    item.innerHTML = `
                        <div>
                            <div class="appt-name">${appt.client.name}</div>
                            <div class="appt-meta">${new Date(appt.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</div>
                            <div class="appt-meta">${appt.client.phone}${appt.client.email ? ' | ' + appt.client.email : ''}</div>
                            <div><span class="appt-badge">${appt.service.name}</span></div>
                        </div>
                        <div class="btn-row" style="margin-top:10px;">
                            <button class="btn-outline" id="cancel-${i}">Cancel</button>
                            <button class="btn" id="resched-${i}">Reschedule</button>
                        </div>
                    `;
                    main.appendChild(item);
                    setTimeout(() => {
                        document.getElementById(`cancel-${i}`).onclick = async () => {
                            try {
                                await cancelManagedBooking(appt, getManageProof(appt));
                                await loadBookingsFromFirestore();
                                manageStep = 3;
                                render();
                            } catch (error) {
                                console.error("Failed to cancel booking:", error);
                                alert(error?.message || "Could not cancel this booking right now.");
                            }
                        };
                        document.getElementById(`resched-${i}`).onclick = () => {
                            bookingToEdit = appt;
                            manageStep = 4;
                            render();
                        };
                    }, 0);
                });
            }
            const btnRow = document.createElement('div');
            btnRow.className = 'btn-row';
            const backBtn = document.createElement('button');
            backBtn.className = 'btn-outline';
            backBtn.textContent = '← Back';
            backBtn.onclick = () => { manageStep = 1; render(); };
            btnRow.appendChild(backBtn);
            main.appendChild(btnRow);
        }
        // Step 3: Cancelled
        if (manageStep === 3) {
            const card = document.createElement('div');
            card.className = 'confirm-card';
            card.innerHTML = `<div class="checkmark">❌</div><h2>Booking Cancelled</h2><p>Your appointment has been cancelled.</p><div style="margin-top:24px"><button class="btn" id="back-manage">Back</button></div>`;
            main.appendChild(card);
            setTimeout(() => {
                document.getElementById('back-manage').onclick = () => { manageStep = 1; render(); };
            }, 0);
        }
        // Step 4: Reschedule
        if (manageStep === 4 && bookingToEdit) {
            const title = document.createElement('div');
            title.className = 'section-title';
            title.textContent = 'Reschedule Appointment';
            main.appendChild(title);
            // Pick new day
            const dayScroll = document.createElement('div');
            dayScroll.className = 'day-scroll';
            const nextDays = getNextDays(14);
            const availableDays = nextDays.filter(d => availability[d.getDay()]?.open);
            availableDays.forEach(d => {
                const chip = document.createElement('div');
                chip.className = 'day-chip' + (bookingToEdit._newDay && getDayKey(bookingToEdit._newDay) === getDayKey(d) ? ' selected' : '');
                chip.innerHTML = `<div class="dow">${DAYS[d.getDay()]}</div><div class="date-num">${d.getDate()}</div><div class="month">${d.toLocaleString('default', { month: 'short' })}</div>`;
                chip.onclick = () => { bookingToEdit._newDay = d; bookingToEdit._newSlot = null; render(); };
                dayScroll.appendChild(chip);
            });
            main.appendChild(dayScroll);
            // Pick new slot
            if (bookingToEdit._newDay) {
                const slotGrid = document.createElement('div');
                slotGrid.className = 'slot-grid';
                const slots = (() => {
                    const dow = bookingToEdit._newDay.getDay();
                    const av = availability[dow];
                    if (!av || !av.open) return [];
                    const bookedHours = (bookings[getDayKey(bookingToEdit._newDay)] || []).map(b => b.hour);
                    return generateSlots(av.start, av.end, bookingToEdit.service?.duration || 30, bookedHours);
                })();
                slots.forEach(slot => {
                    const btn = document.createElement('button');
                    btn.className = 'slot-btn' + (bookingToEdit._newSlot && bookingToEdit._newSlot.hour === slot.hour ? ' selected' : '');
                    btn.textContent = slot.label;
                    btn.disabled = !slot.available;
                    btn.onclick = () => { bookingToEdit._newSlot = slot; render(); };
                    slotGrid.appendChild(btn);
                });
                if (slots.length === 0) {
                    const noSlots = document.createElement('div');
                    noSlots.style.gridColumn = '1/-1';
                    noSlots.style.color = '#888';
                    noSlots.style.textAlign = 'center';
                    noSlots.textContent = 'No slots available.';
                    slotGrid.appendChild(noSlots);
                }
                main.appendChild(slotGrid);
            }
            // Confirm reschedule
            const btnRow = document.createElement('div');
            btnRow.className = 'btn-row';
            const backBtn = document.createElement('button');
            backBtn.className = 'btn-outline';
            backBtn.textContent = '← Back';
            backBtn.onclick = () => { manageStep = 2; render(); };
            btnRow.appendChild(backBtn);
            const confirmBtn = document.createElement('button');
            confirmBtn.className = 'btn';
            confirmBtn.textContent = 'Confirm';
            confirmBtn.disabled = !(bookingToEdit._newDay && bookingToEdit._newSlot);
            confirmBtn.onclick = async () => {
                try {
                    await rescheduleManagedBooking(
                        bookingToEdit,
                        getDayKey(bookingToEdit._newDay),
                        bookingToEdit._newSlot,
                        getManageProof(bookingToEdit)
                    );
                    await loadBookingsFromFirestore();
                    manageStep = 5;
                    render();
                } catch (error) {
                    console.error("Failed to reschedule booking:", error);
                    alert(error?.message || "Could not reschedule this booking.");
                }
            };
            btnRow.appendChild(confirmBtn);
            main.appendChild(btnRow);
        }
        // Step 5: Rescheduled
        if (manageStep === 5) {
            const card = document.createElement('div');
            card.className = 'confirm-card';
            card.innerHTML = `<div class="checkmark">🔄</div><h2>Booking Rescheduled</h2><p>Your appointment has been updated.</p><div style="margin-top:24px"><button class="btn" id="back-manage">Back</button></div>`;
            main.appendChild(card);
            setTimeout(() => {
                document.getElementById('back-manage').onclick = () => { manageStep = 1; render(); };
            }, 0);
        }
        root.appendChild(main);
        return;
    }
    root.appendChild(main);

    // Nav events
    setTimeout(() => {
        const navBook = document.getElementById('nav-book');
        if (navBook) navBook.onclick = () => { view = 'book'; step = 1; render(); };
    }, 0);
}

// Event handlers (to be attached to DOM elements)
// Example: document.getElementById('service-btn').onclick = ...

// On page load, fetch bookings before first render so availability is correct.
window.onload = async function () {
    render();

    try {
        await Promise.all([
            loadBookingsFromFirestore(),
            loadAvailabilityFromFirestore()
        ]);
    } catch (error) {
        console.error("Initial data load failed:", error);
    }

    render();
};

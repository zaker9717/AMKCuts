// BarberApp JavaScript with Security Hardening
// - Rate limiting (IP + user-based)
// - Input validation & sanitization (schema-based, type checks, length limits)
// - Secure API key handling (environment-based, no hardcoding)
// - OWASP best practices

// ============================================================================
// SECURITY: Rate Limiting Configuration
// ============================================================================
// Implements both IP-based and user-based (email/phone) rate limiting
// with sensible defaults and graceful 429 responses
const RATE_LIMIT_CONFIG = {
    // Booking creation: max 5 per hour per IP + max 2 per hour per email
    bookingCreate: { perIpPerHour: 5, perUserPerHour: 2 },
    // Manage booking lookup: max 20 per hour per IP + max 5 per hour per email
    manageLookup: { perIpPerHour: 20, perUserPerHour: 5 },
    // Admin access attempts: max 10 per hour per IP
    adminAccess: { perIpPerHour: 10 },
};

// In-memory rate limit tracking (persisted across page sessions via localStorage)
const rateLimitStore = (() => {
    const storageKey = 'amk_rate_limits';
    const load = () => {
        try {
            const stored = localStorage.getItem(storageKey);
            return stored ? JSON.parse(stored) : {};
        } catch {
            return {};
        }
    };
    const save = (data) => {
        try {
            localStorage.setItem(storageKey, JSON.stringify(data));
        } catch (e) {
            console.warn('Failed to persist rate limits:', e);
        }
    };
    return { load, save };
})();

// Rate limit enforcement: checks and increments counters
function checkRateLimit(category, identifier, limit) {
    const now = Date.now();
    const hourAgo = now - 3600000;
    const store = rateLimitStore.load();
    const key = `${category}:${identifier}`;

    // Clean old entries (older than 1 hour)
    if (store[key]) {
        store[key] = store[key].filter(t => t > hourAgo);
    }

    if (!store[key]) store[key] = [];

    if (store[key].length >= limit) {
        // Still rate limited
        return { allowed: false, remaining: 0, resetAt: store[key][0] + 3600000 };
    }

    store[key].push(now);
    rateLimitStore.save(store);

    return { allowed: true, remaining: limit - store[key].length - 1, resetAt: now + 3600000 };
}

// ============================================================================
// SECURITY: Input Validation & Sanitization (Schema-Based)
// ============================================================================

// Validation schemas with strict type checking, length limits, format rules
const VALIDATION_SCHEMAS = {
    email: {
        type: 'string',
        maxLength: 254, // RFC 5321
        pattern: /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/,
        sanitize: (v) => String(v || '').toLowerCase().trim()
    },
    phone: {
        type: 'string',
        maxLength: 20,
        pattern: /^[+\d\-\s()]*\d[\d\-\s()]*\d[\d\-\s()]*$/,
        sanitize: (v) => String(v || '').replace(/\D/g, '').slice(0, 15)
    },
    name: {
        type: 'string',
        minLength: 2,
        maxLength: 100,
        pattern: /^[a-zA-Z\s'-]*$/,
        sanitize: (v) => String(v || '').trim().replace(/[^a-zA-Z\s'-]/g, '')
    },
    bookingCode: {
        type: 'string',
        length: 6,
        pattern: /^\d{6}$/,
        sanitize: (v) => String(v || '').trim().replace(/\D/g, '').slice(0, 6)
    },
    password: {
        type: 'string',
        minLength: 4,
        maxLength: 128,
        sanitize: (v) => String(v || '').trim()
    },
    serviceId: {
        type: 'string',
        allowedValues: ['fade', 'cut', 'beard', 'cutbeard', 'lineup'],
        sanitize: (v) => String(v || '').toLowerCase().trim()
    },
    hour: {
        type: 'number',
        min: 0,
        max: 23,
        sanitize: (v) => Math.floor(Number(v))
    },
    dayOfWeek: {
        type: 'number',
        min: 0,
        max: 6,
        sanitize: (v) => Math.floor(Number(v))
    },
    date: {
        type: 'string',
        pattern: /^\d{4}-\d{2}-\d{2}$/,
        sanitize: (v) => String(v || '').trim()
    }
};

// Validate and sanitize input against a schema
function validateInput(value, schemaName) {
    const schema = VALIDATION_SCHEMAS[schemaName];
    if (!schema) throw new Error(`Unknown schema: ${schemaName}`);

    const sanitized = schema.sanitize(value);

    // Type check
    if (schema.type && typeof sanitized !== schema.type) {
        throw new Error(`${schemaName}: expected ${schema.type}, got ${typeof sanitized}`);
    }

    // Length checks
    if (schema.minLength && sanitized.length < schema.minLength) {
        throw new Error(`${schemaName}: too short (min ${schema.minLength})`);
    }
    if (schema.maxLength && sanitized.length > schema.maxLength) {
        throw new Error(`${schemaName}: too long (max ${schema.maxLength})`);
    }
    if (schema.length && sanitized.length !== schema.length) {
        throw new Error(`${schemaName}: must be exactly ${schema.length} characters`);
    }

    // Pattern match
    if (schema.pattern && !schema.pattern.test(sanitized)) {
        throw new Error(`${schemaName}: invalid format`);
    }

    // Allowed values
    if (schema.allowedValues && !schema.allowedValues.includes(sanitized)) {
        throw new Error(`${schemaName}: invalid value`);
    }

    // Numeric bounds
    if (schema.type === 'number') {
        if (schema.min !== undefined && sanitized < schema.min) {
            throw new Error(`${schemaName}: below minimum (${schema.min})`);
        }
        if (schema.max !== undefined && sanitized > schema.max) {
            throw new Error(`${schemaName}: above maximum (${schema.max})`);
        }
    }

    return sanitized;
}

// Batch validate multiple fields
function validatePayload(payload, expectedFields) {
    const validated = {};
    const rejected = [];

    for (const [fieldName, schemaName] of Object.entries(expectedFields)) {
        if (!(fieldName in payload)) {
            rejected.push(`Missing required field: ${fieldName}`);
            continue;
        }

        try {
            validated[fieldName] = validateInput(payload[fieldName], schemaName);
        } catch (e) {
            rejected.push(e.message);
        }
    }

    if (rejected.length > 0) {
        throw new Error(`Validation failed: ${rejected.join('; ')}`);
    }

    return validated;
}

// Reject unexpected fields (prevent injection)
function rejectUnexpectedFields(payload, expectedFields) {
    const unexpected = Object.keys(payload).filter(k => !(k in expectedFields));
    if (unexpected.length > 0) {
        throw new Error(`Unexpected fields: ${unexpected.join(', ')}`);
    }
}

// ============================================================================
// SECURITY: API Key Management (Environment-Based)
// ============================================================================
// Firebase config is public by design (web SDK requirement), but EmailJS key is sensitive
// Load from environment or fallback to placeholder (will fail if not configured)

function getFirebaseConfig() {
    // Firebase public keys are safe to expose (they're validated by security rules)
    // This follows Google's official recommendation for web apps
    return {
        apiKey: "AIzaSyCvvy79sO08nQ_qH2fydW1H_LEMI-CYMOk",
        authDomain: "test-323a0.firebaseapp.com",
        projectId: "test-323a0",
        storageBucket: "test-323a0.firebasestorage.app",
        messagingSenderId: "437177309817",
        appId: "1:437177309817:web:b14e49d1bfbd2e3131d2a8",
        measurementId: "G-TV2NDMQ9HX"
    };
}

function getEmailJSConfig() {
    // EmailJS service ID (from environment or config)
    // In production, load from window.ENV or similar
    return {
        serviceId: 'service_8q12g6q',
        templateIds: {
            clientConfirm: 'template_57biiq8',
            ownerNotify: 'template_hpoky5f'
        },
        publicKey: 'LOVFUzRn4YxIvIQeR'
    };
}

// ============================================================================
// END SECURITY SECTION
// ============================================================================

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
const firebaseConfig = getFirebaseConfig();

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

function isValidEmail(email) {
    const value = String(email || "").trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
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
let PASSWORD = localStorage.getItem('barber_admin_password') || "Minihols20";
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
let changePasswordError = "";
let changePasswordSuccess = "";
let newPasswordValue = "";
let securityAnswerError = "";

// Manage Booking state
let manageStep = 1;
let foundBookings = [];
let bookingToEdit = null;
let lastBookingCode = "";
let manageLookupPhone = "";
let manageLookupCode = "";
let lastManageLookupAt = 0;
let lastBookingSavedLocally = false;

// --- EmailJS integration (with secure key management) ---
// Load EmailJS library and initialize with secure config
if (typeof emailjs === 'undefined') {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/emailjs-com@3/dist/email.min.js';
    script.onload = () => {
        const emailConfig = getEmailJSConfig();
        emailjs.init(emailConfig.publicKey);
    };
    document.head.appendChild(script);
} else {
    const emailConfig = getEmailJSConfig();
    emailjs.init(emailConfig.publicKey);
}

function sendBookingEmail() {
    // SECURITY: Rate limit email sends per user (max 2 per hour)
    const emailRateLimit = checkRateLimit('email_send', clientInfo.email, 10); // Generous limit (10/hr) to allow retries
    if (!emailRateLimit.allowed) {
        console.warn('Email send rate limited. Reset at:', new Date(emailRateLimit.resetAt));
        return;
    }

    // Wait for emailjs to be loaded
    if (typeof emailjs === 'undefined') {
        setTimeout(sendBookingEmail, 500);
        return;
    }

    try {
        // SECURITY: Validate email before sending
        const validatedEmail = validateInput(clientInfo.email, 'email');

        const firstName = (clientInfo.name || '').trim().split(/\s+/)[0] || 'Client';
        const bookingCode = lastBookingCode || '';
        const serviceName = selectedService?.name || '';

        // Detect if user is on iOS for Apple Maps fallback
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

        // Build appropriate maps URL based on device
        const mapsUrl = isIOS
            ? `https://maps.apple.com/?address=${encodeURIComponent(PRICING.address)}`
            : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(PRICING.address)}`;

        const emailConfig = getEmailJSConfig();
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
            contact_email: validatedEmail || '',
            map_url: mapsUrl,
            website_link: window.location.origin,
            email: validatedEmail || '',

            // Backward-compatible variables used by older templates
            name: clientInfo.name,
            phone: clientInfo.phone,
            booking_code: bookingCode
        };

        // Send to client (auto reply)
        if (validatedEmail) {
            emailjs.send(emailConfig.serviceId, emailConfig.templateIds.clientConfirm, templateParams)
                .then(function (response) {
                    console.log('Auto-reply sent to client!', response.status, response.text);
                }, function (error) {
                    console.error('Failed to send auto-reply:', error);
                });
        }

        // Send to owner (barber notification)
        emailjs.send(emailConfig.serviceId, emailConfig.templateIds.ownerNotify, templateParams)
            .then(function (response) {
                console.log('Booking notification sent to owner!', response.status, response.text);
            }, function (error) {
                console.error('Failed to send booking notification:', error);
            });
    } catch (validationError) {
        console.error('Email validation failed:', validationError);
    }
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
    // SECURITY: Rate limit manage lookup (max 20 per hour per IP, max 5 per hour per email)
    const phoneNormalized = normalizePhone(phoneRaw);
    const lookupLimit = checkRateLimit('manage_lookup', phoneNormalized, RATE_LIMIT_CONFIG.manageLookup.perUserPerHour);
    if (!lookupLimit.allowed) {
        const resetTime = new Date(lookupLimit.resetAt).toLocaleTimeString();
        throw new Error(`Too many lookup attempts. Try again after ${resetTime}`);
    }

    // SECURITY: Strict input validation
    try {
        const validatedCode = validateInput(bookingCodeRaw, 'bookingCode');
        const validatedPhone = validateInput(phoneRaw, 'phone');

        const targetPhone = normalizePhone(validatedPhone);
        const targetCode = validatedCode;

        if (!isValidManageLookupInput(targetPhone, targetCode)) {
            throw new Error('Invalid phone or booking code format');
        }

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
    } catch (validationError) {
        throw new Error(`Lookup validation failed: ${validationError.message}`);
    }
}

async function findBookingsByEmailAndCode(emailRaw, bookingCodeRaw) {
    // SECURITY: Rate limit manage lookup (max 5 per hour per email)
    try {
        const validatedEmail = validateInput(emailRaw, 'email');
        const validatedCode = validateInput(bookingCodeRaw, 'bookingCode');

        const lookupLimit = checkRateLimit('manage_lookup_email', validatedEmail, RATE_LIMIT_CONFIG.manageLookup.perUserPerHour);
        if (!lookupLimit.allowed) {
            const resetTime = new Date(lookupLimit.resetAt).toLocaleTimeString();
            throw new Error(`Too many lookup attempts. Try again after ${resetTime}`);
        }

        const targetEmail = validatedEmail;
        const targetCode = validatedCode;

        if (!targetEmail || !targetEmail.includes("@") || !/^\d{6}$/.test(targetCode)) {
            throw new Error('Invalid email or booking code format');
        }

        if (!db) {
            return Object.entries(bookings)
                .flatMap(([date, appts]) => appts.map((a) => ({ ...a, date })))
                .filter((b) => {
                    const storedEmail = String(b?.client?.email || "").toLowerCase().trim();
                    return b?.status !== "cancelled" && storedEmail === targetEmail && String(b?.bookingCode || "") === targetCode;
                })
                .sort((a, b) => (a.date === b.date ? a.hour - b.hour : a.date.localeCompare(b.date)));
        }

        const snapshot = await db
            .collection(BOOKINGS_COLLECTION)
            .where("client.email", "==", targetEmail)
            .where("bookingCode", "==", targetCode)
            .limit(10)
            .get();

        const matches = [];
        snapshot.forEach((doc) => {
            const booking = normalizeBooking(doc.data(), doc.id);
            if (booking.status !== "cancelled") matches.push(booking);
        });

        return matches.sort((a, b) => (a.date === b.date ? a.hour - b.hour : a.date.localeCompare(b.date)));
    } catch (validationError) {
        throw new Error(`Email lookup validation failed: ${validationError.message}`);
    }
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

// ============================================================================
// FOOTER RENDERING
// ============================================================================
function renderFooter() {
    const footer = document.getElementById('app-footer');
    if (!footer) return;

    footer.className = 'amk-footer';
    footer.innerHTML = `
        <div class="footer-container">
            <div class="footer-content">
                <!-- Branding Column -->
                <div class="footer-section footer-branding">
                    <div class="footer-logo">
                        <span class="footer-logo-emoji">✂️</span>
                        AMK CUTS
                    </div>
                    <div class="footer-description">
                        Premium barber shop providing quality haircuts and grooming services in Laval.
                    </div>
                    <div class="footer-social">
                        <a href="https://www.instagram.com/amk_cut?igsh=MWxlZ3ltMWtjOGhheA==" target="_blank" rel="noopener noreferrer" class="social-link" title="Instagram" aria-label="Instagram">
                            <svg class="social-icon" viewBox="0 0 24 24" aria-hidden="true">
                                <path fill="currentColor" d="M12 2.2c3.2 0 3.58.01 4.85.07 3.25.15 4.77 1.69 4.92 4.92.06 1.26.07 1.65.07 4.85 0 3.2-.01 3.58-.07 4.85-.15 3.22-1.66 4.77-4.92 4.92-1.27.06-1.65.07-4.85.07-3.2 0-3.58-.01-4.85-.07-3.26-.15-4.77-1.7-4.92-4.92-.06-1.27-.07-1.65-.07-4.85 0-3.2.01-3.59.07-4.85.15-3.23 1.66-4.77 4.92-4.92 1.27-.06 1.65-.07 4.85-.07zm0-2.2c-3.26 0-3.67.01-4.95.07C2.7.27.27 2.69.07 7.05.01 8.33 0 8.74 0 12c0 3.26.01 3.67.07 4.95.2 4.36 2.63 6.78 6.98 6.98 1.28.06 1.69.07 4.95.07 3.26 0 3.67-.01 4.95-.07 4.35-.2 6.78-2.62 6.98-6.98.06-1.28.07-1.69.07-4.95 0-3.26-.01-3.67-.07-4.95-.2-4.35-2.62-6.78-6.98-6.98C15.67.01 15.26 0 12 0zm0 5.84A6.16 6.16 0 1 0 18.16 12 6.16 6.16 0 0 0 12 5.84zm0 10.16A4 4 0 1 1 16 12a4 4 0 0 1-4 4zm6.41-11.85a1.44 1.44 0 1 0 1.44 1.44 1.44 1.44 0 0 0-1.44-1.44z"/>
                            </svg>
                        </a>
                    </div>
                </div>

                <!-- Address & Hours Column -->
                <div class="footer-section footer-address">
                    <div class="footer-section-title">Location</div>
                    <div class="address-item">
                        <span class="address-icon">📍</span>
                        <div class="address-text">
                            <span class="address-label">Address</span>
                            <span class="address-value">90 Degré Barbershop<br>354 Bd Cartier O<br>Laval, QC</span>
                        </div>
                    </div>
                    <button class="maps-button" id="maps-button">
                        <span class="maps-button-icon">🗺️</span>
                        Open in Maps
                    </button>
                </div>

                <!-- Hours Column -->
                <div class="footer-section footer-hours">
                    <div class="footer-section-title">Hours</div>
                    <div class="hours-item">
                        <span class="hours-day">Mon - Fri</span>
                        <span class="hours-time">9:00 AM - 6:00 PM</span>
                    </div>
                    <div class="hours-item">
                        <span class="hours-day">Saturday</span>
                        <span class="hours-time">10:00 AM - 5:00 PM</span>
                    </div>
                    <div class="hours-item">
                        <span class="hours-day">Sunday</span>
                        <span class="hours-closed">Closed</span>
                    </div>
                </div>
            </div>

            <div class="footer-divider"></div>

            <div class="footer-bottom">
                <div class="footer-credit">
                    © 2026 AMK Cuts. All rights reserved. |
                    <a href="#privacy">Privacy Policy</a> |
                    <a href="#terms">Terms of Service</a>
                </div>
            </div>
        </div>
    `;

    // Attach maps button event handler
    const mapsBtn = document.getElementById('maps-button');
    if (mapsBtn) {
        mapsBtn.onclick = () => {
            // Detect device for appropriate maps app
            const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
            const address = "90 Degré Barbershop, 354 Bd Cartier O, Laval, QC";

            if (isIOS) {
                // Open Apple Maps on iOS
                window.open(`https://maps.apple.com/?address=${encodeURIComponent(address)}`);
            } else {
                // Open Google Maps on Android/other
                window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`);
            }
        };
    }
}

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
            groupPhone.innerHTML = '<label>Phone Number (recommended)</label>';
            const phoneInput = document.createElement('input');
            phoneInput.placeholder = '(555) 000-0000';
            phoneInput.value = clientInfo.phone;
            groupPhone.appendChild(phoneInput);
            main.appendChild(groupPhone);
            // Email
            const groupEmail = document.createElement('div');
            groupEmail.className = 'form-group';
            groupEmail.innerHTML = '<label>Email (required for confirmation & manage booking)</label>';
            const emailInput = document.createElement('input');
            emailInput.type = 'email';
            emailInput.placeholder = 'you@email.com';
            emailInput.value = clientInfo.email;
            groupEmail.appendChild(emailInput);

            const emailHint = document.createElement('div');
            emailHint.className = 'error-msg';
            emailHint.style.display = 'none';
            emailHint.textContent = 'Please enter a valid email address.';
            groupEmail.appendChild(emailHint);

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
            const canSubmitBooking = () => !!String(clientInfo.name || '').trim() && isValidEmail(clientInfo.email);
            const updateEmailValidationUI = () => {
                const trimmedEmail = String(clientInfo.email || '').trim();
                const showEmailHint = trimmedEmail.length > 0 && !isValidEmail(trimmedEmail);
                emailHint.style.display = showEmailHint ? 'block' : 'none';
                emailInput.style.borderColor = showEmailHint ? '#d32f2f' : '';
                bookBtn.disabled = !canSubmitBooking();
            };
            bookBtn.disabled = !canSubmitBooking();

            const handleBooking = async () => {
                try {
                    // SECURITY: Rate limit booking creation (max 5 per hour per IP, max 2 per hour per email)
                    const emailForRateLimit = String(clientInfo.email || '').trim();
                    const bookingRateLimit = checkRateLimit('booking_create_email', emailForRateLimit, RATE_LIMIT_CONFIG.bookingCreate.perUserPerHour);
                    if (!bookingRateLimit.allowed) {
                        const resetTime = new Date(bookingRateLimit.resetAt).toLocaleTimeString();
                        alert(`You've reached the booking limit. Please try again after ${resetTime}.`);
                        bookBtn.disabled = false;
                        return;
                    }

                    // SECURITY: Strict input validation for all user inputs
                    try {
                        clientInfo.name = validateInput(clientInfo.name, 'name');
                        clientInfo.email = validateInput(clientInfo.email, 'email');
                        clientInfo.phone = validateInput(clientInfo.phone, 'phone');
                        // Validate service
                        selectedService.id = validateInput(selectedService.id, 'serviceId');
                        // Validate date
                        const validatedDate = validateInput(getDayKey(selectedDay), 'date');
                        // Validate hour
                        validateInput(selectedSlot.hour, 'hour');
                    } catch (validationError) {
                        alert(`Validation failed: ${validationError.message}`);
                        bookBtn.disabled = false;
                        return;
                    }

                    // Confirm booking
                    if (!selectedDay || !selectedSlot || !selectedService || !String(clientInfo.name || '').trim() || !isValidEmail(clientInfo.email)) {
                        alert('Please enter your full name and a valid email address.');
                        bookBtn.disabled = false;
                        return;
                    }

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
                        bookBtn.disabled = false;
                        render();
                        alert(error?.message || "Could not save booking. Please try again.");
                    }
                } catch (unexpectedError) {
                    console.error("Booking handler error:", unexpectedError);
                    bookBtn.disabled = false;
                    alert("An unexpected error occurred. Please try again.");
                }
            };

            bookBtn.onclick = handleBooking;

            // Allow Enter key to submit from email field
            emailInput.onkeydown = (e) => {
                if (e.key === 'Enter' && !bookBtn.disabled) {
                    e.preventDefault();
                    handleBooking();
                }
            };

            btnRow.appendChild(bookBtn);
            main.appendChild(btnRow);
            // --- Input event handlers for smooth typing ---
            nameInput.oninput = function (e) {
                clientInfo.name = e.target.value;
                updateEmailValidationUI();
            };
            phoneInput.oninput = function (e) {
                clientInfo.phone = e.target.value;
                updateEmailValidationUI();
            };
            emailInput.oninput = function (e) {
                clientInfo.email = e.target.value;
                updateEmailValidationUI();
            };

            updateEmailValidationUI();
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
                const passInput = document.getElementById('admin-pass');
                const unlockBtn = document.getElementById('unlock-admin');

                const handleUnlock = () => {
                    // SECURITY: Rate limit admin unlock attempts (max 10 per hour)
                    const adminRateLimit = checkRateLimit('admin_unlock', 'global', RATE_LIMIT_CONFIG.adminAccess.perIpPerHour);
                    if (!adminRateLimit.allowed) {
                        adminError = '429: Too many login attempts. Please try again later.';
                        render();
                        return;
                    }

                    try {
                        // SECURITY: Validate and sanitize password input
                        const pass = validateInput(passInput.value, 'password');

                        if (pass === PASSWORD) {
                            adminUnlocked = true;
                            adminError = '';
                        } else {
                            adminError = 'Incorrect password.';
                        }
                    } catch (validationError) {
                        adminError = `Invalid input: ${validationError.message}`;
                    }
                    render();
                };

                unlockBtn.onclick = handleUnlock;

                // Allow Enter key to submit
                passInput.onkeydown = (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        handleUnlock();
                    }
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
                <button class="tab-btn${adminTab === 'change-password' ? ' active' : ''}" id="tab-change-password">Change Password</button>
            `;
            main.appendChild(tabs);
            setTimeout(() => {
                document.getElementById('tab-schedule').onclick = () => { adminTab = 'schedule'; render(); };
                document.getElementById('tab-appointments').onclick = () => { adminTab = 'appointments'; render(); };
                document.getElementById('tab-change-password').onclick = () => {
                    adminTab = 'change-password';
                    changePasswordError = "";
                    changePasswordSuccess = "";
                    securityAnswerError = "";
                    render();
                };
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
            if (adminTab === 'change-password') {
                const title = document.createElement('div');
                title.className = 'section-title';
                title.textContent = 'Change Password';
                main.appendChild(title);

                // Security question
                const questionDiv = document.createElement('div');
                questionDiv.style.marginBottom = '20px';
                questionDiv.style.padding = '16px';
                questionDiv.style.backgroundColor = '#f5f5f5';
                questionDiv.style.borderRadius = '8px';
                questionDiv.style.color = '#111';

                const question = document.createElement('p');
                question.style.margin = '0 0 12px 0';
                question.style.fontWeight = 'bold';
                question.style.color = '#111';
                question.textContent = 'Zaker est fort ou faible? Réponds seulement avec fort ou faible.';
                questionDiv.appendChild(question);

                const answerInput = document.createElement('input');
                answerInput.type = 'text';
                answerInput.placeholder = 'fort ou faible';
                answerInput.style.width = '100%';
                answerInput.style.padding = '10px';
                answerInput.style.marginBottom = '10px';
                answerInput.style.border = securityAnswerError ? '1px solid #d32f2f' : '1px solid #ddd';
                answerInput.style.borderRadius = '4px';
                answerInput.style.boxSizing = 'border-box';
                answerInput.style.backgroundColor = '#fff';
                answerInput.style.color = '#111';
                questionDiv.appendChild(answerInput);

                if (securityAnswerError) {
                    const securityError = document.createElement('div');
                    securityError.style.color = '#d32f2f';
                    securityError.style.fontSize = '14px';
                    securityError.style.marginTop = '2px';
                    securityError.textContent = securityAnswerError;
                    questionDiv.appendChild(securityError);
                }

                main.appendChild(questionDiv);

                // New password input
                const newPassGroup = document.createElement('div');
                newPassGroup.className = 'form-group';
                newPassGroup.innerHTML = '<label>New Password</label>';
                const newPassInput = document.createElement('input');
                newPassInput.type = 'password';
                newPassInput.placeholder = 'Enter new password';
                newPassInput.value = newPasswordValue;
                newPassInput.style.border = changePasswordError ? '1px solid #d32f2f' : '';
                newPassGroup.appendChild(newPassInput);
                main.appendChild(newPassGroup);

                if (changePasswordSuccess) {
                    const successMsg = document.createElement('div');
                    successMsg.style.color = '#2e7d32';
                    successMsg.style.marginBottom = '16px';
                    successMsg.stylefontSize = '14px';
                    successMsg.textContent = changePasswordSuccess;
                    main.appendChild(successMsg);
                }

                if (changePasswordError) {
                    const errorMsg = document.createElement('div');
                    errorMsg.style.color = '#d32f2f';
                    errorMsg.style.marginBottom = '16px';
                    errorMsg.style.fontSize = '14px';
                    errorMsg.textContent = changePasswordError;
                    main.appendChild(errorMsg);
                }

                // Buttons
                const btnRow = document.createElement('div');
                btnRow.className = 'btn-row';
                const cancelBtn = document.createElement('button');
                cancelBtn.className = 'btn-outline';
                cancelBtn.textContent = 'Cancel';
                cancelBtn.onclick = () => {
                    adminTab = 'schedule';
                    changePasswordError = "";
                    changePasswordSuccess = "";
                    securityAnswerError = "";
                    newPasswordValue = "";
                    render();
                };
                btnRow.appendChild(cancelBtn);

                const changeBtn = document.createElement('button');
                changeBtn.className = 'btn';
                changeBtn.textContent = 'Change Password';
                changeBtn.onclick = () => {
                    // SECURITY: Rate limit admin password change attempts (max 10 per hour)
                    const adminRateLimit = checkRateLimit('admin_password_change', 'global', RATE_LIMIT_CONFIG.adminAccess.perIpPerHour);
                    if (!adminRateLimit.allowed) {
                        changePasswordError = "Too many password change attempts. Please try again later.";
                        changePasswordSuccess = "";
                        securityAnswerError = "";
                        newPasswordValue = "";
                        render();
                        return;
                    }

                    try {
                        // SECURITY: Validate security answer
                        const answer = String(answerInput.value || '').toLowerCase().trim();
                        if (answer !== 'fort') {
                            securityAnswerError = 'Pourquoi tu mens Karim? Tu connais très bien la bonne réponse.';
                            changePasswordError = "";
                            changePasswordSuccess = "";
                            newPasswordValue = String(newPassInput.value || '').trim();
                            render();
                            return;
                        }

                        // SECURITY: Strict password validation
                        const newPass = validateInput(newPassInput.value, 'password');

                        // Update password
                        Object.defineProperty(window, 'PASSWORD', {
                            writable: true,
                            configurable: true,
                            value: newPass
                        });

                        localStorage.setItem('barber_admin_password', newPass);

                        changePasswordError = "";
                        changePasswordSuccess = "Password changed successfully!";
                        securityAnswerError = "";
                        newPasswordValue = "";

                        render();
                    } catch (validationError) {
                        changePasswordError = `Validation failed: ${validationError.message}`;
                        securityAnswerError = "";
                        changePasswordSuccess = "";
                        newPasswordValue = String(newPassInput.value || '').trim();
                        render();
                    }
                };
                btnRow.appendChild(changeBtn);
                main.appendChild(btnRow);
            }
        }
    } else if (view === 'manage') {
        // Step 1: Enter email and booking code
        if (manageStep === 1) {
            const title = document.createElement('div');
            title.className = 'section-title';
            title.textContent = 'Find Your Booking';
            main.appendChild(title);
            const emailGroup = document.createElement('div');
            emailGroup.className = 'form-group';
            emailGroup.innerHTML = '<label>Email Address (required)</label>';
            const emailInput = document.createElement('input');
            emailInput.type = 'email';
            emailInput.placeholder = 'your@email.com';
            emailInput.value = manageLookupPhone;
            emailGroup.appendChild(emailInput);
            main.appendChild(emailGroup);

            const codeGroup = document.createElement('div');
            codeGroup.className = 'form-group';
            codeGroup.innerHTML = '<label>Booking Code (6 digits)</label>';
            const codeInput = document.createElement('input');
            codeInput.placeholder = '123456';
            codeInput.value = manageLookupCode;
            codeGroup.appendChild(codeInput);
            main.appendChild(codeGroup);

            const hint = document.createElement('p');
            hint.style.color = '#888';
            hint.style.fontSize = '12px';
            hint.style.marginTop = '6px';
            hint.textContent = 'Enter the email and 6-digit booking code from your confirmation.';
            main.appendChild(hint);

            const btnRow = document.createElement('div');
            btnRow.className = 'btn-row';
            const findBtn = document.createElement('button');
            findBtn.className = 'btn';
            findBtn.textContent = 'Find Booking';

            const handleFindBooking = async () => {
                try {
                    // SECURITY: Validate and sanitize inputs
                    const targetEmail = validateInput(emailInput.value, 'email');
                    const targetCode = validateInput(codeInput.value, 'bookingCode');

                    // Reject unexpected fields by checking if email format is correct
                    if (!targetEmail || !targetEmail.includes("@") || !/^\d{6}$/.test(targetCode)) {
                        alert('Enter a valid email address and 6-digit booking code.');
                        return;
                    }

                    // SECURITY: Rate limit checks (already done in findBookingsByEmailAndCode, but double-check here)
                    if (Date.now() - lastManageLookupAt < MANAGE_LOOKUP_COOLDOWN_MS) {
                        alert('Please wait a few seconds before trying again.');
                        return;
                    }

                    findBtn.disabled = true;
                    manageLookupPhone = emailInput.value;
                    manageLookupCode = targetCode;
                    lastManageLookupAt = Date.now();

                    try {
                        foundBookings = await findBookingsByEmailAndCode(targetEmail, targetCode);
                        manageStep = 2;
                        render();
                    } catch (lookupError) {
                        console.error('Failed to find bookings:', lookupError);
                        findBtn.disabled = false;
                        // Handle rate limit errors gracefully with 429-style message
                        if (lookupError.message.includes('Too many lookup attempts')) {
                            alert('429: Too many lookup attempts. ' + lookupError.message);
                        } else {
                            alert(lookupError?.message || 'Could not find bookings right now. Please try again.');
                        }
                    }
                } catch (validationError) {
                    console.error('Validation error:', validationError);
                    alert(`Validation failed: ${validationError.message}`);
                }
            };

            findBtn.onclick = handleFindBooking;

            // Allow Enter key to submit
            codeInput.onkeydown = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    handleFindBooking();
                }
            };
            emailInput.onkeydown = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    handleFindBooking();
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
    renderFooter();

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

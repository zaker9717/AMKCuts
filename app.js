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

// --- FIREBASE SETUP ---
const firebaseConfig = {
    apiKey: "AIzaSyD3JSC7IymUdEQIOFpY2Sc7kXKhcTwIUPs",
    authDomain: "barber-booking-1575c.firebaseapp.com",
    projectId: "barber-booking-1575c",
    storageBucket: "barber-booking-1575c.firebasestorage.app",
    messagingSenderId: "738769582633",
    appId: "1:738769582633:web:a7c5bb1290f40b53f93a38",
    measurementId: "G-MM82WMY3W8"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

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
let adminTab = "schedule";

// Manage Booking state
let manageStep = 1;
let foundBookings = [];
let bookingToEdit = null;

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
    const templateParams = {
        service: selectedService?.name || '',
        date: selectedDay?.toLocaleDateString() || '',
        time: selectedSlot?.label || '',
        name: clientInfo.name,
        phone: clientInfo.phone,
        email: clientInfo.email,
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
async function loadBookingsFromFirestore() {
    const snapshot = await db.collection('bookings').get();
    bookings = {};
    snapshot.forEach(doc => {
        const data = doc.data();
        if (!bookings[data.date]) bookings[data.date] = [];
        bookings[data.date].push({ ...data, _id: doc.id });
    });
}
async function saveBookingToFirestore(booking) {
    await db.collection('bookings').add(booking);
}
async function deleteBookingFromFirestore(id) {
    await db.collection('bookings').doc(id).delete();
}
async function updateBookingInFirestore(id, newData) {
    await db.collection('bookings').doc(id).update(newData);
}


// --- Patch booking actions ---
// On page load, load bookings from Firestore, then render
loadBookingsFromFirestore().then(render);

// --- LocalStorage persistence for bookings ---
function saveBookings() {
    localStorage.setItem('barber_bookings', JSON.stringify(bookings));
}
function loadBookings() {
    const data = localStorage.getItem('barber_bookings');
    if (data) {
        try {
            bookings = JSON.parse(data);
        } catch (e) {
            bookings = {};
        }
    }
}
// Load bookings on page load

loadBookings();
render();

// Helper to update the UI
function render() {
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
    setTimeout(() => {
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
        if (navBook) navBook.onclick = () => { view = 'book'; step = 1; render(); };
        const navManage = document.getElementById('nav-manage');
        if (navManage) navManage.onclick = () => { view = 'manage'; manageStep = 1; foundBookings = []; bookingToEdit = null; render(); };
    }, 0);

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
                    client: { ...clientInfo },
                    service: selectedService,
                    date: getDayKey(selectedDay)
                };
                await saveBookingToFirestore(booking);
                await loadBookingsFromFirestore();
                sendBookingEmail();
                step = 4;
                render();
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
                    ${clientInfo.email ? `<div class="confirm-row"><span>Reminder sent to</span><span>${clientInfo.email}</span></div>` : ''}
                </div>
                <p style="color:#555;font-size:12px">A reminder will be sent 24 hours before your appointment.</p>
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
                            render();
                        };
                        document.getElementById(`start-${i}`).onchange = e => {
                            availability[i].start = parseInt(e.target.value);
                            render();
                        };
                        document.getElementById(`end-${i}`).onchange = e => {
                            availability[i].end = parseInt(e.target.value);
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
            group.appendChild(phoneInput);
            main.appendChild(group);
            const btnRow = document.createElement('div');
            btnRow.className = 'btn-row';
            const findBtn = document.createElement('button');
            findBtn.className = 'btn';
            findBtn.textContent = 'Find Booking';
            findBtn.onclick = () => {
                // Search all bookings for this phone
                foundBookings = Object.entries(bookings).flatMap(([date, appts]) =>
                    appts.map((a, idx) => ({ ...a, date, idx }))
                ).filter(b => b.client.phone === phoneInput.value);
                manageStep = 2;
                render();
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
                            // Remove booking
                            const arr = bookings[appt.date];
                            arr.splice(appt.idx, 1);
                            if (arr.length === 0) delete bookings[appt.date];
                            await deleteBookingFromFirestore(appt._id);
                            await loadBookingsFromFirestore();
                            manageStep = 3;
                            render();
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
                // Remove old booking
                const arr = bookings[bookingToEdit.date];
                arr.splice(bookingToEdit.idx, 1);
                if (arr.length === 0) delete bookings[bookingToEdit.date];
                await deleteBookingFromFirestore(bookingToEdit._id);
                // Add new booking
                const newBooking = {
                    hour: bookingToEdit._newSlot.hour,
                    label: bookingToEdit._newSlot.label,
                    client: bookingToEdit.client,
                    service: bookingToEdit.service,
                    date: getDayKey(bookingToEdit._newDay)
                };
                await saveBookingToFirestore(newBooking);
                await loadBookingsFromFirestore();
                manageStep = 5;
                render();
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

// On page load, render the initial UI
window.onload = function () {
    render();
};

/* ------------------------------------------------------------------
   Study-Room Board – Express back-end (full, production-ready)
   --------------------------------------------------------------
   • Uses LibCal /hours/{LOCATION_ID} to get *today’s* open/close
   • Builds 30-minute slots, handles midnight rollover (e.g., 08:00 → 01:00)
   • Fetches bookings for today (+ tomorrow if hours span past midnight)
   • Marks each slot as OCCUPIED/AVAILABLE; keeps a slot visible until it ends
   • Caches OAuth token to avoid rate limits
------------------------------------------------------------------- */

import express from 'express';
import fetch   from 'node-fetch';
import dotenv  from 'dotenv';
import dayjs   from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';

dayjs.extend(customParseFormat);
dotenv.config();

/* --------------------------------------------------
   Environment
-------------------------------------------------- */
const {
  LIBCAL_HOST,               // e.g., https://libcal.gettysburg.edu
  LIBCAL_CLIENT_ID,
  LIBCAL_CLIENT_SECRET,
  ROOM_ID,                   // space (room) ID used with /space/bookings
  LOCATION_ID,               // location/library ID used with /hours/{id}
  FALLBACK_OPEN  = 8,        // used only if hours API fails (24h clock)
  FALLBACK_CLOSE = 23,
  PORT           = 4000
} = process.env;

if (!LIBCAL_HOST || !LIBCAL_CLIENT_ID || !LIBCAL_CLIENT_SECRET || !ROOM_ID || !LOCATION_ID) {
  console.warn('[WARN] Missing one or more required .env keys: LIBCAL_HOST, LIBCAL_CLIENT_ID, LIBCAL_CLIENT_SECRET, ROOM_ID, LOCATION_ID');
}

/* --------------------------------------------------
   Express app
-------------------------------------------------- */
const app = express();
app.use(express.static('public'));   // serves index.html + JS/CSS

/* --------------------------------------------------
   OAuth token cache
-------------------------------------------------- */
let tokenCache = { token: null, expires: 0 };

async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expires) return tokenCache.token;

  const res = await fetch(`${LIBCAL_HOST}/api/1.1/oauth/token`, {
    method : 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body   : new URLSearchParams({
      grant_type   : 'client_credentials',
      client_id    : LIBCAL_CLIENT_ID,
      client_secret: LIBCAL_CLIENT_SECRET
    })
  });

  if (!res.ok) throw new Error(`OAuth failed (${res.status})`);
  const json = await res.json();

  tokenCache = {
    token  : json.access_token,
    expires: Date.now() + (json.expires_in - 60) * 1000   // renew 1 min early
  };
  return tokenCache.token;
}

/* --------------------------------------------------
   Helpers
-------------------------------------------------- */
const SLOT_MINUTES = 30;

/** Parse a time string that may be "9:00am", "4:30 pm", "16:00", "12 am" */
function parseTime(dateISO, timeStr) {
  const patterns = [
    'YYYY-MM-DD h:mma', 'YYYY-MM-DD h:mm a', 'YYYY-MM-DD hh:mma',
    'YYYY-MM-DD H:mm',  'YYYY-MM-DD HH:mm',
    'YYYY-MM-DD h a',   'YYYY-MM-DD ha'
  ];
  for (const fmt of patterns) {
    const d = dayjs(`${dateISO} ${timeStr}`, fmt);
    if (d.isValid()) return d;
  }
  return null;
}

/** Fetch today’s opening hours and return { openStr, closeStr } */
async function getTodayHours(bearer, isoDate) {
  try {
    const url  = `${LIBCAL_HOST}/api/1.1/hours/${LOCATION_ID}?date=${isoDate}`;
    const json = await fetch(url, { headers:{ Authorization:`Bearer ${bearer}` } })
                 .then(r => r.json());

    // Payload shape used by your tenant:
    // [{"dates": { "YYYY-MM-DD": { status: "open", hours:[{from,to}...] } }}]
    const dayData = json?.[0]?.dates?.[isoDate];
    if (!dayData) throw new Error('No date entry in hours payload');

    // If LibCal marks "open_all_day" (or returns open with no ranges), create a 24h window
    if (/open/i.test(dayData.status) && (!Array.isArray(dayData.hours) || dayData.hours.length === 0)) {
      return { openStr: '12:00am', closeStr: '12:00am' }; // will roll to next day below
    }

    if (!/open/i.test(dayData.status) || !Array.isArray(dayData.hours)) {
      throw new Error(`Closed or malformed hours status: ${dayData.status}`);
    }

    const hours = dayData.hours;

    // Earliest open / latest close across any intervals
    const openStr  = hours.reduce((earliest, h) =>
      dayjs(h.from, 'h:mma').isBefore(dayjs(earliest, 'h:mma')) ? h.from : earliest,
      hours[0].from
    );
    const closeStr = hours.reduce((latest, h) =>
      dayjs(h.to, 'h:mma').isAfter(dayjs(latest, 'h:mma')) ? h.to : latest,
      hours[0].to
    );

    return { openStr, closeStr };
  } catch (e) {
    // Fall back to .env hours if endpoint is closed or not readable
    return {
      openStr : `${String(FALLBACK_OPEN).padStart(2,'0')}:00`,
      closeStr: `${String(FALLBACK_CLOSE).padStart(2,'0')}:00`
    };
  }
}

/** Build 30-min slots between openStr and closeStr; include the final slot that ends exactly at close */
function buildSlots(dateISO, openStr, closeStr) {
  let first = parseTime(dateISO, openStr);
  let close = parseTime(dateISO, closeStr);

  if (!first || !close) {
    throw new Error(`Could not parse opening hours: ${openStr} – ${closeStr}`);
  }

  // Handle hours that roll past midnight (e.g., 08:00 → 01:00 next day, or "… → 12:00am")
  if (!close.isAfter(first)) {
    close = close.add(1, 'day');
  }

  // Round opening down to nearest :00 / :30 so our slots align cleanly
  const startMin = first.minute();
  let t = first.minute(startMin < 30 ? 0 : 30).second(0);

  const slots = [];
  while (true) {
    const slotEnd = t.clone().add(SLOT_MINUTES, 'minute');
    if (slotEnd.isAfter(close)) break;        // don’t exceed closing time
    slots.push(t.clone());
    t = slotEnd;                              // next slot starts at previous end
  }
  return slots;
}

/* --------------------------------------------------
   API consumed by the front-end board
-------------------------------------------------- */
app.get('/api/today', async (_req, res) => {
  try {
    const todayISO = dayjs().format('YYYY-MM-DD');
    const bearer   = await getAccessToken();

    /* ---- Opening hours ---- */
    const { openStr, closeStr } = await getTodayHours(bearer, todayISO);
    const openDT  = parseTime(todayISO, openStr);
    let   closeDT = parseTime(todayISO, closeStr);
    const spansNextDay = closeDT && openDT ? !closeDT.isAfter(openDT) : false;

    /* ---- Bookings (today + tomorrow if hours span midnight) ---- */
    const mkBookingsUrl = d => `${LIBCAL_HOST}/api/1.1/space/bookings?eid=${ROOM_ID}&date=${d}`;

    const bookingsToday = await fetch(mkBookingsUrl(todayISO), {
      headers: { Authorization: `Bearer ${bearer}` }
    }).then(r => r.json());

    let bookings = bookingsToday;

    if (spansNextDay) {
      const tomorrowISO = dayjs(todayISO).add(1, 'day').format('YYYY-MM-DD');
      const bookingsTomorrow = await fetch(mkBookingsUrl(tomorrowISO), {
        headers: { Authorization: `Bearer ${bearer}` }
      }).then(r => r.json());
      bookings = bookingsToday.concat(bookingsTomorrow);
    }

    /* ---- Build set of taken half-hour slices ---- */
    const taken = new Set();
    bookings.forEach(b => {
      const start = dayjs(b.fromDate || b.from);
      const end   = dayjs(b.toDate   || b.to);
      if (!start.isValid() || !end.isValid()) return;
      for (let t = start.clone(); t.isBefore(end); t = t.add(SLOT_MINUTES, 'minute')) {
        taken.add(t.format('HH:mm'));               // e.g., "12:30"
      }
    });

    /* ---- Build grid ---- */
    const now      = dayjs();
    const allSlots = buildSlots(todayISO, openStr, closeStr);

    // Keep slots until their *end* time passes (so 1:00–1:30 remains visible at 1:05)
    let slots = allSlots.filter(t => t.clone().add(SLOT_MINUTES,'minute').isAfter(now));

    // After hours (or before opening) show the full day instead of an empty grid
    if (slots.length === 0) slots = allSlots;

    const grid = slots.map(t => ({
      label : t.format('h:mm A'),
      booked: taken.has(t.format('HH:mm'))
    }));

    res.json({
      dateDisplay: dayjs().format('dddd, MMMM D, YYYY'),
      grid
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* --------------------------------------------------
   Start HTTP listener
-------------------------------------------------- */
app.listen(PORT, () => {
  console.log(`⇢  http://localhost:${PORT}`);
});

/* --------------------------------------------------
   DEBUG ROUTES (disabled) – Uncomment temporarily if needed
   ----------------------------------------------------------------
   // Inspect raw hours JSON:
   // app.get('/api/debug/hours', async (_req, res) => {
   //   const bearer = await getAccessToken();
   //   const today  = dayjs().format('YYYY-MM-DD');
   //   const url    = `${LIBCAL_HOST}/api/1.1/hours/${LOCATION_ID}?date=${today}`;
   //   const raw    = await fetch(url, { headers:{Authorization:`Bearer ${bearer}` } }).then(r => r.text());
   //   res.type('text/plain').send(raw);
   // });

   // Inspect raw bookings for a given date (?d=YYYY-MM-DD, default today):
   // app.get('/api/debug/bookings', async (req, res) => {
   //   const d = req.query.d || dayjs().format('YYYY-MM-DD');
   //   const bearer = await getAccessToken();
   //   const url = `${LIBCAL_HOST}/api/1.1/space/bookings?eid=${ROOM_ID}&date=${d}`;
   //   const raw = await fetch(url, { headers:{Authorization:`Bearer ${bearer}` } }).then(r => r.text());
   //   res.type('text/plain').send(raw);
   // });
------------------------------------------------------------------- */

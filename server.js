/* ------------------------------------------------------------------
   Study-Room Board – Express back-end (timezone-aware, date-safe)
   --------------------------------------------------------------
   • Uses LibCal /hours/{LOCATION_ID} to get *today’s* open/close
   • Pins all date math to a chosen TZ (default America/New_York)
   • Handles midnight rollover (e.g., 08:00 → 01:00 next day)
   • Fetches bookings for today (+ tomorrow if spanning midnight)
   • Filters out canceled/etc. bookings by status
   • Marks slots OCCUPIED/AVAILABLE using full datetime keys
   • Keeps each slot visible until its *end* time passes
   • Shows full day after closing to avoid an empty screen
   • Caches OAuth token to avoid rate limits
------------------------------------------------------------------- */

import express from 'express';
import fetch   from 'node-fetch';
import dotenv  from 'dotenv';
import dayjs   from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import utc     from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';

dayjs.extend(customParseFormat);
dayjs.extend(utc);
dayjs.extend(timezone);
dotenv.config();

/* --------------------------------------------------
   Environment
-------------------------------------------------- */
const {
  LIBCAL_HOST,               // e.g., https://libcal.gettysburg.edu
  LIBCAL_CLIENT_ID,
  LIBCAL_CLIENT_SECRET,
  ROOM_ID,                   // space (room) ID for /space/bookings
  LOCATION_ID,               // location/library ID for /hours/{id}
  TIMEZONE = 'America/New_York', // <<< pin app to this zone
  FALLBACK_OPEN  = 8,        // used only if hours API fails (24h clock)
  FALLBACK_CLOSE = 23,
  PORT           = 4000
} = process.env;

const TZ = TIMEZONE;

/* --------------------------------------------------
   Express app
-------------------------------------------------- */
const app = express();
app.use(express.static('public'));

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
    expires: Date.now() + (json.expires_in - 60) * 1000
  };
  return tokenCache.token;
}

/* --------------------------------------------------
   Helpers
-------------------------------------------------- */
const SLOT_MINUTES = 30;

/** Parse a time string (“9:00am”, “4:30 pm”, “16:00”, “12 am”) at TZ */
function parseTime(dateISO, timeStr) {
  const patterns = [
    'YYYY-MM-DD h:mma', 'YYYY-MM-DD h:mm a', 'YYYY-MM-DD hh:mma',
    'YYYY-MM-DD H:mm',  'YYYY-MM-DD HH:mm',
    'YYYY-MM-DD h a',   'YYYY-MM-DD ha'
  ];
  for (const fmt of patterns) {
    const d = dayjs.tz(`${dateISO} ${timeStr}`, fmt, TZ);
    if (d.isValid()) return d;
  }
  return null;
}

/** Determine if a booking status should count as active/occupied */
function isActiveStatus(status) {
  const s = String(status || '').trim().toLowerCase();
  return s === 'confirmed' || s === 'checked in' || s === 'checked-in' || s === 'active';
}

/** Fetch today’s opening hours: returns { openStr, closeStr } strings */
async function getTodayHours(bearer, isoDate) {
  try {
    const url  = `${LIBCAL_HOST}/api/1.1/hours/${LOCATION_ID}?date=${isoDate}`;
    const json = await fetch(url, { headers:{ Authorization:`Bearer ${bearer}` } })
                 .then(r => r.json());

    // Your tenant shape: [{"dates": { "<YYYY-MM-DD>": { status, hours:[{from,to}] } }}]
    const dayData = json?.[0]?.dates?.[isoDate];
    if (!dayData) throw new Error('No date entry in hours payload');

    // If “open” with no ranges, treat as 24h (midnight→midnight)
    if (/open/i.test(dayData.status) && (!Array.isArray(dayData.hours) || dayData.hours.length === 0)) {
      return { openStr: '12:00am', closeStr: '12:00am' }; // will roll to next day
    }

    if (!/open/i.test(dayData.status) || !Array.isArray(dayData.hours)) {
      throw new Error(`Closed or malformed hours: ${dayData.status}`);
    }

    const hours = dayData.hours;

    // Earliest open / latest close across intervals
    const openStr  = hours.reduce((earliest, h) =>
      dayjs(h.from, 'h:mma').isBefore(dayjs(earliest, 'h:mma')) ? h.from : earliest,
      hours[0].from
    );
    const closeStr = hours.reduce((latest, h) =>
      dayjs(h.to, 'h:mma').isAfter(dayjs(latest, 'h:mma')) ? h.to : latest,
      hours[0].to
    );

    return { openStr, closeStr };
  } catch {
    // Fall back if hours endpoint is unavailable
    return {
      openStr : `${String(FALLBACK_OPEN).padStart(2,'0')}:00`,
      closeStr: `${String(FALLBACK_CLOSE).padStart(2,'0')}:00`
    };
  }
}

/** Build 30-min slots between openStr and closeStr at TZ */
function buildSlots(dateISO, openStr, closeStr) {
  let first = parseTime(dateISO, openStr);   // TZ aware
  let close = parseTime(dateISO, closeStr);  // TZ aware
  if (!first || !close) {
    throw new Error(`Could not parse opening hours: ${openStr} – ${closeStr}`);
  }

  // Hours that roll past midnight (e.g., 08:00 → 01:00 next day, or “→ 12:00am”)
  if (!close.isAfter(first)) close = close.add(1, 'day');

  // Align opening to :00 or :30
  const startMin = first.minute();
  let t = first.minute(startMin < 30 ? 0 : 30).second(0);

  const slots = [];
  while (true) {
    const slotEnd = t.clone().add(SLOT_MINUTES, 'minute');
    if (slotEnd.isAfter(close)) break;  // do not exceed closing
    slots.push(t.clone());
    t = slotEnd;
  }
  return slots;
}

/* --------------------------------------------------
   API consumed by the front-end board
-------------------------------------------------- */
app.get('/api/today', async (_req, res) => {
  try {
    // Pin “today” and the display date to TZ
    const todayISO    = dayjs().tz(TZ).format('YYYY-MM-DD');
    const dateDisplay = dayjs().tz(TZ).format('dddd, MMMM D, YYYY');

    const bearer = await getAccessToken();

    /* ---- Opening hours ---- */
    const { openStr, closeStr } = await getTodayHours(bearer, todayISO);

    // Determine if hours span to the next day
    const openDT   = parseTime(todayISO, openStr);
    let   closeDT  = parseTime(todayISO, closeStr);
    const spansNextDay = closeDT && openDT ? !closeDT.isAfter(openDT) : false;

    /* ---- Bookings (today + tomorrow if spanning midnight) ---- */
    const mkBookingsUrl = d => `${LIBCAL_HOST}/api/1.1/space/bookings?eid=${ROOM_ID}&date=${d}`;

    const bookingsToday = await fetch(mkBookingsUrl(todayISO), {
      headers: { Authorization: `Bearer ${bearer}` }
    }).then(r => r.json());

    let bookings = bookingsToday;

    if (spansNextDay) {
      const tomorrowISO = dayjs.tz(todayISO, 'YYYY-MM-DD', TZ).add(1,'day').format('YYYY-MM-DD');
      const bookingsTomorrow = await fetch(mkBookingsUrl(tomorrowISO), {
        headers: { Authorization: `Bearer ${bearer}` }
      }).then(r => r.json());
      bookings = bookingsToday.concat(bookingsTomorrow);
    }

    /* ---- Build set of taken half-hour slices (DATE + time keys) ---- */
    const taken = new Set();
    bookings
      .filter(b => isActiveStatus(b.status))   // ignore canceled/rejected/etc.
      .forEach(b => {
        const start = dayjs(b.fromDate || b.from).tz(TZ);
        const end   = dayjs(b.toDate   || b.to).tz(TZ);
        if (!start.isValid() || !end.isValid()) return;
        for (let u = start.clone(); u.isBefore(end); u = u.add(SLOT_MINUTES, 'minute')) {
          taken.add(u.format('YYYY-MM-DD HH:mm'));  // include DATE to avoid tomorrow bleed
        }
      });

    /* ---- Build grid ---- */
    const now      = dayjs().tz(TZ);
    const allSlots = buildSlots(todayISO, openStr, closeStr);

    // Keep a slot until its *end* passes; show full day if none remain
    let slots = allSlots.filter(t => t.clone().add(SLOT_MINUTES,'minute').isAfter(now));
    if (slots.length === 0) slots = allSlots;

    const grid = slots.map(t => ({
      label : t.format('h:mm A'),
      booked: taken.has(t.format('YYYY-MM-DD HH:mm'))
    }));

    res.json({ dateDisplay, grid });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* --------------------------------------------------
   Start HTTP listener
-------------------------------------------------- */
app.listen(PORT, () => {
  console.log(`⇢  http://localhost:${PORT}  (TZ=${TZ})`);
});

/* --------------------------------------------------
   DEBUG ROUTES (disabled) – uncomment temporarily if needed
   ----------------------------------------------------------------
   // Inspect raw hours JSON:
   // app.get('/api/debug/hours', async (_req, res) => {
   //   const bearer = await getAccessToken();
   //   const today  = dayjs().tz(TZ).format('YYYY-MM-DD');
   //   const url    = `${LIBCAL_HOST}/api/1.1/hours/${LOCATION_ID}?date=${today}`;
   //   const raw    = await fetch(url, { headers:{Authorization:`Bearer ${bearer}` } }).then(r => r.text());
   //   res.type('text/plain').send(raw);
   // });

   // Inspect raw bookings for a given date (?d=YYYY-MM-DD, default today):
   // app.get('/api/debug/bookings', async (req, res) => {
   //   const d = req.query.d || dayjs().tz(TZ).format('YYYY-MM-DD');
   //   const bearer = await getAccessToken();
   //   const url = `${LIBCAL_HOST}/api/1.1/space/bookings?eid=${ROOM_ID}&date=${d}`;
   //   const raw = await fetch(url, { headers:{Authorization:`Bearer ${bearer}` } }).then(r => r.text());
   //   res.type('text/plain').send(raw);
   // });
------------------------------------------------------------------- */

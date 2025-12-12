/* ------------------------------------------------------------------
   Study-Room Board – Express back-end (timezone-aware, date-safe)
------------------------------------------------------------------- */

import express from 'express';
import dotenv from 'dotenv';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';

dayjs.extend(customParseFormat);
dayjs.extend(utc);
dayjs.extend(timezone);
dotenv.config();

/* --------------------------------------------------
   Environment
-------------------------------------------------- */
const {
  LIBCAL_HOST,               // e.g., https://libcal.gettysburg.edu   (no trailing /api)
  LIBCAL_CLIENT_ID,
  LIBCAL_CLIENT_SECRET,
  ROOM_ID,                   // space (room) ID for /space/bookings
  LOCATION_ID,               // location/library ID for /hours/{id}
  TIMEZONE = 'America/New_York',
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
   OAuth token cache with robust token fetch
-------------------------------------------------- */
let tokenCache = { token: null, expires: 0 };

async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expires) return tokenCache.token;

  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id:  LIBCAL_CLIENT_ID,
    client_secret: LIBCAL_CLIENT_SECRET
  });

  const tokenUrls = [
    `${LIBCAL_HOST}/1.1/oauth/token`,
    `${LIBCAL_HOST}/api/1.1/oauth/token`
  ];

  let lastErr;
  for (const url of tokenUrls) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form
      });
      const text = await r.text();
      if (!r.ok) {
        console.error('OAUTH_HTTP_ERROR', r.status, url, text.slice(0, 800));
        lastErr = new Error(`OAuth failed (${r.status})`);
        continue;
      }
      let json;
      try { json = JSON.parse(text); } catch (e) {
        console.error('OAUTH_PARSE_ERROR', url, text.slice(0, 800));
        throw e;
      }
      tokenCache = {
        token:   json.access_token,
        expires: Date.now() + (json.expires_in ? (json.expires_in - 60) * 1000 : 59 * 60 * 1000)
      };
      return tokenCache.token;
    } catch (e) {
      lastErr = e;
      console.error('OAUTH_FETCH_ERROR', url, String(e));
    }
  }
  throw lastErr || new Error('OAuth failed');
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
    const r = await fetch(url, { headers:{ Authorization:`Bearer ${bearer}` } });
    const payloadText = await r.text();
    if (!r.ok) {
      console.error('HOURS_HTTP_ERROR', r.status, payloadText.slice(0, 800));
      throw new Error(`Hours HTTP ${r.status}`);
    }
    const json = JSON.parse(payloadText);

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
  } catch (e) {
    console.error('HOURS_FALLBACK_REASON', String(e));
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

    // today
    const rToday = await fetch(mkBookingsUrl(todayISO), {
      headers: { Authorization: `Bearer ${bearer}` }
    });
    const textToday = await rToday.text();
    if (!rToday.ok) {
      console.error('BOOKINGS_HTTP_ERROR_TODAY', rToday.status, textToday.slice(0, 800));
      throw new Error(`Bookings HTTP ${rToday.status}`);
    }
    let bookings = JSON.parse(textToday);

    // tomorrow (if needed)
    if (spansNextDay) {
      const tomorrowISO = dayjs.tz(todayISO, 'YYYY-MM-DD', TZ).add(1,'day').format('YYYY-MM-DD');
      const rTomorrow = await fetch(mkBookingsUrl(tomorrowISO), {
        headers: { Authorization: `Bearer ${bearer}` }
      });
      const textTomorrow = await rTomorrow.text();
      if (!rTomorrow.ok) {
        console.error('BOOKINGS_HTTP_ERROR_TOMORROW', rTomorrow.status, textTomorrow.slice(0, 800));
        throw new Error(`Bookings HTTP ${rTomorrow.status}`);
      }
      const bookingsTomorrow = JSON.parse(textTomorrow);
      bookings = bookings.concat(bookingsTomorrow);
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
    console.error('ROUTE_ERROR', String(err));
    res.status(500).json({ error: err.message });
  }
});

/* Optional tiny health endpoint */
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

/* --------------------------------------------------
   Start HTTP listener
-------------------------------------------------- */
app.listen(PORT, () => {
  console.log(`⇢  http://localhost:${PORT}  (TZ=${TZ})`);
});

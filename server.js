/* ------------------------------------------------------------------
   Study‑Room Board – Express back‑end
   -----------------------------------
   • Looks up today's opening hours via /hours/{LOCATION_ID}
   • Builds 30‑minute slots dynamically from earliest open to latest close
   • Proxies LibCal bookings so bearer token stays server‑side
------------------------------------------------------------------- */

import express from 'express';
import fetch   from 'node-fetch';
import dotenv  from 'dotenv';
import dayjs   from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';  // ← NEW
dayjs.extend(customParseFormat);                                    // ← NEW


dotenv.config();

/* --------------------------------------------------
   Environment
-------------------------------------------------- */
const {
  LIBCAL_HOST,
  LIBCAL_CLIENT_ID,
  LIBCAL_CLIENT_SECRET,
  ROOM_ID,
  LOCATION_ID,
  FALLBACK_OPEN  = 8,    // used only if hours API fails
  FALLBACK_CLOSE = 23,
  PORT           = 4000
} = process.env;

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
    expires: Date.now() + (json.expires_in - 60) * 1000   // renew 1 min early
  };
  return tokenCache.token;
}

/* --------------------------------------------------
   Fetch today's opening hours  (reworked for object‑style JSON)
-------------------------------------------------- */
async function getTodayHours(bearer, isoDate) {
  try {
    const url  = `${LIBCAL_HOST}/api/1.1/hours/${LOCATION_ID}?date=${isoDate}`;
    const json = await fetch(url, { headers:{ Authorization:`Bearer ${bearer}` } })
                 .then(r => r.json());

    // Musselman-style payload: json[0].dates.{YYYY-MM-DD}
    const dayData = json?.[0]?.dates?.[isoDate];
    if (!dayData || !/open/i.test(dayData.status)) throw new Error('Closed');

    const hours = dayData.hours;                // array of {from,to}

    /* Earliest opening + latest closing across all intervals */
    const openStr  = hours.reduce((earliest, h) =>
                     dayjs(h.from, 'h:mma').isBefore(dayjs(earliest, 'h:mma')) ? h.from : earliest,
                     hours[0].from);

    const closeStr = hours.reduce((latest, h) =>
                     dayjs(h.to, 'h:mma').isAfter(dayjs(latest, 'h:mma')) ? h.to : latest,
                     hours[0].to);

    return { openStr, closeStr };
  } catch {
    /* Fallback to .env hours if the endpoint is closed or malformed */
    return {
      openStr : `${String(FALLBACK_OPEN).padStart(2,'0')}:00`,
      closeStr: `${String(FALLBACK_CLOSE).padStart(2,'0')}:00`
    };
  }
}


/* --------------------------------------------------
   Slot builder
-------------------------------------------------- */
const SLOT_MINUTES = 30;

/* ---------- helper to parse time strings ---------- */
function parseTime(dateISO, timeStr) {
  const patterns = [
    'YYYY-MM-DD h:mma', 'YYYY-MM-DD h:mm a', 'YYYY-MM-DD hh:mma',
    'YYYY-MM-DD H:mm',  'YYYY-MM-DD HH:mm'
  ];
  for (const fmt of patterns) {
    const d = dayjs(`${dateISO} ${timeStr}`, fmt);
    if (d.isValid()) return d;
  }
  return null;
}

/* ---------- build the 30‑min slot array ---------- */
function buildSlots(dateISO, openStr, closeStr) {
  const first = parseTime(dateISO, openStr);
  const close = parseTime(dateISO, closeStr);

  if (!first || !close) {
    throw new Error(`Could not parse opening hours: ${openStr} – ${closeStr}`);
  }

  /* Round the opening time down to :00 or :30 */
  const startMin = first.minute();
  let t = first.minute(startMin < 30 ? 0 : 30).second(0);

  const slots = [];
  while (true) {
    const slotEnd = t.clone().add(SLOT_MINUTES, 'minute');
    if (slotEnd.isAfter(close)) break;   // stop once this slot would exceed close
    slots.push(t.clone());
    t = slotEnd;                         // next slot starts where this one ended
  }
  return slots;
}



/* --------------------------------------------------
   Main API consumed by the front‑end board
-------------------------------------------------- */
app.get('/api/today', async (_req, res) => {
  try {
    const todayISO = dayjs().format('YYYY-MM-DD');
    const bearer   = await getAccessToken();

    /* ---- Opening hours ---- */
    const { openStr, closeStr } = await getTodayHours(bearer, todayISO);

    /* ---- Bookings ---- */
    const bookingsURL = `${LIBCAL_HOST}/api/1.1/space/bookings?eid=${ROOM_ID}&date=${todayISO}`;
    const bookings = await fetch(bookingsURL, {
      headers: { Authorization: `Bearer ${bearer}` }
    }).then(r => r.json());

    // Build taken slice set
    const taken = new Set();
    bookings.forEach(b => {
      const start = dayjs(b.fromDate || b.from);
      const end   = dayjs(b.toDate   || b.to);

      for (let t = start.clone(); t.isBefore(end); t = t.add(SLOT_MINUTES, 'minute')) {
        taken.add(t.format('HH:mm'));
      }
    });

    /* ---- Slot grid ---- */
    const now   = dayjs();
    const slots = buildSlots(todayISO, openStr, closeStr).filter(t =>
      t.clone().add(SLOT_MINUTES,'minute').isAfter(now)   // keep until slot end passes
    );

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

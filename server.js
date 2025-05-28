import express from 'express';
import fetch   from 'node-fetch';
import dotenv  from 'dotenv';
import dayjs   from 'dayjs';

dotenv.config();

const {
  LIBCAL_HOST, LIBCAL_CLIENT_ID, LIBCAL_CLIENT_SECRET,
  ROOM_ID, OPEN_HOUR, CLOSE_HOUR
} = process.env;

const app = express();
app.use(express.static('public'));

let cache = { token: null, exp: 0 };

async function token() {
  if (cache.token && Date.now() < cache.exp) return cache.token;

  const r = await fetch(`${LIBCAL_HOST}/api/1.1/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type':'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:'client_credentials',
      client_id:LIBCAL_CLIENT_ID,
      client_secret:LIBCAL_CLIENT_SECRET
    })
  }).then(r => r.json());

  cache = { token:r.access_token, exp: Date.now() + (r.expires_in-60)*1e3 };
  return cache.token;
}

function buildSlots(date) {
  const start = dayjs(date).hour(+OPEN_HOUR).minute(0);
  const end   = dayjs(date).hour(+CLOSE_HOUR).minute(30); // inclusive
  const slots = [];
  for (let t = start; t.isBefore(end); t = t.add(30,'minute')) {
    slots.push(t.clone());
  }
  return slots;
}

app.get('/api/today', async (_req,res) => {
  try {
    const today = dayjs().format('YYYY-MM-DD');
    const bear  = await token();

    const url = `${LIBCAL_HOST}/api/1.1/space/bookings?eid=${ROOM_ID}&date=${today}`;
    const bookings = await fetch(url, { headers:{Authorization:`Bearer ${bear}`} })
                           .then(r => r.json());

    const taken = new Set( bookings.map(b => dayjs(b.from).format('HH:mm')) );

    const now     = dayjs();
    const all     = buildSlots(today);
    const future  = all.filter(t => t.isAfter(now) || t.isSame(now,'minute'));

    const grid = future.map(t => ({
      label: t.format('h:mm A'),
      booked: taken.has(t.format('HH:mm'))
    }));

    res.json({
      dateDisplay: dayjs().format('dddd, MMMM D, YYYY'),
      grid
    });
  } catch (e) { console.error(e); res.status(500).json({error:e.message}); }
});

app.listen(4000,()=>console.log('⇢  http://localhost:4000'));

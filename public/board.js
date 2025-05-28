import dayjs from 'https://cdn.jsdelivr.net/npm/dayjs@1/dayjs.min.js';

const REFRESH_MS = 5 * 60_000;
const gridEl     = document.getElementById('grid');
const titleEl    = document.getElementById('title');

async function draw() {
  const { dateDisplay, grid } = await fetch('/api/today').then(r=>r.json());

  titleEl.textContent = `Room Availability for ${dateDisplay}`;

  gridEl.style.gridTemplateColumns = `repeat(${grid.length}, 1fr)`;
  gridEl.innerHTML = '';   // wipe

  grid.forEach(slot => {
    const div = document.createElement('div');
    div.className = `cell ${slot.booked ? 'busy' : 'free'}`;
    div.textContent = `${slot.label} ${slot.booked ? 'NOT AVAILABLE' : 'AVAILABLE'}`;
    gridEl.appendChild(div);
  });
}

draw();
setInterval(draw, REFRESH_MS);

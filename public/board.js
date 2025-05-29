import dayjs from 'https://cdn.jsdelivr.net/npm/dayjs@1/+esm';

const REFRESH_MS = 5 * 60_000;          // 5‑minute refresh
const gridEl     = document.getElementById('grid');
const titleEl    = document.getElementById('title');

async function draw() {
  const { dateDisplay, grid } = await fetch('/api/today').then(r => r.json());

  titleEl.textContent = `Room Availability for ${dateDisplay}`;

  gridEl.innerHTML = '';                 // clear previous cells

  grid.forEach(slot => {
    const div = document.createElement('div');
    div.className = `cell ${slot.booked ? 'busy' : 'free'}`;
    div.innerHTML = `
      <div>${slot.label}</div>
      <div style="font-size:.9rem;margin-top:.25rem">
        ${slot.booked ? 'OCCUPIED' : 'AVAILABLE'}
      </div>`;
    gridEl.appendChild(div);
  });
}

draw();                       // initial render
setInterval(draw, REFRESH_MS);  // periodic refresh

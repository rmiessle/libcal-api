import dayjs from 'https://cdn.jsdelivr.net/npm/dayjs@1/+esm';

const REFRESH_MS = 5 * 60_000;          // 5-minute refresh
const gridEl     = document.getElementById('grid');
const titleEl    = document.getElementById('title');

async function draw() {
  try {
    const { dateDisplay, grid } = await fetch('/api/today').then(r => r.json());

    titleEl.textContent = `Room Availability for ${dateDisplay}`;
    gridEl.innerHTML    = '';           // clear previous cells

    grid.forEach(slot => {
      const div = document.createElement('div');
      div.className = `cell ${slot.booked ? 'busy' : 'free'}`;
      div.innerHTML = `
        <div>${slot.label}</div>
        <div style="font-size:clamp(.8rem,1vw,.95rem);margin-top:.25rem">
          ${slot.booked ? 'OCCUPIED' : 'AVAILABLE'}
        </div>`;
      gridEl.appendChild(div);
    });
  } catch (err) {
    titleEl.textContent = 'Error loading schedule';
    console.error(err);
  }
}

draw();                       // initial render
setInterval(draw, REFRESH_MS);  // periodic refresh

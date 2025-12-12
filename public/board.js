// ES module; runs in the browser
const REFRESH_MS = 5 * 60_000;          // refresh every 5 minutes
const gridEl     = document.getElementById('grid');
const titleEl    = document.getElementById('title');

async function draw() {
  try {
    const r = await fetch('/api/today', { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { dateDisplay, grid } = await r.json();

    titleEl.textContent = `Room Availability for ${dateDisplay}`;
    gridEl.innerHTML = '';

    grid.forEach(slot => {
      const div = document.createElement('div');
      div.className = `cell ${slot.booked ? 'busy' : 'free'}`;
      div.innerHTML = `
        <div>${slot.label}</div>
        <div class="status">${slot.booked ? 'OCCUPIED' : 'AVAILABLE'}</div>
      `;
      gridEl.appendChild(div);
    });
  } catch (err) {
    console.error('UI_FETCH_ERROR', err);
    titleEl.textContent = 'Room Availability — error contacting server';
  }
}

draw();                       // initial render
setInterval(draw, REFRESH_MS);  // periodic refresh

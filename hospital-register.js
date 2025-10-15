import { getGeolocation } from './geolocation.js';

document.addEventListener('DOMContentLoaded', () => {
  const regForm = document.getElementById('hospital-register-form');
  const geoBtn = document.getElementById('fetch-location-btn');
  const latInput = document.getElementById('latitude');
  const lonInput = document.getElementById('longitude');
  const msg = document.getElementById('geo-message');

  geoBtn.addEventListener('click', async () => {
    msg.textContent = 'Fetching location...';
    try {
      const { position, isPrecise } = await getGeolocation({ timeoutMs: 10000 });
      latInput.value = position.coords.latitude.toFixed(6);
      lonInput.value = position.coords.longitude.toFixed(6);
      msg.textContent = isPrecise ? 'Accurate GPS fix!' : 'Approximate location captured.';
      msg.style.color = 'green';
    } catch (err) {
      msg.textContent = `Error: ${err.message || 'Unable to fetch location.'}`;
      msg.style.color = 'red';
    }
  });

  regForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    // your existing POST logic
  });
});
